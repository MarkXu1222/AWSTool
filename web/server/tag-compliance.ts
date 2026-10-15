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
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import { AccountClient, GetRegionOptStatusCommand, EnableRegionCommand, ListRegionsCommand } from '@aws-sdk/client-account';
import { SFNClient, StartExecutionCommand, ListExecutionsCommand } from '@aws-sdk/client-sfn';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { SNSClient, ListSubscriptionsByTopicCommand, SubscribeCommand, UnsubscribeCommand } from '@aws-sdk/client-sns';
import {
  IAMClient, GetRoleCommand, CreateRoleCommand, ListAttachedRolePoliciesCommand, PutRolePolicyCommand,
  DetachRolePolicyCommand, UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  ResourceExplorer2Client, ListViewsCommand, CreateViewCommand,
  GetIndexCommand, CreateIndexCommand, UpdateIndexTypeCommand, ListIndexesForMembersCommand,
} from '@aws-sdk/client-resource-explorer-2';
import {
  CloudFormationClient, DescribeStackSetCommand, CreateStackSetCommand, UpdateStackSetCommand,
  CreateStackInstancesCommand, UpdateStackInstancesCommand, DeleteStackInstancesCommand,
  ListStackInstancesCommand, ListStackSetOperationsCommand,
  ListStackSetAutoDeploymentTargetsCommand,
} from '@aws-sdk/client-cloudformation';
import {
  OrganizationsClient, DescribeOrganizationCommand, ListRootsCommand, ListAccountsCommand,
  EnableAWSServiceAccessCommand, ListAWSServiceAccessForOrganizationCommand,
} from '@aws-sdk/client-organizations';
import path from 'path';
import fs from 'fs';
import { db } from './db';
import { assumeSupportRoleStrict, assumeToAccount, getTempAdminCredentials } from './aws-service';

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

function awsErrorDetail(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const value = error as { name?: string; message?: string; $metadata?: { requestId?: string } };
  const name = value.name || 'AwsError';
  const message = value.message && value.message !== name ? value.message : '';
  const requestId = value.$metadata?.requestId;
  return `[${name}]${message ? ` ${message}` : ''}${requestId ? ` (requestId: ${requestId})` : ''}`;
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
let orgConfigWriteQueue: Promise<void> = Promise.resolve();

function withOrgConfigWriteLock<T>(work: () => Promise<T>): Promise<T> {
  const operation = orgConfigWriteQueue.then(work, work);
  orgConfigWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/**
 * MAP 主标签的 key —— 业务纪律，固定不可改。
 * 每个组织只能自定义它的 value（orgs.json 的 tag_value）。
 */
export const MAP_TAG_KEY = 'map-migrated';

/** AWS 的 tag key 长度上限 128，value 上限 256 */
const TAG_KEY_MAX = 128;
const TAG_VALUE_MAX = 256;

/** tag key/value 允许的字符集（AWS 通用规则） */
const TAG_CHAR_RE = /^[\w\s+\-=.:/@]+$/;

/**
 * 校验组织的「额外自定义标签」。
 *
 * 业务背景：MAP 标签 `map-migrated` 是固定纪律不能动，但不同组织有各自的
 * 成本归集需求（如 Project / CostCenter），所以允许每个组织**额外**再打
 * 一组 kv。留空表示不打额外标签。
 *
 * ⚠️ key 不允许再写 `map-migrated` —— 那会和主标签撞车，
 * 谁后写谁生效，属于难排查的静默覆盖。
 */
function normalizeExtraTag(org: any, index: number):
  { extra_tag_key?: string; extra_tag_value?: string } {
  const rawKey = typeof org.extra_tag_key === 'string' ? org.extra_tag_key.trim() : '';
  const rawValue = typeof org.extra_tag_value === 'string'
    ? org.extra_tag_value.trim() : '';

  // 两者都空 = 不配额外标签，合法
  if (!rawKey && !rawValue) return {};

  // 只填一半是配置错误：单独的 key 或 value 都打不出标签，
  // 静默忽略会让用户以为配好了
  if (!rawKey) {
    throw new Error(`第 ${index + 1} 项填了 extra_tag_value 但没有 extra_tag_key`);
  }
  if (!rawValue) {
    throw new Error(`第 ${index + 1} 项填了 extra_tag_key 但没有 extra_tag_value`);
  }

  if (rawKey.length > TAG_KEY_MAX) {
    throw new Error(`第 ${index + 1} 项 extra_tag_key 超过 ${TAG_KEY_MAX} 字符`);
  }
  if (rawValue.length > TAG_VALUE_MAX) {
    throw new Error(`第 ${index + 1} 项 extra_tag_value 超过 ${TAG_VALUE_MAX} 字符`);
  }
  if (!TAG_CHAR_RE.test(rawKey)) {
    throw new Error(`第 ${index + 1} 项 extra_tag_key 含非法字符：${rawKey}`);
  }
  if (!TAG_CHAR_RE.test(rawValue)) {
    throw new Error(`第 ${index + 1} 项 extra_tag_value 含非法字符：${rawValue}`);
  }
  // aws: 前缀是 AWS 保留的，打不上去
  if (/^aws:/i.test(rawKey)) {
    throw new Error(`第 ${index + 1} 项 extra_tag_key 不能以 aws: 开头（AWS 保留前缀）`);
  }
  if (rawKey.toLowerCase() === MAP_TAG_KEY) {
    throw new Error(
      `第 ${index + 1} 项 extra_tag_key 不能是 ${MAP_TAG_KEY} —— `
      + '它由 tag_value 单独控制，重复配置会互相覆盖');
  }

  return { extra_tag_key: rawKey, extra_tag_value: rawValue };
}

function normalizeOrgsConfig(orgs: any[]): any[] {
  if (!Array.isArray(orgs)) throw new Error('orgs 配置必须是一个数组');

  return orgs.map((org, index) => {
    if (!org || typeof org !== 'object') throw new Error(`第 ${index + 1} 项不是对象`);
    for (const field of ['org_id', 'search_role_arn', 'view_arn']) {
      if (!org[field]) throw new Error(`第 ${index + 1} 项缺少必填字段 ${field}`);
    }
    const tagValue = typeof org.tag_value === 'string' ? org.tag_value.trim() : '';
    if (!tagValue) throw new Error(`第 ${index + 1} 项缺少必填字段 tag_value`);

    // 额外自定义标签：空值必须**删掉键**而不是留空串 —— 中央 Lambda
    // 若按「字段存在」判断是否打标，空串会让它尝试打一个空 key 的标签。
    const extra = normalizeExtraTag(org, index);
    const normalizedOrg: any = { ...org, tag_value: tagValue };
    delete normalizedOrg.extra_tag_key;
    delete normalizedOrg.extra_tag_value;
    Object.assign(normalizedOrg, extra);

    // 中央 search Lambda 的配置契约是逗号分隔字符串。兼容页面旧版本
    // 已产生的数组输入，但落盘前必须统一为字符串，否则扫描器调用 split() 会失败。
    const rawExclude = org.exclude_accounts;
    if (rawExclude === undefined || rawExclude === null || rawExclude === '') return normalizedOrg;
    if (!Array.isArray(rawExclude) && typeof rawExclude !== 'string') {
      throw new Error(`第 ${index + 1} 项 exclude_accounts 必须是字符串或账户 ID 数组`);
    }
    const accountIds = (Array.isArray(rawExclude) ? rawExclude : rawExclude.split(','))
      .map((value: any) => String(value).trim())
      .filter(Boolean);
    const invalid = accountIds.find((accountId: string) => !/^\d{12}$/.test(accountId));
    if (invalid) throw new Error(`第 ${index + 1} 项包含不合法的排除账户 ID: ${invalid}`);

    return { ...normalizedOrg, exclude_accounts: [...new Set(accountIds)].join(',') };
  });
}

/** 仅供测试：规范化逻辑含多条静默故障防线，需要单独覆盖 */
export function __test__normalizeOrgsConfig(orgs: any[]): any[] {
  return normalizeOrgsConfig(orgs);
}

export interface OrgsConfigSnapshot {
  orgs: any[];
  etag: string | null;
  versionId?: string;
  exists: boolean;
}

export class OrgConfigConflictError extends Error {
  code = 'ORG_CONFIG_CONFLICT';
  constructor(message = '组织配置已被其他任务更新，请重新加载后再保存') { super(message); }
}

function isS3PreconditionFailed(error: any): boolean {
  return error?.name === 'PreconditionFailed'
    || error?.Code === 'PreconditionFailed'
    || error?.$metadata?.httpStatusCode === 412;
}

async function writeOrgsConfig(
  orgs: any[],
  condition: { etag: string | null },
): Promise<{ count: number; etag: string | null; versionId?: string }> {
  const client = await s3Client();
  try {
    const response = await client.send(new PutObjectCommand({
      Bucket: TC.reportsBucket,
      Key: ORG_CONFIG_KEY,
      Body: JSON.stringify(orgs, null, 2),
      ContentType: 'application/json',
      ...(condition.etag ? { IfMatch: condition.etag } : { IfNoneMatch: '*' }),
    }));
    return { count: orgs.length, etag: response.ETag || null, versionId: response.VersionId };
  } catch (error: any) {
    if (isS3PreconditionFailed(error)) throw new OrgConfigConflictError();
    throw error;
  }
}

export async function getOrgsConfigSnapshot(): Promise<OrgsConfigSnapshot> {
  const client = await s3Client();
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: TC.reportsBucket, Key: ORG_CONFIG_KEY }));
    const text = await bodyToString(response.Body);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error('S3 组织配置格式损坏：config/orgs.json 根节点必须是数组，已拒绝覆盖');
    }
    return { orgs: parsed, etag: response.ETag || null, versionId: response.VersionId, exists: true };
  } catch (error: any) {
    if (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey') {
      return { orgs: [], etag: null, exists: false };
    }
    throw error;
  }
}

export async function getOrgsConfig(): Promise<any[]> {
  return (await getOrgsConfigSnapshot()).orgs;
}

export async function putOrgsConfig(
  orgs: any[],
  expectedEtag: string | null,
): Promise<{ count: number; etag: string | null; versionId?: string }> {
  return withOrgConfigWriteLock(async () => writeOrgsConfig(normalizeOrgsConfig(orgs), { etag: expectedEtag }));
}

export interface OrgConfigUpsertInput {
  payerAccountId: string;
  orgId: string;
  searchRoleArn: string;
  viewArn: string;
  tagValue: string;
  /**
   * 额外自定义标签（可选）。两者要么都给、要么都不给。
   * 传空串表示**清除**已有的额外标签。
   */
  extraTagKey?: string;
  extraTagValue?: string;
}

/**
 * 按组织 ID（或 payer ARN）原子地更新单个组织配置，避免后台任务与页面全量保存互相覆盖。
 * 新组织默认排除 payer 管理账户；更新已有组织时保留其现有排除列表。
 */
export async function upsertOrgConfig(input: OrgConfigUpsertInput): Promise<{ count: number; created: boolean; org: any; etag: string | null }> {
  if (!/^\d{12}$/.test(input.payerAccountId)) throw new Error('payerAccountId 必须是 12 位账户 ID');
  if (!/^o-[a-z0-9]{10,32}$/.test(input.orgId)) throw new Error(`组织 ID 不合法: ${input.orgId}`);
  const tagValue = String(input.tagValue || '').trim();
  if (!tagValue) throw new Error('tag_value 必填');

  return withOrgConfigWriteLock(async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const snapshot = await getOrgsConfigSnapshot();
      const current = snapshot.orgs;
      const payerArnPattern = new RegExp(`^arn:aws:iam::${input.payerAccountId}:role/`);
      const index = current.findIndex(org =>
        org?.org_id === input.orgId || payerArnPattern.test(String(org?.search_role_arn || '')));
      const created = index < 0;
      const existing = created ? {} : current[index];
      const candidate: any = {
        ...existing,
        org_id: input.orgId,
        search_role_arn: input.searchRoleArn,
        view_arn: input.viewArn,
        tag_value: tagValue,
      };

      // 额外标签：只有调用方**显式传了**才改动，否则保留 existing 里的值。
      // 用 undefined 区分「没传」与「传空串要清除」—— 一键接入不传这两个
      // 字段时，不能把用户先前配好的额外标签抹掉。
      if (input.extraTagKey !== undefined || input.extraTagValue !== undefined) {
        const k = String(input.extraTagKey || '').trim();
        const v = String(input.extraTagValue || '').trim();
        if (k || v) {
          candidate.extra_tag_key = k;
          candidate.extra_tag_value = v;
        } else {
          delete candidate.extra_tag_key;
          delete candidate.extra_tag_value;
        }
      }
      // 2026-09-18 起不再默认排除 payer 自身：业务要求 payer 管理账户的资源
      // 同样要打 MAP 标签。配套改动是 provisionOrg 会在 payer 账户内单独创建
      // auto-tagger-role（SERVICE_MANAGED StackSet 覆盖不到管理账户）。
      // 仍允许调用方显式传 exclude_accounts 排除特定账户。

      const next = [...current];
      if (created) next.push(candidate);
      else next[index] = candidate;
      const normalized = normalizeOrgsConfig(next);
      try {
        await writeOrgsConfig(normalized, { etag: snapshot.etag });
      } catch (error) {
        if (error instanceof OrgConfigConflictError && attempt < 5) continue;
        throw error;
      }

      // S3 PUT 成功后回读并核对关键字段，任务只有在最终配置可见时才算完成。
      const verifiedSnapshot = await getOrgsConfigSnapshot();
      const verified = verifiedSnapshot.orgs.find(org => org?.org_id === input.orgId);
      if (!verified
        || verified.search_role_arn !== input.searchRoleArn
        || verified.view_arn !== input.viewArn
        || verified.tag_value !== tagValue) {
        throw new Error('S3 组织配置写入后回读校验失败');
      }
      // 额外标签同样要回读核对：写进去但没落盘会让用户以为配好了，
      // 而扫描器读到的仍是旧值
      const expectKey = candidate.extra_tag_key || undefined;
      const expectValue = candidate.extra_tag_value || undefined;
      if ((verified.extra_tag_key || undefined) !== expectKey
        || (verified.extra_tag_value || undefined) !== expectValue) {
        throw new Error('S3 组织配置的额外标签写入后回读校验失败');
      }
      return { count: normalized.length, created, org: verified, etag: verifiedSnapshot.etag };
    }
    throw new OrgConfigConflictError('组织配置持续发生并发更新，后台合并重试已达上限');
  });
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
    result.orgError = awsErrorDetail(e);
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

