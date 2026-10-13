/**
 * 一次性存量清理：删除各组织的 admin-console-role-orgwide（常驻 AdministratorAccess 角色）。
 * 见 .kiro/specs/admin-console-on-demand/design.md §5.11。
 *
 * 背景：admin-console 曾由该 SERVICE_MANAGED StackSet 下发到每个成员账户（AutoDeployment=true，
 * 新账户自动获得）。现改为按需临时开通（server/temp-admin.ts，独立 StackSet admin-console-role-temporary），
 * 存量常驻角色全部删除。临时开通用的 StackSet 不受本脚本影响。
 *
 * 用法（必须在 EC2 执行，读生产 config.json）：
 *   npx tsx scripts/remove-orgwide-admin-console.ts --payer <名称>            # dry-run：只看状态与残留
 *   npx tsx scripts/remove-orgwide-admin-console.ts --all                     # dry-run：全部组织
 *   npx tsx scripts/remove-orgwide-admin-console.ts --payer <名称> --execute  # 真正删除
 *   可加 --out <目录> 指定残留清单 CSV 的输出位置（默认当前目录）
 *
 * --execute 每个组织：关闭 AutoDeployment → DeleteStackInstances(Root OU, RetainStacks=false) →
 * 实例清空后 DeleteStackSet。之后探测仍能 AssumeRole admin-console 的成员账户（手工角色 / 删除失败），
 * 输出残留清单 —— 只列不删，由人决定。先对 1 个组织执行并核对，再 --all。
 * 不读写 data/。
 */
import fs from 'fs';
import path from 'path';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { OrganizationsClient, ListRootsCommand, ListAccountsCommand } from '@aws-sdk/client-organizations';
import {
  CloudFormationClient, DescribeStackSetCommand, UpdateStackSetCommand, DeleteStackInstancesCommand,
  DeleteStackSetCommand, ListStackInstancesCommand, DescribeStackSetOperationCommand,
} from '@aws-sdk/client-cloudformation';

const ORGWIDE_STACKSET = 'admin-console-role-orgwide';
const PROBE_CONCURRENCY = 6;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const payerArg = argValue('--payer');
const all = process.argv.includes('--all');
const execute = process.argv.includes('--execute');
const outDir = argValue('--out') || process.cwd();

const USAGE = '用法: npx tsx scripts/remove-orgwide-admin-console.ts (--payer <名称> | --all) [--execute] [--out <目录>]';
if (!payerArg && !all) {
  console.error(USAGE);
  process.exit(1);
}

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
const REGION: string = CONFIG.region || 'us-east-1';
const ADMIN_ROLE: string = CONFIG.adminRoleName || 'admin-console';
const BASE = { accessKeyId: CONFIG.credentials.accessKeyId, secretAccessKey: CONFIG.credentials.secretAccessKey };
const PAYERS: { name: string; roleArn: string }[] = CONFIG.payers || [];

const log = (...a: any[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const isDenied = (e: any) => ['AccessDenied', 'AccessDeniedException'].includes(e?.name);
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function assumePayer(roleArn: string) {
  const sts = new STSClient({ region: REGION, credentials: BASE });
  try {
    const c = (await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn, RoleSessionName: 'awstool-remove-orgwide-admin', DurationSeconds: 3600,
    }))).Credentials!;
    return { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! };
  } finally { sts.destroy(); }
}

async function waitOp(cf: CloudFormationClient, opId: string | undefined, maxMin: number): Promise<string> {
  if (!opId) throw new Error('未返回操作 ID');
  const deadline = Date.now() + maxMin * 60_000;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const op = (await cf.send(new DescribeStackSetOperationCommand({
      StackSetName: ORGWIDE_STACKSET, OperationId: opId, CallAs: 'SELF',
    }))).StackSetOperation;
    if (op?.Status && !['RUNNING', 'QUEUED', 'STOPPING'].includes(op.Status)) {
      return op.StatusReason ? `${op.Status}（${op.StatusReason}）` : op.Status;
    }
  }
  return `TIMEOUT(${maxMin}min，操作仍在后台进行)`;
}

