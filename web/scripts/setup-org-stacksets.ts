/**
 * 组织级角色下发 —— 为各 AWS Organization 建立/修正两个 SERVICE_MANAGED StackSet，
 * 使成员账户（含未来新加入的）自动获得平台所需角色。
 *
 * 为什么需要这个脚本：
 *   平台访问成员账户依赖两个角色，`support-quota`（只读）和 `admin-console`（admin 一级跳）。
 *   新账户能否自动拿到它们，取决于 StackSet 的 AutoDeployment 是否开启且部署目标覆盖 Root OU。
 *   加入新 payer 时必须跑一次本脚本，否则该组织的新账户在平台里只能看到名字、读不到任何数据。
 *
 *   `admin-console` 尤其重要：INVITED（邀请加入）的账户不会自带 OrganizationAccountAccessRole，
 *   payer 二级跳进不去，只有直接信任平台身份的 admin-console 这条路。
 *
 * 用法:
 *   npx tsx scripts/setup-org-stacksets.ts support              # 所有组织
 *   npx tsx scripts/setup-org-stacksets.ts admin  yanhuang31    # 指定组织
 *   npx tsx scripts/setup-org-stacksets.ts admin  --dry-run     # 只看当前状态，不改
 *   npx tsx scripts/setup-org-stacksets.ts admin  upup --refresh-template # 显式更新模板并部署到已有实例
 *
 * 行为（幂等，可重复执行）:
 *   StackSet 不存在        → 按整 Root OU + AutoDeployment 创建，然后部署
 *   存在但 AutoDeployment 关 → UpdateStackSet 开启（沿用原模板，不动现有角色定义）
 *   已正确配置             → 只补齐尚未覆盖的账户实例
 *   --refresh-template     → 使用脚本内当前模板更新 StackSet，并 UpdateStackInstances 到已有账户
 *
 * 已知失败情形（属正常，不影响新账户自动化）:
 *   - "already exists in stack ..." 该账户的角色由另一个（可能已删除的）stack 管理，
 *     角色本身在、可用；只是无法被本 StackSet 接管
 *   - OptInRequired（403）账户未完成激活，CloudFormation 进不去，需人工处理
 *   - SKIPPED_SUSPENDED_ACCOUNT 账户已暂停，跳过即正确
 */
import fs from 'fs';
import path from 'path';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { OrganizationsClient, ListAccountsCommand, ListRootsCommand } from '@aws-sdk/client-organizations';
import {
  CloudFormationClient, CreateStackSetCommand, UpdateStackSetCommand, DescribeStackSetCommand,
  CreateStackInstancesCommand, UpdateStackInstancesCommand, ListStackInstancesCommand, DescribeStackSetOperationCommand,
} from '@aws-sdk/client-cloudformation';

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
const REGION: string = CONFIG.region || 'us-east-1';
const BASE = {
  accessKeyId: CONFIG.credentials.accessKeyId,
  secretAccessKey: CONFIG.credentials.secretAccessKey,
};
const PAYERS: { name: string; roleArn: string }[] = CONFIG.payers || [];
const cv = (c: any) => ({ accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken });
const log = (...a: any[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/**
 * 读取敏感权限客户账户名单（直接读 db.json，避免脚本依赖服务端模块）。
 * 这些账户已按客户要求收窄权限并启用 ExternalId，绝不能被组织级模板覆盖。
 */
function readRestrictedAccountIds(payerName: string): string[] {
  const dbPath = path.join(__dirname, '../../data/db.json');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`受限账户数据不存在，拒绝部署: ${dbPath}`);
  }
  try {
    const data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    const records = data.restricted_accounts;
    if (records != null && !Array.isArray(records)) {
      throw new Error('restricted_accounts 不是数组');
    }
    const knownPayers = new Set(PAYERS.map(p => p.name));
    (records || []).forEach((record: any, index: number) => {
      const accountId = String(record?.account_id || '');
      const recordPayer = String(record?.payer || '');
      if (!/^\d{12}$/.test(accountId)) {
        throw new Error(`restricted_accounts[${index}].account_id 无效`);
      }
      if (!recordPayer || !knownPayers.has(recordPayer)) {
        throw new Error(`restricted_accounts[${index}].payer 无效或未配置`);
      }
    });
    // 不按 state 过滤：只要标记过就排除。failed 的账户往往已从组织级 StackSet
    // 摘除，漏掉排除会让下一次全量下发把宽权限重新盖回客户账户。
    return (records || [])
      .filter((r: any) => r.payer === payerName)
      .map((r: any) => String(r.account_id));
  } catch (error: any) {
    throw new Error(`无法读取受限账户数据，拒绝部署: ${dbPath} (${error?.message || 'unknown error'})`);
  }
}