// ============================================================
// 组织 → payer 名称映射
// orgs.json 里没有 payer 名字，但 search_role_arn 里带着 payer 账户 ID，
// 用它去 config.payers 里反查名字，供报告/配置页展示。
// ============================================================
export async function getOrgPayerMap(): Promise<Record<string, { payerAccountId: string; payerName: string }>> {
  const map: Record<string, { payerAccountId: string; payerName: string }> = {};
  let orgs: any[] = [];
  try { orgs = await getOrgsConfig(); } catch { return map; }

  // 账户缓存兜底：payer 不在 config.payers 里但在我们组织树内时，仍能拿到账户名
  let cached: any[] = [];
  try { cached = (db.getAccountsCache()?.accounts || []) as any[]; } catch { /* 缓存不可用则忽略 */ }

  for (const o of orgs) {
    const orgId = o?.org_id;
    if (!orgId) continue;
    const m = /arn:aws:iam::(\d+):role\//.exec(String(o.search_role_arn || ''));
    const payerAccountId = m ? m[1] : '';
    const payer = payerAccountId ? PAYERS.find(p => (p.roleArn || '').includes(`:${payerAccountId}:`)) : undefined;
    const cachedAcct = payerAccountId ? cached.find((a: any) => a.Id === payerAccountId) : undefined;
    map[orgId] = {
      payerAccountId,
      payerName: payer?.name || cachedAcct?.Name || '',
    };
  }
  return map;
}

// ============================================================
// 一键接入：自动补齐组织的前置资源
// 对应 RE-AUTOTAG「添加新组织」文档的 2.2 / 2.3 / 2.4 步，
// 用平台已有的 payer role/tool 管理员凭证执行，全部幂等，可重复运行。
// ============================================================

const AUTO_TAGGER_STACKSET_NAME = 'AutoTaggerRole';
const SEARCH_ROLE_NAME = 'resource-explorer-search-role';
/** 早期挂在 search-role 上的托管只读策略，已由内联 SearchPolicy 取代 */
const SEARCH_ROLE_LEGACY_POLICIES = [
  'arn:aws:iam::aws:policy/AWSResourceExplorerReadOnlyAccess',
  'arn:aws:iam::aws:policy/AWSOrganizationsReadOnlyAccess',
];
const AUTO_TAGGER_STACKSET_DESCRIPTION = 'IAM role for central tag-compliance auto-tagger (managed by AWSTool)';
const READ_ONLY_ACCESS_ARN = 'arn:aws:iam::aws:policy/ReadOnlyAccess';
const ORG_VIEW_NAME = 'OrgView';

// auto-tagger-role StackSet 模板（与 RE-AUTOTAG 项目 stacksets/auto-tagger-role.yaml 保持一致）。
// 打标用 TagResources API，除 tag:TagResources 外还需各服务自身的打标权限，故权限列表很长。
export const AUTO_TAGGER_ROLE_TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Description: >
  IAM role for the central MAP tag-compliance auto-tagger (managed by AWSTool).
  Least privilege: tag-write actions only. Deploy to ONE region per account (IAM is global).

Parameters:
  CentralToolingAccountId:
    Type: String
    Description: Account ID of the central tooling account where the tagger Lambda runs
  AllowedTagKeys:
    Type: CommaDelimitedList
    Default: map-migrated
    Description: Tag keys the role may write when EnforceTagKeys is true
  EnforceTagKeys:
    Type: String
    Default: "false"
    AllowedValues: ["true", "false"]
    Description: Restrict writes to AllowedTagKeys via aws:TagKeys

Conditions:
  EnforceTagKeysEnabled: !Equals [!Ref EnforceTagKeys, "true"]

Resources:
  AutoTaggerRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: auto-tagger-role
      Description: Central MAP tag-compliance auto-tagger (managed by AWSTool)
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              AWS: !Sub "arn:aws:iam::\${CentralToolingAccountId}:root"
            Action: sts:AssumeRole
            Condition:
              StringLike:
                "aws:PrincipalArn": !Sub "arn:aws:iam::\${CentralToolingAccountId}:role/tag-compliance*"
      Policies:
        - PolicyName: AutoTagPolicy
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: TagWrite
                Effect: Allow
                Action:
                  - tag:TagResources
                  - ec2:CreateTags
                  - lambda:TagResource
                  - ecs:TagResource
                  - eks:TagResource
                  - elasticloadbalancing:AddTags
                  - autoscaling:CreateOrUpdateTags
                  - apprunner:TagResource
                  - elasticbeanstalk:AddTags
                  - batch:TagResource
                  - s3:PutBucketTagging
                  - s3:TagResource
                  - s3:GetBucketTagging
                  - elasticfilesystem:TagResource
                  - fsx:TagResource
                  - storagegateway:AddTagsToResource
                  - backup:TagResource
                  - rds:AddTagsToResource
                  - dynamodb:TagResource
                  - elasticache:AddTagsToResource
                  - redshift:CreateTags
                  - es:AddTags
                  - memorydb:TagResource
                  - dms:AddTagsToResource
                  - cloudfront:TagResource
                  - globalaccelerator:TagResource
                  - network-firewall:TagResource
                  - sqs:TagQueue
                  - sns:TagResource
                  - events:TagResource
                  - states:TagResource
                  - kinesis:AddTagsToStream
                  - firehose:TagDeliveryStream
                  - kafka:TagResource
                  - airflow:TagResource
                  - mq:CreateTags
                  - appsync:TagResource
                  - athena:TagResource
                  - glue:TagResource
                  - emr-serverless:TagResource
                  - elasticmapreduce:AddTags
                  - kinesisanalytics:TagResource
                  - quicksight:TagResource
                  - sagemaker:AddTags
                  - bedrock:TagResource
                  - comprehend:TagResource
                  - rekognition:TagResource
                  - kendra:TagResource
                  - personalize:TagResource
                  - forecast:TagResource
                  - kms:TagResource
                  - secretsmanager:TagResource
                  - acm-pca:TagCertificateAuthority
                  - wafv2:TagResource
                  - cognito-idp:TagResource
                  - cognito-identity:TagResource
                  - logs:TagLogGroup
                  - logs:TagResource
                  - cloudwatch:TagResource
                  - cloudtrail:AddTags
                  - config:TagResource
                  - ssm:AddTagsToResource
                  - cloudformation:TagResource
                  - iam:TagRole
                  - iam:TagUser
                  - iam:TagPolicy
                  - iam:TagInstanceProfile
                  - iam:TagOpenIDConnectProvider
                  - iam:TagSAMLProvider
                  - ecr:TagResource
                  - ds:AddTagsToResource
                  - ses:TagResource
                  - connect:TagResource
                  - gamelift:TagResource
                  - ivs:TagResource
                  - codepipeline:TagResource
                  - codecommit:TagResource
                  - codeconnections:TagResource
                  - transfer:TagResource
                  - datasync:TagResource
                  - m2:TagResource
                  - refactor-spaces:TagResource
                  - vpc-lattice:TagResource
                  - servicediscovery:TagResource
                  - directconnect:TagResource
                  - shield:TagResource
                  - lex:TagResource
                  - healthlake:TagResource
                  - omics:TagResource
                  - frauddetector:TagResource
                  - iot:TagResource
                  - iotevents:TagResource
                  - iotfleetwise:TagResource
                  - iotsitewise:TagResource
                  - iottwinmaker:TagResource
                  - greengrass:TagResource
                  - databrew:TagResource
                  - kinesisvideo:TagResource
                  - dataexchange:TagResource
                  - emr-containers:TagResource
                  - synthetics:TagResource
                  - rum:TagResource
                  - ssm-incidents:TagResource
                  - fis:TagResource
                  - codebuild:TagResource
                  - codeartifact:TagResource
                  - mediapackage:TagResource
                  - mediatailor:TagResource
                  - mobiletargeting:TagResource
                  - pipes:TagResource
                  - resource-explorer-2:TagResource
                  - oam:TagResource
                  - ram:TagResource
                  - amplify:TagResource
                  - appstream:TagResource
                  - workspaces:CreateTags
                  - workspaces-web:TagResource
                  - grafana:TagResource
                  - aps:TagResource
                  - appflow:TagResource
                  - managedblockchain:TagResource
                  - outposts:TagResource
                  - groundstation:TagResource
                  - backup-gateway:TagResource
                  - route53-recovery-control:TagResource
                  - route53-recovery-readiness:TagResource
                  - devicefarm:TagResource
                  - app-integrations:TagResource
                  - dax:TagResource
                  - aoss:TagResource
                  - glacier:TagResource
                Resource: "*"
                Condition: !If
                  - EnforceTagKeysEnabled
                  - "ForAllValues:StringEquals":
                      "aws:TagKeys": !Ref AllowedTagKeys
                  - !Ref "AWS::NoValue"
              - Sid: ApiGatewayTagWrite
                Effect: Allow
                Action:
                  - apigateway:PUT
                  - apigateway:POST
                Resource:
                  - "arn:aws:apigateway:*::/tags/*"
                Condition: !If
                  - EnforceTagKeysEnabled
                  - "ForAllValues:StringEquals":
                      "aws:TagKeys": !Ref AllowedTagKeys
                  - !Ref "AWS::NoValue"
      Tags:
        - Key: Purpose
          Value: AutoTagger
        - Key: ManagedBy
          Value: AWSTool