async function listInstances(cf: CloudFormationClient) {
  const out: Array<{ account: string; status: string; reason: string }> = [];
  let token: string | undefined;
  do {
    const page = await cf.send(new ListStackInstancesCommand({ StackSetName: ORGWIDE_STACKSET, CallAs: 'SELF', NextToken: token }));
    for (const s of page.Summaries || []) {
      out.push({
        account: s.Account || '',
        status: s.StackInstanceStatus?.DetailedStatus || s.Status || '',
        reason: s.StatusReason || '',
      });
    }
    token = page.NextToken;
  } while (token);
  return out;
}

function countByStatus(list: Array<{ status: string }>) {
  const m = new Map<string, number>();
  for (const i of list) m.set(i.status, (m.get(i.status) || 0) + 1);
  return [...m].map(([s, n]) => `${s}=${n}`).join(' ') || '0';
}

async function memberAccounts(creds: any, payerAccountId: string) {
  const org = new OrganizationsClient({ region: REGION, credentials: creds });
  const out: Array<{ id: string; name: string; joined: string }> = [];
  try {
    let token: string | undefined;
    do {
      const page = await org.send(new ListAccountsCommand({ NextToken: token }));
      for (const a of page.Accounts || []) {
        const state = (a as any).State || a.Status;
        if (a.Id && a.Id !== payerAccountId && state === 'ACTIVE') {
          out.push({ id: a.Id, name: a.Name || '', joined: a.JoinedMethod || '' });
        }
      }
      token = page.NextToken;
    } while (token);
  } finally { org.destroy(); }
  return out;
}

/** 能 AssumeRole admin-console 的账户 = 残留；非 AccessDenied 的错误单独标出，不当作「无残留」 */
async function probeResidual(accounts: Array<{ id: string; name: string; joined: string }>) {
  const residual: typeof accounts = [];
  const unknown: Array<{ id: string; error: string }> = [];
  const queue = [...accounts];
  const sts = new STSClient({ region: REGION, credentials: BASE });
  try {
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length || 1) }, async () => {
      while (queue.length) {
        const a = queue.shift()!;
        try {
          await sts.send(new AssumeRoleCommand({
            RoleArn: `arn:aws:iam::${a.id}:role/${ADMIN_ROLE}`, RoleSessionName: 'awstool-residual-probe', DurationSeconds: 900,
          }));
          residual.push(a);
        } catch (e: any) {
          if (!isDenied(e)) unknown.push({ id: a.id, error: e?.name || String(e) });
        }
      }
    }));
  } finally { sts.destroy(); }
  return { residual, unknown };
}

