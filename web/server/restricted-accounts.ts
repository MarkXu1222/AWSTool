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
 *   2. 为该账户建独立 StackSet 部署收窄版角色，信任策略带 sts:ExternalId 条件。
 *      每账户一套 ExternalId，一个泄露不牵连其它账户。
 *   3. AutoDeployment 只在账户「加入 OU」时触发，已移除的实例不会被自动重建；
 *      但手工跑 scripts/setup-org-stacksets.ts 会重新覆盖，故该脚本必须读取
 *      本模块的排除名单。这是最容易漏的一环。
 *
 * 收窄后这些账户会失去账单分析、资源清理扫描、IAM 安全状态展示等功能，
 * 属预期取舍，调用方应据 isRestricted() 给出明确提示而非裸 AccessDenied。
 */
import { randomBytes } from 'crypto';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { OrganizationsClient, ListRootsCommand } from '@aws-sdk/client-organizations';
import {
  CloudFormationClient, CreateStackInstancesCommand, DeleteStackInstancesCommand,
  DescribeStackSetOperationCommand, ListStackInstancesCommand, DeleteStackSetCommand,
} from '@aws-sdk/client-cloudformation';
import {
  IAMClient, DetachRolePolicyCommand, ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand, DeleteRolePolicyCommand, PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand, GetRoleCommand,
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
const PAYERS: { name: string; roleArn: string }[] = CONFIG.payers || [];

const ORG_STACKSET = 'support-quota-role-orgwide';
export const RESTRICTED_PREFIX = 'support-quota-role-restricted';

const RESTRICTED_INLINE_POLICY = 'SupportQuotaRestricted';

/** 收窄后保留的权限 —— 只够查配额与区域 opt-in 状态 */
const RESTRICTED_POLICY_DOC = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: [
        'servicequotas:Get*',
        'servicequotas:List*',
        'account:GetRegionOptStatus',
        'account:ListRegions',
        'sts:GetCallerIdentity',
      ],
      Resource: '*',
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
}

// ===== 查询 =====

export function getRestrictedAccounts(): RestrictedAccount[] {
  return db.getRestrictedAccounts();
}

/** 该账户是否受限（供业务处做优雅降级判断） */
export function isRestricted(accountId: string): boolean {
  return db.getRestrictedAccounts().some((r: any) => r.account_id === accountId && r.state !== 'failed');
}

/** 取该账户的 ExternalId 明文；未标记返回 undefined */
export function getExternalId(accountId: string): string | undefined {
  const rec = db.getRestrictedAccounts().find((r: any) => r.account_id === accountId);
  if (!rec?.external_id_enc) return undefined;
  try { return decryptField(rec.external_id_enc); } catch { return undefined; }
}

/** 组织级 StackSet 下发时必须排除的账户 */
export function getExcludedAccountIds(payerName?: string): string[] {
  return db.getRestrictedAccounts()
    .filter((r: any) => r.state !== 'failed' && (!payerName || r.payer === payerName))
    .map((r: any) => r.account_id);
}