`;

export type ProvisionStatus = 'ok' | 'created' | 'skipped' | 'pending' | 'failed';
export interface ProvisionStep {
  key: string;
  label: string;
  status: ProvisionStatus;
  detail?: string;
}
export interface ProvisionResult {
  payerAccountId: string;
  centralAccountId: string;
  orgId?: string;
  rootOuId?: string;
  steps: ProvisionStep[];
  searchRoleArn?: string;
  viewArn?: string;
  /** 是否还有未完成项（多为 RE 聚合索引仍在创建/升级），需稍后重跑 */
  needsRetry: boolean;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * 幂等地为某个 payer 组织补齐 tag-compliance 前置资源。
 * 步骤：开启 RE 跨账户访问 → payer 聚合索引 → OrgView → search-role → AutoTaggerRole StackSet。
 * 任一步失败不会中断后续独立步骤；RE 索引尚未 ACTIVE 时相关步骤标为 pending，稍后重跑即可。
 */
export interface ProvisionOptions {
  /** 接入任务传入；手工「一键接入」不传则沿用 StackSet 现值 */
  allowedTagKeys?: string[];
}

export async function provisionOrg(payerAccountId: string, opts: ProvisionOptions = {}): Promise<ProvisionResult> {
  const central = centralAccountId();
  const region = 'us-east-1';
  const steps: ProvisionStep[] = [];
  const out: ProvisionResult = { payerAccountId, centralAccountId: central, steps, needsRetry: false };

  const creds = await assumePayer(payerAccountId);
  if (!creds) {
    throw new Error('该 payer 不在平台配置（config.payers）中，无法自动接入；请先加入 payer 或手动执行 CLI');
  }

  const org = new OrganizationsClient({ region, credentials: creds });
  const re = new ResourceExplorer2Client({ region, credentials: creds });
  const iam = new IAMClient({ region, credentials: creds });
  const cfn = new CloudFormationClient({ region, credentials: creds });

  // 组织信息（org_id / 根 OU）
  try {
    const o = await org.send(new DescribeOrganizationCommand({}));
    out.orgId = o.Organization?.Id;
    const roots = await org.send(new ListRootsCommand({}));
    out.rootOuId = roots.Roots?.[0]?.Id;
  } catch (e: any) {
    steps.push({ key: 'org', label: '读取组织信息', status: 'failed', detail: awsErrorDetail(e) });
    out.needsRetry = true;
    return out;
  }

  // ---- 1. 开启 Resource Explorer 组织级服务访问 ----
  try {
    let enabled = false;
    let token: string | undefined;
    do {
      const p = await org.send(new ListAWSServiceAccessForOrganizationCommand({ NextToken: token }));
      if ((p.EnabledServicePrincipals || []).some(s => s.ServicePrincipal === 'resource-explorer-2.amazonaws.com')) enabled = true;
      token = p.NextToken;
    } while (token && !enabled);
    if (enabled) {
      steps.push({ key: 'serviceAccess', label: '开启 Resource Explorer 跨账户访问', status: 'skipped', detail: '已开启' });
    } else {
      await org.send(new EnableAWSServiceAccessCommand({ ServicePrincipal: 'resource-explorer-2.amazonaws.com' }));
      steps.push({ key: 'serviceAccess', label: '开启 Resource Explorer 跨账户访问', status: 'created' });
    }
  } catch (e: any) {
    steps.push({ key: 'serviceAccess', label: '开启 Resource Explorer 跨账户访问', status: 'failed', detail: awsErrorDetail(e) });
    out.needsRetry = true;
  }

  // ---- 2. payer 自身的 Resource Explorer 聚合索引 ----
  // Quick Setup 不覆盖管理账户；组织级 View 要求管理账户在该区域有 AGGREGATOR 索引。
  let indexReady = false;
  try {
    let idx: any = null;
    try { idx = await re.send(new GetIndexCommand({})); }
    catch (e: any) { if (e.name !== 'ResourceNotFoundException') throw e; }

    if (!idx) {
      await re.send(new CreateIndexCommand({}));
      // 新建索引默认 LOCAL，需等 ACTIVE 后升级为 AGGREGATOR
      for (let i = 0; i < 20; i++) {
        await sleep(3000);
        try {
          const s = await re.send(new GetIndexCommand({}));
          if (s.State === 'ACTIVE') { idx = s; break; }
        } catch { /* 继续等 */ }
      }
      if (!idx) {
        steps.push({ key: 'reIndex', label: 'payer 聚合索引 (Resource Explorer)', status: 'pending', detail: '索引已创建，正在初始化，请稍后重跑以继续升级为聚合索引' });
        out.needsRetry = true;
      }
    }

    if (idx) {
      if (idx.Type === 'AGGREGATOR' && idx.State === 'ACTIVE') {
        indexReady = true;
        steps.push({ key: 'reIndex', label: 'payer 聚合索引 (Resource Explorer)', status: 'skipped', detail: '已是 ACTIVE 聚合索引' });
      } else if (idx.Type === 'LOCAL' && idx.State === 'ACTIVE') {
        await re.send(new UpdateIndexTypeCommand({ Arn: idx.Arn!, Type: 'AGGREGATOR' }));
        steps.push({ key: 'reIndex', label: 'payer 聚合索引 (Resource Explorer)', status: 'pending', detail: '已提交 LOCAL→AGGREGATOR 升级，AWS 侧生效可能需要较长时间，稍后重跑' });
        out.needsRetry = true;
      } else {
        steps.push({ key: 'reIndex', label: 'payer 聚合索引 (Resource Explorer)', status: 'pending', detail: `索引状态 ${idx.State}/${idx.Type}，等待 ACTIVE 后重跑` });
        out.needsRetry = true;
      }
    }
  } catch (e: any) {
    steps.push({ key: 'reIndex', label: 'payer 聚合索引 (Resource Explorer)', status: 'failed', detail: awsErrorDetail(e) });
    out.needsRetry = true;
  }

  // ---- 3. 组织级 OrgView ----
  try {
    const views = await re.send(new ListViewsCommand({}));
    const existing = (views.Views || []).find(a => a.includes(`:view/${ORG_VIEW_NAME}/`));
    if (existing) {
      out.viewArn = existing;
      steps.push({ key: 'orgView', label: '组织级 OrgView', status: 'skipped', detail: '已存在' });
    } else if (!indexReady) {
      steps.push({ key: 'orgView', label: '组织级 OrgView', status: 'pending', detail: '需等聚合索引就绪后才能创建，稍后重跑' });
      out.needsRetry = true;
    } else {
      const v = await re.send(new CreateViewCommand({
        ViewName: ORG_VIEW_NAME,
        IncludedProperties: [{ Name: 'tags' }],
        Scope: `arn:aws:organizations::${payerAccountId}:organization/${out.orgId}`,
      }));
      out.viewArn = v.View?.ViewArn;
      steps.push({ key: 'orgView', label: '组织级 OrgView', status: 'created', detail: out.viewArn });
    }
  } catch (e: any) {
    steps.push({ key: 'orgView', label: '组织级 OrgView', status: 'failed', detail: awsErrorDetail(e) });
    out.needsRetry = true;
  }

  // ---- 4. search-role（只信任中央 tag-compliance* 角色，只能列 OrgView 资源与组织账户） ----
  try {
    const trust = buildCentralTrust(central);
    const changes: string[] = [];
    let exists = false;
    try {
      const r = await iam.send(new GetRoleCommand({ RoleName: SEARCH_ROLE_NAME }));
      exists = true;
      out.searchRoleArn = r.Role?.Arn;
      if (!samePolicyDocument(r.Role?.AssumeRolePolicyDocument || '{}', trust)) {
        await iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: SEARCH_ROLE_NAME, PolicyDocument: JSON.stringify(trust) }));
        changes.push('信任策略已收紧为中央 tag-compliance* 角色');
      }
    } catch (e: any) { if (e.name !== 'NoSuchEntityException') throw e; }

    if (!exists) {
      const r = await iam.send(new CreateRoleCommand({
        RoleName: SEARCH_ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify(trust),
        Description: 'Resource Explorer search role for central tag-compliance scanner',
        MaxSessionDuration: 3600,
        Tags: [{ Key: 'Purpose', Value: 'TagCompliance' }],
      }));
      out.searchRoleArn = r.Role?.Arn;
    }
    // 先写最小内联策略，再摘旧托管策略 —— 中间任何一步失败都不会让扫描器无权限
    await iam.send(new PutRolePolicyCommand({
      RoleName: SEARCH_ROLE_NAME, PolicyName: 'SearchPolicy',
      PolicyDocument: JSON.stringify(buildSearchRolePolicy(payerAccountId, region)),
    }));
    const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: SEARCH_ROLE_NAME }));
    for (const policy of attached.AttachedPolicies || []) {
      if (!SEARCH_ROLE_LEGACY_POLICIES.includes(policy.PolicyArn || '')) continue;
      await iam.send(new DetachRolePolicyCommand({ RoleName: SEARCH_ROLE_NAME, PolicyArn: policy.PolicyArn }));
      changes.push(`已移除 ${policy.PolicyName}`);
    }
    steps.push({
      key: 'searchRole', label: 'Resource Explorer 搜索角色',
      status: !exists || changes.length ? 'created' : 'skipped',
      detail: changes.length ? changes.join('；') : out.searchRoleArn,
    });
  } catch (e: any) {
    steps.push({ key: 'searchRole', label: 'Resource Explorer 搜索角色', status: 'failed', detail: awsErrorDetail(e) });
    out.needsRetry = true;
  }

  // ---- 5. AutoTaggerRole StackSet + 部署到根 OU ----
  // 步骤 6 的 payer 角色要与成员模板使用同一组 TagKeys 设置；步骤 5 没取到设置时步骤 6 不改策略，
  // 否则已开启的 TagKeys 限制会被一次瞬时失败悄悄放宽
  let taggerPolicyOpts: { allowedTagKeys: string[]; enforceTagKeys: boolean } | null = null;
  try {
    let existing: { TemplateBody?: string; Parameters?: CfnParam[] } | null = null;
    try {
      const d = await cfn.send(new DescribeStackSetCommand({ StackSetName: AUTO_TAGGER_STACKSET_NAME, CallAs: 'SELF' }));
      existing = { TemplateBody: d.StackSet?.TemplateBody, Parameters: d.StackSet?.Parameters };
    } catch (e: any) { if (e.name !== 'StackSetNotFoundException') throw e; }
    const stackSetExists = !!existing;
    const desired = resolveAutoTaggerParams(central, opts.allowedTagKeys, existing?.Parameters);
    taggerPolicyOpts = { allowedTagKeys: desired.AllowedTagKeys.split(','), enforceTagKeys: desired.EnforceTagKeys === 'true' };

    if (!stackSetExists) {
      await cfn.send(new CreateStackSetCommand({
        StackSetName: AUTO_TAGGER_STACKSET_NAME,
        Description: AUTO_TAGGER_STACKSET_DESCRIPTION,
        TemplateBody: AUTO_TAGGER_ROLE_TEMPLATE,
        PermissionModel: 'SERVICE_MANAGED',
        AutoDeployment: { Enabled: true, RetainStacksOnAccountRemoval: false },
        ManagedExecution: { Active: true },
        Capabilities: ['CAPABILITY_NAMED_IAM'],
        Parameters: autoTaggerParamList(desired),
        CallAs: 'SELF',
        Tags: [{ Key: 'ManagedBy', Value: 'AWSTool' }, { Key: 'Purpose', Value: 'TagCompliance' }],
      }));
    }

    // 已存在：按名字存在就跳过曾让 taoVolt 一直信任旧中央账户。模板或参数不符就原地更新。
    if (existing) {
      const ops = await cfn.send(new ListStackSetOperationsCommand({ StackSetName: AUTO_TAGGER_STACKSET_NAME, CallAs: 'SELF', MaxResults: 1 }));
      const latest = ops.Summaries?.[0]?.Status;
      const diffs = autoTaggerDrift(existing, desired);
      if (latest && ['RUNNING', 'QUEUED', 'STOPPING'].includes(latest)) {
        steps.push({ key: 'stackSet', label: '打标角色 StackSet (AutoTaggerRole)', status: 'pending', detail: 'StackSet 操作进行中，稍后重跑' });
        out.needsRetry = true;
      } else if (diffs.length > 0) {
        try {
          await cfn.send(new UpdateStackSetCommand({
            StackSetName: AUTO_TAGGER_STACKSET_NAME,
            Description: AUTO_TAGGER_STACKSET_DESCRIPTION,
            TemplateBody: AUTO_TAGGER_ROLE_TEMPLATE,
            Parameters: autoTaggerParamList(desired),
            Capabilities: ['CAPABILITY_NAMED_IAM'],
            OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
            CallAs: 'SELF',
          }));
          steps.push({ key: 'stackSet', label: '打标角色 StackSet (AutoTaggerRole)', status: 'pending', detail: `已提交更新：${diffs.join('；')}` });
        } catch (e: any) {
          if (e.name !== 'OperationInProgressException') throw e;
          steps.push({ key: 'stackSet', label: '打标角色 StackSet (AutoTaggerRole)', status: 'pending', detail: 'StackSet 操作进行中，稍后重跑' });
        }
        out.needsRetry = true;
      } else {
        const instances: any[] = [];
        let token: string | undefined;
        do {
          const page = await cfn.send(new ListStackInstancesCommand({ StackSetName: AUTO_TAGGER_STACKSET_NAME, CallAs: 'SELF', NextToken: token }));
          instances.push(...(page.Summaries || []));
          token = page.NextToken;
        } while (token);
        const stale = instances.filter(i => i.Status !== 'CURRENT').map(i => i.Account as string);
        if (instances.length > 0) {
          steps.push({
            key: 'stackSet', label: '打标角色 StackSet (AutoTaggerRole)', status: 'skipped',
            detail: `模板与参数一致（最小权限）`
              + (stale.length ? `；${stale.length} 个实例未更新：${stale.slice(0, 5).join(', ')}` : ''),
          });
        }
      }
    }

    // 仅在还没有任何实例时才下发，避免重复触发操作；上面已给出结论（更新中/一致）时不再处理
    if (!steps.some(step => step.key === 'stackSet')) {
      const instances = await cfn.send(new ListStackInstancesCommand({ StackSetName: AUTO_TAGGER_STACKSET_NAME, CallAs: 'SELF' }));
      const instanceCount = (instances.Summaries || []).length;
      if (instanceCount === 0) {
        if (!out.rootOuId) throw new Error('未取到根 OU，无法下发 StackSet 实例');
        await cfn.send(new CreateStackInstancesCommand({
          StackSetName: AUTO_TAGGER_STACKSET_NAME,
          DeploymentTargets: { OrganizationalUnitIds: [out.rootOuId] },
          Regions: [region],
          OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
          CallAs: 'SELF',
        }));
        steps.push({
          key: 'stackSet', label: '打标角色 StackSet (AutoTaggerRole)',
          status: 'created',
          detail: stackSetExists ? '已存在 StackSet，已下发到根 OU（异步进行中）' : '已创建 StackSet 并下发到根 OU（异步进行中）',
        });
      } else {
        steps.push({
          key: 'stackSet', label: '打标角色 StackSet (AutoTaggerRole)',
          status: 'skipped',
          detail: `已有 ${instanceCount} 个成员账户实例；新成员由 AutoDeployment 自动覆盖`,
        });
      }
    }
  } catch (e: any) {
    steps.push({ key: 'stackSet', label: '打标角色 StackSet (AutoTaggerRole)', status: 'failed', detail: awsErrorDetail(e) });
    out.needsRetry = true;
  }

  // ---- 6. payer 管理账户自身的 auto-tagger-role ----
  // SERVICE_MANAGED StackSet 不会部署到管理账户，所以 payer 自己永远没有这个角色。
  // 过去靠 exclude_accounts 把 payer 整个排除掉来回避；现在业务要求 payer 的资源
  // 也要打 MAP 标签，就必须在 payer 账户里单独建一份同样的角色，否则扫描器能发现
  // 资源却 AssumeRole 失败，报告里每天多一批 failed。
  try {
    if (!taggerPolicyOpts) throw new Error('打标角色 StackSet 参数未取到，本次不改动 payer 角色，稍后重跑');
    const { created, changes } = await ensurePayerTaggerRole(creds, central, taggerPolicyOpts);
    steps.push({
      key: 'payerTaggerRole', label: 'payer 自身打标角色 (auto-tagger-role)',
      status: created || changes.length ? 'created' : 'skipped',
      detail: created ? '已在 payer 管理账户创建（StackSet 覆盖不到管理账户）'
        : changes.length ? changes.join('；') : '已存在，权限与成员模板一致',
    });
  } catch (e: any) {
    steps.push({
      key: 'payerTaggerRole', label: 'payer 自身打标角色 (auto-tagger-role)',
      status: 'failed', detail: awsErrorDetail(e),
    });
    out.needsRetry = true;
  }

  return out;
}

/**
 * 从 AUTO_TAGGER_ROLE_TEMPLATE 里解析出打标 Action 列表，生成等价的内联策略。
 *
 * ⚠️ 必须与 CFN 模板同源，不能另写一份 Action 清单 —— 两处维护一定会漂移。
 *
 * ⚠️ 也**不能**用托管策略 ResourceGroupsandTagEditorFullAccess 替代：
 * 它只给 tag:TagResources / resource-groups:*，不含各服务自身的打标 API。
 * 而 TagResources 底层是代调 athena:TagResource、logs:TagResource、
 * s3:PutBucketTagging 这些，缺了就全线 AccessDenied（已实测踩过）。
 */
export function AUTO_TAGGER_INLINE_POLICY(
  opts: { allowedTagKeys?: string[]; enforceTagKeys?: boolean } = {},
): { Version: string; Statement: Record<string, unknown>[] } {
  // 模板里形如 "                  - ec2:CreateTags" 的行即 Action
  const actions = [...AUTO_TAGGER_ROLE_TEMPLATE.matchAll(/^\s+- ([a-z0-9-]+:[A-Za-z*]+)$/gm)]
    .map(m => m[1])
    .filter(a => !a.startsWith('apigateway:'));  // apigateway 走独立资源级语句
  // 与模板的 EnforceTagKeys 条件一致：开启后只能写允许的 key
  const condition = opts.enforceTagKeys
    ? { Condition: { 'ForAllValues:StringEquals': { 'aws:TagKeys': opts.allowedTagKeys ?? [MAP_TAG_KEY] } } }
    : {};
  return {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'TagWrite', Effect: 'Allow', Action: [...new Set(actions)], Resource: '*', ...condition },
      {
        Sid: 'ApiGatewayTagWrite',
        Effect: 'Allow',
        Action: ['apigateway:PUT', 'apigateway:POST'],
        Resource: ['arn:aws:apigateway:*::/tags/*'],
        ...condition,
      },
    ],
  };
}

type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
type CfnParam = { ParameterKey?: string; ParameterValue?: string };

/** ['map-migrated', extra?]：额外标签 key 也要能写，否则开启 TagKeys 限制后额外标签全部被拒 */
export function normalizeAllowedTagKeys(extraTagKey?: string): string[] {
  const extra = (extraTagKey || '').trim();
  return extra && extra !== MAP_TAG_KEY ? [MAP_TAG_KEY, extra] : [MAP_TAG_KEY];
}

export interface AutoTaggerParams {
  CentralToolingAccountId: string;
  /** 逗号分隔 */
  AllowedTagKeys: string;
  EnforceTagKeys: 'true' | 'false';
}

/**
 * 中央账户永远以平台配置为准。AllowedTagKeys：接入任务传入优先，否则沿用现值。
 * EnforceTagKeys 只沿用现值 —— 它由 tag-keys-canary.ts 先单账户、再全量开启，重跑接入不能把它关掉。
 */
export function resolveAutoTaggerParams(
  central: string, requestedKeys: string[] | undefined, existing: CfnParam[] | undefined,
): AutoTaggerParams {
  const current = (key: string) => existing?.find(p => p.ParameterKey === key)?.ParameterValue;
  const keys = requestedKeys?.length ? requestedKeys.join(',') : (current('AllowedTagKeys') || MAP_TAG_KEY);
  const enforce = current('EnforceTagKeys') === 'true' ? 'true' : 'false';
  return { CentralToolingAccountId: central, AllowedTagKeys: keys, EnforceTagKeys: enforce };
}

/** 现有 StackSet 与平台最小权限版本的差异；[] 表示一致 */
export function autoTaggerDrift(
  current: { TemplateBody?: string; Parameters?: CfnParam[] }, desired: AutoTaggerParams,
): string[] {
  const diffs: string[] = [];
  if ((current.TemplateBody || '').trim() !== AUTO_TAGGER_ROLE_TEMPLATE.trim()) {
    diffs.push('模板不是平台当前的最小权限版本');
  }
  for (const key of ['CentralToolingAccountId', 'AllowedTagKeys', 'EnforceTagKeys'] as const) {
    const was = current.Parameters?.find(p => p.ParameterKey === key)?.ParameterValue;
    if (was !== desired[key]) diffs.push(`${key}: ${was || '(无)'} → ${desired[key]}`);
  }
  return diffs;
}

function autoTaggerParamList(params: AutoTaggerParams) {
  return (Object.keys(params) as (keyof AutoTaggerParams)[])
    .map(key => ({ ParameterKey: key, ParameterValue: params[key] }));
}

/** 只信任中央工具账户里 tag-compliance* 前缀的角色（SAM 栈 tag-compliance-prod 生成的 Lambda 角色） */
export function buildCentralTrust(central: string) {
  return {
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { AWS: `arn:aws:iam::${central}:root` },
      Action: 'sts:AssumeRole',
      Condition: { StringLike: { 'aws:PrincipalArn': `arn:aws:iam::${central}:role/tag-compliance*` } },
    }],
  };
}

/**
 * search-role 的全部权限。中央 search_handler 只调 OrgView 上的 ListResources 与
 * organizations:ListAccounts；此前挂的两个托管只读策略远超所需（含 SCP、账户邮箱等组织细节）。
 */
export function buildSearchRolePolicy(payerAccountId: string, viewRegion: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ListOrgViewResources', Effect: 'Allow', Action: ['resource-explorer-2:ListResources'],
        Resource: `arn:aws:resource-explorer-2:${viewRegion}:${payerAccountId}:view/${ORG_VIEW_NAME}/*`,
      },
      { Sid: 'ListOrgAccounts', Effect: 'Allow', Action: ['organizations:ListAccounts'], Resource: '*' },
    ],
  };
}

/** account:ListRegions 结果 → 已启用区域（等价于 DescribeRegions 的 opted-in + opt-in-not-required） */
export function enabledRegionsFromListRegions(
  regions: Array<{ RegionName?: string; RegionOptStatus?: string }>,
): string[] {
  return regions
    .filter(r => r.RegionName && (r.RegionOptStatus === 'ENABLED' || r.RegionOptStatus === 'ENABLED_BY_DEFAULT'))
    .map(r => r.RegionName!)
    .sort();
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort()
      .map(key => [key, canonicalJson((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** 策略文档比较：GetRole 返回的是 URL 编码的 JSON 字符串，两边都规范化后比较 */
export function samePolicyDocument(a: unknown, b: unknown): boolean {
  const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(decodeURIComponent(v)) : v);
  return JSON.stringify(canonicalJson(parse(a))) === JSON.stringify(canonicalJson(parse(b)));
}

/**
 * 在 payer 管理账户内直接创建 auto-tagger-role（幂等）。
 * SERVICE_MANAGED StackSet 不部署到管理账户，所以只能这样单独建。
 *
 * 权限只有 AUTO_TAGGER_INLINE_POLICY()（与 CFN 模板同源，同一组 TagKeys 设置），不挂任何托管策略。
 * 信任策略与模板一致：只信任中央工具账户下 tag-compliance* 前缀的角色。
 */
async function ensurePayerTaggerRole(
  creds: AwsCredentials, centralAccount: string,
  policyOpts: { allowedTagKeys: string[]; enforceTagKeys: boolean },
): Promise<{ created: boolean; changes: string[] }> {
  const iam = new IAMClient({ region: REGION, credentials: creds });
  const trust = buildCentralTrust(centralAccount);
  const changes: string[] = [];
  let exists = true;
  try {
    const r = await iam.send(new GetRoleCommand({ RoleName: 'auto-tagger-role' }));
    if (!samePolicyDocument(r.Role?.AssumeRolePolicyDocument || '{}', trust)) {
      await iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: 'auto-tagger-role', PolicyDocument: JSON.stringify(trust) }));
      changes.push('信任策略已对齐中央 tag-compliance*');
    }
  } catch (e: any) {
    if (e.name !== 'NoSuchEntityException') throw e;
    exists = false;
  }

  if (!exists) {
    await iam.send(new CreateRoleCommand({
      RoleName: 'auto-tagger-role',
      Description: 'Central tag-compliance auto-tagger (payer account, managed by AWSTool)',
      AssumeRolePolicyDocument: JSON.stringify(trust),
      Tags: [{ Key: 'ManagedBy', Value: 'AWSTool' }, { Key: 'Purpose', Value: 'AutoTagger' }],
    }));
  }

  // 内联策略每次都覆盖写：模板增补了新服务、或 TagKeys 限制切换时，重跑一键接入即可同步权限
  await iam.send(new PutRolePolicyCommand({
    RoleName: 'auto-tagger-role',
    PolicyName: 'AutoTagPolicy',
    PolicyDocument: JSON.stringify(AUTO_TAGGER_INLINE_POLICY(policyOpts)),
  }));

  // 早期版本挂了 ReadOnlyAccess（可读 S3 对象等业务数据），中央打标只调 TagResources，用不到。
  // 放在写完内联策略之后摘，保证中间不会无打标权限。
  const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: 'auto-tagger-role' }));
  if ((attached.AttachedPolicies || []).some(p => p.PolicyArn === READ_ONLY_ACCESS_ARN)) {
    await iam.send(new DetachRolePolicyCommand({ RoleName: 'auto-tagger-role', PolicyArn: READ_ONLY_ACCESS_ARN }));
    changes.push('已移除 ReadOnlyAccess');
  }
  return { created: !exists, changes };
}

