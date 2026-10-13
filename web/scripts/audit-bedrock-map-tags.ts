/**
 * 一次性只读排查：历史上做过 Bedrock 创建 / 打 Tag / 交付的账户，当前 profile 的
 * map-migrated 标签是否合规（.kiro/specs/bedrock-map-tag-guard/design.md §10）。
 *
 * 用法（在 web/ 下）：
 *   npx tsx scripts/audit-bedrock-map-tags.ts [--payer <payer名>] [--out <目录>] [--plan-only]
 *
 * - 审计日志直接读 data/db.json（或 DB_PATH），不经 db.ts
 * - 非 plan-only 会通过 Admin 链路读取各账户 Bedrock 标签（ListInferenceProfiles + ListTagsForResource），
 *   对 AWS 只读；但 Admin 链路会经 db.ts 读受限账户名单，若当天还没有备份，会触发与服务本身相同的
 *   每日自动备份（写 data/backups/），不改 db.json / root-email-jobs.json 本身
 * - --plan-only：只解析审计日志，写 history CSV，打印将查询的账户与区域，不加载任何 AWS 模块，完全不碰 data/
 *
 * 修正方式：在平台 Bedrock 页「Profiles 管理」重新打 Tag（会覆盖错值、移除大小写变体 key），
 * 再重新生成交付表。本脚本不做任何写操作。
 */
import fs from 'fs';
import path from 'path';
import { checkMapTagValue, findMapTagKeyVariant, findMapTagValue, type BedrockTag } from '../server/map-tag-rules';

const ACTIONS = new Set(['BEDROCK_PROFILE_CREATE', 'BEDROCK_PROFILE_TAG', 'BEDROCK_DELIVERY_EXPORT']);
const DEFAULT_REGIONS = ['us-east-1', 'us-west-2'];
const REGION_BATCH = 12; // /profiles 单次上限，与 listProfiles 调用方保持一致

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const payerFilter = argValue('--payer');
const outDir = argValue('--out') || process.cwd();
const planOnly = process.argv.includes('--plan-only');
const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/db.json');

/** CSV 字段：一律双引号包裹，内部双引号转义；数字原样写入，不加千分位 */
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function writeCsv(file: string, header: string[], rows: unknown[][]) {
  const body = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
  fs.writeFileSync(file, '\uFEFF' + body + '\n', 'utf-8');
}

const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

interface HistoryRow { createdAt: string; action: string; payer: string; accountId: string; value: string; valid: boolean; reason: string }

