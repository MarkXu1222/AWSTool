/**
 * 临时 admin-console —— 没有 OrganizationAccountAccessRole 的成员账户按需开通 1–3 小时管理员角色，到期自动删除。
 *
 * 背景：admin-console（AdministratorAccess）曾由各组织的 admin-console-role-orgwide StackSet 常驻下发到
 * 每个成员账户（含未来新账户）。现改为默认不存在：
 *   - 有 OAAR 的账户一律经 payer role/tool → OAAR 取 Admin（角色链，≤1 小时）
 *   - 没有 OAAR 的账户（通常是邀请加入的）由管理员针对单个账户临时开通，到期由平台从 payer 侧删除实例
 *
 * 为什么只能走 StackSet：这类账户平台没有任何写权限入口，无法直接 CreateRole；
 * 唯一的路是 payer 用 SERVICE_MANAGED StackSet 往账户里部署。每个 payer 一个专用 StackSet
 * admin-console-role-temporary，AutoDeployment 永远关闭，平时 0 个实例。
 *
 * 状态机：provisioning → active → revoking → revoked；开通失败若已请求过实例进 revoking（交给 sweeper 删），
 * 否则 failed。回收只认 AssumeRole 返回 AccessDenied 为「已删除」，网络错误不算成功。
 *
 * ⚠️ 不得 import aws-service / restricted-accounts / account-roles：它们都要依赖本模块（循环依赖）。
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { OrganizationsClient, ListRootsCommand } from '@aws-sdk/client-organizations';
import {
  CloudFormationClient, DescribeStackSetCommand, CreateStackSetCommand, CreateStackInstancesCommand,
  DeleteStackInstancesCommand, ListStackInstancesCommand, DescribeStackSetOperationCommand,
} from '@aws-sdk/client-cloudformation';
import { db, type TempAdminGrant, type TempAdminGrantReason } from './db';
import { sendNotification } from './notify';

let CONFIG: any = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
} catch (e: any) {
  console.error('[TempAdmin] 读取 config.json 失败:', e.message);
}

const REGION: string = CONFIG.region || 'us-east-1';
const BASE_CREDENTIALS = {
  accessKeyId: CONFIG.credentials?.accessKeyId || '',
  secretAccessKey: CONFIG.credentials?.secretAccessKey || '',
};
const PAYERS: { name: string; roleArn: string }[] = CONFIG.payers || [];
const ADMIN_ROLE: string = CONFIG.adminRoleName || 'admin-console';
const CHILD_ROLE: string = CONFIG.childRoleName || 'OrganizationAccountAccessRole';

export const TEMP_ADMIN_STACKSET = 'admin-console-role-temporary';
export const TEMP_ADMIN_HOURS = [1, 2, 3] as const;
export const TEMP_ADMIN_MAX_SESSION_SECONDS = 10800;
const TRUST_PRINCIPAL = 'arn:aws:iam::509399618054:user/mark';

const OPERATION_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 5_000;
// IAM 最终一致：与受限账户复验同一经验值（36 × 5 秒，约 3 分钟）
const VERIFY_MAX_ATTEMPTS = 36;
const ALERT_AFTER_ATTEMPTS = 3;

const TEMP_ADMIN_TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Description: AWSTool temporary admin-console role (per-account, time-boxed, deleted on expiry)
Resources:
  AdminConsoleRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ${ADMIN_ROLE}
      MaxSessionDuration: ${TEMP_ADMIN_MAX_SESSION_SECONDS}
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS:
                - ${TRUST_PRINCIPAL}
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/AdministratorAccess
      Tags:
        - Key: Purpose
          Value: TemporaryAdmin
        - Key: ManagedBy
          Value: AWSTool
`;

export class TempAdminError extends Error {
  constructor(message: string, public readonly statusCode: 400 | 404 | 409 | 503) {
    super(message);
    this.name = 'TempAdminError';
  }
}

/** 成员账户既无 OAAR 也无有效开通时由 Admin 链路抛出，路由映射为 409 + code */
export class TempAdminRequiredError extends Error {
  readonly code = 'TEMP_ADMIN_REQUIRED';
  constructor(accountId: string) {
    super(`账户 ${accountId} 无法经 OrganizationAccountAccessRole 进入（通常是邀请加入的账户）。请管理员在账户页「临时开通 Admin」后重试`);
    this.name = 'TempAdminRequiredError';
  }
}

