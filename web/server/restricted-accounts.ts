/**
 * 敏感权限客户账户 —— 按客户安全要求，对单个账户收窄平台权限并启用 ExternalId。
 *
 * 背景：默认下发的 support-quota 附带 ReadOnlyAccess 托管策略（2900+ action），
 * 有客户会审出来并要求收窄。收窄必须精确到账户级：同组织其他账户不应被牵连，
 * 平台自己的 StackSet 也不能把宽权限再盖回来。
 *
 * 隔离手段：
 *   1. 把该账户从组织级 StackSet(support-quota-role-orgwide) 的实例中移除，
 *      DeleteStackInstances 带 RetainStacks=true —— 只脱离管理、不删账户内角色，
 *      过程中平台访问不中断。
 *   2. 就地收窄 support-quota（配额查询 / 提额 / 提额进度 / Support 工单 / 区域状态查询），
 *      信任策略带 sts:ExternalId 条件，备份原策略用于取消标记时恢复。
 *   3. 删除该账户的 admin-console（StackSet 实例 RetainStacks=false；手工角色走 IAM 删除），
 *      删除后复验 AssumeRole 被拒。自愈（account-roles.ts）与组织脚本都不会补回。
 *   4. OrganizationAccountAccessRole 保留不动：Admin 临时凭证（≤1h）、Admin 控制台、区域开通经它执行。
 *      INVITED 账户本来没有 OAAR，收窄后平台只剩 support-quota（见 isSupportOnlyRestricted）。
 *   5. AutoDeployment 只在账户「加入 OU」时触发，已移除的实例不会被自动重建；
 *      但手工跑 scripts/setup-org-stacksets.ts 会重新覆盖，故该脚本必须读取
 *      本模块的排除名单。这是最容易漏的一环。
 *
 * 收窄后这些账户会失去资源清理扫描、IAM 安全状态展示等功能（查询类不自动回退 OAAR），
 * 属预期取舍，调用方应据 isRestricted() 给出明确提示而非裸 AccessDenied。
 */
import { randomBytes } from 'crypto';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { OrganizationsClient, ListRootsCommand } from '@aws-sdk/client-organizations';
import {
  CloudFormationClient, CreateStackInstancesCommand, DeleteStackInstancesCommand,
  DescribeStackSetOperationCommand, paginateListStackInstances, UpdateStackInstancesCommand,
} from '@aws-sdk/client-cloudformation';
import {
  IAMClient, DetachRolePolicyCommand, ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand, DeleteRolePolicyCommand, PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand, GetRoleCommand, GetRolePolicyCommand, DeleteRoleCommand,
  AttachRolePolicyCommand, paginateListAttachedRolePolicies, paginateListRolePolicies,
} from '@aws-sdk/client-iam';
import fs from 'fs';
import path from 'path';
import { db, encryptField, decryptField } from './db';

let CONFIG: any = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
} catch (e: any) {
  console.error('[Restricted] 读取 config.json 失败:', e.message);
}

const REGION: string = CONFIG.region || 'us-east-1';
const BASE_CREDENTIALS = {
  accessKeyId: CONFIG.credentials?.accessKeyId || '',
  secretAccessKey: CONFIG.credentials?.secretAccessKey || '',
};
const SUPPORT_ROLE: string = CONFIG.supportRoleName || 'support-quota';
const ADMIN_ROLE: string = CONFIG.adminRoleName || 'admin-console';
const PAYERS: { name: string; roleArn: string }[] = CONFIG.payers || [];

const ORG_STACKSET = 'support-quota-role-orgwide';
const ADMIN_STACKSET = 'admin-console-role-orgwide';
export const RESTRICTED_PREFIX = 'support-quota-role-restricted';

const RESTRICTED_INLINE_POLICY = 'SupportQuotaRestricted';

interface SupportPolicyBackup {
  managed: string[];
  inline: Record<string, string>;
}