// ============================================================
// Resource Explorer 索引自动化（替代控制台 Quick Setup）
// 两个 SERVICE_MANAGED StackSet：
//   - 聚合索引：只部署到聚合区域（每个账户只能有一个 AGGREGATOR 区域）
//   - 本地索引：部署到除聚合区域外的其它区域
// 另外单独给 payer 管理账户直接建索引（SERVICE_MANAGED 不覆盖管理账户）。
// 整体是异步的：下发后用 getReIndexStatus 轮询进度。
// ============================================================

export const RE_AGGREGATOR_STACKSET = 'ResourceExplorerAggregatorIndex';
export const RE_LOCAL_STACKSET = 'ResourceExplorerLocalIndexes';
export const RE_SCOPED_LOCAL_STACKSET = 'ResourceExplorerScopedLocalIndexes';

const RE_AGGREGATOR_TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Description: >
  Resource Explorer Aggregator Index + Default View.
  Deploy to ONE region per account (the aggregator region).

Resources:
  Index:
    Type: AWS::ResourceExplorer2::Index
    Properties:
      Type: AGGREGATOR
      Tags:
        Purpose: ResourceExplorer

  View:
    Type: AWS::ResourceExplorer2::View
    Properties:
      ViewName: DefaultView
      IncludedProperties:
        - Name: tags
      Tags:
        Purpose: ResourceExplorer
    DependsOn: Index

  DefaultViewAssociation:
    Type: AWS::ResourceExplorer2::DefaultViewAssociation
    Properties:
      ViewArn: !Ref View
`;

const RE_LOCAL_TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Description: >
  Resource Explorer Local Indexes + Views.
  Deploy to ALL regions EXCEPT the aggregator region.

Resources:
  Index:
    Type: AWS::ResourceExplorer2::Index
    Properties:
      Type: LOCAL
      Tags:
        Purpose: ResourceExplorer

  View:
    Type: AWS::ResourceExplorer2::View
    Properties:
      ViewName: LocalView
      IncludedProperties:
        - Name: tags
      Tags:
        Purpose: ResourceExplorer
    DependsOn: Index
`;