async function handle(payer: { name: string; roleArn: string }): Promise<string> {
  const payerAccountId = /arn:aws:iam::(\d+):role\//.exec(payer.roleArn)?.[1] || '';
  const creds = await assumePayer(payer.roleArn);
  const cf = new CloudFormationClient({ region: REGION, credentials: creds });
  let summary = '';
  try {
    let set: any = null;
    try {
      set = (await cf.send(new DescribeStackSetCommand({ StackSetName: ORGWIDE_STACKSET, CallAs: 'SELF' }))).StackSet;
    } catch (e: any) {
      if (e?.name !== 'StackSetNotFoundException') throw e;
    }

    if (!set) {
      log(`${payer.name}: ${ORGWIDE_STACKSET} 不存在`);
      summary = 'StackSet 不存在';
    } else {
      const before = await listInstances(cf);
      log(`${payer.name}: auto=${!!set.AutoDeployment?.Enabled} 实例 ${before.length}（${countByStatus(before)}）`);
      summary = `实例 ${before.length}`;

      if (execute) {
        if (set.AutoDeployment?.Enabled) {
          const op = await cf.send(new UpdateStackSetCommand({
            StackSetName: ORGWIDE_STACKSET, UsePreviousTemplate: true, Capabilities: ['CAPABILITY_NAMED_IAM'],
            PermissionModel: 'SERVICE_MANAGED', AutoDeployment: { Enabled: false }, CallAs: 'SELF',
          }));
          const status = await waitOp(cf, op.OperationId, 30);
          log(`${payer.name}: 关闭 AutoDeployment → ${status}`);
          // 自动部署没关掉就删实例，新加入的账户仍会被补上常驻 admin-console —— 停在这里人工处理
          if (!status.startsWith('SUCCEEDED')) throw new Error(`关闭 AutoDeployment 未成功（${status}），未删除任何实例`);
        }
        if (before.length) {
          const root = (await new OrganizationsClient({ region: REGION, credentials: creds }).send(new ListRootsCommand({}))).Roots![0].Id!;
          const op = await cf.send(new DeleteStackInstancesCommand({
            StackSetName: ORGWIDE_STACKSET,
            DeploymentTargets: { OrganizationalUnitIds: [root] },
            Regions: [REGION],
            RetainStacks: false,
            OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
            CallAs: 'SELF',
          }));
          log(`${payer.name}: 删除实例 → ${await waitOp(cf, op.OperationId, 60)}`);
        }
        const after = await listInstances(cf);
        if (after.length === 0) {
          await cf.send(new DeleteStackSetCommand({ StackSetName: ORGWIDE_STACKSET, CallAs: 'SELF' }));
          log(`${payer.name}: StackSet 已删除`);
          summary += ' → 已全部删除，StackSet 已删除';
        } else {
          for (const i of after) log(`${payer.name}:   残留实例 ${i.account} ${i.status} ${i.reason}`);
          summary += ` → 仍剩 ${after.length} 个实例，StackSet 保留（可重跑）`;
        }
      }
    }
  } finally { cf.destroy(); }

  const accounts = await memberAccounts(creds, payerAccountId);
  const { residual, unknown } = await probeResidual(accounts);
  if (residual.length) {
    const file = path.join(outDir, `orgwide-admin-console-residual-${payer.name}-${today}.csv`);
    const rows = [['payer', 'accountId', 'accountName', 'joinedMethod'],
      ...residual.map(a => [payer.name, a.id, a.name, a.joined])];
    fs.writeFileSync(file, '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n', 'utf-8');
    log(`${payer.name}: 仍可 AssumeRole ${ADMIN_ROLE} 的成员账户 ${residual.length} 个 → ${file}`);
  }
  if (unknown.length) {
    log(`${payer.name}: ${unknown.length} 个账户探测出错（不能视为无残留）：${unknown.slice(0, 5).map(u => `${u.id}(${u.error})`).join(', ')}`);
  }
  return `${summary} | 成员 ${accounts.length}，残留 ${residual.length}，探测出错 ${unknown.length}`;
}

(async () => {
  const targets = all ? PAYERS : PAYERS.filter(p => p.name === payerArg);
  if (!targets.length) {
    console.error(`未找到组织 "${payerArg}"，config.payers 里可选: ${PAYERS.map(p => p.name).join(', ')}`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  log(`${execute ? '[EXECUTE]' : '[dry-run]'} ${ORGWIDE_STACKSET} → ${targets.length} 个组织`);
  const results: string[] = [];
  let failed = 0;
  // 组织间串行：删除的是完整管理员角色，出错时便于逐个定位
  for (const p of targets) {
    try {
      results.push(`${p.name}: ${await handle(p)}`);
    } catch (e: any) {
      failed++;
      results.push(`${p.name}: ❌ ${e?.name} ${String(e?.message || '').slice(0, 160)}`);
    }
  }
  console.log('\n===== 汇总 =====');
  for (const r of results) console.log(r);
  process.exit(failed ? 1 : 0);
})();