/** 读取仅排除管理员角色的账户；support-quota 仍由原 StackSet/角色保留。 */
function readAdminRoleExcludedAccountIds(payerName: string): string[] {
  const records = CONFIG.adminRoleExcludedAccounts;
  if (records == null) return [];
  if (!Array.isArray(records)) {
    throw new Error('config.adminRoleExcludedAccounts 必须是数组');
  }
  const knownPayers = new Set(PAYERS.map(payer => payer.name));
  records.forEach((record: any, index: number) => {
    const accountId = String(record?.accountId || '');
    const recordPayer = String(record?.payer || '');
    if (!/^\d{12}$/.test(accountId)) {
      throw new Error(`adminRoleExcludedAccounts[${index}].accountId 无效`);
    }
    if (!knownPayers.has(recordPayer)) {
      throw new Error(`adminRoleExcludedAccounts[${index}].payer 未配置`);
    }
  });
  return [...new Set(records
    .filter((record: any) => record.payer === payerName)
    .map((record: any) => String(record.accountId)))];
}

/** 校验 admin-only 排除账户确实属于当前 payer，防止配置写错后真实组织继续补建 Admin。 */
async function validateAdminRoleExcludedAccounts(
  org: OrganizationsClient,
  payerName: string,
  accountIds: string[],
): Promise<void> {
  if (accountIds.length === 0) return;
  const organizationAccountIds = new Set<string>();
  let nextToken: string | undefined;
  do {
    const response = await org.send(new ListAccountsCommand({ NextToken: nextToken }));
    for (const account of response.Accounts || []) {
      if (account.Id) organizationAccountIds.add(account.Id);
    }
    nextToken = response.NextToken;
  } while (nextToken);

  const mismatched = accountIds.filter(accountId => !organizationAccountIds.has(accountId));
  if (mismatched.length > 0) {
    throw new Error(`${payerName}: adminRoleExcludedAccounts 账户不属于该组织: ${mismatched.join(', ')}`);
  }
}

// 信任主体只保留当前平台身份。历史身份 134103550877 不再写入新建的角色。
const TRUST_PRINCIPAL = 'arn:aws:iam::509399618054:user/mark';

const TEMPLATES: Record<string, { stackSetName: string; description: string; body: string }> = {
  support: {
    stackSetName: 'support-quota-role-orgwide',
    description: 'Deploy support-quota role for AWSTool to all organization member accounts',
    body: `AWSTemplateFormatVersion: '2010-09-09'
Description: Deploy support-quota role for AWSTool
Resources:
  SupportQuotaRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ${CONFIG.supportRoleName || 'support-quota'}
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS:
                - ${TRUST_PRINCIPAL}
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/ReadOnlyAccess
        - arn:aws:iam::aws:policy/AWSSupportAccess
      Policies:
        - PolicyName: SupportQuotaPerms
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - sts:GetCallerIdentity
                  - ec2:Describe*
                  - ce:GetCostAndUsage
                  - servicequotas:*
                  - iam:GetAccountSummary
                  - iam:ListMFADevices
                  - iam:ListUsers
                  - iam:GenerateCredentialReport
                  - iam:GetCredentialReport
                  - s3:ListAllMyBuckets
                  - lambda:ListFunctions
                  - rds:Describe*
                  - organizations:ListAccounts
                Resource: '*'
              - Effect: Allow
                Action: iam:CreateServiceLinkedRole
                Resource: '*'
                Condition:
                  StringEquals:
                    iam:AWSServiceName: servicequotas.amazonaws.com
      Tags:
        - Key: Purpose
          Value: SupportQuota
        - Key: ManagedBy
          Value: AWSTool
`,
  },
  admin: {
    stackSetName: 'admin-console-role-orgwide',
    description: 'AWSTool admin-console role (one-hop admin, org-wide auto deploy)',
    body: `AWSTemplateFormatVersion: "2010-09-09"
Description: Deploy admin-console role for AWSTool (full admin, one-hop federated console)
Resources:
  AdminConsoleRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ${CONFIG.adminRoleName || 'admin-console'}
      MaxSessionDuration: 43200
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
          Value: AdminConsole
        - Key: ManagedBy
          Value: AWSTool
`,
  },
};

async function waitOp(cf: CloudFormationClient, name: string, opId: string, maxMin = 30) {
  const t0 = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 15000));
    try {
      const st = await cf.send(new DescribeStackSetOperationCommand({ StackSetName: name, OperationId: opId, CallAs: 'SELF' }));
      const s = st.StackSetOperation?.Status || '';
      if (['SUCCEEDED', 'FAILED', 'STOPPED'].includes(s)) return s;
    } catch { return 'POLL-ERR'; }
    if (Date.now() - t0 > maxMin * 60 * 1000) return 'TIMEOUT';
  }
}