export interface ReIndexDeployResult {
  payerAccountId: string;
  rootOuId?: string;
  aggregatorRegion: string;
  localRegions: string[];
  steps: ProvisionStep[];
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

function effectiveStackInstanceStatus(summary: {
  Status?: string;
  StackInstanceStatus?: { DetailedStatus?: string };
}): string {
  if (summary.Status === 'OUTDATED' || summary.Status === 'INOPERABLE') return summary.Status;
  return summary.StackInstanceStatus?.DetailedStatus || summary.Status || 'UNKNOWN';
}

/**
 * 为整个组织下发 Resource Explorer 索引（幂等）。
 * 只在缺失的区域下发实例，已有实例的区域跳过；返回后用 getReIndexStatus 轮询。
 */
export async function deployReIndexes(
  payerAccountId: string,
  aggregatorRegion = 'us-east-1',
  localRegions: string[] = [],
  payerLocalRegions: string[] = localRegions,
  memberEnabledRegions: Record<string, string[]> = {},
  autoDeploymentRegions: string[] = [],
): Promise<ReIndexDeployResult> {
  if (!REGION_RE.test(aggregatorRegion)) throw new Error(`聚合区域不合法: ${aggregatorRegion}`);
  const locals = [...new Set(localRegions.filter(r => REGION_RE.test(r) && r !== aggregatorRegion))];
  const managementLocals = [...new Set(payerLocalRegions.filter(r => REGION_RE.test(r) && r !== aggregatorRegion))];
  const memberAccountIds = Object.keys(memberEnabledRegions).sort();
  const aggregatorDisabledAccounts = memberAccountIds.filter(
    accountId => !memberEnabledRegions[accountId].includes(aggregatorRegion),
  );
  if (aggregatorDisabledAccounts.length > 0) {
    throw new Error(`聚合区域 ${aggregatorRegion} 未在全部 ACTIVE 成员账户启用`);
  }
  if (!autoDeploymentRegions.includes(aggregatorRegion)) {
    throw new Error(`聚合区域 ${aggregatorRegion} 不是新账户默认启用区域，不能用于 AutoDeployment`);
  }

  const creds = await assumePayer(payerAccountId);
  if (!creds) throw new Error('该 payer 不在平台配置（config.payers）中，无法自动部署索引');

  const steps: ProvisionStep[] = [];
  const out: ReIndexDeployResult = { payerAccountId, aggregatorRegion, localRegions: locals, steps };

  const org = new OrganizationsClient({ region: aggregatorRegion, credentials: creds });
  const cfn = new CloudFormationClient({ region: aggregatorRegion, credentials: creds });

  try {
    const roots = await org.send(new ListRootsCommand({}));
    out.rootOuId = roots.Roots?.[0]?.Id;
    if (!out.rootOuId) throw new Error('未取到根 OU');
  } catch (e: any) {
    steps.push({ key: 'root', label: '读取根 OU', status: 'failed', detail: awsErrorDetail(e) });
    return out;
  }

  // 确保 StackSet 存在（幂等）
  async function ensureStackSet(name: string, template: string, desc: string, autoDeployment = true) {
    try {
      await cfn.send(new DescribeStackSetCommand({ StackSetName: name, CallAs: 'SELF' }));
      return false; // 已存在
    } catch (e: any) {
      if (e.name !== 'StackSetNotFoundException') throw e;
    }
    await cfn.send(new CreateStackSetCommand({
      StackSetName: name,
      Description: desc,
      TemplateBody: template,
      PermissionModel: 'SERVICE_MANAGED',
      AutoDeployment: autoDeployment
        ? { Enabled: true, RetainStacksOnAccountRemoval: false }
        : { Enabled: false },
      ManagedExecution: { Active: true },
      CallAs: 'SELF',
      Tags: [{ Key: 'ManagedBy', Value: 'AWSTool' }, { Key: 'Purpose', Value: 'ResourceExplorer' }],
    }));
    return true; // 新建
  }

  const retryableStatuses = new Set(['FAILED', 'CANCELLED', 'INOPERABLE', 'OUTDATED', 'SKIPPED_SUSPENDED_ACCOUNT']);

  // 账户 × 区域级别读取现有实例，不能因某区域只有一个实例就误判全组织已覆盖。
  async function deployedTargets(name: string): Promise<Map<string, string>> {
    const targets = new Map<string, string>();
    let token: string | undefined;
    do {
      const page = await cfn.send(new ListStackInstancesCommand({
        StackSetName: name,
        CallAs: 'SELF',
        NextToken: token,
      }));
      for (const summary of page.Summaries || []) {
        if (!summary.Account || !summary.Region) continue;
        const status = effectiveStackInstanceStatus(summary);
        targets.set(`${summary.Account}:${summary.Region}`, status);
      }
      token = page.NextToken;
    } while (token);
    return targets;
  }

  async function rootAutoDeploymentRegions(name: string): Promise<Set<string>> {
    const regions = new Set<string>();
    let token: string | undefined;
    do {
      const page = await cfn.send(new ListStackSetAutoDeploymentTargetsCommand({
        StackSetName: name,
        CallAs: 'SELF',
        NextToken: token,
      }));
      for (const summary of page.Summaries || []) {
        if (summary.OrganizationalUnitId !== out.rootOuId) continue;
        for (const region of summary.Regions || []) regions.add(region);
      }
      token = page.NextToken;
    } while (token);
    return regions;
  }

  async function submitTargetOperations(
    stackSetName: string,
    region: string,
    targetAccounts: string[],
    currentTargets: Map<string, string>,
    allowRootTarget: boolean,
  ): Promise<string[]> {
    const missing = targetAccounts.filter(accountId => !currentTargets.has(`${accountId}:${region}`));
    const failed = targetAccounts.filter(accountId => {
      const status = currentTargets.get(`${accountId}:${region}`);
      return status ? retryableStatuses.has(status) : false;
    });
    const operationIds: string[] = [];

    if (missing.length === targetAccounts.length && missing.length > 0 && allowRootTarget) {
      const response = await cfn.send(new CreateStackInstancesCommand({
        StackSetName: stackSetName,
        DeploymentTargets: { OrganizationalUnitIds: [out.rootOuId!], AccountFilterType: 'NONE' },
        Regions: [region],
        OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
        CallAs: 'SELF',
      }));
      if (response.OperationId) operationIds.push(response.OperationId);
    } else {
      for (let offset = 0; offset < missing.length; offset += 50) {
        const accounts = missing.slice(offset, offset + 50);
        const response = await cfn.send(new CreateStackInstancesCommand({
          StackSetName: stackSetName,
          DeploymentTargets: {
            OrganizationalUnitIds: [out.rootOuId!],
            Accounts: accounts,
            AccountFilterType: 'INTERSECTION',
          },
          Regions: [region],
          OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
          CallAs: 'SELF',
        }));
        if (response.OperationId) operationIds.push(response.OperationId);
      }
    }

    for (let offset = 0; offset < failed.length; offset += 50) {
      const accounts = failed.slice(offset, offset + 50);
      const response = await cfn.send(new UpdateStackInstancesCommand({
        StackSetName: stackSetName,
        DeploymentTargets: {
          OrganizationalUnitIds: [out.rootOuId!],
          Accounts: accounts,
          AccountFilterType: 'INTERSECTION',
        },
        Regions: [region],
        OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
        CallAs: 'SELF',
      }));
      if (response.OperationId) operationIds.push(response.OperationId);
    }
    return operationIds;
  }

  // ---- 聚合索引 StackSet：聚合区必须覆盖全部成员账户 ----
  try {
    const created = await ensureStackSet(RE_AGGREGATOR_STACKSET, RE_AGGREGATOR_TEMPLATE, 'Resource Explorer aggregator index (managed by AWSTool)');
    if (memberAccountIds.length === 0) {
      const autoRegions = await rootAutoDeploymentRegions(RE_AGGREGATOR_STACKSET);
      if (autoRegions.has(aggregatorRegion)) {
        steps.push({ key: 'aggStackSet', label: `聚合索引 StackSet (${aggregatorRegion})`, status: 'skipped', detail: '根 OU 自动部署目标已存在，等待未来成员账户' });
      } else {
        const operation = await cfn.send(new CreateStackInstancesCommand({
          StackSetName: RE_AGGREGATOR_STACKSET,
          DeploymentTargets: { OrganizationalUnitIds: [out.rootOuId!], AccountFilterType: 'NONE' },
          Regions: [aggregatorRegion],
          OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
          CallAs: 'SELF',
        }));
        steps.push({
          key: 'aggStackSet',
          label: `聚合索引 StackSet (${aggregatorRegion})`,
          status: 'created',
          detail: `${created ? '已创建 StackSet；' : ''}已建立根 OU 自动目标，供未来成员使用（operationId ${operation.OperationId}）`,
        });
      }
    } else {
      const currentTargets = await deployedTargets(RE_AGGREGATOR_STACKSET);
      const operations = await submitTargetOperations(
        RE_AGGREGATOR_STACKSET,
        aggregatorRegion,
        memberAccountIds,
        currentTargets,
        true,
      );
      steps.push({
        key: 'aggStackSet',
        label: `聚合索引 StackSet (${aggregatorRegion})`,
        status: operations.length > 0 ? 'created' : 'skipped',
        detail: operations.length > 0
          ? `${created ? '已创建 StackSet；' : ''}已提交 ${operations.length} 个精确覆盖操作（${memberAccountIds.length} 个成员账户）`
          : `${memberAccountIds.length} 个成员账户均已有实例或正在部署`,
      });
    }
  } catch (e: any) {
    steps.push({ key: 'aggStackSet', label: `聚合索引 StackSet (${aggregatorRegion})`, status: 'failed', detail: awsErrorDetail(e) });
  }

  // ---- 本地索引：共同区域自动部署；部分 opt-in 区域使用禁用自动部署的 scoped StackSet ----
  const memberLocalRegions = memberAccountIds.length === 0
    ? autoDeploymentRegions.filter(region => region !== aggregatorRegion)
    : locals.filter(region => memberAccountIds.some(
      accountId => memberEnabledRegions[accountId].includes(region),
    ));
  const commonLocalRegions = memberLocalRegions.filter(region =>
    autoDeploymentRegions.includes(region)
    && memberAccountIds.every(accountId => memberEnabledRegions[accountId].includes(region)));
  const scopedLocalRegions = memberLocalRegions.filter(region => !commonLocalRegions.includes(region));
  let legacyCleanupSubmitted = false;

  if (memberLocalRegions.length === 0) {
    steps.push({ key: 'localStackSet', label: '本地索引 StackSet', status: 'skipped', detail: '成员账户没有其它启用区域' });
  } else {
    try {
      const created = await ensureStackSet(RE_LOCAL_STACKSET, RE_LOCAL_TEMPLATE, 'Resource Explorer common local indexes (managed by AWSTool)');
      const currentTargets = await deployedTargets(RE_LOCAL_STACKSET);
      const operations: string[] = [];
      const failures: string[] = [];

      const autoRegions = await rootAutoDeploymentRegions(RE_LOCAL_STACKSET);
      const extraAutoRegions = [...autoRegions].filter(region => !commonLocalRegions.includes(region)).sort();
      if (extraAutoRegions.length > 0) {
        const cleanup = await cfn.send(new DeleteStackInstancesCommand({
          StackSetName: RE_LOCAL_STACKSET,
          DeploymentTargets: { OrganizationalUnitIds: [out.rootOuId!], AccountFilterType: 'NONE' },
          Regions: extraAutoRegions,
          RetainStacks: true,
          OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
          CallAs: 'SELF',
        }));
        legacyCleanupSubmitted = true;
        if (cleanup.OperationId) operations.push(`cleanup:${cleanup.OperationId}`);
      }

      let targetPairCount = 0;
      for (const region of commonLocalRegions) {
        targetPairCount += memberAccountIds.length;
        try {
          if (memberAccountIds.length === 0) {
            if (!autoRegions.has(region)) {
              const response = await cfn.send(new CreateStackInstancesCommand({
                StackSetName: RE_LOCAL_STACKSET,
                DeploymentTargets: { OrganizationalUnitIds: [out.rootOuId!], AccountFilterType: 'NONE' },
                Regions: [region],
                OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
                CallAs: 'SELF',
              }));
              if (response.OperationId) operations.push(`${region}:${response.OperationId}`);
            }
          } else {
            const submitted = await submitTargetOperations(
              RE_LOCAL_STACKSET,
              region,
              memberAccountIds,
              currentTargets,
              true,
            );
            operations.push(...submitted.map(operationId => `${region}:${operationId}`));
          }
        } catch (error: any) {
          failures.push(`${region}: ${awsErrorDetail(error)}`);
        }
      }
      steps.push({
        key: 'localStackSet',
        label: '共同区域本地索引 StackSet',
        status: failures.length > 0 ? 'failed' : (legacyCleanupSubmitted ? 'pending' : (operations.length > 0 ? 'created' : 'skipped')),
        detail: failures.length > 0
          ? `已提交 ${operations.length} 个操作，但 ${failures.length} 个区域失败：${failures.join('；')}`
          : `${created ? '已创建 StackSet；' : ''}共同区域 ${commonLocalRegions.length} 个 / 目标 ${targetPairCount} 个 / 操作 ${operations.length} 个${legacyCleanupSubmitted ? '；旧宽泛目标正以 RetainStacks=true 无损解绑' : ''}`,
      });
    } catch (e: any) {
      steps.push({ key: 'localStackSet', label: '共同区域本地索引 StackSet', status: 'failed', detail: awsErrorDetail(e) });
    }
  }

  if (scopedLocalRegions.length === 0) {
    steps.push({ key: 'localScopedStackSet', label: '部分区域本地索引 StackSet', status: 'skipped', detail: '没有部分账户独有的 opt-in 区域' });
  } else {
    try {
      const created = await ensureStackSet(
        RE_SCOPED_LOCAL_STACKSET,
        RE_LOCAL_TEMPLATE,
        'Resource Explorer account-scoped local indexes (managed by AWSTool)',
        false,
      );
      if (legacyCleanupSubmitted) {
        steps.push({
          key: 'localScopedStackSet',
          label: '部分区域本地索引 StackSet',
          status: 'pending',
          detail: `等待旧 StackSet 无损解绑后，再按 ${scopedLocalRegions.length} 个区域的账户交集补齐`,
        });
      } else {
        const currentTargets = await deployedTargets(RE_SCOPED_LOCAL_STACKSET);
        const operations: string[] = [];
        const failures: string[] = [];
        let targetPairCount = 0;
        for (const region of scopedLocalRegions) {
          const targetAccounts = memberAccountIds.filter(
            accountId => memberEnabledRegions[accountId].includes(region),
          );
          targetPairCount += targetAccounts.length;
          try {
            const submitted = await submitTargetOperations(
              RE_SCOPED_LOCAL_STACKSET,
              region,
              targetAccounts,
              currentTargets,
              false,
            );
            operations.push(...submitted.map(operationId => `${region}:${operationId}`));
          } catch (error: any) {
            failures.push(`${region}: ${awsErrorDetail(error)}`);
          }
        }
        steps.push({
          key: 'localScopedStackSet',
          label: '部分区域本地索引 StackSet',
          status: failures.length > 0 ? 'failed' : (operations.length > 0 ? 'created' : 'skipped'),
          detail: failures.length > 0
            ? `已提交 ${operations.length} 个操作，但 ${failures.length} 个区域失败：${failures.join('；')}`
            : `${created ? '已创建 AutoDeployment=false StackSet；' : ''}按 ${targetPairCount} 个账户×区域目标提交 ${operations.length} 个操作`,
        });
      }
    } catch (e: any) {
      steps.push({ key: 'localScopedStackSet', label: '部分区域本地索引 StackSet', status: 'failed', detail: awsErrorDetail(e) });
    }
  }

  // ---- payer 管理账户自身的本地索引（SERVICE_MANAGED 不覆盖管理账户）----
  // 只在 payer 自身已启用的区域创建；成员独有的 opt-in 区域仅由 StackSet 覆盖。
  if (managementLocals.length > 0) {
    const results = await Promise.allSettled(managementLocals.map(async (region) => {
      const re = new ResourceExplorer2Client({ region, credentials: creds });
      try {
        try {
          await re.send(new GetIndexCommand({}));
          return 'exists';
        } catch (e: any) {
          if (e.name !== 'ResourceNotFoundException') throw e;
        }
        await re.send(new CreateIndexCommand({}));
        return 'created';
      } finally {
        re.destroy();
      }
    }));
    const created = results.filter(r => r.status === 'fulfilled' && r.value === 'created').length;
    const exists = results.filter(r => r.status === 'fulfilled' && r.value === 'exists').length;
    const failureDetails = results.flatMap((result, index) => result.status === 'rejected'
      ? [`${managementLocals[index]}: ${awsErrorDetail(result.reason)}`]
      : []);
    const failed = failureDetails.length;
    steps.push({
      key: 'payerLocalIndexes',
      label: 'payer 管理账户本地索引',
      status: failed > 0 ? (created + exists > 0 ? 'pending' : 'failed') : (created > 0 ? 'created' : 'skipped'),
      detail: `新建 ${created} / 已存在 ${exists} / 失败 ${failed}（管理账户不在 StackSet 覆盖范围，单独创建）${failureDetails.length ? `；失败明细：${failureDetails.join('；')}` : ''}`,
    });
  }

  return out;
}

export interface ReIndexStackSetStatus {
  name: string;
  exists: boolean;
  instanceCount: number;
  regions: string[];
  statusCounts: Record<string, number>;
  latestOperation?: { operationId?: string; action?: string; status?: string; timestamp?: Date };
}

/** 查询 Resource Explorer 索引 StackSet 的部署进度，供前端轮询 */
export async function getReIndexStatus(payerAccountId: string, region = 'us-east-1'): Promise<{ payerAccountId: string; stackSets: ReIndexStackSetStatus[] }> {
  const creds = await assumePayer(payerAccountId);
  if (!creds) throw new Error('该 payer 不在平台配置（config.payers）中');
  const cfn = new CloudFormationClient({ region, credentials: creds });

  const stackSets: ReIndexStackSetStatus[] = [];
  for (const name of [RE_AGGREGATOR_STACKSET, RE_LOCAL_STACKSET, RE_SCOPED_LOCAL_STACKSET]) {
    const entry: ReIndexStackSetStatus = { name, exists: false, instanceCount: 0, regions: [], statusCounts: {} };
    try {
      await cfn.send(new DescribeStackSetCommand({ StackSetName: name, CallAs: 'SELF' }));
      entry.exists = true;
    } catch (e: any) {
      if (e.name === 'StackSetNotFoundException') { stackSets.push(entry); continue; }
      throw e;
    }
    const regions = new Set<string>();
    let token: string | undefined;
    do {
      const p = await cfn.send(new ListStackInstancesCommand({ StackSetName: name, CallAs: 'SELF', NextToken: token }));
      for (const s of p.Summaries || []) {
        entry.instanceCount++;
        if (s.Region) regions.add(s.Region);
        const st = effectiveStackInstanceStatus(s);
        entry.statusCounts[st] = (entry.statusCounts[st] || 0) + 1;
      }
      token = p.NextToken;
    } while (token);
    entry.regions = [...regions].sort();
    try {
      const ops = await cfn.send(new ListStackSetOperationsCommand({ StackSetName: name, CallAs: 'SELF', MaxResults: 1 }));
      const op = (ops.Summaries || [])[0];
      if (op) entry.latestOperation = { operationId: op.OperationId, action: op.Action, status: op.Status, timestamp: op.CreationTimestamp };
    } catch { /* 操作列表拿不到不影响主结果 */ }
    stackSets.push(entry);
  }
  return { payerAccountId, stackSets };
}

// ============================================================
// 报告通知邮箱（SNS 订阅管理）
// NotificationEmail 是 SAM 参数，只能有一个且改动需重新部署；
// 但 SNS 主题支持多订阅，这里直接用 SNS API 增删，无需重新部署 SAM。
// 注意：SAM 创建的那条订阅由 CloudFormation 管理，删它会造成栈漂移，
// 因此下面会把它标记为 managedByStack，前端提示不建议删除。
// ============================================================

export interface NotifySubscription {
  subscriptionArn: string;
  endpoint: string;
  protocol: string;
  /** 邮箱订阅需收件人点确认链接后才生效 */
  pendingConfirmation: boolean;
  /** 是否疑似由 SAM/CloudFormation 创建（等于栈参数 NotificationEmail 的那个邮箱） */
  managedByStack: boolean;
}

function topicArn(): string {
  const arn = TC.topicArn;
  if (!arn) {
    throw new Error('未配置 tagCompliance.topicArn，无法管理通知邮箱；请在 config.json 中补充 SNS 主题 ARN');
  }
  return arn;
}

export function isNotifyConfigured(): boolean {
  return !!(TC.roleArn && TC.topicArn);
}

/** 列出当前所有报告通知订阅 */
export async function listNotifySubscriptions(): Promise<NotifySubscription[]> {
  const creds = await getConsoleCreds();
  const sns = new SNSClient({ region: TC.region || 'us-east-1', credentials: creds });
  const arn = topicArn();
  const out: NotifySubscription[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: arn, NextToken: nextToken }));
    for (const s of resp.Subscriptions || []) {
      const subArn = s.SubscriptionArn || '';
      out.push({
        subscriptionArn: subArn,
        endpoint: s.Endpoint || '',
        protocol: s.Protocol || '',
        // 未确认的订阅 ARN 是字面量 "PendingConfirmation"
        pendingConfirmation: subArn === 'PendingConfirmation' || !subArn.startsWith('arn:'),
        managedByStack: false,
      });
    }
    nextToken = resp.NextToken;
  } while (nextToken);

  // 标记 SAM 栈参数里的那个邮箱（不改动它，仅提示）
  const stackEmail = (TC.notificationEmail || '').trim().toLowerCase();
  if (stackEmail) {
    for (const s of out) {
      if (s.endpoint.trim().toLowerCase() === stackEmail) s.managedByStack = true;
    }
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** 添加一个邮箱订阅；返回后需收件人点确认邮件才会真正生效 */
export async function addNotifyEmail(email: string): Promise<{ endpoint: string; alreadyExists: boolean }> {
  const target = String(email || '').trim();
  if (!EMAIL_RE.test(target)) throw new Error(`邮箱格式不正确: ${email}`);
  const existing = await listNotifySubscriptions();
  if (existing.some(s => s.endpoint.trim().toLowerCase() === target.toLowerCase())) {
    return { endpoint: target, alreadyExists: true };
  }
  const creds = await getConsoleCreds();
  const sns = new SNSClient({ region: TC.region || 'us-east-1', credentials: creds });
  await sns.send(new SubscribeCommand({
    TopicArn: topicArn(),
    Protocol: 'email',
    Endpoint: target,
    ReturnSubscriptionArn: true,
  }));
  return { endpoint: target, alreadyExists: false };
}

/** 删除一个订阅。必须传完整的订阅 ARN（未确认的订阅无法删除） */
export async function removeNotifySubscription(subscriptionArn: string): Promise<void> {
  const arn = String(subscriptionArn || '').trim();
  const expectedPrefix = topicArn() + ':';
  if (!arn.startsWith(expectedPrefix)) {
    throw new Error('订阅 ARN 不属于当前报告通知主题，已拒绝操作');
  }
  const creds = await getConsoleCreds();
  const sns = new SNSClient({ region: TC.region || 'us-east-1', credentials: creds });
  await sns.send(new UnsubscribeCommand({ SubscriptionArn: arn }));
}

// ============================================================
// 全自动接入 runner 使用的区域发现与精确 StackSet 覆盖检查
// ============================================================

interface RegionAvailability {
  enabledRegions: string[];
  defaultRegions: string[];
}

async function getRegionAvailability(payerAccountId: string): Promise<RegionAvailability> {
  const creds = await assumePayer(payerAccountId);
  if (!creds) throw new Error('该 payer 不在平台配置（config.payers）中，无法查询可用区域');
  const ec2 = new EC2Client({ region: 'us-east-1', credentials: creds });
  try {
    const response = await ec2.send(new DescribeRegionsCommand({ AllRegions: true }));
    const available = (response.Regions || []).filter(item => item.RegionName);
    return {
      enabledRegions: available
        .filter(item => item.OptInStatus === 'opt-in-not-required' || item.OptInStatus === 'opted-in')
        .map(item => item.RegionName!)
        .sort(),
      defaultRegions: available
        .filter(item => item.OptInStatus === 'opt-in-not-required')
        .map(item => item.RegionName!)
        .sort(),
    };
  } finally {
    ec2.destroy();
  }
}

/** 只返回 payer 管理账户已启用或无需 opt-in 的商业区域。 */
export async function getEnabledRegions(payerAccountId: string): Promise<string[]> {
  return (await getRegionAvailability(payerAccountId)).enabledRegions;
}

export type PayerRegionEnableOutcome = 'enabled' | 'enabling' | 'submitted' | 'failed';

export interface PayerRegionEnableResult {
  region: string;
  outcome: PayerRegionEnableOutcome;
  detail?: string;
}

/**
 * 在 payer 管理账户内启用指定的可选区域（成员账户已启用、payer 未启用的区域）。
 * StackSets 要求管理账户先启用全部目标区域；这一步原本需要人工去控制台点。
 * 开启是账户级、不可在启用中途取消的变更，只对调用方明确传入的区域执行；已启用/启用中的跳过。
 */
export async function enablePayerRegions(payerAccountId: string, regions: string[]): Promise<PayerRegionEnableResult[]> {
  const creds = await assumePayer(payerAccountId);
  if (!creds) throw new Error('该 payer 不在平台配置（config.payers）中，无法启用区域');
  const client = new AccountClient({ region: 'us-east-1', credentials: creds });
  const results: PayerRegionEnableResult[] = [];
  try {
    for (const region of [...new Set(regions)].sort()) {
      if (!REGION_RE.test(region)) {
        results.push({ region, outcome: 'failed', detail: '区域名称不合法' });
        continue;
      }
      try {
        const current = await client.send(new GetRegionOptStatusCommand({ RegionName: region }));
        const status = current.RegionOptStatus;
        if (status === 'ENABLED' || status === 'ENABLED_BY_DEFAULT') {
          results.push({ region, outcome: 'enabled' });
        } else if (status === 'ENABLING') {
          results.push({ region, outcome: 'enabling' });
        } else if (status === 'DISABLING') {
          // 停用中的区域不能立即重新启用，下一轮再试。
          results.push({ region, outcome: 'enabling', detail: '区域正在停用，等待结束后再启用' });
        } else {
          await client.send(new EnableRegionCommand({ RegionName: region }));
          results.push({ region, outcome: 'submitted' });
        }
      } catch (error) {
        results.push({ region, outcome: 'failed', detail: awsErrorDetail(error) });
      }
    }
  } finally {
    client.destroy();
  }
  return results;
}

/** 返回新账户默认启用、可安全用于 StackSet AutoDeployment 的区域。 */
export async function getDefaultRegions(payerAccountId: string): Promise<string[]> {
  return (await getRegionAvailability(payerAccountId)).defaultRegions;
}

/**
 * 查询每个 ACTIVE 成员账户自己的区域启用状态。可选区域是账户级设置，不能用 payer 的状态代替成员。
 * 结果会持久化进 onboarding job，后续轮询不重复扫描全部成员。
 */
export interface MemberRegionDiscovery {
  regions: Record<string, string[]>;
  /** 平台进不去或查不到区域的账户：记录后跳过，不让一个账户拖垮整个组织的接入 */
  unreachable: Array<{ accountId: string; error: string }>;
}

/**
 * 读取每个 ACTIVE 成员账户的已启用区域。
 *
 * 用 account:ListRegions 而不是 ec2:DescribeRegions：受限账户的 support-quota 收窄后只保留了前者，
 * 用后者会让受限账户（taoVolt 的两个 tor 账户）每次都 UnauthorizedOperation、整个组织接入失败。
 */
export async function getMemberEnabledRegions(payerAccountId: string): Promise<MemberRegionDiscovery> {
  const payerCreds = await assumePayer(payerAccountId);
  if (!payerCreds) throw new Error('该 payer 不在平台配置（config.payers）中，无法查询成员区域');
  const org = new OrganizationsClient({ region: 'us-east-1', credentials: payerCreds });
  const memberAccountIds: string[] = [];
  let token: string | undefined;
  do {
    const page = await org.send(new ListAccountsCommand({ NextToken: token }));
    for (const account of page.Accounts || []) {
      const active = account.State ? account.State === 'ACTIVE' : account.Status === 'ACTIVE';
      if (active && account.Id && account.Id !== payerAccountId) memberAccountIds.push(account.Id);
    }
    token = page.NextToken;
  } while (token);

  const result: MemberRegionDiscovery = { regions: {}, unreachable: [] };
  const batchSize = 5;
  for (let index = 0; index < memberAccountIds.length; index += batchSize) {
    const batch = memberAccountIds.slice(index, index + batchSize);
    await Promise.all(batch.map(async accountId => {
      let credentials: AwsCredentials;
      try {
        credentials = await assumeToAccount(accountId);
      } catch (e: any) {
        // 拿不到凭证（角色不存在/被拒）才算不可达；限流、超时抛出让任务重试，否则该账户会被永久跳过
        if (isTransientAwsError(e)) throw e;
        result.unreachable.push({ accountId, error: awsErrorDetail(e) });
        return;
      }
      try {
        const account = new AccountClient({ region: 'us-east-1', credentials });
        const listed: Array<{ RegionName?: string; RegionOptStatus?: string }> = [];
        let next: string | undefined;
        do {
          const page = await account.send(new ListRegionsCommand({
            RegionOptStatusContains: ['ENABLED', 'ENABLED_BY_DEFAULT'], MaxResults: 50, NextToken: next,
          }));
          listed.push(...(page.Regions || []));
          next = page.NextToken;
        } while (next);
        const regions = enabledRegionsFromListRegions(listed);
        if (regions.length === 0) {
          result.unreachable.push({ accountId, error: 'ListRegions 返回空' });
          return;
        }
        result.regions[accountId] = regions;
      } catch (e: any) {
        if (!isAccessDeniedError(e)) throw e;
        result.unreachable.push({ accountId, error: awsErrorDetail(e) });
      }
    }));
  }
  result.unreachable.sort((a, b) => a.accountId.localeCompare(b.accountId));
  return result;
}

export interface OrgEnabledRegionsResult {
  payerAccountId: string;
  payerRegions: string[];
  defaultRegions: string[];
  regions: string[];
  aggregatorRegions: string[];
  memberAccountCount: number;
  memberEnabledRegions: Record<string, string[]>;
  regionAccountCounts: Record<string, number>;
  /** 无法进入、未纳入区域统计的成员账户 */
  unreachableAccounts: Array<{ accountId: string; error: string }>;
}

/**
 * 读取 payer 与所有 ACTIVE 成员账户的实际启用区域并取并集。
 * 手工索引部署必须使用这份动态结果，不能依赖会随 AWS 新区域发布而过期的固定列表。
 */
export async function getOrgEnabledRegions(payerAccountId: string): Promise<OrgEnabledRegionsResult> {
  const [payerAvailability, discovery] = await Promise.all([
    getRegionAvailability(payerAccountId),
    getMemberEnabledRegions(payerAccountId),
  ]);
  const memberEnabledRegions = discovery.regions;
  const { enabledRegions: payerRegions, defaultRegions } = payerAvailability;
  const allRegions = new Set(payerRegions);
  const regionAccountCounts: Record<string, number> = {};
  for (const regions of Object.values(memberEnabledRegions)) {
    for (const region of regions) {
      allRegions.add(region);
      regionAccountCounts[region] = (regionAccountCounts[region] || 0) + 1;
    }
  }
  for (const region of payerRegions) {
    regionAccountCounts[region] = (regionAccountCounts[region] || 0) + 1;
  }
  const memberAccountIds = Object.keys(memberEnabledRegions);
  const aggregatorRegions = defaultRegions.filter(region => memberAccountIds.every(
    accountId => memberEnabledRegions[accountId].includes(region),
  ));
  return {
    payerAccountId,
    payerRegions,
    defaultRegions,
    regions: [...allRegions].sort(),
    aggregatorRegions,
    memberAccountCount: memberAccountIds.length,
    memberEnabledRegions,
    regionAccountCounts,
    unreachableAccounts: discovery.unreachable,
  };
}

export interface StackSetTargetStatus {
  accountId: string;
  region: string;
  status?: string;
}

const RE_INDEX_STACKSETS = [RE_AGGREGATOR_STACKSET, RE_LOCAL_STACKSET, RE_SCOPED_LOCAL_STACKSET];

/**
 * 成员账户在接入前自己建过 Resource Explorer 索引时，StackSet 实例会以
 * AlreadyExists 失败。CloudFormation 把这类实例的 Status 标成 OUTDATED、
 * DetailedStatus 标成 FAILED —— effectiveStackInstanceStatus 优先返回 OUTDATED，
 * 所以两种状态都必须识别，否则会被当成真实失败反复 UpdateStackInstances 直到超时。
 */
export function isExistingIndexConflict(stackSetName: string, status?: string, reason?: string): boolean {
  return RE_INDEX_STACKSETS.includes(stackSetName)
    && ['FAILED', 'OUTDATED'].includes(status || '')
    && /AlreadyExists|index already exists/i.test(reason || '');
}

/**
 * ready   — 已有索引满足扫描要求，可替代 StackSet 实例
 * upgrade — 聚合区已有 ACTIVE 的 LOCAL 索引，需升级为 AGGREGATOR
 * pending — 索引在变更中，或本地索引尚未开始向聚合区复制，等待下一轮
 * invalid — 不可用（类型冲突、读取失败等），按失败处理
 */
export type ExistingIndexVerdict = 'ready' | 'upgrade' | 'pending' | 'invalid';

export function classifyExistingIndex(
  stackSetName: string,
  aggregatorRegion: string,
  index: { Type?: string; State?: string; ReplicatingTo?: string[] } | null | undefined,
): ExistingIndexVerdict {
  if (!index || !RE_INDEX_STACKSETS.includes(stackSetName)) return 'invalid';
  if (index.State !== 'ACTIVE') {
    return ['CREATING', 'UPDATING'].includes(index.State || '') ? 'pending' : 'invalid';
  }
  if (stackSetName === RE_AGGREGATOR_STACKSET) {
    if (index.Type === 'AGGREGATOR') return 'ready';
    return index.Type === 'LOCAL' ? 'upgrade' : 'invalid';
  }
  // 本地区域若已是 AGGREGATOR，说明该账户的聚合区不在平台约定区域，单账户只能有一个聚合索引，需人工处理。
  if (index.Type !== 'LOCAL') return 'invalid';
  // 聚合区索引升级后 AWS 会自动开始复制，复制建立前先等待，不判失败。
  return (index.ReplicatingTo || []).includes(aggregatorRegion) ? 'ready' : 'pending';
}

/**
 * payer 侧 ListIndexesForMembers 只给出索引类型，看不到 State 与复制状态，
 * 所以只在成员侧读取被拒（受限账户）时使用：类型符合约定即视为可复用。
 * 聚合区是 LOCAL 需要升级 —— 受限账户不能临时开通 admin，只能人工处理，按 invalid 报出。
 */
export function classifyIndexFromMemberListing(
  stackSetName: string, aggregatorRegion: string, region: string, type: string | undefined,
): ExistingIndexVerdict {
  if (!type || !RE_INDEX_STACKSETS.includes(stackSetName)) return 'invalid';
  if (stackSetName === RE_AGGREGATOR_STACKSET) {
    return region === aggregatorRegion && type === 'AGGREGATOR' ? 'ready' : 'invalid';
  }
  return type === 'LOCAL' ? 'ready' : 'invalid';
}

/** 权限不足类错误（IAM 拒绝），与网络/限流等可重试错误区分 */
/** 限流、超时、服务端瞬时故障：应重试，不能据此判定账户不可达 */
export function isTransientAwsError(error: unknown): boolean {
  const e = error as { name?: string; $retryable?: unknown; $metadata?: { httpStatusCode?: number } } | undefined;
  const name = e?.name || '';
  return e?.$retryable != null
    || /Throttl|TooManyRequests|RequestLimitExceeded|Timeout|AbortError|ServiceUnavailable|InternalFailure|InternalError|NetworkingError|ECONNRESET|ETIMEDOUT/i.test(name)
    || (e?.$metadata?.httpStatusCode ?? 0) >= 500;
}

export function isAccessDeniedError(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; message?: string } | undefined;
  const code = e?.name || e?.Code || '';
  return ['AccessDeniedException', 'AccessDenied', 'UnauthorizedOperation', 'UnauthorizedException'].includes(code)
    || /not authorized to perform/i.test(e?.message || '');
}

