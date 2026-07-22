/**
 * MAP 标签合规 — 编排中央工具账户里的 tag-compliance 系统。
 *
 * 平台不重写扫描/打标逻辑，而是 assume 工具账户的 tag-compliance-console-role
 * （最小权限：只能操作那一个状态机 + 读写那一个报告桶），去：
 *   - 读/写 orgs.json（组织配置）
 *   - 触发 Step Functions 扫描
 *   - 查执行状态
 *   - 读最新合规报告
 *
 * 打标本身仍由中央系统用最小权限的 auto-tagger-role 执行，安全模型不变。
 */
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { SFNClient, StartExecutionCommand, ListExecutionsCommand } from '@aws-sdk/client-sfn';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { IAMClient, GetRoleCommand } from '@aws-sdk/client-iam';
import { ResourceExplorer2Client, ListViewsCommand } from '@aws-sdk/client-resource-explorer-2';
import { CloudFormationClient, DescribeStackSetCommand } from '@aws-sdk/client-cloudformation';
import { OrganizationsClient, DescribeOrganizationCommand, ListRootsCommand, ListAccountsCommand } from '@aws-sdk/client-organizations';
import path from 'path';
import fs from 'fs';

const CONFIG_PATH = path.join(__dirname, '../../config.json');
let config: any = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch { /* fallback to env */ }

const BASE_CREDENTIALS = {
  accessKeyId: config.credentials?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || '',
  secretAccessKey: config.credentials?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '',
};

const TC = config.tagCompliance || {};
const REGION: string = TC.region || 'us-east-1';
const ORG_CONFIG_KEY: string = TC.orgConfigKey || 'config/orgs.json';

export function isConfigured(): boolean {
  return !!(TC.roleArn && TC.stateMachineArn && TC.reportsBucket);
}

function ensureConfigured() {
  if (!isConfigured()) {
    throw new Error('未配置 tagCompliance（缺 roleArn/stateMachineArn/reportsBucket），请检查 config.json');
  }
}

// assume 控制台角色，缓存凭证（50 分钟）
let credCache: { creds: any; expiry: number } | null = null;
async function getConsoleCreds() {
  if (credCache && Date.now() < credCache.expiry) return credCache.creds;
  const sts = new STSClient({ region: REGION, credentials: BASE_CREDENTIALS });
  const resp = await sts.send(new AssumeRoleCommand({
    RoleArn: TC.roleArn,
    RoleSessionName: 'toolbox-tagconsole',
    DurationSeconds: 3600,
  }));
  const creds = {
    accessKeyId: resp.Credentials!.AccessKeyId!,
    secretAccessKey: resp.Credentials!.SecretAccessKey!,
    sessionToken: resp.Credentials!.SessionToken!,
  };
  credCache = { creds, expiry: Date.now() + 50 * 60 * 1000 };
  return creds;
}

async function sfnClient() {
  ensureConfigured();
  return new SFNClient({ region: REGION, credentials: await getConsoleCreds() });
}
async function s3Client() {
  ensureConfigured();
  return new S3Client({ region: REGION, credentials: await getConsoleCreds() });
}

async function bodyToString(body: any): Promise<string> {
  if (body && typeof body.transformToString === 'function') return await body.transformToString();
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

// ---- 组织配置 orgs.json ----
export async function getOrgsConfig(): Promise<any[]> {
  const client = await s3Client();
  try {
    const resp = await client.send(new GetObjectCommand({ Bucket: TC.reportsBucket, Key: ORG_CONFIG_KEY }));
    const text = await bodyToString(resp.Body);
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e: any) {
    if (e.name === 'NoSuchKey' || e.Code === 'NoSuchKey') return [];
    throw e;
  }
}

export async function putOrgsConfig(orgs: any[]): Promise<{ count: number }> {
  if (!Array.isArray(orgs)) throw new Error('orgs 配置必须是一个数组');
  // 基础字段校验，避免写入一份会让扫描器崩掉的配置
  for (const [i, o] of orgs.entries()) {
    if (!o || typeof o !== 'object') throw new Error(`第 ${i + 1} 项不是对象`);
    for (const f of ['org_id', 'search_role_arn', 'view_arn']) {
      if (!o[f]) throw new Error(`第 ${i + 1} 项缺少必填字段 ${f}`);
    }
  }
  const client = await s3Client();
  await client.send(new PutObjectCommand({
    Bucket: TC.reportsBucket,
    Key: ORG_CONFIG_KEY,
    Body: JSON.stringify(orgs, null, 2),
    ContentType: 'application/json',
  }));
  return { count: orgs.length };
}

// ---- 触发扫描 / 执行状态 ----
export async function startScan(): Promise<{ executionArn?: string; startDate?: Date }> {
  const client = await sfnClient();
  const resp = await client.send(new StartExecutionCommand({
    stateMachineArn: TC.stateMachineArn,
    input: '{}',
  }));
  return { executionArn: resp.executionArn, startDate: resp.startDate };
}

export async function listExecutions(limit = 15) {
  const client = await sfnClient();
  const resp = await client.send(new ListExecutionsCommand({
    stateMachineArn: TC.stateMachineArn,
    maxResults: limit,
  }));
  return (resp.executions || []).map((e) => ({
    executionArn: e.executionArn,
    name: e.name,
    status: e.status,
    startDate: e.startDate,
    stopDate: e.stopDate,
  }));
}

// ---- 最新报告 ----
export async function getLatestReport(): Promise<{ key: string; generatedAt?: string; report: any } | null> {
  const client = await s3Client();
  const reportKeys: string[] = [];
  let token: string | undefined;
  do {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: TC.reportsBucket,
      Prefix: 'compliance-reports/',
      ContinuationToken: token,
    }));
    for (const o of resp.Contents || []) {
      if (o.Key && o.Key.endsWith('/report.json')) reportKeys.push(o.Key);
    }
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);

  if (reportKeys.length === 0) return null;
  // key 形如 compliance-reports/YYYY-MM-DD/HHMMSS/report.json，字典序即时间序
  reportKeys.sort();
  const latestKey = reportKeys[reportKeys.length - 1];
  const obj = await client.send(new GetObjectCommand({ Bucket: TC.reportsBucket, Key: latestKey }));
  const text = await bodyToString(obj.Body);
  // 从 key 里抽出时间：compliance-reports/2026-07-22/153045/report.json
  const m = latestKey.match(/compliance-reports\/([^/]+)\/([^/]+)\//);
  const generatedAt = m ? `${m[1]} ${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}` : undefined;
  return { key: latestKey, generatedAt, report: JSON.parse(text) };
}