async function countInstances(cf: CloudFormationClient, name: string) {
  const all: any[] = [];
  let token: string | undefined;
  do {
    const r = await cf.send(new ListStackInstancesCommand({ StackSetName: name, CallAs: 'SELF', NextToken: token, MaxResults: 100 }));
    all.push(...(r.Summaries || []));
    token = r.NextToken;
  } while (token);
  const d = (s: any) => String(s.StackInstanceStatus?.DetailedStatus);
  return {
    total: all.length,
    ok: all.filter(s => d(s) === 'SUCCEEDED').length,
    susp: all.filter(s => d(s) === 'SKIPPED_SUSPENDED_ACCOUNT').length,
    fail: all.filter(s => !['SUCCEEDED', 'SKIPPED_SUSPENDED_ACCOUNT'].includes(d(s))).length,
  };
}

async function handle(
  payer: { name: string; roleArn: string },
  kind: string,
  dryRun: boolean,
  refreshTemplate: boolean,
): Promise<boolean> {
  const tpl = TEMPLATES[kind];
  try {
    const sts = new STSClient({ region: REGION, credentials: BASE });
    const ar = await sts.send(new AssumeRoleCommand({ RoleArn: payer.roleArn, RoleSessionName: 'setup-ss', DurationSeconds: 3600 }));
    const creds = cv(ar.Credentials);
    const org = new OrganizationsClient({ region: REGION, credentials: creds });
    const rootId = (await org.send(new ListRootsCommand({}))).Roots![0].Id!;
    const cf = new CloudFormationClient({ region: REGION, credentials: creds });

    let existing: any = null;
    try {
      existing = (await cf.send(new DescribeStackSetCommand({ StackSetName: tpl.stackSetName, CallAs: 'SELF' }))).StackSet;
    } catch (e: any) {
      if (e?.name !== 'StackSetNotFoundException') throw e;
    }

    // 在任何部署操作前读取权威排除名单；读取失败必须 fail-closed。
    // restricted 同时排除 support/admin；adminRoleExcludedAccounts 只排除 admin。
    const restricted = readRestrictedAccountIds(payer.name);
    const adminOnlyExcluded = kind === 'admin' ? readAdminRoleExcludedAccountIds(payer.name) : [];
    await validateAdminRoleExcludedAccounts(org, payer.name, adminOnlyExcluded);
    const excluded = [...new Set([...restricted, ...adminOnlyExcluded])];

    if (dryRun) {
      const c = existing ? await countInstances(cf, tpl.stackSetName) : null;
      const maxSession = existing?.TemplateBody?.match(/MaxSessionDuration:\s*(\d+)/)?.[1];
      log(`${payer.name}: ${existing
        ? `存在 auto=${!!existing.AutoDeployment?.Enabled}${maxSession ? ` maxSession=${maxSession}s` : ''} 实例 ${c!.total}(ok${c!.ok}/susp${c!.susp}/fail${c!.fail})`
        : '不存在'} | 排除 ${excluded.length}（受限 ${restricted.length}/仅Admin ${adminOnlyExcluded.length}）`);
      return true;
    }

    if (excluded.length) {
      log(`${payer.name}: ${kind} 排除 ${excluded.length} 个账户（受限 ${restricted.length}/仅Admin ${adminOnlyExcluded.length}）→ ${excluded.join(', ')}`);
    }

    let action = 'ALREADY-AUTO';
    if (!existing) {
      await cf.send(new CreateStackSetCommand({
        StackSetName: tpl.stackSetName,
        Description: tpl.description,
        TemplateBody: tpl.body,
        Capabilities: ['CAPABILITY_NAMED_IAM'],
        PermissionModel: 'SERVICE_MANAGED',
        AutoDeployment: { Enabled: true, RetainStacksOnAccountRemoval: false },
        ManagedExecution: { Active: true },
        CallAs: 'SELF',
      }));
      action = 'CREATED';
    } else if (refreshTemplate) {
      const templateChanged = String(existing.TemplateBody || '').trim() !== tpl.body.trim();
      if (templateChanged || !existing.AutoDeployment?.Enabled) {
        const up = await cf.send(new UpdateStackSetCommand({
          StackSetName: tpl.stackSetName,
          Description: tpl.description,
          TemplateBody: tpl.body,
          Capabilities: ['CAPABILITY_NAMED_IAM'],
          PermissionModel: 'SERVICE_MANAGED',
          AutoDeployment: { Enabled: true, RetainStacksOnAccountRemoval: false },
          ManagedExecution: { Active: true },
          CallAs: 'SELF',
        }));
        const status = await waitOp(cf, tpl.stackSetName, up.OperationId!);
        if (status !== 'SUCCEEDED') throw new Error(`StackSet 模板更新未成功: ${status}`);
        action = 'TEMPLATE-UPDATED';
      } else {
        action = 'TEMPLATE-CURRENT';
      }
    } else if (!existing.AutoDeployment?.Enabled) {
      const up = await cf.send(new UpdateStackSetCommand({
        StackSetName: tpl.stackSetName,
        UsePreviousTemplate: true,
        Capabilities: ['CAPABILITY_NAMED_IAM'],
        PermissionModel: 'SERVICE_MANAGED',
        AutoDeployment: { Enabled: true, RetainStacksOnAccountRemoval: false },
        CallAs: 'SELF',
      }));
      action = `AUTO-ENABLED(${await waitOp(cf, tpl.stackSetName, up.OperationId!)})`;
    }

    // 按角色种类应用排除：restricted 排除两类角色，admin-only 只影响管理员 StackSet。
    const deploymentTargets = excluded.length
      ? { OrganizationalUnitIds: [rootId], Accounts: excluded, AccountFilterType: 'DIFFERENCE' as const }
      : { OrganizationalUnitIds: [rootId] };
    const operationPreferences = {
      FailureTolerancePercentage: 25,
      MaxConcurrentPercentage: 50,
      RegionConcurrencyType: 'PARALLEL' as const,
    };

    let deploy = 'SKIP';
    try {
      const op = existing && refreshTemplate
        ? await cf.send(new UpdateStackInstancesCommand({
            StackSetName: tpl.stackSetName,
            DeploymentTargets: deploymentTargets,
            Regions: [REGION],
            OperationPreferences: operationPreferences,
            CallAs: 'SELF',
          }))
        : await cf.send(new CreateStackInstancesCommand({
            StackSetName: tpl.stackSetName,
            DeploymentTargets: deploymentTargets,
            Regions: [REGION],
            OperationPreferences: operationPreferences,
            CallAs: 'SELF',
          }));
      deploy = await waitOp(cf, tpl.stackSetName, op.OperationId!);
    } catch (e: any) {
      if (refreshTemplate) {
        throw new Error(`StackSet 实例刷新请求失败: ${e?.name || 'UnknownError'} ${e?.message || ''}`);
      }
      deploy = `NO-OP(${e?.name})`;
    }

    const c = await countInstances(cf, tpl.stackSetName);
    log(`${payer.name}: ${action} | ${existing && refreshTemplate ? '更新' : '部署'}=${deploy} | 实例 ${c.total} ok${c.ok}/susp${c.susp}/fail${c.fail}`);
    if (refreshTemplate && deploy !== 'SUCCEEDED') {
      throw new Error(`StackSet 实例刷新未成功: ${deploy}`);
    }
    if (refreshTemplate && c.fail > 0) {
      throw new Error(`StackSet 实例刷新后仍有 ${c.fail} 个失败或未完成实例`);
    }
    return true;
  } catch (e: any) {
    log(`${payer.name}: ❌ ${e?.name} ${String(e?.message || '').slice(0, 180)}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const kind = args[0];
  const dryRun = args.includes('--dry-run');
  const refreshTemplate = args.includes('--refresh-template');
  const only = args.find(a => a !== kind && !a.startsWith('--'));

  if (!TEMPLATES[kind]) {
    console.error('用法: npx tsx scripts/setup-org-stacksets.ts <support|admin> [payerName] [--dry-run] [--refresh-template]');
    process.exit(1);
  }
  if (dryRun && refreshTemplate) {
    console.error('--dry-run 与 --refresh-template 不能同时使用');
    process.exit(1);
  }
  if (refreshTemplate && !only) {
    console.error('--refresh-template 必须显式指定单个 payerName，禁止默认刷新全部组织');
    process.exit(1);
  }

  const targets = only ? PAYERS.filter(p => p.name === only) : PAYERS;
  if (targets.length === 0) {
    console.error(`未找到组织 "${only}"，config.payers 里可选: ${PAYERS.map(p => p.name).join(', ')}`);
    process.exit(1);
  }

  log(`${dryRun ? '[dry-run] ' : ''}${refreshTemplate ? '[refresh-template] ' : ''}${TEMPLATES[kind].stackSetName} → ${targets.length} 个组织`);

  // 跨组织并发，单组织内串行
  const q = [...targets];
  let failed = 0;
  await Promise.all(Array.from({ length: Math.min(5, q.length) }, async () => {
    while (q.length) {
      const ok = await handle(q.shift()!, kind, dryRun, refreshTemplate);
      if (!ok) failed += 1;
    }
  }));

  if (failed > 0) {
    log(`失败：${failed}/${targets.length} 个组织未完成`);
    process.exitCode = 1;
    return;
  }
  log('完成');
}

main().catch(e => { console.error('FATAL', e?.name, e?.message); process.exit(1); });