export interface OnboardingStackSetStatus extends ReIndexStackSetStatus {
  requiredRegions: string[];
  rootRequiredRegions: string[];
  extraRootRegions: string[];
  autoDeploymentRequired: boolean;
  expectedInstanceCount: number;
  missingInstanceCount: number;
  pendingInstanceCount: number;
  failedInstanceCount: number;
  missingTargets: StackSetTargetStatus[];
  failedTargets: StackSetTargetStatus[];
  /** 聚合区已有 LOCAL 索引、需升级为 AGGREGATOR 的目标（仅聚合索引 StackSet 会出现） */
  indexUpgradeTargets: StackSetTargetStatus[];
  /** 已有索引与平台约定冲突且无法自动处理的目标；修复逻辑不会重试它们 */
  indexConflictTargets: StackSetTargetStatus[];
  permissionModel?: string;
  autoDeploymentEnabled: boolean;
  rootTargeted: boolean;
  configurationValid: boolean;
  complete: boolean;
}

export interface OnboardingStackSetsStatus {
  payerAccountId: string;
  memberAccountCount: number;
  complete: boolean;
  /** 需人工处理的已有索引冲突（AWS 拒绝重复创建，自动重试无效） */
  indexConflicts: Array<StackSetTargetStatus & { stackSetName: string }>;
  failed: boolean;
  stackSets: OnboardingStackSetStatus[];
}