// 兼容早期未保存策略备份的标记，与 setup-org-stacksets.ts 的默认策略一致。
const DEFAULT_SUPPORT_BACKUP: SupportPolicyBackup = {
  managed: ['arn:aws:iam::aws:policy/ReadOnlyAccess', 'arn:aws:iam::aws:policy/AWSSupportAccess'],
  inline: { SupportQuotaPerms: JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow', Resource: '*',
      Action: ['sts:GetCallerIdentity', 'ec2:Describe*', 'servicequotas:*', 'iam:GetAccountSummary',
        'iam:ListMFADevices', 'iam:ListUsers', 'iam:GenerateCredentialReport', 'iam:GetCredentialReport',
        's3:ListAllMyBuckets', 'lambda:ListFunctions', 'rds:Describe*', 'organizations:ListAccounts'],
    }, {
      Effect: 'Allow', Action: 'iam:CreateServiceLinkedRole', Resource: '*',
      Condition: { StringEquals: { 'iam:AWSServiceName': 'servicequotas.amazonaws.com' } },
    }],
  }) },
};

/**
 * 收窄后保留的权限：配额查询 / 提额 / 提额进度（Get*、List* 覆盖）、
 * Support 工单（提额文档自动回帖与附件上传需要，AWS 未完整公开 Support Center 依赖的 action，故给 support:*）、
 * 区域 opt-in 状态查询。
 */
const RESTRICTED_POLICY_DOC = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: [
        'servicequotas:Get*',
        'servicequotas:List*',
        'servicequotas:RequestServiceQuotaIncrease',
        'support:*',
        'account:GetRegionOptStatus',
        'account:ListRegions',
        'sts:GetCallerIdentity',
      ],
      Resource: '*',
    },
    {
      // 首次提额时 Service Quotas 需要创建自己的服务关联角色
      Effect: 'Allow',
      Action: 'iam:CreateServiceLinkedRole',
      Resource: '*',
      Condition: { StringEquals: { 'iam:AWSServiceName': 'servicequotas.amazonaws.com' } },
    },
  ],
};

/** 带 ExternalId 条件的信任策略 */
function trustPolicy(externalId: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: 'arn:aws:iam::509399618054:user/mark' },
        Action: 'sts:AssumeRole',
        Condition: { StringEquals: { 'sts:ExternalId': externalId } },
      },
    ],
  };
}

export interface RestrictedAccount {
  account_id: string;
  payer?: string;
  account_name?: string;
  external_id_enc?: string;      // 加密存储，不落明文
  state: 'pending' | 'applied' | 'failed';
  last_error?: string | null;
  marked_by?: string;
  marked_at: string;
  applied_at?: string | null;
  note?: string;
  support_policy_backup?: SupportPolicyBackup;
}

// ===== 查询 =====

export function getRestrictedAccounts(): RestrictedAccount[] {
  return db.getRestrictedAccounts();
}

/** 该账户是否受限（供业务处做优雅降级判断） */
export function isRestricted(accountId: string): boolean {
  return db.getRestrictedAccounts().some((r: any) => r.account_id === accountId);
}

/** 取该账户的 ExternalId 明文；未标记返回 undefined */
export function getExternalId(accountId: string): string | undefined {
  const rec = db.getRestrictedAccounts().find((r: any) => r.account_id === accountId);
  if (!rec?.external_id_enc) return undefined;
  try { return decryptField(rec.external_id_enc, 'external-id'); } catch { return undefined; }
}

/**
 * 组织级 StackSet 下发时必须排除的账户。
 *
 * 注意这里刻意不按 state 过滤：只要账户被标记过（记录尚未删除），就一律排除。
 * state=failed 表示收窄执行失败，但账户很可能已经从组织级 StackSet 摘除，
 * 若因 failed 而漏掉排除，下一次全量下发就会把宽权限重新盖回客户账户，
 * 直接违反对客户的承诺。取消标记走 unmarkRestricted()，会删除记录。
 */
export function getExcludedAccountIds(payerName?: string): string[] {
  return db.getRestrictedAccounts()
    .filter((r: any) => !payerName || r.payer === payerName)
    .map((r: any) => r.account_id);
}

/** 受限账户不可用的功能，供接口与前端给出明确原因 */
export const RESTRICTED_UNAVAILABLE = [
  'Admin 临时凭证超过 1 小时（admin-console 已移除，只能经 OrganizationAccountAccessRole 签发）',
  '资源清理扫描（需 ec2/rds/s3/lambda 的 Describe 与 List）',
  '账户详情的 IAM 安全状态（需 iam 的 List 与 Get）',
  'INVITED（邀请加入）账户没有 OrganizationAccountAccessRole：Admin 临时凭证、Admin 控制台、区域开通均不可用',
];