// 只取 accountId 集合；格式校验由 aws-service 启动时负责
let adminExcluded = new Set<string>(
  (Array.isArray(CONFIG.adminRoleExcludedAccounts) ? CONFIG.adminRoleExcludedAccounts : [])
    .map((item: any) => String(item?.accountId || '')).filter(Boolean),
);
let notifier: (title: string, content: string) => Promise<unknown> = sendNotification;

const OPEN_STATUSES = new Set(['provisioning', 'active', 'revoking']);
const isOpen = (g: TempAdminGrant) => OPEN_STATUSES.has(g.status);
const errMsg = (e: any) => e?.message || String(e);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const isDenied = (e: any) => ['AccessDenied', 'AccessDeniedException'].includes(e?.name);
const isStackSetMissing = (e: any) => e?.name === 'StackSetNotFoundException';

// ===== 查询 =====

export function getActiveGrant(accountId: string, now = Date.now()): TempAdminGrant | null {
  return db.listTempAdminGrants().find(g =>
    g.accountId === accountId && g.status === 'active' && !!g.expiresAt && Date.parse(g.expiresAt) > now) || null;
}

export function remainingSeconds(grant: TempAdminGrant, now = Date.now()): number {
  if (!grant.expiresAt) return 0;
  return Math.max(0, Math.floor((Date.parse(grant.expiresAt) - now) / 1000));
}

export function listOpenGrants(): TempAdminGrant[] {
  return db.listTempAdminGrants().filter(isOpen);
}

// ===== AWS 工具 =====

/** 同一 StackSet 并发操作会 OperationInProgressException，按 payer 串行 */
const payerLocks = new Map<string, Promise<unknown>>();
function withPayerLock<T>(payer: string, fn: () => Promise<T>): Promise<T> {
  const prev = payerLocks.get(payer) || Promise.resolve();
  const run = prev.then(fn, fn);
  payerLocks.set(payer, run.then(() => undefined, () => undefined));
  return run;
}

async function assumePayer(payerName: string) {
  const payer = PAYERS.find(p => p.name === payerName);
  if (!payer) throw new Error(`payer ${payerName} 不在平台配置中`);
  const sts = new STSClient({ region: REGION, credentials: BASE_CREDENTIALS });
  try {
    const r = await sts.send(new AssumeRoleCommand({
      RoleArn: payer.roleArn, RoleSessionName: 'awstool-temp-admin', DurationSeconds: 3600,
    }));
    const c = r.Credentials!;
    return { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! };
  } finally { sts.destroy(); }
}

async function rootOuId(creds: any): Promise<string> {
  const org = new OrganizationsClient({ region: REGION, credentials: creds });
  try {
    const id = (await org.send(new ListRootsCommand({}))).Roots?.[0]?.Id;
    if (!id) throw new Error('未取到组织根 OU');
    return id;
  } finally { org.destroy(); }
}