/**
 * 对照组织内 ACTIVE 成员账户 × 目标区域逐项检查三个 StackSet。
 * 范围外的历史账户/旧区域只保留在 statusCounts 诊断信息里，不参与完成判定。
 */
export async function getOnboardingStackSetStatus(
  payerAccountId: string,
  aggregatorRegion: string,
  localRegions: string[],
  memberEnabledRegions: Record<string, string[]>,
  /** 区域发现时无法进入、已明确跳过的账户；其它缺区域信息的账户仍按不安全处理并报错 */
  skippedAccountIds: string[] = [],
): Promise<OnboardingStackSetsStatus> {
  const creds = await assumePayer(payerAccountId);
  if (!creds) throw new Error('该 payer 不在平台配置（config.payers）中');
  const cfn = new CloudFormationClient({ region: aggregatorRegion, credentials: creds });
  const org = new OrganizationsClient({ region: aggregatorRegion, credentials: creds });

  const roots = await org.send(new ListRootsCommand({}));
  const rootOuId = roots.Roots?.[0]?.Id;
  if (!rootOuId) throw new Error('未取到组织根 OU');

  const memberAccounts: string[] = [];
  let accountToken: string | undefined;
  do {
    const page = await org.send(new ListAccountsCommand({ NextToken: accountToken }));
    for (const account of page.Accounts || []) {
      const active = account.State ? account.State === 'ACTIVE' : account.Status === 'ACTIVE';
      if (active && account.Id && account.Id !== payerAccountId && !skippedAccountIds.includes(account.Id)) {
        memberAccounts.push(account.Id);
      }
    }
    accountToken = page.NextToken;
  } while (accountToken);

  const autoDeploymentRegionSet = new Set(await getDefaultRegions(payerAccountId));
  const hasMemberAccounts = memberAccounts.length > 0;
  const localRequiredRegions = hasMemberAccounts
    ? [...new Set(localRegions)].filter(region => memberAccounts.some(
      accountId => memberEnabledRegions[accountId]?.includes(region),
    )).sort()
    : [...autoDeploymentRegionSet].filter(region => region !== aggregatorRegion).sort();
  const commonLocalRegions = localRequiredRegions.filter(region =>
    autoDeploymentRegionSet.has(region)
    && memberAccounts.every(accountId => memberEnabledRegions[accountId]?.includes(region)));
  const scopedLocalRegions = localRequiredRegions.filter(region => !commonLocalRegions.includes(region));
  const definitions = [
    {
      name: AUTO_TAGGER_STACKSET_NAME,
      requiredRegions: ['us-east-1'],
      rootRequiredRegions: ['us-east-1'],
      autoDeploymentRequired: true,
    },
    {
      name: RE_AGGREGATOR_STACKSET,
      requiredRegions: [aggregatorRegion],
      rootRequiredRegions: [aggregatorRegion],
      autoDeploymentRequired: true,
    },
    {
      name: RE_LOCAL_STACKSET,
      requiredRegions: commonLocalRegions,
      rootRequiredRegions: commonLocalRegions,
      autoDeploymentRequired: true,
    },
    {
      name: RE_SCOPED_LOCAL_STACKSET,
      requiredRegions: scopedLocalRegions,
      rootRequiredRegions: [],
      autoDeploymentRequired: false,
    },
  ];
  const stackSets: OnboardingStackSetStatus[] = [];

  for (const definition of definitions) {
    const expectedKeys = new Set<string>();
    for (const accountId of memberAccounts) {
      const enabledForAccount = memberEnabledRegions[accountId];
      if (!Array.isArray(enabledForAccount)) {
        throw new Error(`缺少成员账户 ${accountId} 的区域启用状态，无法安全判断 StackSet 覆盖`);
      }
      const enabled = new Set(enabledForAccount);
      for (const region of definition.requiredRegions) {
        if (enabled.has(region)) expectedKeys.add(`${accountId}:${region}`);
      }
    }
    const entry: OnboardingStackSetStatus = {
      name: definition.name,
      exists: false,
      instanceCount: 0,
      regions: [],
      statusCounts: {},
      requiredRegions: definition.requiredRegions,
      rootRequiredRegions: definition.rootRequiredRegions,
      extraRootRegions: [],
      autoDeploymentRequired: definition.autoDeploymentRequired,
      expectedInstanceCount: expectedKeys.size,
      missingInstanceCount: expectedKeys.size,
      pendingInstanceCount: 0,
      failedInstanceCount: 0,
      missingTargets: [],
      failedTargets: [],
      indexUpgradeTargets: [],
      indexConflictTargets: [],
      autoDeploymentEnabled: false,
      rootTargeted: false,
      configurationValid: false,
      complete: definition.requiredRegions.length === 0,
    };

    try {
      const described = await cfn.send(new DescribeStackSetCommand({ StackSetName: definition.name, CallAs: 'SELF' }));
      entry.exists = true;
      entry.permissionModel = described.StackSet?.PermissionModel;
      entry.autoDeploymentEnabled = described.StackSet?.AutoDeployment?.Enabled === true;
    } catch (error: any) {
      if (error.name === 'StackSetNotFoundException') {
        stackSets.push(entry);
        continue;
      }
      throw error;
    }

    const autoTargets: Array<{ ou?: string; regions: string[] }> = [];
    let targetToken: string | undefined;
    do {
      const page = await cfn.send(new ListStackSetAutoDeploymentTargetsCommand({
        StackSetName: definition.name,
        CallAs: 'SELF',
        NextToken: targetToken,
      }));
      for (const summary of page.Summaries || []) {
        autoTargets.push({ ou: summary.OrganizationalUnitId, regions: summary.Regions || [] });
      }
      targetToken = page.NextToken;
    } while (targetToken);
    const actualRootRegions = new Set(autoTargets
      .filter(target => target.ou === rootOuId)
      .flatMap(target => target.regions));
    entry.rootTargeted = definition.rootRequiredRegions.every(region => actualRootRegions.has(region));
    entry.extraRootRegions = definition.name === RE_LOCAL_STACKSET
      ? [...actualRootRegions].filter(region => !definition.rootRequiredRegions.includes(region)).sort()
      : [];
    entry.configurationValid = entry.permissionModel === 'SERVICE_MANAGED'
      && entry.autoDeploymentEnabled === definition.autoDeploymentRequired
      && entry.rootTargeted
      && entry.extraRootRegions.length === 0;

    const targetStatuses = new Map<string, { status: string; reason?: string }>();
    const regions = new Set<string>();
    let instanceToken: string | undefined;
    do {
      const page = await cfn.send(new ListStackInstancesCommand({
        StackSetName: definition.name,
        CallAs: 'SELF',
        NextToken: instanceToken,
      }));
      for (const summary of page.Summaries || []) {
        entry.instanceCount++;
        if (summary.Region) regions.add(summary.Region);
        const status = effectiveStackInstanceStatus(summary);
        entry.statusCounts[status] = (entry.statusCounts[status] || 0) + 1;
        if (summary.Account && summary.Region) {
          targetStatuses.set(`${summary.Account}:${summary.Region}`, { status, reason: summary.StatusReason });
        }
      }
      instanceToken = page.NextToken;
    } while (instanceToken);
    entry.regions = [...regions].sort();

    let operationActive = false;
    try {
      const operations = await cfn.send(new ListStackSetOperationsCommand({
        StackSetName: definition.name,
        CallAs: 'SELF',
        MaxResults: 20,
      }));
      const operationSummaries = operations.Summaries || [];
      const operation = operationSummaries[0];
      operationActive = operationSummaries.some(item => (
        ['RUNNING', 'QUEUED', 'STOPPING'].includes(item.Status || '')
      ));
      if (operation) {
        entry.latestOperation = {
          operationId: operation.OperationId,
          action: operation.Action,
          status: operation.Status,
          timestamp: operation.CreationTimestamp,
        };
      }
    } catch { /* 操作列表不可用时仍以实例覆盖为准 */ }

    const supportCredentialsByAccount = new Map<string, ReturnType<typeof assumeSupportRoleStrict>>();
    function strictSupportCredentials(accountId: string) {
      let credentials = supportCredentialsByAccount.get(accountId);
      if (!credentials) {
        credentials = assumeSupportRoleStrict(accountId);
        supportCredentialsByAccount.set(accountId, credentials);
      }
      return credentials;
    }

    // 受限账户的 support-quota 收窄后没有 GetIndex：改从 payer 侧只读列出该账户的索引类型核对。
    const memberIndexTypesByAccount = new Map<string, Promise<Map<string, string>>>();
    function memberIndexTypes(accountId: string) {
      let types = memberIndexTypesByAccount.get(accountId);
      if (!types) {
        types = (async () => {
          const re = new ResourceExplorer2Client({ region: aggregatorRegion, credentials: creds! });
          const byRegion = new Map<string, string>();
          let next: string | undefined;
          do {
            const page = await re.send(new ListIndexesForMembersCommand({ AccountIdList: [accountId], NextToken: next }));
            for (const index of page.Indexes || []) {
              if (index.Region && index.Type) byRegion.set(index.Region, index.Type);
            }
            next = page.NextToken;
          } while (next);
          return byRegion;
        })();
        memberIndexTypesByAccount.set(accountId, types);
      }
      return types;
    }

    // 只读校验走成员账户的 support-quota（ReadOnlyAccess 含 resource-explorer-2:GetIndex）。
    async function classifyTargetIndex(accountId: string, region: string): Promise<ExistingIndexVerdict> {
      let client: ResourceExplorer2Client | undefined;
      let timeout: NodeJS.Timeout | undefined;
      try {
        const credentials = await strictSupportCredentials(accountId);
        client = new ResourceExplorer2Client({ region, credentials, maxAttempts: 2 });
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 15_000);
        const index = await client.send(new GetIndexCommand({}), { abortSignal: controller.signal });
        return classifyExistingIndex(definition.name, aggregatorRegion, index);
      } catch (error) {
        if (isAccessDeniedError(error)) {
          try {
            const type = (await memberIndexTypes(accountId)).get(region);
            return classifyIndexFromMemberListing(definition.name, aggregatorRegion, region, type);
          } catch (fallbackError) {
            console.warn(`[MAP Onboarding] payer 侧索引核对失败 ${accountId}/${region}: ${awsErrorDetail(fallbackError)}`);
            return 'invalid';
          }
        }
        console.warn(`[MAP Onboarding] 已有索引校验失败 ${accountId}/${region}: ${awsErrorDetail(error)}`);
        return 'invalid';
      } finally {
        if (timeout) clearTimeout(timeout);
        client?.destroy();
      }
    }

    const existingIndexCandidates: StackSetTargetStatus[] = [];
    for (const key of expectedKeys) {
      const separator = key.indexOf(':');
      const accountId = key.slice(0, separator);
      const region = key.slice(separator + 1);
      const target = targetStatuses.get(key);
      const status = target?.status;
      if (!status) {
        if ([RE_LOCAL_STACKSET, RE_SCOPED_LOCAL_STACKSET].includes(definition.name)) {
          existingIndexCandidates.push({ accountId, region, status: 'MISSING' });
        } else {
          entry.missingTargets.push({ accountId, region });
        }
      } else if (['CURRENT', 'SUCCEEDED'].includes(status)) {
        // 仅真正完成的 ACTIVE 目标计为成功。
      } else if (['FAILED', 'CANCELLED', 'INOPERABLE', 'OUTDATED', 'SKIPPED_SUSPENDED_ACCOUNT'].includes(status)) {
        if (isExistingIndexConflict(definition.name, status, target?.reason)) {
          existingIndexCandidates.push({ accountId, region, status });
        } else {
          entry.failedTargets.push({ accountId, region, status });
        }
      } else {
        entry.pendingInstanceCount++;
      }
    }

    const verificationConcurrency = 5;
    if (operationActive) {
      // 活跃 operation 的实例分页快照尚未收敛，结束后下一轮再逐账户验证已有索引。
      entry.pendingInstanceCount += existingIndexCandidates.length;
    } else {
      for (let index = 0; index < existingIndexCandidates.length; index += verificationConcurrency) {
        const batch = existingIndexCandidates.slice(index, index + verificationConcurrency);
        const verified = await Promise.all(batch.map(async target => ({
          target,
          verdict: await classifyTargetIndex(target.accountId, target.region),
        })));
        for (const { target, verdict } of verified) {
          const status = target.status || 'FAILED';
          if (verdict === 'ready') {
            if (status !== 'MISSING') entry.statusCounts[status] = Math.max(0, (entry.statusCounts[status] || 0) - 1);
            entry.statusCounts.ACTIVE_EXISTING_INDEX = (entry.statusCounts.ACTIVE_EXISTING_INDEX || 0) + 1;
          } else if (verdict === 'upgrade') {
            entry.indexUpgradeTargets.push(target);
            entry.pendingInstanceCount++;
          } else if (verdict === 'pending') {
            entry.pendingInstanceCount++;
          } else if (status === 'MISSING') {
            entry.missingTargets.push({ accountId: target.accountId, region: target.region });
          } else {
            // 已有索引不可用：不能放进 failedTargets，否则修复逻辑会重试同一实例、注定再次 AlreadyExists。
            entry.indexConflictTargets.push(target);
          }
        }
      }
    }
    entry.missingInstanceCount = entry.missingTargets.length;
    entry.failedInstanceCount = entry.failedTargets.length;

    if (operationActive) {
      // StackSet 操作进行中时实例分页结果不是原子快照；待操作收敛后再判定缺失或失败。
      entry.pendingInstanceCount += entry.missingInstanceCount + entry.failedInstanceCount;
      entry.missingInstanceCount = 0;
      entry.failedInstanceCount = 0;
    }
    entry.complete = definition.requiredRegions.length === 0
      ? entry.extraRootRegions.length === 0
      : (
        entry.exists
        && entry.configurationValid
        && entry.missingInstanceCount === 0
        && entry.pendingInstanceCount === 0
        && entry.failedInstanceCount === 0
        && entry.indexConflictTargets.length === 0
        && !operationActive
      );
    stackSets.push(entry);
  }

  return {
    payerAccountId,
    memberAccountCount: memberAccounts.length,
    complete: stackSets.every(item => item.complete),
    indexConflicts: stackSets.flatMap(item => item.indexConflictTargets.map(target => ({ ...target, stackSetName: item.name }))),
    failed: stackSets.some(item => item.requiredRegions.length > 0 && (
      (!item.exists && item.name === AUTO_TAGGER_STACKSET_NAME)
      || (item.exists && (
        item.permissionModel !== 'SERVICE_MANAGED'
        || item.autoDeploymentEnabled !== item.autoDeploymentRequired
      ))
    )),
    stackSets,
  };
}