// ---- 接入组织前置自检（A 档） ----
// 中央工具账户 ID（auto-tagger-role / search-role 都信任它）
function centralAccountId(): string {
  const m = String(TC.roleArn || '').match(/arn:aws:iam::(\d+):/);
  return m ? m[1] : '382309211956';
}

const PAYERS: { name: string; roleArn: string }[] = Array.isArray(config.payers) ? config.payers : [];

// 用平台基础凭证 assume 某个 payer 的 role/tool，拿到该 payer 账户内的临时凭证
async function assumePayer(payerAccountId: string) {
  const payer = PAYERS.find((p) => (p.roleArn || '').includes(`:${payerAccountId}:`));
  if (!payer) return null;
  const sts = new STSClient({ region: REGION, credentials: BASE_CREDENTIALS });
  const resp = await sts.send(new AssumeRoleCommand({
    RoleArn: payer.roleArn,
    RoleSessionName: 'toolbox-tc-precheck',
    DurationSeconds: 900,
  }));
  return {
    accessKeyId: resp.Credentials!.AccessKeyId!,
    secretAccessKey: resp.Credentials!.SecretAccessKey!,
    sessionToken: resp.Credentials!.SessionToken!,
  };
}

export interface PrecheckResult {
  reachable: boolean;
  reason?: string;
  payerAccountId: string;
  centralAccountId: string;
  orgId?: string;
  rootOuId?: string;
  accountCount?: number;
  orgError?: string;
  checks: {
    searchRole?: { status: 'ok' | 'missing' | 'unknown'; arn?: string; detail?: string };
    orgView?: { status: 'ok' | 'missing' | 'unknown'; arn?: string; detail?: string };
    stackSet?: { status: 'ok' | 'missing' | 'unknown'; detail?: string };
  };
}

/**
 * 探测某个 payer 是否已具备接入 tag-compliance 的前置条件。
 * 尽力而为：任何一项检测失败（多半是 role/tool 权限不足）都不抛错，
 * 而是标记为 unknown，前端仍会给出对应的一键 CLI。
 */
export async function precheckOrg(payerAccountId: string): Promise<PrecheckResult> {
  const central = centralAccountId();
  const creds = await assumePayer(payerAccountId);
  if (!creds) {
    return {
      reachable: false,
      reason: '该 payer 不在平台配置（config.payers）中，无法自动检测，可手动填写后添加',
      payerAccountId,
      centralAccountId: central,
      checks: {},
    };
  }
  const region = 'us-east-1';
  const result: PrecheckResult = { reachable: true, payerAccountId, centralAccountId: central, checks: {} };

  // 组织信息：org_id / 根 OU / 账户数
  try {
    const org = new OrganizationsClient({ region, credentials: creds });
    const o = await org.send(new DescribeOrganizationCommand({}));
    result.orgId = o.Organization?.Id;
    const roots = await org.send(new ListRootsCommand({}));
    result.rootOuId = roots.Roots?.[0]?.Id;
    let count = 0;
    let token: string | undefined;
    do {
      const p = await org.send(new ListAccountsCommand({ NextToken: token }));
      count += (p.Accounts || []).length;
      token = p.NextToken;
    } while (token);
    result.accountCount = count;
  } catch (e: any) {
    result.orgError = e.name || e.message;
  }

  // search-role：Resource Explorer 搜索角色
  try {
    const iam = new IAMClient({ region, credentials: creds });
    const r = await iam.send(new GetRoleCommand({ RoleName: 'resource-explorer-search-role' }));
    result.checks.searchRole = { status: 'ok', arn: r.Role?.Arn };
  } catch (e: any) {
    result.checks.searchRole = { status: e.name === 'NoSuchEntityException' ? 'missing' : 'unknown', detail: e.name };
  }

  // OrgView：Resource Explorer 聚合视图
  try {
    const re = new ResourceExplorer2Client({ region, credentials: creds });
    const v = await re.send(new ListViewsCommand({}));
    const orgView = (v.Views || []).find((arn) => arn.includes(':view/OrgView/'));
    result.checks.orgView = orgView ? { status: 'ok', arn: orgView } : { status: 'missing' };
  } catch (e: any) {
    result.checks.orgView = { status: 'unknown', detail: e.name };
  }

  // StackSet：AutoTaggerRole（打标角色，SERVICE_MANAGED 自动部署到成员账户）
  try {
    const cfn = new CloudFormationClient({ region, credentials: creds });
    await cfn.send(new DescribeStackSetCommand({ StackSetName: 'AutoTaggerRole', CallAs: 'SELF' }));
    result.checks.stackSet = { status: 'ok' };
  } catch (e: any) {
    result.checks.stackSet = { status: e.name === 'StackSetNotFoundException' ? 'missing' : 'unknown', detail: e.name };
  }

  return result;
}
