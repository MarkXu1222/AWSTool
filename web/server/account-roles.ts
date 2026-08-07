/**
 * 账户角色自愈 — 新账户加入后自动检测平台所需角色，缺失则补齐，补不上则告警。
 *
 * 背景：成员账户的两个角色由各组织的 SERVICE_MANAGED StackSet 下发，
 * AutoDeployment 会在账户加入 Root OU 时自动创建。但自动部署并非 100% 可靠：
 *   - 账户未完成激活时 CloudFormation 返回 OptInRequired，部署必然失败
 *   - StackSet 操作可能排队/超时
 *   - 角色可能被人为删除
 * 而这些失败只躺在 CloudFormation 里，平台此前完全不知道 —— 账户在列表里看着正常，
 * 点进去什么都读不了。本模块补上这个缺口。
 *
 * 策略：
 *   增量（跟账户同步一起跑）：只检测「从未检测过」的账户，缺失就按 payer 批量触发 StackSet 定向部署
 *   全量（每日）：重新检测所有账户，发现被删除的角色
 *   失败重试到上限后标记 unreachable 并飞书告警，避免无限重试刷 API
 */
import fs from 'fs';
import path from 'path';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
  CloudFormationClient, CreateStackInstancesCommand,
  DescribeStackSetOperationCommand, DescribeStackSetCommand,
} from '@aws-sdk/client-cloudformation';
import { db } from './db';
import { notifyAccountRoleIssues } from './notify';
import { isRestricted } from './restricted-accounts';

// ===== 配置 =====
let CONFIG: any = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
} catch (e: any) {
  console.error('[AccountRoles] 读取 config.json 失败:', e.message);
}

const REGION: string = CONFIG.region || 'us-east-1';
const BASE_CREDENTIALS = {
  accessKeyId: CONFIG.credentials?.accessKeyId || '',
  secretAccessKey: CONFIG.credentials?.secretAccessKey || '',
};
const SUPPORT_ROLE: string = CONFIG.supportRoleName || 'support-quota';
const ADMIN_ROLE: string = CONFIG.adminRoleName || 'admin-console';
const PAYERS: { name: string; roleArn: string }[] = CONFIG.payers || [];

// StackSet 名称与角色的对应关系（与已部署的组织级 StackSet 保持一致）
const STACKSET_FOR: Record<'support' | 'admin', string> = {
  support: 'support-quota-role-orgwide',
  admin: 'admin-console-role-orgwide',
};

const MAX_ATTEMPTS = 3;          // 补齐尝试上限，超过标记 unreachable
const PROBE_CONCURRENCY = 6;     // 探测并发，避免 STS 限流
const MAX_NEW_PER_RUN = 60;      // 增量单轮上限：新账户通常很少，够用且不打满 API
const MAX_FULL_PER_RUN = 400;    // 全量单轮上限：配合「最久未检查优先」轮转，数日内覆盖全部账户

export type RoleKind = 'support' | 'admin';

export interface AccountRoleRecord {
  account_id: string;
  account_name?: string;
  payer?: string;
  support: boolean;
  admin: boolean;
  state: 'ok' | 'partial' | 'pending' | 'unreachable';
  attempts: number;
  last_error?: string | null;
  checked_at: string;
  remediated_at?: string | null;
}

// ===== 基础工具 =====

function stsClient(creds: any) {
  return new STSClient({ region: REGION, credentials: creds });
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<any>) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length || 1) }, async () => {
    while (q.length) await fn(q.shift()!);
  }));
}

/** 尝试 AssumeRole，成功返回 true。仅用于探测角色是否存在且信任本平台。 */
async function canAssume(accountId: string, roleName: string): Promise<boolean> {
  try {
    await stsClient(BASE_CREDENTIALS).send(new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
      RoleSessionName: 'awstool-roleprobe',
      DurationSeconds: 900,
    }));
    return true;
  } catch {
    return false;
  }
}

