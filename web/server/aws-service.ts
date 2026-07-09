/**
 * AWS Service Layer — reads config from shared config.json
 */
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { OrganizationsClient, ListAccountsCommand } from '@aws-sdk/client-organizations';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { ServiceQuotasClient, ListServiceQuotasCommand, RequestServiceQuotaIncreaseCommand, ListRequestedServiceQuotaChangeHistoryCommand, GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';
import { IAMClient, GetAccountSummaryCommand, ListMFADevicesCommand, ListUsersCommand } from '@aws-sdk/client-iam';
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand } from '@aws-sdk/client-ec2';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import path from 'path';
import fs from 'fs';

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

async function getAdminCredsForPayer(payerRoleArn: string) {
  const cached = adminCredsCache.get(payerRoleArn);
  if (cached && Date.now() < cached.expiry) return cached.creds;

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
  // 兜底：如果 accountId 本身就是一个 payer 账号，直接用 payer role 的 admin creds
  // （payer 账号一般没有 CHILD_ROLE_NAME=OrganizationAccountAccessRole，无法 AssumeRole）
  const selfPayer = PAYERS.find(p => {
    const m = /arn:aws:iam::(\d+):role\//.exec(p.roleArn);
    return m && m[1] === accountId;
  });
  if (selfPayer) {
    return await getAdminCredsForPayer(selfPayer.roleArn);
  }

  const roleArn = `arn:aws:iam::${accountId}:role/${CHILD_ROLE_NAME}`;

  // Try known payer first
  const knownPayer = accountPayerMap.get(accountId);
  if (knownPayer) {
    const admin = await getAdminCredsForPayer(knownPayer);
    const sts = new STSClient({ region: DEFAULT_REGION, credentials: admin });
    const resp = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: `web-${accountId}`, DurationSeconds: 3600 }));
    return { accessKeyId: resp.Credentials!.AccessKeyId!, secretAccessKey: resp.Credentials!.SecretAccessKey!, sessionToken: resp.Credentials!.SessionToken! };
  }

  // Try all payers
  for (const payer of PAYERS) {
    try {
      const admin = await getAdminCredsForPayer(payer.roleArn);
      const sts = new STSClient({ region: DEFAULT_REGION, credentials: admin });
      const resp = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: `web-${accountId}`, DurationSeconds: 3600 }));
      accountPayerMap.set(accountId, payer.roleArn);
      return { accessKeyId: resp.Credentials!.AccessKeyId!, secretAccessKey: resp.Credentials!.SecretAccessKey!, sessionToken: resp.Credentials!.SessionToken! };
    } catch { continue; }
  }
  throw new Error(`无法 AssumeRole 到 ${accountId}`);
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
