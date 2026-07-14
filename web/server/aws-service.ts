/**
 * AWS Service Layer — reads config from shared config.json
 */
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand, AssumeRootCommand } from '@aws-sdk/client-sts';
import { OrganizationsClient, ListAccountsCommand } from '@aws-sdk/client-organizations';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { ServiceQuotasClient, ListServiceQuotasCommand, RequestServiceQuotaIncreaseCommand, ListRequestedServiceQuotaChangeHistoryCommand, GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';
import { IAMClient, GetAccountSummaryCommand, ListMFADevicesCommand, ListUsersCommand, ListVirtualMFADevicesCommand, DeactivateMFADeviceCommand, DeleteVirtualMFADeviceCommand, CreateLoginProfileCommand } from '@aws-sdk/client-iam';
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand } from '@aws-sdk/client-ec2';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import path from 'path';
import fs from 'fs';
import { db } from './db';

// Load shared config
const CONFIG_PATH = path.join(__dirname, '../../config.json');
let config: any = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  console.log('✅ Loaded config from config.json');
} catch (e) {
  console.warn('⚠️  config.json not found, falling back to env vars');
}

// Read from config.json, fallback to env
const BASE_CREDENTIALS = {
  accessKeyId: config.credentials?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || '',
  secretAccessKey: config.credentials?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '',
};
const DEFAULT_REGION = config.region || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const CHILD_ROLE_NAME = config.childRoleName || process.env.CHILD_ROLE_NAME || 'OrganizationAccountAccessRole';
// 一级跳专用: 每个账户里都建有并信任主账号的 role (方案 A: 优先用它，失败 fallback 到 payer 二级跳)
const SUPPORT_ROLE_NAME = config.supportRoleName || process.env.SUPPORT_ROLE_NAME || 'support-quota';

// Payers from config.json or env
let PAYERS: { name: string; roleArn: string }[] = config.payers || [];
if (PAYERS.length === 0) {
  // Fallback to env format: name|arn,name|arn
  PAYERS = (process.env.PAYERS || '').split(',').filter(Boolean).map(p => {
    const [name, roleArn] = p.split('|');
    return { name: name?.trim(), roleArn: roleArn?.trim() };
  }).filter(p => p.name && p.roleArn);
}

// Credential cache
const adminCredsCache: Map<string, { creds: any; expiry: number }> = new Map();
const accountPayerMap: Map<string, string> = new Map();
// 记录哪些账号的 support-quota role AssumeRole 失败过 (避免每次都重试消耗 STS 调用)
const supportRoleUnavailable: Set<string> = new Set();

// 尝试一级跳: 直接 AssumeRole 到目标账户的 support-quota role
async function tryAssumeSupportRole(accountId: string) {
  if (!SUPPORT_ROLE_NAME) return null;
  if (supportRoleUnavailable.has(accountId)) return null;
  try {
    const roleArn = `arn:aws:iam::${accountId}:role/${SUPPORT_ROLE_NAME}`;
    const sts = new STSClient({ region: DEFAULT_REGION, credentials: BASE_CREDENTIALS });
    const resp = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `web-${accountId}`,
      DurationSeconds: 3600,
    }));
    return {
      accessKeyId: resp.Credentials!.AccessKeyId!,
      secretAccessKey: resp.Credentials!.SecretAccessKey!,
      sessionToken: resp.Credentials!.SessionToken!,
    };
  } catch (e) {
    // 该账户没有 support-quota role 或者信任关系没建立好，记住，下次不重试
    supportRoleUnavailable.add(accountId);
    return null;
  }
}