/** 探测某账户的两个角色可用性 */
export async function probeAccountRoles(accountId: string): Promise<{ support: boolean; admin: boolean }> {
  const [support, admin] = await Promise.all([
    canAssume(accountId, SUPPORT_ROLE),
    canAssume(accountId, ADMIN_ROLE),
  ]);
  return { support, admin };
}

/** 取某 payer 的管理凭证（用于操作该组织的 StackSet） */
async function assumePayer(payerName: string) {
  const p = PAYERS.find(x => x.name === payerName);
  if (!p) throw new Error(`payer ${payerName} 不在 config.payers 中`);
  const r = await stsClient(BASE_CREDENTIALS).send(new AssumeRoleCommand({
    RoleArn: p.roleArn,
    RoleSessionName: 'awstool-remediate',
    DurationSeconds: 3600,
  }));
  const c = r.Credentials!;
  return { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! };
}

/**
 * 对一批账户触发 StackSet 定向部署（同一 payer、同一角色一次调用）。
 * 返回操作是否最终成功；不抛异常，失败原因写进 error。
 */
async function deployToAccounts(
  payerName: string,
  kind: RoleKind,
  accountIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  const name = STACKSET_FOR[kind];
  try {
    const creds = await assumePayer(payerName);
    const cf = new CloudFormationClient({ region: REGION, credentials: creds });

    // StackSet 必须已存在（组织级下发由部署脚本一次性建好）。不存在就直接报错，
    // 避免在这里隐式创建出配置不一致的 StackSet。
    let ous: string[] = [];
    try {
      const d = await cf.send(new DescribeStackSetCommand({ StackSetName: name, CallAs: 'SELF' }));
      ous = d.StackSet?.OrganizationalUnitIds || [];
    } catch (e: any) {
      return { ok: false, error: `StackSet ${name} 不存在于 ${payerName}（${e?.name}）` };
    }
    if (ous.length === 0) return { ok: false, error: `StackSet ${name} 无部署目标 OU` };

    const op = await cf.send(new CreateStackInstancesCommand({
      StackSetName: name,
      // 限定在已有 OU 范围内，只对指定账户生效
      DeploymentTargets: { OrganizationalUnitIds: ous, Accounts: accountIds, AccountFilterType: 'INTERSECTION' },
      Regions: [REGION],
      OperationPreferences: { FailureTolerancePercentage: 50, MaxConcurrentPercentage: 50 },
      CallAs: 'SELF',
    }));

    // 轮询到结束（单批账户数不多，最多等 10 分钟）
    const started = Date.now();
    for (;;) {
      await new Promise(r => setTimeout(r, 10000));
      let status = '';
      try {
        const st = await cf.send(new DescribeStackSetOperationCommand({
          StackSetName: name, OperationId: op.OperationId, CallAs: 'SELF',
        }));
        status = st.StackSetOperation?.Status || '';
      } catch (e: any) {
        return { ok: false, error: `轮询失败 ${e?.name}` };
      }
      if (status === 'SUCCEEDED') return { ok: true };
      if (['FAILED', 'STOPPED'].includes(status)) return { ok: false, error: `操作 ${status}` };
      if (Date.now() - started > 10 * 60 * 1000) return { ok: false, error: '操作超时（仍在后台进行）' };
    }
  } catch (e: any) {
    return { ok: false, error: `${e?.name}: ${String(e?.message || '').slice(0, 120)}` };
  }
}

// ===== 主流程 =====

export interface SyncOptions {
  /** full=true 时重新检测所有账户（每日复检）；否则只检测从未检测过的账户 */
  full?: boolean;
  /** 只处理指定账户（手动触发用） */
  accountIds?: string[];
  /** 只检测不补齐 */
  probeOnly?: boolean;
}

export interface SyncResult {
  scanned: number;
  ok: number;
  remediated: number;
  pending: number;
  unreachable: number;
  skippedSuspended: number;
  details: AccountRoleRecord[];
}

/**
 * 检测 → 补齐 → 复验 → 记录 → 告警
 */