/**
 * 受限且为 INVITED 的账户：没有 OAAR，admin-console 又已删除，平台只剩 support-quota。
 * 调用方据此直接给出明确提示，不去尝试 AssumeRole。
 * joinedMethod 未传时从账户缓存读取（listAccounts 等已有 JoinedMethod 的场景应直接传入）。
 */
export function isSupportOnlyRestricted(accountId: string, joinedMethod?: string): boolean {
  if (!isRestricted(accountId)) return false;
  const method = joinedMethod
    ?? (db.getAccountsCache().accounts || []).find((a: any) => a.Id === accountId)?.JoinedMethod;
  return method === 'INVITED';
}

// ===== 内部工具 =====

async function assumePayer(payerName: string) {
  const p = PAYERS.find(x => x.name === payerName);
  if (!p) throw new Error(`payer ${payerName} 不在 config.payers`);
  const r = await new STSClient({ region: REGION, credentials: BASE_CREDENTIALS }).send(new AssumeRoleCommand({
    RoleArn: p.roleArn, RoleSessionName: 'awstool-restrict', DurationSeconds: 3600,
  }));
  const c = r.Credentials!;
  return { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! };
}

/**
 * 用 payer 管理员凭证二级跳进成员账户拿 admin。
 * 改 IAM 需要写权限，support-quota 自身（只读）改不了自己。
 */
async function assumeChildAdmin(payerCreds: any, accountId: string) {
  const childRole = CONFIG.childRoleName || 'OrganizationAccountAccessRole';
  const adminRole = CONFIG.adminRoleName || 'admin-console';
  const sts = new STSClient({ region: REGION, credentials: payerCreds });
  const errs: string[] = [];
  for (const role of [childRole, adminRole]) {
    try {
      const r = await sts.send(new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${accountId}:role/${role}`,
        RoleSessionName: 'awstool-restrict-iam',
        DurationSeconds: 3600,
      }));
      const c = r.Credentials!;
      return { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! };
    } catch (e: any) { errs.push(`${role}:${e?.name}`); }
  }
  // INVITED 账户没有 OAAR；组织模板的 admin-console 信任平台用户，未必信任 payer。
  try {
    const r = await new STSClient({ region: REGION, credentials: BASE_CREDENTIALS }).send(new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${accountId}:role/${adminRole}`,
      RoleSessionName: 'awstool-restrict-iam', DurationSeconds: 3600,
    }));
    const c = r.Credentials!;
    return { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! };
  } catch (e: any) { errs.push(`direct-${adminRole}:${e?.name}`); }
  throw new Error(`无法取得该账户管理员凭证（${errs.join(', ')}）`);
}

const isDenied = (e: any) => ['AccessDenied', 'AccessDeniedException'].includes(e?.name);
const isMissingRole = (e: any) => ['NoSuchEntity', 'NoSuchEntityException'].includes(e?.name);

async function rolePolicies(iam: IAMClient, roleName: string): Promise<SupportPolicyBackup> {
  const managed: string[] = [], inline: Record<string, string> = {};
  for await (const page of paginateListAttachedRolePolicies({ client: iam }, { RoleName: roleName })) {
    for (const p of page.AttachedPolicies || []) if (p.PolicyArn) managed.push(p.PolicyArn);
  }
  for await (const page of paginateListRolePolicies({ client: iam }, { RoleName: roleName })) {
    for (const name of page.PolicyNames || []) {
      const r = await iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: name }));
      if (!r.PolicyDocument) throw new Error(`无法读取策略 ${roleName}/${name}`);
      const doc: unknown = r.PolicyDocument;
      inline[name] = typeof doc === 'string' ? JSON.stringify(JSON.parse(decodeURIComponent(doc))) : JSON.stringify(doc);
    }
  }
  return { managed, inline };
}

async function stackAccounts(cf: CloudFormationClient, name: string): Promise<Set<string>> {
  const accounts = new Set<string>();
  try {
    for await (const page of paginateListStackInstances({ client: cf }, { StackSetName: name, CallAs: 'SELF' })) {
      for (const s of page.Summaries || []) if (s.Account && s.Region === REGION) accounts.add(s.Account);
    }
  } catch (e: any) {
    if (e?.name !== 'StackSetNotFoundException') throw e;
  }
  return accounts;
}