async function getAdminCredsForPayer(payerRoleArn: string, forceFresh = false) {
  const cached = adminCredsCache.get(payerRoleArn);
  if (!forceFresh && cached && Date.now() < cached.expiry) return cached.creds;

  const sts = new STSClient({ region: DEFAULT_REGION, credentials: BASE_CREDENTIALS });
  const resp = await sts.send(new AssumeRoleCommand({
    RoleArn: payerRoleArn,
    RoleSessionName: 'aws-toolbox-web',
    DurationSeconds: 3600,
  }));

  const creds = {
    accessKeyId: resp.Credentials!.AccessKeyId!,
    secretAccessKey: resp.Credentials!.SecretAccessKey!,
    sessionToken: resp.Credentials!.SessionToken!,
  };
  adminCredsCache.set(payerRoleArn, { creds, expiry: Date.now() + 50 * 60 * 1000 });
  return creds;
}

async function assumeToAccount(accountId: string) {
  // ★ 方案 A: 优先尝试一级跳 support-quota role
  const supportCreds = await tryAssumeSupportRole(accountId);
  if (supportCreds) {
    console.log(`[assume] ${accountId} → support-quota (一级跳)`);
    return supportCreds;
  }

  // 兜底：如果 accountId 本身就是一个 payer 账号，直接用 payer role 的 admin creds
  const selfPayer = PAYERS.find(p => {
    const m = /arn:aws:iam::(\d+):role\//.exec(p.roleArn);
    return m && m[1] === accountId;
  });
  if (selfPayer) {
    console.log(`[assume] ${accountId} → payer role/tool (selfPayer)`);
    return await getAdminCredsForPayer(selfPayer.roleArn);
  }

  const roleArn = `arn:aws:iam::${accountId}:role/${CHILD_ROLE_NAME}`;

  // Try known payer first
  const knownPayer = accountPayerMap.get(accountId);
  if (knownPayer) {
    const admin = await getAdminCredsForPayer(knownPayer);
    const sts = new STSClient({ region: DEFAULT_REGION, credentials: admin });
    const resp = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: `web-${accountId}`, DurationSeconds: 3600 }));
    console.log(`[assume] ${accountId} → OrganizationAccountAccessRole (二级跳, 已知 payer)`);
    return { accessKeyId: resp.Credentials!.AccessKeyId!, secretAccessKey: resp.Credentials!.SecretAccessKey!, sessionToken: resp.Credentials!.SessionToken! };
  }

  // Try all payers
  for (const payer of PAYERS) {
    try {
      const admin = await getAdminCredsForPayer(payer.roleArn);
      const sts = new STSClient({ region: DEFAULT_REGION, credentials: admin });
      const resp = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: `web-${accountId}`, DurationSeconds: 3600 }));
      accountPayerMap.set(accountId, payer.roleArn);
      console.log(`[assume] ${accountId} → OrganizationAccountAccessRole (二级跳, 探测到 ${payer.name})`);
      return { accessKeyId: resp.Credentials!.AccessKeyId!, secretAccessKey: resp.Credentials!.SecretAccessKey!, sessionToken: resp.Credentials!.SessionToken! };
    } catch { continue; }
  }
  console.log(`[assume] ${accountId} → 全部失败`);
  throw new Error(`无法 AssumeRole 到 ${accountId}`);
}

/**
 * 生成账户的 Admin 权限临时凭证（有效期 1 小时）。
 * 与 assumeToAccount 不同：这里明确走管理员角色（OrganizationAccountAccessRole / payer role），
 * 不使用受限的 support-quota role，供操作者复制到 AWS CLI / SDK 临时使用。
 */