export async function syncAccountRoles(opts: SyncOptions = {}): Promise<SyncResult> {
  const { accounts } = db.getAccountsCache();
  const known = db.getAccountRoles();
  const knownMap = new Map(known.map(r => [r.account_id, r]));

  // 选择待检测账户
  let targets = (accounts || []).filter((a: any) => !a._isPayer);
  if (opts.accountIds?.length) {
    const set = new Set(opts.accountIds);
    targets = targets.filter((a: any) => set.has(a.Id));
  } else if (!opts.full) {
    // 增量：只看没检测过的，以及此前 pending（等自动部署完成）的
    targets = targets.filter((a: any) => {
      const rec = knownMap.get(a.Id);
      return !rec || rec.state === 'pending';
    });
    // 最近加入组织的优先 —— 这才是本功能要盯的对象。
    // 首次上线时全部账户都算「未检测」，若按缓存顺序取，真正的新账户可能排到很后面。
    targets = [...targets].sort((a: any, b: any) =>
      String(b.JoinedTimestamp || '').localeCompare(String(a.JoinedTimestamp || '')));
  } else {
    // 全量复检：最久未检查的优先，配合单轮上限实现轮转覆盖。
    // 否则每轮都从列表头部取同一批，后面的账户永远轮不到。
    targets = [...targets].sort((a: any, b: any) => {
      const ta = knownMap.get(a.Id)?.checked_at || '';
      const tb = knownMap.get(b.Id)?.checked_at || '';
      return ta.localeCompare(tb);
    });
  }

  const skippedSuspended = targets.filter((a: any) => a.Status !== 'ACTIVE').length;
  targets = targets.filter((a: any) => a.Status === 'ACTIVE');

  // 限流，避免一次打满 STS。指定账户时不限（人工触发，数量可控）。
  if (!opts.accountIds) {
    const cap = opts.full ? MAX_FULL_PER_RUN : MAX_NEW_PER_RUN;
    if (targets.length > cap) targets = targets.slice(0, cap);
  }

  if (targets.length === 0) {
    return { scanned: 0, ok: 0, remediated: 0, pending: 0, unreachable: 0, skippedSuspended, details: [] };
  }

  console.log(`[AccountRoles] 检测 ${targets.length} 个账户（${opts.full ? '全量' : '增量'}）`);

  // 1) 探测
  const probed: { acct: any; support: boolean; admin: boolean }[] = [];
  await pool(targets, PROBE_CONCURRENCY, async (acct: any) => {
    const r = await probeAccountRoles(acct.Id);
    probed.push({ acct, ...r });
  });

  const needFix = probed.filter(p => !p.support || !p.admin);
  console.log(`[AccountRoles] 探测完成：正常 ${probed.length - needFix.length}，缺角色 ${needFix.length}`);

  // 2) 补齐 —— 按 payer + 角色种类分组批量部署
  const remediatedIds = new Set<string>();
  if (!opts.probeOnly && needFix.length > 0) {
    const groups = new Map<string, string[]>(); // `${payer}|${kind}` -> accountIds
    for (const p of needFix) {
      const payer = p.acct._payer;
      if (!payer) continue;
      // 敏感权限客户账户的角色由独立受限 StackSet 管理，
      // 走组织级 StackSet 补齐会把宽权限盖回去，直接跳过
      if (isRestricted(p.acct.Id)) continue;
      const rec = knownMap.get(p.acct.Id);
      // 超过尝试上限的不再补（全量复检会重置机会）
      if (!opts.full && (rec?.attempts || 0) >= MAX_ATTEMPTS) continue;
      if (!p.support) {
        const k = `${payer}|support`;
        groups.set(k, [...(groups.get(k) || []), p.acct.Id]);
      }
      if (!p.admin) {
        const k = `${payer}|admin`;
        groups.set(k, [...(groups.get(k) || []), p.acct.Id]);
      }
    }

    for (const [key, ids] of groups) {
      const [payer, kind] = key.split('|') as [string, RoleKind];
      console.log(`[AccountRoles] 补齐 ${payer} 的 ${kind}：${ids.length} 个账户`);
      const r = await deployToAccounts(payer, kind, ids);
      if (r.ok) {
        ids.forEach(id => remediatedIds.add(id));
        console.log(`[AccountRoles] ✅ ${payer}/${kind} 部署成功`);
      } else {
        console.log(`[AccountRoles] ⚠️ ${payer}/${kind} 部署未成功: ${r.error}`);
      }
    }
  }

  // 3) 复验被补齐过的账户
  const finalState = new Map<string, { support: boolean; admin: boolean }>();
  probed.forEach(p => finalState.set(p.acct.Id, { support: p.support, admin: p.admin }));
  const toReverify = probed.filter(p => remediatedIds.has(p.acct.Id));
  if (toReverify.length > 0) {
    await pool(toReverify, PROBE_CONCURRENCY, async (p: any) => {
      finalState.set(p.acct.Id, await probeAccountRoles(p.acct.Id));
    });
  }

  // 4) 写库
  const details: AccountRoleRecord[] = [];
  const nowIso = new Date().toISOString();
  let okN = 0, pendingN = 0, unreachableN = 0, remediatedN = 0;

  for (const p of probed) {
    const st = finalState.get(p.acct.Id)!;
    const prev = knownMap.get(p.acct.Id);
    const wasBroken = !p.support || !p.admin;
    const nowGood = st.support && st.admin;
    const fixed = wasBroken && nowGood;

    let state: AccountRoleRecord['state'];
    let attempts = prev?.attempts || 0;
    if (nowGood) {
      state = 'ok';
      attempts = 0;
    } else {
      attempts = wasBroken ? attempts + 1 : attempts;
      if (attempts >= MAX_ATTEMPTS) state = 'unreachable';
      else state = st.support || st.admin ? 'partial' : 'pending';
    }

    const rec: AccountRoleRecord = {
      account_id: p.acct.Id,
      account_name: p.acct.Name,
      payer: p.acct._payer,
      support: st.support,
      admin: st.admin,
      state,
      attempts,
      last_error: nowGood ? null : (prev?.last_error || null),
      checked_at: nowIso,
      remediated_at: fixed ? nowIso : (prev?.remediated_at || null),
    };
    details.push(rec);

    if (state === 'ok') okN++;
    else if (state === 'unreachable') unreachableN++;
    else pendingN++;
    if (fixed) remediatedN++;
  }

  db.upsertAccountRoles(details);

  console.log(`[AccountRoles] 完成：正常 ${okN}，已修复 ${remediatedN}，待重试 ${pendingN}，不可达 ${unreachableN}`);

  // 5) 告警 —— 只对本轮新变成 unreachable 的账户通知，避免重复刷屏
  try {
    const newlyUnreachable = details.filter(d => {
      if (d.state !== 'unreachable') return false;
      const prev = knownMap.get(d.account_id);
      return prev?.state !== 'unreachable';
    });
    if (newlyUnreachable.length > 0) {
      await notifyAccountRoleIssues(newlyUnreachable.map(d => ({
        accountId: d.account_id,
        accountName: d.account_name || d.account_id,
        payer: d.payer || '',
        support: d.support,
        admin: d.admin,
      })));
    }
  } catch (e: any) {
    console.error('[AccountRoles] 告警发送失败:', e.message);
  }

  return { scanned: probed.length, ok: okN, remediated: remediatedN, pending: pendingN, unreachable: unreachableN, skippedSuspended, details };
}

/** 汇总视图，供前端展示 */
export function getAccountRolesSummary() {
  const all = db.getAccountRoles();
  const byState: Record<string, number> = {};
  all.forEach(r => { byState[r.state] = (byState[r.state] || 0) + 1; });
  const problems = all
    .filter(r => r.state !== 'ok')
    .sort((a, b) => (a.payer || '').localeCompare(b.payer || ''));
  return {
    total: all.length,
    byState,
    problems,
    lastCheckedAt: all.reduce((max, r) => (r.checked_at > max ? r.checked_at : max), ''),
  };
}