export interface StackSetRepairResult {
  submitted: boolean;
  stackSetName?: string;
  operationId?: string;
  detail: string;
}

/** 每次最多提交一个修复操作，后续轮询会继续处理剩余区域/账户，避免同一 StackSet 操作冲突。 */
export async function repairOnboardingStackSetCoverage(
  payerAccountId: string,
  aggregatorRegion: string,
  localRegions: string[],
  memberEnabledRegions: Record<string, string[]>,
  inspected?: OnboardingStackSetsStatus,
  skippedAccountIds: string[] = [],
): Promise<StackSetRepairResult> {
  const status = inspected || await getOnboardingStackSetStatus(
    payerAccountId, aggregatorRegion, localRegions, memberEnabledRegions, skippedAccountIds,
  );
  if (status.complete) return { submitted: false, detail: 'StackSet 覆盖已完整' };
  const creds = await assumePayer(payerAccountId);
  if (!creds) throw new Error('该 payer 不在平台配置（config.payers）中');
  const cfn = new CloudFormationClient({ region: aggregatorRegion, credentials: creds });
  const org = new OrganizationsClient({ region: aggregatorRegion, credentials: creds });
  const roots = await org.send(new ListRootsCommand({}));
  const rootOuId = roots.Roots?.[0]?.Id;
  if (!rootOuId) throw new Error('未取到组织根 OU');

  for (const stackSet of status.stackSets) {
    if (stackSet.complete) continue;
    if (stackSet.requiredRegions.length === 0 && stackSet.extraRootRegions.length === 0) continue;

    // 成员账户自建的 LOCAL 索引占住了聚合区：StackSet 无法再建 AGGREGATOR（AlreadyExists），
    // 原地升级是无损操作，升级后该账户其它区域的本地索引会自动开始向它复制。
    const upgradeTarget = stackSet.indexUpgradeTargets[0];
    if (upgradeTarget) {
      const memberCredentials = await getTempAdminCredentials(upgradeTarget.accountId);
      const re = new ResourceExplorer2Client({ region: upgradeTarget.region, credentials: memberCredentials });
      try {
        const index = await re.send(new GetIndexCommand({}));
        if (classifyExistingIndex(stackSet.name, aggregatorRegion, index) !== 'upgrade') {
          return { submitted: false, detail: `${upgradeTarget.accountId} 的 ${upgradeTarget.region} 索引状态已变化，下一轮重新核验` };
        }
        await re.send(new UpdateIndexTypeCommand({ Arn: index.Arn!, Type: 'AGGREGATOR' }));
      } finally {
        re.destroy();
      }
      return {
        submitted: true,
        stackSetName: stackSet.name,
        detail: `已将成员账户 ${upgradeTarget.accountId} 在 ${upgradeTarget.region} 的已有 LOCAL 索引升级为 AGGREGATOR`
          + `（剩余 ${stackSet.indexUpgradeTargets.length - 1} 个待升级）`,
      };
    }

    if (!stackSet.exists) {
      const definition = stackSet.name === RE_AGGREGATOR_STACKSET
        ? {
          template: RE_AGGREGATOR_TEMPLATE,
          description: 'Resource Explorer aggregator index (managed by AWSTool)',
          autoDeployment: true,
        }
        : [RE_LOCAL_STACKSET, RE_SCOPED_LOCAL_STACKSET].includes(stackSet.name)
          ? {
            template: RE_LOCAL_TEMPLATE,
            description: stackSet.name === RE_SCOPED_LOCAL_STACKSET
              ? 'Resource Explorer account-scoped local indexes (managed by AWSTool)'
              : 'Resource Explorer common local indexes (managed by AWSTool)',
            autoDeployment: stackSet.name !== RE_SCOPED_LOCAL_STACKSET,
          }
          : null;
      if (!definition) throw new Error(`StackSet ${stackSet.name} 不存在，需返回部署阶段重建`);
      await cfn.send(new CreateStackSetCommand({
        StackSetName: stackSet.name,
        Description: definition.description,
        TemplateBody: definition.template,
        PermissionModel: 'SERVICE_MANAGED',
        AutoDeployment: definition.autoDeployment
          ? { Enabled: true, RetainStacksOnAccountRemoval: false }
          : { Enabled: false },
        ManagedExecution: { Active: true },
        CallAs: 'SELF',
        Tags: [{ Key: 'ManagedBy', Value: 'AWSTool' }, { Key: 'Purpose', Value: 'ResourceExplorer' }],
      }));
      return {
        submitted: true,
        stackSetName: stackSet.name,
        detail: `已创建 ${definition.autoDeployment ? 'AutoDeployment=true' : 'AutoDeployment=false'} 的 ${stackSet.name}`,
      };
    }
    if (stackSet.permissionModel !== 'SERVICE_MANAGED'
      || stackSet.autoDeploymentEnabled !== stackSet.autoDeploymentRequired) {
      throw new Error(`StackSet ${stackSet.name} 权限模型或 AutoDeployment 配置不符合预期`);
    }
    if (['RUNNING', 'QUEUED', 'STOPPING'].includes(stackSet.latestOperation?.status || '')) continue;

    if (stackSet.extraRootRegions.length > 0) {
      const response = await cfn.send(new DeleteStackInstancesCommand({
        StackSetName: stackSet.name,
        DeploymentTargets: { OrganizationalUnitIds: [rootOuId], AccountFilterType: 'NONE' },
        Regions: stackSet.extraRootRegions,
        RetainStacks: true,
        OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
        CallAs: 'SELF',
      }));
      return {
        submitted: true,
        stackSetName: stackSet.name,
        operationId: response.OperationId,
        detail: `${stackSet.name} 正在以 RetainStacks=true 无损解绑 ${stackSet.extraRootRegions.length} 个历史宽泛区域`,
      };
    }

    if (!stackSet.rootTargeted && stackSet.rootRequiredRegions.length > 0) {
      const response = await cfn.send(new CreateStackInstancesCommand({
        StackSetName: stackSet.name,
        DeploymentTargets: { OrganizationalUnitIds: [rootOuId], AccountFilterType: 'NONE' },
        Regions: stackSet.rootRequiredRegions,
        OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
        CallAs: 'SELF',
      }));
      return {
        submitted: true,
        stackSetName: stackSet.name,
        operationId: response.OperationId,
        detail: `${stackSet.name} 已重新绑定根 OU 和 ${stackSet.rootRequiredRegions.length} 个共同启用区域`,
      };
    }

    const repairTargets = stackSet.failedTargets.length > 0 ? stackSet.failedTargets : stackSet.missingTargets;
    if (repairTargets.length === 0) continue;
    const region = repairTargets[0].region;
    const accounts = repairTargets.filter(target => target.region === region).slice(0, 50).map(target => target.accountId);
    const deploymentTargets = {
      OrganizationalUnitIds: [rootOuId],
      Accounts: accounts,
      AccountFilterType: 'INTERSECTION' as const,
    };
    const common = {
      StackSetName: stackSet.name,
      DeploymentTargets: deploymentTargets,
      Regions: [region],
      OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
      CallAs: 'SELF' as const,
    };
    const response = stackSet.failedTargets.length > 0
      ? await cfn.send(new UpdateStackInstancesCommand(common))
      : await cfn.send(new CreateStackInstancesCommand(common));
    return {
      submitted: true,
      stackSetName: stackSet.name,
      operationId: response.OperationId,
      detail: `${stackSet.name} 已提交 ${accounts.length} 个账户在 ${region} 的${stackSet.failedTargets.length > 0 ? '失败重试' : '缺口补建'}`,
    };
  }
  return { submitted: false, detail: '已有 StackSet 操作进行中，等待下一轮检查' };
}