export async function getTempAdminCredentials(accountId: string) {
  const format = (resp: any) => ({
    accountId,
    accessKeyId: resp.Credentials!.AccessKeyId!,
    secretAccessKey: resp.Credentials!.SecretAccessKey!,
    sessionToken: resp.Credentials!.SessionToken!,
    expiration: resp.Credentials!.Expiration, // Date → ISO string after JSON 序列化
    region: DEFAULT_REGION,
  });

  // 情况 1：账户本身就是 payer —— 用长期密钥直接 AssumeRole 到 payer role（可拿完整 1 小时）
  const selfPayer = PAYERS.find(p => {
    const m = /arn:aws:iam::(\d+):role\//.exec(p.roleArn);
    return m && m[1] === accountId;
  });
  if (selfPayer) {
    const sts = new STSClient({ region: DEFAULT_REGION, credentials: BASE_CREDENTIALS });
    const resp = await sts.send(new AssumeRoleCommand({
      RoleArn: selfPayer.roleArn,
      RoleSessionName: `admin-${accountId}`,
      DurationSeconds: 3600,
    }));
    console.log(`[temp-cred] ${accountId} → payer admin (selfPayer)`);
    return format(resp);
  }

  // 情况 2：成员账户 —— 二级跳: payer admin creds → OrganizationAccountAccessRole
  // 角色链式 AssumeRole 上限为 1 小时；用 forceFresh 取新鲜 payer 凭证，保证接近完整 1 小时。
  const roleArn = `arn:aws:iam::${accountId}:role/${CHILD_ROLE_NAME}`;
  const knownPayer = accountPayerMap.get(accountId);
  const payerArns = knownPayer
    ? [knownPayer, ...PAYERS.map(p => p.roleArn).filter(a => a !== knownPayer)]
    : PAYERS.map(p => p.roleArn);

  let lastErr: any;
  for (const payerArn of payerArns) {
    try {
      const admin = await getAdminCredsForPayer(payerArn, true);
      const sts = new STSClient({ region: DEFAULT_REGION, credentials: admin });
      const resp = await sts.send(new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `admin-${accountId}`,
        DurationSeconds: 3600,
      }));
      accountPayerMap.set(accountId, payerArn);
      console.log(`[temp-cred] ${accountId} → OrganizationAccountAccessRole (二级跳)`);
      return format(resp);
    } catch (e) { lastErr = e; continue; }
  }
  throw new Error(`无法为账户 ${accountId} 生成管理员临时凭证：${lastErr?.message || '所有 payer 均尝试失败'}`);
}

// ===== 集中式根访问 (sts:AssumeRoot) =====
// AWS 管理的根任务策略 ARN，用于把 root 会话权限收敛到具体特权任务
const ROOT_TASK_POLICY = {
  delete: 'arn:aws:iam::aws:policy/root-task/IAMDeleteRootUserCredentials',
  createPassword: 'arn:aws:iam::aws:policy/root-task/IAMCreateRootUserPassword',
  audit: 'arn:aws:iam::aws:policy/root-task/IAMAuditRootUserCredentials',
};