function main() {
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  const auditLog: any[] = Array.isArray(db.audit_log) ? db.audit_log : [];
  const cache: any[] = Array.isArray(db.accounts_cache) ? db.accounts_cache : [];
  const payerOf = (id: string) => cache.find(a => a?.Id === id)?._payer || 'unknown';

  const regionsByAccount = new Map<string, Set<string>>();
  const history: HistoryRow[] = [];

  for (const log of auditLog) {
    if (!ACTIONS.has(log?.action)) continue;
    const detail = String(log.detail || '');
    const accountId = /账户 (\d{12})/.exec(detail)?.[1];
    if (!accountId) continue;
    const payer = payerOf(accountId);
    if (payerFilter && payer !== payerFilter) continue;

    if (!regionsByAccount.has(accountId)) regionsByAccount.set(accountId, new Set(DEFAULT_REGIONS));
    const region = /\| ([a-z]{2}(?:-[a-z]+)+-\d) \|/.exec(detail)?.[1];
    if (region) regionsByAccount.get(accountId)!.add(region);

    // 交付记录写的是「tag=值」；只对交付记录用这条，否则会把 cost-tag=abc 这类额外 Tag 误当成历史值
    const values = [
      ...[...detail.matchAll(/map-migrated=([^;|\s]+)/g)].map(m => m[1]),
      ...(log.action === 'BEDROCK_DELIVERY_EXPORT'
        ? [...detail.matchAll(/[，,(（]tag=([^\s，）)]+)/g)].map(m => m[1]) : []),
    ];
    for (const value of values) {
      const reason = checkMapTagValue(value);
      history.push({
        createdAt: String(log.created_at || ''), action: log.action, payer, accountId,
        value, valid: !reason, reason: reason || '',
      });
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const historyFile = path.join(outDir, `bedrock-map-tag-history-${today}.csv`);
  writeCsv(historyFile, ['createdAt', 'action', 'payer', 'accountId', 'value', 'valid', 'reason'],
    history.map(h => [h.createdAt, h.action, h.payer, h.accountId, h.value, h.valid, h.reason]));

  console.log(`审计记录中涉及 ${regionsByAccount.size} 个账户${payerFilter ? `（payer=${payerFilter}）` : ''}`);
  for (const [id, regions] of regionsByAccount) console.log(`  ${id} [${payerOf(id)}] → ${[...regions].join(',')}`);
  const badHistory = history.filter(h => !h.valid);
  console.log(`历史标签值 ${history.length} 条，不合规 ${badHistory.length} 条 → ${historyFile}`);
  return { regionsByAccount, payerOf };
}

async function scanCurrent(regionsByAccount: Map<string, Set<string>>, payerOf: (id: string) => string) {
  // 动态加载：plan-only 时不引入任何 AWS / 配置模块
  const { listProfiles } = await import('../server/bedrock-tools');
  const rows: unknown[][] = [];
  const counts = new Map<string, number>();
  const badAccounts = new Set<string>();
  let profileCount = 0;
  const bump = (status: string) => counts.set(status, (counts.get(status) || 0) + 1);

  for (const [accountId, regionSet] of regionsByAccount) {
    const payer = payerOf(accountId);
    const regions = [...regionSet];
    for (let i = 0; i < regions.length; i += REGION_BATCH) {
      const batch = regions.slice(i, i + REGION_BATCH);
      let result: { rows: any[]; errors: Array<{ region: string; message: string }> };
      try {
        result = await listProfiles(accountId, batch);
      } catch (e: any) {
        rows.push([payer, accountId, batch.join('|'), '', '', '', '查询失败', e?.message || String(e)]);
        bump('查询失败');
        continue;
      }
      for (const err of result.errors) {
        rows.push([payer, accountId, err.region, '', '', '', '查询失败', err.message]);
        bump('查询失败');
      }
      for (const p of result.rows) {
        profileCount += 1;
        const tags: BedrockTag[] = p.tags || [];
        const variant = findMapTagKeyVariant(tags);
        const value = findMapTagValue(tags);
        let status = 'OK';
        let reason = '';
        if (variant) { status = '大小写变体'; reason = `存在 key「${variant}」`; }
        // listProfiles 读标签失败时返回空 tags，这里无法区分「真没打」与「读失败」
        else if (value === null) { status = '缺失'; reason = '未读到 map-migrated（标签读取失败也会显示为缺失，请在页面复核）'; }
        else {
          const err = checkMapTagValue(value);
          if (err) { status = '格式错误'; reason = err; }
        }
        if (status !== 'OK') badAccounts.add(`${accountId} [${payer}]`);
        bump(status);
        rows.push([payer, accountId, p.region, p.name, p.arn, value ?? '', status, reason]);
      }
    }
  }

  const currentFile = path.join(outDir, `bedrock-map-tag-current-${today}.csv`);
  writeCsv(currentFile, ['payer', 'accountId', 'region', 'profileName', 'arn', 'mapValue', 'status', 'reason'], rows);
  console.log(`当前 profile ${profileCount} 个：${[...counts].map(([s, n]) => `${s} ${n}`).join('，') || '无'} → ${currentFile}`);
  if (badAccounts.size) console.log(`需要处理的账户：\n  ${[...badAccounts].join('\n  ')}`);
}

(async () => {
  const { regionsByAccount, payerOf } = main();
  if (!planOnly) await scanCurrent(regionsByAccount, payerOf);
  process.exit(0);
})().catch(e => { console.error('排查失败：', e?.message || e); process.exit(1); });