/** 受限账户不可用的功能，供接口与前端给出明确原因 */
export const RESTRICTED_UNAVAILABLE = [
  '账单成本分析（需 ce:GetCostAndUsage）',
  '资源清理扫描（需 ec2/rds/s3/lambda 的 Describe 与 List）',
  '账户详情的 IAM 安全状态（需 iam 的 List 与 Get）',
];

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
  throw new Error(`无法取得该账户管理员凭证（${errs.join(', ')}）`);
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

  // 不带 ExternalId 必须被拒，否则条件没生效
  try {
    await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: 'verify-noext', DurationSeconds: 900 }));
    return { ok: false, error: 'ExternalId 条件未生效：不带 ExternalId 仍可 AssumeRole' };
  } catch { /* 预期被拒 */ }

  // 敏感权限必须已经失效
  try {
    const iam = new IAMClient({
      region: REGION,
      credentials: {
        accessKeyId: creds.AccessKeyId, secretAccessKey: creds.SecretAccessKey, sessionToken: creds.SessionToken,
      },
    });
    await iam.send(new GetRoleCommand({ RoleName: SUPPORT_ROLE }));
    return { ok: false, error: '收窄未生效：仍可调用 iam:GetRole' };
  } catch { /* 预期被拒 */ }

  return { ok: true };
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

    // 先落 pending，中途失败也留痕迹
    db.upsertRestrictedAccounts(items.map(i => ({
      account_id: i.id,
      account_name: i.name,
      payer: payerName,
      external_id_enc: encryptField(idToExtId.get(i.id)!),
      state: 'pending' as const,
      marked_by: opts.markedBy,
      marked_at: now,
      note: opts.note,
      last_error: null,
    })));

    try {
      const creds = await assumePayer(payerName);
      const org = new OrganizationsClient({ region: REGION, credentials: creds });
      const rootId = (await org.send(new ListRootsCommand({}))).Roots![0].Id!;
      const cf = new CloudFormationClient({ region: REGION, credentials: creds });

      // 1) 从组织级 StackSet 摘除，保留账户内角色（不中断访问）
      let toRemove: string[] = [];
      try {
        const inst: any[] = [];
        let t: string | undefined;
        do {
          const r = await cf.send(new ListStackInstancesCommand({ StackSetName: ORG_STACKSET, CallAs: 'SELF', NextToken: t, MaxResults: 100 }));
          inst.push(...(r.Summaries || [])); t = r.NextToken;
        } while (t);
        toRemove = inst.filter(s => ids.includes(s.Account)).map(s => s.Account);
      } catch { /* 组织级 StackSet 不存在则无需摘除 */ }

      if (toRemove.length) {
        const del = await cf.send(new DeleteStackInstancesCommand({
          StackSetName: ORG_STACKSET,
          DeploymentTargets: { OrganizationalUnitIds: [rootId], Accounts: toRemove, AccountFilterType: 'INTERSECTION' },
          Regions: [REGION],
          RetainStacks: true,   // 关键：保留已有角色，收窄生效前平台不断连
          OperationPreferences: { FailureTolerancePercentage: 0, MaxConcurrentPercentage: 100 },
          CallAs: 'SELF',
        }));
        const s = await waitOp(cf, ORG_STACKSET, del.OperationId!);
        console.log(`[Restricted] ${payerName}: 从 ${ORG_STACKSET} 摘除 ${toRemove.length} 个实例 → ${s}`);
      }

      // 2) 就地改造已有角色（不能用 StackSet 部署同名角色 —— 上一步 RetainStacks=true
      //    保留了原角色，CloudFormation 创建同名 IAM Role 会报 already exists）。
      //    直接改 IAM 的好处是零断连、立即生效；角色此时已脱离 StackSet 管理，改它最自然。
      for (const id of ids) {
        try {
          const extId = idToExtId.get(id)!;
          // 用原（尚未收窄的）角色进去改自己 —— ReadOnlyAccess 不含 IAM 写权限，
          // 因此必须借 payer 的管理员凭证走二级跳
          const admin = await assumeChildAdmin(creds, id);
          const iam = new IAMClient({ region: REGION, credentials: admin });

          // 2.1 摘掉两个托管策略（ReadOnlyAccess 才是真正的大口子）
          const att = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: SUPPORT_ROLE }));
          for (const pol of att.AttachedPolicies || []) {
            await iam.send(new DetachRolePolicyCommand({ RoleName: SUPPORT_ROLE, PolicyArn: pol.PolicyArn! }));
            console.log(`[Restricted] ${id}: 摘除托管策略 ${pol.PolicyArn!.split('/').pop()}`);
          }

          // 2.2 删掉原宽内联策略，写入收窄版
          const inl = await iam.send(new ListRolePoliciesCommand({ RoleName: SUPPORT_ROLE }));
          for (const name of inl.PolicyNames || []) {
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

          db.upsertRestrictedAccounts([{
            account_id: id,
            state: 'applied' as const,
            applied_at: new Date().toISOString(),
            last_error: null,
          }]);
          results.push({ accountId: id, ok: true, state: 'applied' });
          console.log(`[Restricted] ${id}: ✅ 收窄完成并复验通过`);
        } catch (e: any) {
          const msg = `${e?.name}: ${String(e?.message || '').slice(0, 160)}`;
          db.upsertRestrictedAccounts([{ account_id: id, state: 'failed' as const, last_error: msg }]);
          results.push({ accountId: id, ok: false, state: 'failed', error: msg });
          console.error(`[Restricted] ${id}: ❌ ${msg}`);
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
 * 取消标记：先把默认权限角色装回去，再删受限角色。
 * 顺序反了会有一段时间完全无法访问该账户。
 */
export async function unmarkRestricted(accountId: string): Promise<{ ok: boolean; error?: string }> {
  const rec = db.getRestrictedAccounts().find((r: any) => r.account_id === accountId);
  if (!rec) return { ok: false, error: '该账户未被标记' };

  try {
    const creds = await assumePayer(rec.payer);
    const org = new OrganizationsClient({ region: REGION, credentials: creds });
    const rootId = (await org.send(new ListRootsCommand({}))).Roots![0].Id!;
    const cf = new CloudFormationClient({ region: REGION, credentials: creds });
    const ssName = `${RESTRICTED_PREFIX}-${accountId}`;

    // 角色是就地改造的（非 StackSet 管理），恢复也走 IAM：
    // 先去掉 ExternalId 条件并装回默认权限，再把账户交回组织级 StackSet 托管。
    const admin = await assumeChildAdmin(creds, accountId);
    const iam = new IAMClient({ region: REGION, credentials: admin });

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
    await iam.send(new DeleteRolePolicyCommand({ RoleName: SUPPORT_ROLE, PolicyName: RESTRICTED_INLINE_POLICY })
      ).catch(() => { /* 可能已不存在 */ });

    // 交回组织级 StackSet：先删掉就地改造的角色，让 StackSet 能重建
    // （删除前平台仍可用 payer 二级跳访问该账户，不会完全失联）
    try {
      const del = await cf.send(new DeleteStackInstancesCommand({
        StackSetName: ssName,
        DeploymentTargets: { OrganizationalUnitIds: [rootId], Accounts: [accountId], AccountFilterType: 'INTERSECTION' },
        Regions: [REGION],
        RetainStacks: false,
        OperationPreferences: { FailureTolerancePercentage: 0, MaxConcurrentPercentage: 100 },
        CallAs: 'SELF',
      }));
      await waitOp(cf, ssName, del.OperationId!);
      await cf.send(new DeleteStackSetCommand({ StackSetName: ssName, CallAs: 'SELF' })).catch(() => {});
    } catch { /* 受限 StackSet 可能从未成功创建 */ }

    db.deleteRestrictedAccount(accountId);
    console.log(`[Restricted] ${accountId}: 已取消标记，恢复默认权限`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `${e?.name}: ${String(e?.message || '').slice(0, 160)}` };
  }
}