// 解析某成员账户所属组织的 payer(管理账户) role ARN：优先内存映射，其次账户缓存里的 _payer 名称
function getPayerRoleArnForAccount(accountId: string): string | null {
  const known = accountPayerMap.get(accountId);
  if (known) return known;
  try {
    const { accounts } = db.getAccountsCache();
    const acct = (accounts || []).find((a: any) => a.Id === accountId);
    if (acct?._payer) {
      const payer = PAYERS.find(p => p.name === acct._payer);
      if (payer) return payer.roleArn;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * AssumeRoot 到成员账户的 root，换取短期特权会话凭证（≤15 分钟）。
 * 关键：AssumeRoot 必须由「目标账户所属组织的管理账户(payer)」发起，不能用工具用户直接调用。
 * 因此先 AssumeRole 到该账户对应 payer 的 tool 角色（进入管理账户），再从管理账户凭证发起 AssumeRoot。
 * 注意：AssumeRoot 不支持全球端点，必须使用区域性 STS 端点；SDK v3 指定 region 即为区域端点。
 * 前提：组织已开启集中式根访问，且该 payer 的 tool 角色具备 sts:AssumeRoot 权限。
 */
async function assumeRoot(accountId: string, taskPolicyArn: string) {
  const doAssume = async (payerRoleArn: string) => {
    const mgmtCreds = await getAdminCredsForPayer(payerRoleArn); // 管理账户凭证
    const sts = new STSClient({ region: DEFAULT_REGION, credentials: mgmtCreds });
    const resp = await sts.send(new AssumeRootCommand({
      TargetPrincipal: accountId,
      TaskPolicyArn: { arn: taskPolicyArn },
      DurationSeconds: 900,
    }));
    accountPayerMap.set(accountId, payerRoleArn);
    return {
      accessKeyId: resp.Credentials!.AccessKeyId!,
      secretAccessKey: resp.Credentials!.SecretAccessKey!,
      sessionToken: resp.Credentials!.SessionToken!,
    };
  };

  // 已知归属 payer → 直接用它（错误信息最准确）
  const payerRoleArn = getPayerRoleArnForAccount(accountId);
  if (payerRoleArn) return await doAssume(payerRoleArn);

  // 归属未知 → 依次尝试各 payer
  let lastErr: any;
  for (const p of PAYERS) {
    try { return await doAssume(p.roleArn); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(`无法确定账户 ${accountId} 所属组织，AssumeRoot 失败`);
}

/**
 * 删除成员账户根用户的（虚拟）MFA 设备。
 * 步骤：1) 用管理员凭证 ListVirtualMFADevices 定位 root 的设备 SerialNumber；
 *      2) AssumeRoot(IAMDeleteRootUserCredentials) 换取 root 会话；
 *      3) DeactivateMFADevice + DeleteVirtualMFADevice（root 会话须省略 UserName）。
 */
export async function deleteRootMFA(accountId: string) {
  // 1) 用管理员凭证枚举虚拟 MFA 设备，找出分配给 root 的那个
  const admin = await getTempAdminCredentials(accountId);
  const adminCreds = { accessKeyId: admin.accessKeyId, secretAccessKey: admin.secretAccessKey, sessionToken: admin.sessionToken };
  const iamAdmin = new IAMClient({ region: 'us-east-1', credentials: adminCreds });
  const list = await iamAdmin.send(new ListVirtualMFADevicesCommand({ AssignmentStatus: 'Assigned' }));
  const rootDevices = (list.VirtualMFADevices || []).filter(d =>
    (d.User?.Arn || '').endsWith(':root') || (d.SerialNumber || '').includes('root-account-mfa-device')
  );
  if (rootDevices.length === 0) {
    throw new Error('未找到根用户的虚拟 MFA 设备（可能未启用，或为硬件 MFA — 需在该账户根用户控制台手动处理）');
  }

  // 2) AssumeRoot 换取 root 特权会话
  const rootCreds = await assumeRoot(accountId, ROOT_TASK_POLICY.delete);
  const iamRoot = new IAMClient({ region: DEFAULT_REGION, credentials: rootCreds });

  // 3) 逐个停用并删除（root 会话须省略 UserName）
  const removed: string[] = [];
  for (const d of rootDevices) {
    const serial = d.SerialNumber!;
    await iamRoot.send(new DeactivateMFADeviceCommand({ SerialNumber: serial }));
    // 仅虚拟设备可删除；停用后从账户移除，避免残留
    try { await iamRoot.send(new DeleteVirtualMFADeviceCommand({ SerialNumber: serial })); } catch { /* 非虚拟设备忽略 */ }
    removed.push(serial);
  }
  return { accountId, removed };
}

/**
 * 恢复（重新启用）成员账户根用户的密码。
 * AssumeRoot(IAMCreateRootUserPassword) → CreateLoginProfile（root 会话须省略 UserName 与 Password，
 * 由 AWS 触发根用户密码恢复流程，向该账户根邮箱发送重置邮件）。
 */
export async function recoverRootPassword(accountId: string) {
  const rootCreds = await assumeRoot(accountId, ROOT_TASK_POLICY.createPassword);
  const iamRoot = new IAMClient({ region: DEFAULT_REGION, credentials: rootCreds });
  await iamRoot.send(new CreateLoginProfileCommand({}));
  return { accountId, ok: true };
}

// ===== Exported service functions =====

export async function testConnection() {
  const results = [];
  for (const payer of PAYERS) {
    try {
      const creds = await getAdminCredsForPayer(payer.roleArn);
      const sts = new STSClient({ region: DEFAULT_REGION, credentials: creds });
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      results.push({ name: payer.name, account: identity.Account, ok: true });
    } catch (e: any) {
      results.push({ name: payer.name, error: e.message, ok: false });
    }
  }
  return results;
}

export async function listAccounts() {
  const allAccounts: any[] = [];
  for (const payer of PAYERS) {
    try {
      const admin = await getAdminCredsForPayer(payer.roleArn);
      const client = new OrganizationsClient({ region: 'us-east-1', credentials: admin });
      let nextToken: string | undefined;
      do {
        const resp = await client.send(new ListAccountsCommand({ NextToken: nextToken }));
        for (const a of resp.Accounts || []) {
          allAccounts.push({ ...a, _payer: payer.name });
          if (a.Id) accountPayerMap.set(a.Id, payer.roleArn);
        }
        nextToken = resp.NextToken;
      } while (nextToken);
    } catch { /* skip failed payer */ }
  }
  // Deduplicate
  const seen = new Set<string>();
  return allAccounts.filter(a => { if (seen.has(a.Id)) return false; seen.add(a.Id); return true; });
}

export async function getCostByAccount(startDate: string, endDate: string) {
  const allResults: any[] = [];
  for (const payer of PAYERS) {
    try {
      const admin = await getAdminCredsForPayer(payer.roleArn);
      const ce = new CostExplorerClient({ region: 'us-east-1', credentials: admin });
      const resp = await ce.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: startDate, End: endDate }, Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'], GroupBy: [{ Type: 'DIMENSION', Key: 'LINKED_ACCOUNT' }],
      }));
      if (resp.ResultsByTime) allResults.push(...resp.ResultsByTime);
    } catch { /* skip */ }
  }
  return allResults;
}

export async function getCostByService(accountId: string, startDate: string, endDate: string) {
  const payerRole = accountPayerMap.get(accountId) || PAYERS[0]?.roleArn;
  if (!payerRole) throw new Error('No payer');
  const admin = await getAdminCredsForPayer(payerRole);
  const ce = new CostExplorerClient({ region: 'us-east-1', credentials: admin });
  const resp = await ce.send(new GetCostAndUsageCommand({
    TimePeriod: { Start: startDate, End: endDate }, Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'], GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    Filter: { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [accountId] } },
  }));
  return resp.ResultsByTime || [];
}

export async function listServiceQuotas(accountId: string, serviceCode: string, region?: string) {
  const creds = await assumeToAccount(accountId);
  const client = new ServiceQuotasClient({ region: region || DEFAULT_REGION, credentials: creds });
  const quotas: any[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await client.send(new ListServiceQuotasCommand({ ServiceCode: serviceCode, NextToken: nextToken }));
    if (resp.Quotas) quotas.push(...resp.Quotas);
    nextToken = resp.NextToken;
  } while (nextToken);
  return quotas;
}

export async function requestQuotaIncrease(accountId: string, serviceCode: string, quotaCode: string, desiredValue: number, region?: string) {
  const creds = await assumeToAccount(accountId);
  const client = new ServiceQuotasClient({ region: region || DEFAULT_REGION, credentials: creds });
  const resp = await client.send(new RequestServiceQuotaIncreaseCommand({ ServiceCode: serviceCode, QuotaCode: quotaCode, DesiredValue: desiredValue }));
  return resp.RequestedQuota;
}

export async function listQuotaRequests(accountId: string) {
  const creds = await assumeToAccount(accountId);
  const allRequests: any[] = [];
  
  // Only query regions likely to have data — default regions + commonly used opt-in
  // Use a fast approach: query all in parallel, timeout quickly for unavailable regions
  const regions = [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1', 'eu-central-1',
    'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4', 'ap-southeast-5',
    'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
    'ap-south-1', 'ap-south-2', 'ap-east-1',
    'sa-east-1', 'ca-central-1', 'ca-west-1',
    'af-south-1', 'me-south-1', 'me-central-1',
    'eu-south-1', 'eu-south-2', 'eu-central-2',
    'il-central-1', 'ap-southeast-6', 'ap-southeast-7', 'mx-central-1',
  ];
  
  // Query all regions in parallel — each with a 8s timeout to skip unavailable regions fast
  const timeoutMs = 8000;
  const results = await Promise.allSettled(regions.map(async (region) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const client = new ServiceQuotasClient({ region, credentials: creds });
      const resp = await client.send(new ListRequestedServiceQuotaChangeHistoryCommand({}), { abortSignal: controller.signal });
      clearTimeout(timer);
      return (resp.RequestedQuotas || []).map(r => ({ ...r, _accountId: accountId, _region: region, _currentValue: null }));
    } catch {
      clearTimeout(timer);
      return [];
    }
  }));

  for (const result of results) {
    if (result.status === 'fulfilled') allRequests.push(...result.value);
  }

  return allRequests;
}