async function requireOperation(cf: CloudFormationClient, name: string, opId?: string) {
  if (!opId) throw new Error(`${name} 未返回操作 ID`);
  const status = await waitOp(cf, name, opId);
  if (status !== 'SUCCEEDED') throw new Error(`${name} 操作 ${status}`);
}

async function removeAdmin(cf: CloudFormationClient, rootId: string, accountId: string, iam: IAMClient) {
  const managedAccounts = await stackAccounts(cf, ADMIN_STACKSET);
  if (managedAccounts.has(accountId)) {
    const op = await cf.send(new DeleteStackInstancesCommand({
      StackSetName: ADMIN_STACKSET,
      DeploymentTargets: { OrganizationalUnitIds: [rootId], Accounts: [accountId], AccountFilterType: 'INTERSECTION' },
      Regions: [REGION], RetainStacks: false,
      OperationPreferences: { FailureTolerancePercentage: 0, MaxConcurrentPercentage: 100 }, CallAs: 'SELF',
    }));
    await requireOperation(cf, ADMIN_STACKSET, op.OperationId);
  } else {
    // 未由 StackSet 管理的角色也必须清理；不能把查询错误当成角色不存在。
    try {
      const policies = await rolePolicies(iam, ADMIN_ROLE);
      for (const arn of policies.managed) await iam.send(new DetachRolePolicyCommand({ RoleName: ADMIN_ROLE, PolicyArn: arn }));
      for (const name of Object.keys(policies.inline)) await iam.send(new DeleteRolePolicyCommand({ RoleName: ADMIN_ROLE, PolicyName: name }));
      await iam.send(new DeleteRoleCommand({ RoleName: ADMIN_ROLE }));
    } catch (e) { if (!isMissingRole(e)) throw e; }
  }

  // 删除完成仍需复验；IAM 传播延迟时短暂重试，网络错误不能被当作撤权成功。
  const sts = new STSClient({ region: REGION, credentials: BASE_CREDENTIALS });
  for (let i = 0; i < 6; i++) {
    try {
      await sts.send(new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${accountId}:role/${ADMIN_ROLE}`,
        RoleSessionName: 'verify-admin-removed', DurationSeconds: 900,
      }));
    } catch (e) { if (isDenied(e)) return; throw e; }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`收窄未完成：仍可 AssumeRole ${ADMIN_ROLE}`);
}

/** 复验：带 ExternalId 能进、不带进不去、且敏感权限已失效 */
async function verifyRestricted(accountId: string, externalId: string): Promise<{ ok: boolean; error?: string }> {
  const sts = new STSClient({ region: REGION, credentials: BASE_CREDENTIALS });
  const roleArn = `arn:aws:iam::${accountId}:role/${SUPPORT_ROLE}`;

  // IAM 是最终一致的，信任策略刚改需要等一会儿
  let creds: any = null;
  for (let i = 0; i < 6 && !creds; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const r = await sts.send(new AssumeRoleCommand({
        RoleArn: roleArn, RoleSessionName: 'verify-restricted', DurationSeconds: 900, ExternalId: externalId,
      }));
      creds = r.Credentials;
    } catch { /* 重试 */ }
  }
  if (!creds) return { ok: false, error: '带 ExternalId 仍无法 AssumeRole，请检查信任策略' };

  // 不带 ExternalId 必须被拒，否则条件没生效。
  // 旧信任策略（无条件）在 IAM 传播完成前仍可能放行 —— 上面带 ExternalId 的成功也可能是旧策略放行的，
  // 因此这里同样要轮询，不能一次放行就判失败（2026-10 生产曾因此把已收窄的 4 个账户误判为 failed）。
  let externalIdEnforced = false;
  for (let i = 0; i < 6 && !externalIdEnforced; i++) {
    try {
      await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: 'verify-noext', DurationSeconds: 900 }));
      await new Promise(r => setTimeout(r, 5000));
    } catch (e) {
      if (!isDenied(e)) throw e;
      externalIdEnforced = true;
    }
  }
  if (!externalIdEnforced) return { ok: false, error: 'ExternalId 条件未生效：不带 ExternalId 仍可 AssumeRole' };

  // 敏感权限必须已经失效（同样考虑策略传播延迟）
  const iam = new IAMClient({
    region: REGION,
    credentials: {
      accessKeyId: creds.AccessKeyId, secretAccessKey: creds.SecretAccessKey, sessionToken: creds.SessionToken,
    },
  });
  for (let i = 0; i < 6; i++) {
    try {
      await iam.send(new GetRoleCommand({ RoleName: SUPPORT_ROLE }));
      await new Promise(r => setTimeout(r, 5000));
    } catch (e) {
      if (!isDenied(e)) throw e;
      return { ok: true };
    }
  }
  return { ok: false, error: '收窄未生效：仍可调用 iam:GetRole' };
}

async function waitOp(cf: CloudFormationClient, stackSetName: string, opId: string, maxMin = 15) {
  const t0 = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 10000));
    try {
      const st = await cf.send(new DescribeStackSetOperationCommand({
        StackSetName: stackSetName, OperationId: opId, CallAs: 'SELF',
      }));
      const s = st.StackSetOperation?.Status || '';
      if (['SUCCEEDED', 'FAILED', 'STOPPED'].includes(s)) return s;
    } catch { return 'POLL-ERR'; }
    if (Date.now() - t0 > maxMin * 60 * 1000) return 'TIMEOUT';
  }
}

// ===== 主流程 =====

/**
 * 标记账户为敏感权限客户并执行收窄。幂等：重复调用不会重复创建。
 */
export async function markRestricted(
  accountIds: string[],
  opts: { markedBy?: string; note?: string; externalId?: string } = {},
): Promise<{ results: { accountId: string; ok: boolean; state: string; error?: string }[] }> {
  const { accounts } = db.getAccountsCache();
  const results: { accountId: string; ok: boolean; state: string; error?: string }[] = [];
  const now = new Date().toISOString();

  const byPayer = new Map<string, { id: string; name?: string }[]>();
  for (const id of accountIds) {
    const acct = (accounts || []).find((a: any) => a.Id === id);
    if (!acct?._payer) {
      results.push({ accountId: id, ok: false, state: 'failed', error: '账户不在缓存中或无组织归属，请先刷新账户列表' });
      continue;
    }
    byPayer.set(acct._payer, [...(byPayer.get(acct._payer) || []), { id, name: acct.Name }]);
  }

  for (const [payerName, items] of byPayer) {
    const ids = items.map(i => i.id);
    const idToExtId = new Map<string, string>();
    for (const id of ids) {
      idToExtId.set(id, opts.externalId || getExternalId(id) || randomBytes(24).toString('hex'));
    }

    // 写 pending 之前记下原记录：重复标记时据此保留首次标记时间，并避免把已收窄账户降级为 failed。
    // 必须复制快照 —— db 的记录对象可能被随后的 upsert 原地合并改写。
    const previousById = new Map<string, RestrictedAccount | undefined>(ids.map(id => {
      const rec = db.getRestrictedAccounts().find((r: any) => r.account_id === id);
      return [id, rec ? { ...rec } : undefined];
    }));

    // 先落 pending，中途失败也留痕迹
    db.upsertRestrictedAccounts(items.map(i => ({
      account_id: i.id,
      account_name: i.name,
      payer: payerName,
      external_id_enc: encryptField(idToExtId.get(i.id)!, 'external-id'),
      state: 'pending' as const,
      marked_by: opts.markedBy,
      marked_at: previousById.get(i.id)?.marked_at || now,
      note: opts.note,
      last_error: null,
    })));

    try {
      const creds = await assumePayer(payerName);
      const org = new OrganizationsClient({ region: REGION, credentials: creds });
      const rootId = (await org.send(new ListRootsCommand({}))).Roots![0].Id!;
      const cf = new CloudFormationClient({ region: REGION, credentials: creds });

      // 1) 从组织级 StackSet 摘除，保留账户内角色（不中断访问）
      const supportAccounts = await stackAccounts(cf, ORG_STACKSET);
      const toRemove = ids.filter(id => supportAccounts.has(id));

      if (toRemove.length) {
        const del = await cf.send(new DeleteStackInstancesCommand({
          StackSetName: ORG_STACKSET,
          DeploymentTargets: { OrganizationalUnitIds: [rootId], Accounts: toRemove, AccountFilterType: 'INTERSECTION' },
          Regions: [REGION],
          RetainStacks: true,   // 关键：保留已有角色，收窄生效前平台不断连
          OperationPreferences: { FailureTolerancePercentage: 0, MaxConcurrentPercentage: 100 },
          CallAs: 'SELF',
        }));
        await requireOperation(cf, ORG_STACKSET, del.OperationId);
        console.log(`[Restricted] ${payerName}: 从 ${ORG_STACKSET} 摘除 ${toRemove.length} 个实例`);
      }

      // 2) 就地改造已有角色（不能用 StackSet 部署同名角色 —— 上一步 RetainStacks=true
      //    保留了原角色，CloudFormation 创建同名 IAM Role 会报 already exists）。
      //    直接改 IAM 的好处是零断连、立即生效；角色此时已脱离 StackSet 管理，改它最自然。
      for (const id of ids) {
        try {
          const extId = idToExtId.get(id)!;
          // 用原（尚未收窄的）角色进去改自己 —— ReadOnlyAccess 不含 IAM 写权限，
          // 因此必须借 payer 的管理员凭证走二级跳
          let admin;
          try {
            admin = await assumeChildAdmin(creds, id);
          } catch (e: any) {
            const err: any = new Error(e?.message || '无法取得管理员凭证');
            err.name = e?.name || 'Error';
            err.code = 'NO_ADMIN_PATH';
            throw err;
          }
          const iam = new IAMClient({ region: REGION, credentials: admin });
          const policies = await rolePolicies(iam, SUPPORT_ROLE);
          // 首次修改前保存，重试不能用已经收窄的策略覆盖备份。
          if (!previousById.get(id)?.support_policy_backup) {
            const backup = Object.prototype.hasOwnProperty.call(policies.inline, RESTRICTED_INLINE_POLICY) ? DEFAULT_SUPPORT_BACKUP : policies;
            db.upsertRestrictedAccounts([{ account_id: id, support_policy_backup: backup }]);
          }

          // 2.1 摘掉两个托管策略（ReadOnlyAccess 才是真正的大口子）
          for (const arn of policies.managed) {
            await iam.send(new DetachRolePolicyCommand({ RoleName: SUPPORT_ROLE, PolicyArn: arn }));
            console.log(`[Restricted] ${id}: 摘除托管策略 ${arn.split('/').pop()}`);
          }

          // 2.2 删掉原宽内联策略，写入收窄版
          for (const name of Object.keys(policies.inline)) {
            if (name === RESTRICTED_INLINE_POLICY) continue;
            await iam.send(new DeleteRolePolicyCommand({ RoleName: SUPPORT_ROLE, PolicyName: name }));
            console.log(`[Restricted] ${id}: 删除内联策略 ${name}`);
          }
          await iam.send(new PutRolePolicyCommand({
            RoleName: SUPPORT_ROLE,
            PolicyName: RESTRICTED_INLINE_POLICY,
            PolicyDocument: JSON.stringify(RESTRICTED_POLICY_DOC),
          }));

          // 2.3 信任策略加 ExternalId 条件（放最后 —— 平台已支持传 ExternalId，此步生效即完成）
          await iam.send(new UpdateAssumeRolePolicyCommand({
            RoleName: SUPPORT_ROLE,
            PolicyDocument: JSON.stringify(trustPolicy(extId)),
          }));

          // 2.4 复验：必须带 ExternalId 才能进，且权限已收窄
          const verified = await verifyRestricted(id, extId);
          if (!verified.ok) throw new Error(verified.error || '复验未通过');

          // 3) 收窄 support 之后撤掉管理员角色，避免留下第二条高权限入口。
          await removeAdmin(cf, rootId, id, iam);

          db.upsertRestrictedAccounts([{
            account_id: id,
            state: 'applied' as const,
            applied_at: new Date().toISOString(),
            last_error: null,
          }]);
          results.push({ accountId: id, ok: true, state: 'applied' });
          console.log(`[Restricted] ${id}: 收窄完成并复验通过`);
        } catch (e: any) {
          const msg = `${e?.name}: ${String(e?.message || '').slice(0, 160)}`;
          if (e?.code === 'NO_ADMIN_PATH' && previousById.get(id)?.state === 'applied') {
            // INVITED 账户删除 admin-console 后平台已无管理员入口，重复标记进不去属预期；
            // 此时尚未改动任何 IAM，收窄仍然有效，不能降级为 failed。
            const keep = `无法取得管理员凭证，收窄状态保持不变（INVITED 账户删除 admin-console 后无管理员入口属预期）：${msg}`;
            db.upsertRestrictedAccounts([{ account_id: id, state: 'applied' as const, last_error: keep }]);
            results.push({ accountId: id, ok: false, state: 'applied', error: keep });
            console.warn(`[Restricted] ${id}: ${keep}`);
            continue;
          }
          db.upsertRestrictedAccounts([{ account_id: id, state: 'failed' as const, last_error: msg }]);
          results.push({ accountId: id, ok: false, state: 'failed', error: msg });
          console.error(`[Restricted] ${id}: ${msg}`);
        }
      }
    } catch (e: any) {
      const msg = `${e?.name}: ${String(e?.message || '').slice(0, 160)}`;
      db.upsertRestrictedAccounts(ids.map(id => ({ account_id: id, state: 'failed' as const, last_error: msg })));
      ids.forEach(id => results.push({ accountId: id, ok: false, state: 'failed', error: msg }));
      console.error(`[Restricted] ${payerName} 处理失败: ${msg}`);
    }
  }

  return { results };
}

/**
 * 取消标记：先恢复管理员入口和 support 权限，成功后才删除标记。
 */
export async function unmarkRestricted(accountId: string): Promise<{ ok: boolean; error?: string }> {
  const rec = db.getRestrictedAccounts().find((r: any) => r.account_id === accountId);
  if (!rec) return { ok: false, error: '该账户未被标记' };

  try {
    const creds = await assumePayer(rec.payer);
    const org = new OrganizationsClient({ region: REGION, credentials: creds });
    const rootId = (await org.send(new ListRootsCommand({}))).Roots![0].Id!;
    const cf = new CloudFormationClient({ region: REGION, credentials: creds });
    const adminOnlyExcluded = (CONFIG.adminRoleExcludedAccounts || []).some((r: any) => r.accountId === accountId);
    if (!adminOnlyExcluded) {
      // INVITED 账户可能只能通过 admin-console 管理，必须先由 payer 恢复此角色。
      const existing = await stackAccounts(cf, ADMIN_STACKSET);
      const input = {
        StackSetName: ADMIN_STACKSET,
        DeploymentTargets: { OrganizationalUnitIds: [rootId], Accounts: [accountId], AccountFilterType: 'INTERSECTION' as const },
        Regions: [REGION], CallAs: 'SELF' as const,
        OperationPreferences: { FailureTolerancePercentage: 0, MaxConcurrentPercentage: 100 },
      };
      const op = await cf.send(existing.has(accountId)
        ? new UpdateStackInstancesCommand(input) : new CreateStackInstancesCommand(input));
      await requireOperation(cf, ADMIN_STACKSET, op.OperationId);
    }

    // 角色是就地改造的（非 StackSet 管理），恢复也走 IAM：
    // 原 support 堆栈保留在账户内，直接恢复备份，避免同名 IAM Role 冲突。
    const admin = await assumeChildAdmin(creds, accountId);
    const iam = new IAMClient({ region: REGION, credentials: admin });
    const backup: SupportPolicyBackup = rec.support_policy_backup || DEFAULT_SUPPORT_BACKUP;
    for (const arn of backup.managed) {
      await iam.send(new AttachRolePolicyCommand({ RoleName: SUPPORT_ROLE, PolicyArn: arn }));
    }
    for (const [name, document] of Object.entries(backup.inline)) {
      await iam.send(new PutRolePolicyCommand({ RoleName: SUPPORT_ROLE, PolicyName: name, PolicyDocument: document }));
    }

    await iam.send(new UpdateAssumeRolePolicyCommand({
      RoleName: SUPPORT_ROLE,
      PolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { AWS: 'arn:aws:iam::509399618054:user/mark' },
          Action: 'sts:AssumeRole',
        }],
      }),
    }));
    try {
      await iam.send(new DeleteRolePolicyCommand({ RoleName: SUPPORT_ROLE, PolicyName: RESTRICTED_INLINE_POLICY }));
    } catch (e) { if (!isMissingRole(e)) throw e; }

    db.deleteRestrictedAccount(accountId);
    console.log(`[Restricted] ${accountId}: 已取消标记，恢复默认权限`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `${e?.name}: ${String(e?.message || '').slice(0, 160)}` };
  }
}