async function waitOperation(cf: CloudFormationClient, opId: string | undefined, maxMs = OPERATION_TIMEOUT_MS) {
  if (!opId) throw new Error(`${TEMP_ADMIN_STACKSET} 未返回操作 ID`);
  for (let i = 0; i < Math.ceil(maxMs / POLL_MS); i++) {
    const op = (await cf.send(new DescribeStackSetOperationCommand({
      StackSetName: TEMP_ADMIN_STACKSET, OperationId: opId, CallAs: 'SELF',
    }))).StackSetOperation;
    if (op?.Status === 'SUCCEEDED') return;
    if (op?.Status === 'FAILED' || op?.Status === 'STOPPED') {
      throw new Error(`StackSet 操作 ${op.Status}${op.StatusReason ? `：${op.StatusReason}` : ''}`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`StackSet 操作 ${Math.round(maxMs / 60_000)} 分钟内未完成`);
}

async function probeOaar(payerCreds: any, accountId: string): Promise<'yes' | 'no' | 'unknown'> {
  const sts = new STSClient({ region: REGION, credentials: payerCreds });
  try {
    await sts.send(new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${accountId}:role/${CHILD_ROLE}`,
      RoleSessionName: 'awstool-oaar-probe', DurationSeconds: 900,
    }));
    return 'yes';
  } catch (e) {
    return isDenied(e) ? 'no' : 'unknown';
  } finally { sts.destroy(); }
}

/** expect=true：等到能 AssumeRole；expect=false：等到 AccessDenied（其它错误立即抛出，不能当作已删除） */
async function waitAssumable(accountId: string, expect: boolean) {
  const sts = new STSClient({ region: REGION, credentials: BASE_CREDENTIALS });
  try {
    for (let i = 0; i < VERIFY_MAX_ATTEMPTS; i++) {
      try {
        await sts.send(new AssumeRoleCommand({
          RoleArn: `arn:aws:iam::${accountId}:role/${ADMIN_ROLE}`,
          RoleSessionName: expect ? 'awstool-temp-admin-verify' : 'awstool-temp-admin-revoked', DurationSeconds: 900,
        }));
        if (expect) return;
      } catch (e) {
        if (!isDenied(e)) throw e;
        if (!expect) return;
      }
      await sleep(POLL_MS);
    }
    throw new Error(expect ? `${ADMIN_ROLE} 部署后仍无法 AssumeRole` : `${ADMIN_ROLE} 删除后仍可 AssumeRole`);
  } finally { sts.destroy(); }
}

function instanceTargets(rootId: string, accountId: string) {
  return { OrganizationalUnitIds: [rootId], Accounts: [accountId], AccountFilterType: 'INTERSECTION' as const };
}

// ===== 开通 =====

export async function openTempAdmin(input: {
  accountId: string;
  hours: number;
  requestedBy: { id: number | string | null; username: string };
  reason?: TempAdminGrantReason;
  bypassRestricted?: boolean;
}): Promise<TempAdminGrant> {
  const { accountId, hours } = input;
  if (!(TEMP_ADMIN_HOURS as readonly number[]).includes(hours)) {
    throw new TempAdminError('临时 Admin 时长只能是 1、2、3 小时', 400);
  }
  if (!/^\d{12}$/.test(accountId)) throw new TempAdminError('无效的账户 ID', 400);

  const acct = (db.getAccountsCache().accounts || []).find((a: any) => a.Id === accountId);
  if (!acct?._payer) throw new TempAdminError('账户不在缓存中或无组织归属，请先刷新账户列表', 404);
  const isPayerAccount = acct._isPayer
    || PAYERS.some(p => /arn:aws:iam::(\d+):role\//.exec(p.roleArn)?.[1] === accountId);
  if (isPayerAccount) throw new TempAdminError('payer 管理账户经 role/tool 管理，无需临时开通', 409);
  if (adminExcluded.has(accountId)) throw new TempAdminError('该账户已配置为仅保留 support-quota，不提供 Admin', 409);
  const restricted = db.getRestrictedAccounts().some((r: any) => r.account_id === accountId);
  if (restricted && !input.bypassRestricted) throw new TempAdminError('该账户为敏感权限客户账户，不提供临时 Admin', 409);
  const existing = db.listTempAdminGrants().find(g => g.accountId === accountId && isOpen(g));
  if (existing) {
    throw new TempAdminError(`该账户已有临时 Admin（${existing.status}${existing.expiresAt ? `，到期 ${existing.expiresAt}` : ''}）`, 409);
  }
  const payer: string = acct._payer;

  let payerCreds: any;
  try { payerCreds = await assumePayer(payer); }
  catch (e) { throw new TempAdminError(`无法以 payer ${payer} 管理身份操作：${errMsg(e)}`, 503); }
  const oaar = await probeOaar(payerCreds, accountId);
  if (oaar === 'yes') throw new TempAdminError('该账户可经 OrganizationAccountAccessRole 获得 Admin，无需临时开通', 409);
  if (oaar === 'unknown') throw new TempAdminError('暂时无法确认 OAAR 状态，请稍后重试', 503);

  const grant: TempAdminGrant = {
    id: randomUUID(),
    accountId,
    accountName: acct.Name,
    payer,
    hours: hours as 1 | 2 | 3,
    reason: input.reason || 'manual',
    status: 'provisioning',
    requestedBy: input.requestedBy.username,
    requestedByUserId: input.requestedBy.id,
    createdAt: new Date().toISOString(),
    instanceRequested: false,
    revokeAttempts: 0,
  };
  db.insertTempAdminGrant(grant);

  try {
    await withPayerLock(payer, async () => {
      const cf = new CloudFormationClient({ region: REGION, credentials: payerCreds });
      try {
        let autoDeploy = false;
        try {
          const set = (await cf.send(new DescribeStackSetCommand({ StackSetName: TEMP_ADMIN_STACKSET, CallAs: 'SELF' }))).StackSet;
          autoDeploy = set?.AutoDeployment?.Enabled === true;
        } catch (e) {
          if (!isStackSetMissing(e)) throw e;
          await cf.send(new CreateStackSetCommand({
            StackSetName: TEMP_ADMIN_STACKSET,
            Description: 'AWSTool temporary admin-console (per-account, time-boxed; deleted on expiry)',
            TemplateBody: TEMP_ADMIN_TEMPLATE,
            PermissionModel: 'SERVICE_MANAGED',
            AutoDeployment: { Enabled: false },
            ManagedExecution: { Active: true },
            Capabilities: ['CAPABILITY_NAMED_IAM'],
            CallAs: 'SELF',
            Tags: [{ Key: 'ManagedBy', Value: 'AWSTool' }, { Key: 'Purpose', Value: 'TemporaryAdmin' }],
          }));
        }
        // 自动部署一旦被打开，新账户都会常驻 admin-console —— 正是本模块要杜绝的
        if (autoDeploy) throw new Error(`${TEMP_ADMIN_STACKSET} 的 AutoDeployment 被开启，拒绝开通，请人工检查`);

        const rootId = await rootOuId(payerCreds);
        db.updateTempAdminGrant(grant.id, { instanceRequested: true });
        grant.instanceRequested = true;
        const op = await cf.send(new CreateStackInstancesCommand({
          StackSetName: TEMP_ADMIN_STACKSET,
          DeploymentTargets: instanceTargets(rootId, accountId),
          Regions: [REGION],
          OperationPreferences: { FailureTolerancePercentage: 0, MaxConcurrentPercentage: 100 },
          CallAs: 'SELF',
        }));
        await waitOperation(cf, op.OperationId);
      } finally { cf.destroy(); }
    });
    await waitAssumable(accountId, true);
  } catch (e) {
    const nowIso = new Date().toISOString();
    db.updateTempAdminGrant(grant.id, grant.instanceRequested
      ? { status: 'revoking', nextRevokeAt: nowIso, lastError: errMsg(e) }
      : { status: 'failed', lastError: errMsg(e) });
    throw new TempAdminError(`临时开通失败：${errMsg(e)}`, 503);
  }

  const activatedAt = Date.now();
  return db.updateTempAdminGrant(grant.id, {
    status: 'active',
    activatedAt: new Date(activatedAt).toISOString(),
    expiresAt: new Date(activatedAt + hours * 3600_000).toISOString(),
  });
}

// ===== 回收 =====

function backoffMs(attempts: number): number {
  return Math.min(2 ** (attempts - 1) * 60_000, 30 * 60_000);
}

async function runRevoke(grant: TempAdminGrant, by: string, now = Date.now()): Promise<TempAdminGrant> {
  db.updateTempAdminGrant(grant.id, {
    status: 'revoking',
    revokeRequestedAt: grant.revokeRequestedAt || new Date(now).toISOString(),
    revokedBy: by,
  });
  try {
    await withPayerLock(grant.payer, async () => {
      const creds = await assumePayer(grant.payer);
      const cf = new CloudFormationClient({ region: REGION, credentials: creds });
      try {
        let hasInstance = false;
        try {
          const list = await cf.send(new ListStackInstancesCommand({
            StackSetName: TEMP_ADMIN_STACKSET, StackInstanceAccount: grant.accountId, CallAs: 'SELF',
          }));
          hasInstance = (list.Summaries || []).some(s => s.Account === grant.accountId);
        } catch (e) { if (!isStackSetMissing(e)) throw e; }
        if (hasInstance) {
          const op = await cf.send(new DeleteStackInstancesCommand({
            StackSetName: TEMP_ADMIN_STACKSET,
            DeploymentTargets: instanceTargets(await rootOuId(creds), grant.accountId),
            Regions: [REGION],
            RetainStacks: false,
            OperationPreferences: { FailureTolerancePercentage: 0, MaxConcurrentPercentage: 100 },
            CallAs: 'SELF',
          }));
          await waitOperation(cf, op.OperationId);
        }
      } finally { cf.destroy(); }
    });
    await waitAssumable(grant.accountId, false);
  } catch (e) {
    const attempts = (db.listTempAdminGrants().find(g => g.id === grant.id)?.revokeAttempts || 0) + 1;
    const updated = db.updateTempAdminGrant(grant.id, {
      revokeAttempts: attempts,
      nextRevokeAt: new Date(now + backoffMs(attempts)).toISOString(),
      lastError: errMsg(e),
    });
    if (attempts >= ALERT_AFTER_ATTEMPTS && !updated.alertedAt) {
      db.updateTempAdminGrant(grant.id, { alertedAt: new Date(now).toISOString() });
      notifier('临时 Admin 回收失败',
        `账户 ${grant.accountId}（${grant.accountName || '-'}，payer ${grant.payer}）的临时 admin-console 已连续 ${attempts} 次未能删除。`
        + `\n到期时间：${grant.expiresAt || '-'}\n最近错误：${errMsg(e)}\n平台会继续重试，请人工确认该账户的 ${TEMP_ADMIN_STACKSET} 实例。`)
        .catch(err => console.error('[TempAdmin] 告警发送失败:', errMsg(err)));
    }
    throw e;
  }
  return db.updateTempAdminGrant(grant.id, {
    status: 'revoked', revokedAt: new Date().toISOString(), nextRevokeAt: undefined, lastError: undefined,
  });
}

export async function revokeTempAdmin(accountId: string, by: string): Promise<TempAdminGrant | null> {
  const grant = db.listTempAdminGrants().find(g => g.accountId === accountId && isOpen(g));
  if (!grant) return null;
  if (grant.status === 'provisioning') throw new TempAdminError('开通进行中，请稍后再关闭', 409);
  try {
    return await runRevoke(grant, by);
  } catch (e) {
    throw new TempAdminError(`临时 Admin 回收失败：${errMsg(e)}（平台会继续自动重试）`, 503);
  }
}

let sweeping = false;

/** 调度器每 60 秒调用：回收到期的 active，重试到点的 revoking */
export async function sweepTempAdminGrants(now = Date.now()): Promise<{ revoked: number; failed: number }> {
  if (sweeping) return { revoked: 0, failed: 0 };
  sweeping = true;
  let revoked = 0, failed = 0;
  try {
    const due = db.listTempAdminGrants().filter(g =>
      (g.status === 'active' && !!g.expiresAt && Date.parse(g.expiresAt) <= now)
      || (g.status === 'revoking' && (!g.nextRevokeAt || Date.parse(g.nextRevokeAt) <= now)));
    for (const g of due) {
      const by = g.status === 'active' ? 'system:expiry' : (g.revokedBy || 'system:expiry');
      try {
        await runRevoke(g, by, now);
        revoked++;
        db.addAuditLog(null, 'TEMP_ADMIN_REVOKE',
          `AWS 账户 ${g.accountId} · 临时 Admin 已回收（${by}，开通人 ${g.requestedBy}）`, 'system', undefined);
      } catch (e) {
        failed++;
        db.addAuditLog(null, 'TEMP_ADMIN_REVOKE_FAILED',
          `AWS 账户 ${g.accountId} · 临时 Admin 回收失败：${errMsg(e)}`, 'system', undefined);
      }
    }
  } finally { sweeping = false; }
  return { revoked, failed };
}

/** 服务启动时调用：开通过程中被中断的记录无法确认实例状态，一律交给 sweeper 回收 */
export function recoverTempAdminGrantsOnStartup(): number {
  const stuck = db.listTempAdminGrants().filter(g => g.status === 'provisioning');
  const nowIso = new Date().toISOString();
  for (const g of stuck) {
    db.updateTempAdminGrant(g.id, { status: 'revoking', nextRevokeAt: nowIso, lastError: '开通过程中服务重启，自动回收' });
  }
  return stuck.length;
}

/** 仅供测试 */
export const __test__ = {
  TEMPLATE: TEMP_ADMIN_TEMPLATE,
  backoffMs,
  resetLocks() { payerLocks.clear(); sweeping = false; },
  setNotifier(fn: (title: string, content: string) => Promise<unknown>) { notifier = fn; },
  setAdminExcluded(ids: string[]) { adminExcluded = new Set(ids); },
};