// Lightweight version — only fetches history, no current value enrichment
// Used for batch sync where speed matters
export async function listQuotaRequestsFast(accountId: string) {
  return listQuotaRequests(accountId);
}

// Enrich requests with current values — used for single-account view
export async function enrichCurrentValues(accountId: string, requests: any[]) {
  if (requests.length === 0) return requests;
  const creds = await assumeToAccount(accountId);
  
  const byRegion: Record<string, any[]> = {};
  for (const r of requests) {
    const region = r._region || r.region || 'us-east-1';
    if (!byRegion[region]) byRegion[region] = [];
    byRegion[region].push(r);
  }

  await Promise.allSettled(Object.entries(byRegion).map(async ([region, reqs]) => {
    const client = new ServiceQuotasClient({ region, credentials: creds });
    const seen = new Set<string>();
    const valueMap: Record<string, number | null> = {};
    for (const r of reqs) {
      const sc = r.ServiceCode || r.service_code;
      const qc = r.QuotaCode || r.quota_code;
      if (!sc || !qc) continue;
      const key = `${sc}|${qc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const resp = await client.send(new GetServiceQuotaCommand({ ServiceCode: sc, QuotaCode: qc }));
        valueMap[key] = resp.Quota?.Value ?? null;
      } catch { valueMap[key] = null; }
    }
    for (const r of reqs) {
      const key = `${r.ServiceCode || r.service_code}|${r.QuotaCode || r.quota_code}`;
      r._currentValue = valueMap[key] ?? r._currentValue ?? null;
    }
  }));

  return requests;
}

export async function getAccountDetail(accountId: string) {
  let iamCreds: any;
  try { iamCreds = await assumeToAccount(accountId); } catch { iamCreds = await getAdminCredsForPayer(PAYERS[0]?.roleArn); }

  const detail: any = { cost: null, services: [], mfa: null, iamSummary: null };

  // Cost
  try {
    const payerRole = accountPayerMap.get(accountId) || PAYERS[0]?.roleArn;
    const admin = await getAdminCredsForPayer(payerRole);
    const ce = new CostExplorerClient({ region: 'us-east-1', credentials: admin });
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()).toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];
    const resp = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: startDate, End: endDate }, Granularity: 'MONTHLY', Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      Filter: { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [accountId] } },
    }));
    let total = 0;
    const services: { name: string; cost: number }[] = [];
    (resp.ResultsByTime || []).forEach(p => (p.Groups || []).forEach(g => {
      const cost = parseFloat(g.Metrics?.UnblendedCost?.Amount || '0');
      if (cost > 0) { services.push({ name: g.Keys?.[0] || '', cost }); total += cost; }
    }));
    services.sort((a, b) => b.cost - a.cost);
    detail.cost = { total, period: `${startDate} ~ ${endDate}` };
    detail.services = services;
  } catch {}

  // IAM
  try {
    const iam = new IAMClient({ region: 'us-east-1', credentials: iamCreds });
    const summary = await iam.send(new GetAccountSummaryCommand({}));
    detail.iamSummary = summary.SummaryMap;
    const rootMFA = (summary.SummaryMap?.AccountMFAEnabled || 0) > 0;
    const users = await iam.send(new ListUsersCommand({ MaxItems: 10 }));
    const mfaStatus: { user: string; hasMFA: boolean }[] = [];
    for (const u of (users.Users || []).slice(0, 10)) {
      const mfa = await iam.send(new ListMFADevicesCommand({ UserName: u.UserName }));
      mfaStatus.push({ user: u.UserName || '', hasMFA: (mfa.MFADevices || []).length > 0 });
    }
    detail.mfa = { root: rootMFA, users: mfaStatus };
  } catch {}

  return detail;
}

export async function scanResources(accountId: string, region: string) {
  const creds = await assumeToAccount(accountId);
  const resources: any[] = [];

  try {
    const ec2 = new EC2Client({ region, credentials: creds });
    const inst = await ec2.send(new DescribeInstancesCommand({}));
    (inst.Reservations || []).forEach(r => (r.Instances || []).forEach(i => {
      if (i.State?.Name !== 'terminated') resources.push({ type: 'EC2', id: i.InstanceId, name: i.Tags?.find(t => t.Key === 'Name')?.Value || i.InstanceId, arn: '', details: `${i.InstanceType} | ${i.State?.Name}` });
    }));
  } catch {}

  try {
    const ec2 = new EC2Client({ region, credentials: creds });
    const vols = await ec2.send(new DescribeVolumesCommand({}));
    (vols.Volumes || []).forEach(v => resources.push({ type: 'EBS', id: v.VolumeId, name: v.Tags?.find(t => t.Key === 'Name')?.Value || v.VolumeId, arn: '', details: `${v.Size}GB | ${v.State}` }));
  } catch {}

  if (region === 'us-east-1') {
    try {
      const s3 = new S3Client({ region, credentials: creds });
      const buckets = await s3.send(new ListBucketsCommand({}));
      (buckets.Buckets || []).forEach(b => resources.push({ type: 'S3', id: b.Name, name: b.Name, arn: '', details: '' }));
    } catch {}
  }

  try {
    const lambda = new LambdaClient({ region, credentials: creds });
    const fns = await lambda.send(new ListFunctionsCommand({}));
    (fns.Functions || []).forEach(f => resources.push({ type: 'Lambda', id: f.FunctionName, name: f.FunctionName, arn: f.FunctionArn, details: `${f.Runtime} | ${f.MemorySize}MB` }));
  } catch {}

  return resources;
}

/**
 * Generate a federated AWS Console sign-in URL for a child account.
 * Lets the user open the account's console (e.g. a Support case) without manual login.
 * Uses STS federation — free, no Business plan required.
 */
export async function getConsoleSigninUrl(accountId: string, destinationUrl: string) {
  // Get temporary credentials for the target account
  const creds = await assumeToAccount(accountId);

  // Step 1: Get a sign-in token from AWS federation endpoint
  const sessionJson = JSON.stringify({
    sessionId: creds.accessKeyId,
    sessionKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  });

  const getTokenUrl = `https://signin.aws.amazon.com/federation?Action=getSigninToken&Session=${encodeURIComponent(sessionJson)}`;
  const tokenResp = await fetch(getTokenUrl);
  if (!tokenResp.ok) {
    throw new Error(`获取登录令牌失败: ${tokenResp.status}`);
  }
  const { SigninToken } = await tokenResp.json() as { SigninToken: string };

  // Step 2: Build the login URL with the token + destination
  const loginUrl = `https://signin.aws.amazon.com/federation?Action=login` +
    `&Issuer=${encodeURIComponent('AWS-Toolbox')}` +
    `&Destination=${encodeURIComponent(destinationUrl)}` +
    `&SigninToken=${SigninToken}`;

  return loginUrl;
}

export { PAYERS, DEFAULT_REGION, assumeToAccount };
