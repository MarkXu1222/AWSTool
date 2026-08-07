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
  CloudFormationClient, CreateStackSetCommand, DescribeStackSetCommand,
  CreateStackInstancesCommand, DeleteStackInstancesCommand,
  DescribeStackSetOperationCommand, ListStackInstancesCommand,
} from '@aws-sdk/client-cloudformation';
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

/** 收窄后的权限范围 —— 只保留配额与区域查询所必需 */
function restrictedTemplate(externalId: string): string {
  return `AWSTemplateFormatVersion: '2010-09-09'
Description: Deploy restricted support-quota role for AWSTool (least privilege, ExternalId required)
Resources:
  SupportQuotaRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ${SUPPORT_ROLE}
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS:
                - arn:aws:iam::509399618054:user/mark
            Action: sts:AssumeRole
            Condition:
              StringEquals:
                sts:ExternalId: '${externalId}'
      Policies:
        - PolicyName: SupportQuotaRestricted
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - servicequotas:Get*
                  - servicequotas:List*
                  - account:GetRegionOptStatus
                  - account:ListRegions
                  - sts:GetCallerIdentity
                Resource: '*'
      Tags:
        - Key: Purpose
          Value: SupportQuotaRestricted
        - Key: ManagedBy
          Value: AWSTool
`;
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

      // 2) 每账户一套受限 StackSet（ExternalId 各不相同，无法共用模板）
      for (const id of ids) {
        const ssName = `${RESTRICTED_PREFIX}-${id}`;
        let exists = false;
        try {
          await cf.send(new DescribeStackSetCommand({ StackSetName: ssName, CallAs: 'SELF' }));
          exists = true;
        } catch (e: any) {
          if (e?.name !== 'StackSetNotFoundException') throw e;
        }

        if (!exists) {
          await cf.send(new CreateStackSetCommand({
            StackSetName: ssName,
            Description: `AWSTool restricted support-quota for ${id} (least privilege + ExternalId)`,
            TemplateBody: restrictedTemplate(idToExtId.get(id)!),
            Capabilities: ['CAPABILITY_NAMED_IAM'],
            PermissionModel: 'SERVICE_MANAGED',
            AutoDeployment: { Enabled: false },   // 只针对这一个账户，不扩散
            ManagedExecution: { Active: true },
            CallAs: 'SELF',
          }));
        }

        const op = await cf.send(new CreateStackInstancesCommand({
          StackSetName: ssName,
          DeploymentTargets: { OrganizationalUnitIds: [rootId], Accounts: [id], AccountFilterType: 'INTERSECTION' },
          Regions: [REGION],
          OperationPreferences: { FailureTolerancePercentage: 0, MaxConcurrentPercentage: 100 },
          CallAs: 'SELF',
        }));
        const s = await waitOp(cf, ssName, op.OperationId!);

        const ok = s === 'SUCCEEDED';
        db.upsertRestrictedAccounts([{
          account_id: id,
          state: ok ? 'applied' : 'failed',
          applied_at: ok ? new Date().toISOString() : null,
          last_error: ok ? null : `受限角色部署结束状态 ${s}`,
        }]);
        results.push({ accountId: id, ok, state: ok ? 'applied' : 'failed', error: ok ? undefined : `部署 ${s}` });
        console.log(`[Restricted] ${id}: 受限角色部署 ${s}`);
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

    const op = await cf.send(new CreateStackInstancesCommand({
      StackSetName: ORG_STACKSET,
      DeploymentTargets: { OrganizationalUnitIds: [rootId], Accounts: [accountId], AccountFilterType: 'INTERSECTION' },
      Regions: [REGION],
      OperationPreferences: { FailureTolerancePercentage: 0, MaxConcurrentPercentage: 100 },
      CallAs: 'SELF',
    }));
    await waitOp(cf, ORG_STACKSET, op.OperationId!);

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
    } catch { /* 受限 StackSet 可能已不存在 */ }

    db.deleteRestrictedAccount(accountId);
    console.log(`[Restricted] ${accountId}: 已取消标记，恢复默认权限`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `${e?.name}: ${String(e?.message || '').slice(0, 160)}` };
  }
}
