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
import { SFNClient, StartExecutionCommand, ListExecutionsCommand } from '@aws-sdk/client-sfn';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { SNSClient, ListSubscriptionsByTopicCommand, SubscribeCommand, UnsubscribeCommand } from '@aws-sdk/client-sns';
import { IAMClient, GetRoleCommand, CreateRoleCommand, AttachRolePolicyCommand, ListAttachedRolePoliciesCommand } from '@aws-sdk/client-iam';
import {
  ResourceExplorer2Client, ListViewsCommand, CreateViewCommand,
  GetIndexCommand, CreateIndexCommand, UpdateIndexTypeCommand,
} from '@aws-sdk/client-resource-explorer-2';
import {
  CloudFormationClient, DescribeStackSetCommand, CreateStackSetCommand,
  CreateStackInstancesCommand, UpdateStackInstancesCommand, ListStackInstancesCommand, ListStackSetOperationsCommand,
  ListStackSetAutoDeploymentTargetsCommand,
} from '@aws-sdk/client-cloudformation';
import {
  OrganizationsClient, DescribeOrganizationCommand, ListRootsCommand, ListAccountsCommand,
  EnableAWSServiceAccessCommand, ListAWSServiceAccessForOrganizationCommand,
} from '@aws-sdk/client-organizations';
import path from 'path';
import fs from 'fs';
import { db } from './db';
import { assumeSupportRoleStrict, assumeToAccount } from './aws-service';

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

function normalizeOrgsConfig(orgs: any[]): any[] {
  if (!Array.isArray(orgs)) throw new Error('orgs 配置必须是一个数组');

  return orgs.map((org, index) => {
    if (!org || typeof org !== 'object') throw new Error(`第 ${index + 1} 项不是对象`);
    for (const field of ['org_id', 'search_role_arn', 'view_arn']) {
      if (!org[field]) throw new Error(`第 ${index + 1} 项缺少必填字段 ${field}`);
    }
    const tagValue = typeof org.tag_value === 'string' ? org.tag_value.trim() : '';
    if (!tagValue) throw new Error(`第 ${index + 1} 项缺少必填字段 tag_value`);
    const normalizedOrg = { ...org, tag_value: tagValue };

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
      if (created && !candidate.exclude_accounts) candidate.exclude_accounts = input.payerAccountId;

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
const ORG_VIEW_NAME = 'OrgView';

// auto-tagger-role StackSet 模板（与 RE-AUTOTAG 项目 stacksets/auto-tagger-role.yaml 保持一致）。
// 打标用 TagResources API，除 tag:TagResources 外还需各服务自身的打标权限，故权限列表很长。
const AUTO_TAGGER_ROLE_TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Description: >
  StackSet #3 - IAM Role for central auto-tagger Lambda to assume.
  Deploy to ONE region per account (IAM is global).

Parameters:
  CentralToolingAccountId:
    Type: String
    Description: Account ID of the central tooling account where Lambda runs

Resources:
  AutoTaggerRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: auto-tagger-role
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
              - Effect: Allow
                Action:
                  - tag:TagResources
                  - tag:GetResources
                Resource: "*"
              - Effect: Allow
                Action:
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
              - Effect: Allow
                Action:
                  - apigateway:PUT
                  - apigateway:POST
                  - apigateway:DELETE
                  - apigateway:GET
                Resource:
                  - !Sub "arn:aws:apigateway:*::/tags/*"
              - Effect: Allow
                Action:
                  - apigateway:GET
                  - apigateway:PATCH
                Resource:
                  - !Sub "arn:aws:apigateway:*::*"
      Tags:
        - Key: Purpose
          Value: AutoTagger
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
export async function provisionOrg(payerAccountId: string): Promise<ProvisionResult> {
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

  // ---- 4. search-role（信任中央工具账户） ----
  try {
    const trust = {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${central}:root` },
        Action: 'sts:AssumeRole',
      }],
    };
    let exists = false;
    try {
      const r = await iam.send(new GetRoleCommand({ RoleName: SEARCH_ROLE_NAME }));
      exists = true;
      out.searchRoleArn = r.Role?.Arn;
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
    // 幂等挂策略
    const wanted = [
      'arn:aws:iam::aws:policy/AWSResourceExplorerReadOnlyAccess',
      'arn:aws:iam::aws:policy/AWSOrganizationsReadOnlyAccess',
    ];
    const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: SEARCH_ROLE_NAME }));
    const have = new Set((attached.AttachedPolicies || []).map(p => p.PolicyArn));
    for (const arn of wanted) {
      if (!have.has(arn)) await iam.send(new AttachRolePolicyCommand({ RoleName: SEARCH_ROLE_NAME, PolicyArn: arn }));
    }
    steps.push({
      key: 'searchRole', label: 'Resource Explorer 搜索角色',
      status: exists ? 'skipped' : 'created',
      detail: out.searchRoleArn,
    });
  } catch (e: any) {
    steps.push({ key: 'searchRole', label: 'Resource Explorer 搜索角色', status: 'failed', detail: awsErrorDetail(e) });
    out.needsRetry = true;
  }

  // ---- 5. AutoTaggerRole StackSet + 部署到根 OU ----
  try {
    let stackSetExists = false;
    try {
      await cfn.send(new DescribeStackSetCommand({ StackSetName: AUTO_TAGGER_STACKSET_NAME, CallAs: 'SELF' }));
      stackSetExists = true;
    } catch (e: any) { if (e.name !== 'StackSetNotFoundException') throw e; }

    if (!stackSetExists) {
      await cfn.send(new CreateStackSetCommand({
        StackSetName: AUTO_TAGGER_STACKSET_NAME,
        Description: 'IAM role for central tag-compliance auto-tagger (managed by AWSTool)',
        TemplateBody: AUTO_TAGGER_ROLE_TEMPLATE,
        PermissionModel: 'SERVICE_MANAGED',
        AutoDeployment: { Enabled: true, RetainStacksOnAccountRemoval: false },
        ManagedExecution: { Active: true },
        Capabilities: ['CAPABILITY_NAMED_IAM'],
        Parameters: [{ ParameterKey: 'CentralToolingAccountId', ParameterValue: central }],
        CallAs: 'SELF',
        Tags: [{ Key: 'ManagedBy', Value: 'AWSTool' }, { Key: 'Purpose', Value: 'TagCompliance' }],
      }));
    }

    // 仅在还没有任何实例时才下发，避免重复触发操作
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
  } catch (e: any) {
    steps.push({ key: 'stackSet', label: '打标角色 StackSet (AutoTaggerRole)', status: 'failed', detail: awsErrorDetail(e) });
    out.needsRetry = true;
  }

  return out;
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

/**
 * 为整个组织下发 Resource Explorer 索引（幂等）。
 * 只在缺失的区域下发实例，已有实例的区域跳过；返回后用 getReIndexStatus 轮询。
 */
export async function deployReIndexes(
  payerAccountId: string,
  aggregatorRegion = 'us-east-1',
  localRegions: string[] = [],
  payerLocalRegions: string[] = localRegions,
): Promise<ReIndexDeployResult> {
  if (!REGION_RE.test(aggregatorRegion)) throw new Error(`聚合区域不合法: ${aggregatorRegion}`);
  const locals = [...new Set(localRegions.filter(r => REGION_RE.test(r) && r !== aggregatorRegion))];
  const managementLocals = [...new Set(payerLocalRegions.filter(r => REGION_RE.test(r) && r !== aggregatorRegion))];

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
  async function ensureStackSet(name: string, template: string, desc: string) {
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
      AutoDeployment: { Enabled: true, RetainStacksOnAccountRemoval: false },
      ManagedExecution: { Active: true },
      CallAs: 'SELF',
      Tags: [{ Key: 'ManagedBy', Value: 'AWSTool' }, { Key: 'Purpose', Value: 'ResourceExplorer' }],
    }));
    return true; // 新建
  }

  // 已部署实例覆盖的区域
  async function deployedRegions(name: string): Promise<Set<string>> {
    const regions = new Set<string>();
    let token: string | undefined;
    do {
      const p = await cfn.send(new ListStackInstancesCommand({ StackSetName: name, CallAs: 'SELF', NextToken: token }));
      for (const s of p.Summaries || []) if (s.Region) regions.add(s.Region);
      token = p.NextToken;
    } while (token);
    return regions;
  }

  // ---- 聚合索引 StackSet ----
  try {
    const created = await ensureStackSet(RE_AGGREGATOR_STACKSET, RE_AGGREGATOR_TEMPLATE, 'Resource Explorer aggregator index (managed by AWSTool)');
    const have = await deployedRegions(RE_AGGREGATOR_STACKSET);
    if (have.has(aggregatorRegion)) {
      steps.push({ key: 'aggStackSet', label: `聚合索引 StackSet (${aggregatorRegion})`, status: 'skipped', detail: '该区域已有实例' });
    } else {
      const op = await cfn.send(new CreateStackInstancesCommand({
        StackSetName: RE_AGGREGATOR_STACKSET,
        DeploymentTargets: { OrganizationalUnitIds: [out.rootOuId!] },
        Regions: [aggregatorRegion],
        OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
        CallAs: 'SELF',
      }));
      steps.push({
        key: 'aggStackSet', label: `聚合索引 StackSet (${aggregatorRegion})`, status: 'created',
        detail: `${created ? '已创建 StackSet 并' : ''}已下发到根 OU（异步，operationId ${op.OperationId}）`,
      });
    }
  } catch (e: any) {
    steps.push({ key: 'aggStackSet', label: `聚合索引 StackSet (${aggregatorRegion})`, status: 'failed', detail: awsErrorDetail(e) });
  }

  // ---- 本地索引 StackSet ----
  if (locals.length === 0) {
    steps.push({ key: 'localStackSet', label: '本地索引 StackSet', status: 'skipped', detail: '未选择其它区域' });
  } else {
    try {
      const created = await ensureStackSet(RE_LOCAL_STACKSET, RE_LOCAL_TEMPLATE, 'Resource Explorer local indexes (managed by AWSTool)');
      const have = await deployedRegions(RE_LOCAL_STACKSET);
      const missing = locals.filter(r => !have.has(r));
      if (missing.length === 0) {
        steps.push({ key: 'localStackSet', label: '本地索引 StackSet', status: 'skipped', detail: `所选 ${locals.length} 个区域均已有实例` });
      } else {
        const op = await cfn.send(new CreateStackInstancesCommand({
          StackSetName: RE_LOCAL_STACKSET,
          DeploymentTargets: { OrganizationalUnitIds: [out.rootOuId!] },
          Regions: missing,
          OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
          CallAs: 'SELF',
        }));
        steps.push({
          key: 'localStackSet', label: '本地索引 StackSet', status: 'created',
          detail: `${created ? '已创建 StackSet 并' : ''}已下发 ${missing.length} 个区域: ${missing.join(', ')}（异步，operationId ${op.OperationId}）`,
        });
      }
    } catch (e: any) {
      steps.push({ key: 'localStackSet', label: '本地索引 StackSet', status: 'failed', detail: awsErrorDetail(e) });
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

/** 查询两个索引 StackSet 的部署进度，供前端轮询 */
export async function getReIndexStatus(payerAccountId: string, region = 'us-east-1'): Promise<{ payerAccountId: string; stackSets: ReIndexStackSetStatus[] }> {
  const creds = await assumePayer(payerAccountId);
  if (!creds) throw new Error('该 payer 不在平台配置（config.payers）中');
  const cfn = new CloudFormationClient({ region, credentials: creds });

  const stackSets: ReIndexStackSetStatus[] = [];
  for (const name of [RE_AGGREGATOR_STACKSET, RE_LOCAL_STACKSET]) {
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
        const st = s.StackInstanceStatus?.DetailedStatus || s.Status || 'UNKNOWN';
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

/** 只返回 payer 管理账户已启用或无需 opt-in 的商业区域。 */
export async function getEnabledRegions(payerAccountId: string): Promise<string[]> {
  const creds = await assumePayer(payerAccountId);
  if (!creds) throw new Error('该 payer 不在平台配置（config.payers）中，无法查询可用区域');
  const ec2 = new EC2Client({ region: 'us-east-1', credentials: creds });
  const response = await ec2.send(new DescribeRegionsCommand({ AllRegions: true }));
  return (response.Regions || [])
    .filter(item => item.RegionName && (item.OptInStatus === 'opt-in-not-required' || item.OptInStatus === 'opted-in'))
    .map(item => item.RegionName!)
    .sort();
}

/**
 * 查询每个 ACTIVE 成员账户自己的区域启用状态。可选区域是账户级设置，不能用 payer 的状态代替成员。
 * 结果会持久化进 onboarding job，后续轮询不重复扫描全部成员。
 */
export async function getMemberEnabledRegions(payerAccountId: string): Promise<Record<string, string[]>> {
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

  const result: Record<string, string[]> = {};
  const batchSize = 5;
  for (let index = 0; index < memberAccountIds.length; index += batchSize) {
    const batch = memberAccountIds.slice(index, index + batchSize);
    const resolved = await Promise.all(batch.map(async accountId => {
      const credentials = await assumeToAccount(accountId);
      const ec2 = new EC2Client({ region: 'us-east-1', credentials });
      const response = await ec2.send(new DescribeRegionsCommand({ AllRegions: true }));
      const regions = (response.Regions || [])
        .filter(item => item.RegionName && (item.OptInStatus === 'opt-in-not-required' || item.OptInStatus === 'opted-in'))
        .map(item => item.RegionName!)
        .sort();
      return { accountId, regions };
    }));
    for (const item of resolved) result[item.accountId] = item.regions;
  }
  return result;
}

export interface StackSetTargetStatus {
  accountId: string;
  region: string;
  status?: string;
}

export interface OnboardingStackSetStatus extends ReIndexStackSetStatus {
  requiredRegions: string[];
  expectedInstanceCount: number;
  missingInstanceCount: number;
  pendingInstanceCount: number;
  failedInstanceCount: number;
  missingTargets: StackSetTargetStatus[];
  failedTargets: StackSetTargetStatus[];
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
      if (active && account.Id && account.Id !== payerAccountId) memberAccounts.push(account.Id);
    }
    accountToken = page.NextToken;
  } while (accountToken);

  const definitions = [
    { name: AUTO_TAGGER_STACKSET_NAME, requiredRegions: ['us-east-1'] },
    { name: RE_AGGREGATOR_STACKSET, requiredRegions: [aggregatorRegion] },
    { name: RE_LOCAL_STACKSET, requiredRegions: [...new Set(localRegions)].sort() },
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
      expectedInstanceCount: expectedKeys.size,
      missingInstanceCount: expectedKeys.size,
      pendingInstanceCount: 0,
      failedInstanceCount: 0,
      missingTargets: [],
      failedTargets: [],
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
    entry.rootTargeted = definition.requiredRegions.length === 0 || definition.requiredRegions.every(region =>
      autoTargets.some(target => target.ou === rootOuId && target.regions.includes(region)));
    entry.configurationValid = entry.permissionModel === 'SERVICE_MANAGED'
      && entry.autoDeploymentEnabled
      && entry.rootTargeted;

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
        const status = summary.StackInstanceStatus?.DetailedStatus || summary.Status || 'UNKNOWN';
        entry.statusCounts[status] = (entry.statusCounts[status] || 0) + 1;
        if (summary.Account && summary.Region) {
          targetStatuses.set(`${summary.Account}:${summary.Region}`, { status, reason: summary.StatusReason });
        }
      }
      instanceToken = page.NextToken;
    } while (instanceToken);
    entry.regions = [...regions].sort();

    const supportCredentialsByAccount = new Map<string, ReturnType<typeof assumeSupportRoleStrict>>();
    function strictSupportCredentials(accountId: string) {
      let credentials = supportCredentialsByAccount.get(accountId);
      if (!credentials) {
        credentials = assumeSupportRoleStrict(accountId);
        supportCredentialsByAccount.set(accountId, credentials);
      }
      return credentials;
    }

    async function hasActiveExistingLocalIndex(accountId: string, region: string): Promise<boolean> {
      let client: ResourceExplorer2Client | undefined;
      let timeout: NodeJS.Timeout | undefined;
      try {
        const credentials = await strictSupportCredentials(accountId);
        client = new ResourceExplorer2Client({ region, credentials, maxAttempts: 2 });
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 15_000);
        const index = await client.send(new GetIndexCommand({}), { abortSignal: controller.signal });
        return index.State === 'ACTIVE'
          && index.Type === 'LOCAL'
          && (index.ReplicatingTo || []).includes(aggregatorRegion);
      } catch (error) {
        console.warn(`[MAP Onboarding] 已有索引校验失败 ${accountId}/${region}: ${awsErrorDetail(error)}`);
        return false;
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
        entry.missingTargets.push({ accountId, region });
      } else if (['CURRENT', 'SUCCEEDED'].includes(status)) {
        // 仅真正完成的 ACTIVE 目标计为成功。
      } else if (['FAILED', 'CANCELLED', 'INOPERABLE', 'SKIPPED_SUSPENDED_ACCOUNT'].includes(status)) {
        const indexAlreadyExists = definition.name === RE_LOCAL_STACKSET
          && status === 'FAILED'
          && /AlreadyExists|index already exists/i.test(target?.reason || '');
        if (indexAlreadyExists) existingIndexCandidates.push({ accountId, region, status });
        else entry.failedTargets.push({ accountId, region, status });
      } else {
        entry.pendingInstanceCount++;
      }
    }

    const verificationConcurrency = 5;
    for (let index = 0; index < existingIndexCandidates.length; index += verificationConcurrency) {
      const batch = existingIndexCandidates.slice(index, index + verificationConcurrency);
      const verified = await Promise.all(batch.map(async target => ({
        target,
        active: await hasActiveExistingLocalIndex(target.accountId, target.region),
      })));
      for (const result of verified) {
        if (result.active) {
          const status = result.target.status || 'FAILED';
          entry.statusCounts[status] = Math.max(0, (entry.statusCounts[status] || 0) - 1);
          entry.statusCounts.ACTIVE_EXISTING_INDEX = (entry.statusCounts.ACTIVE_EXISTING_INDEX || 0) + 1;
        } else {
          entry.failedTargets.push(result.target);
        }
      }
    }
    entry.missingInstanceCount = entry.missingTargets.length;
    entry.failedInstanceCount = entry.failedTargets.length;

    try {
      const operations = await cfn.send(new ListStackSetOperationsCommand({
        StackSetName: definition.name,
        CallAs: 'SELF',
        MaxResults: 1,
      }));
      const operation = operations.Summaries?.[0];
      if (operation) {
        entry.latestOperation = {
          operationId: operation.OperationId,
          action: operation.Action,
          status: operation.Status,
          timestamp: operation.CreationTimestamp,
        };
      }
    } catch { /* 操作列表不可用时仍以实例覆盖为准 */ }

    const operationStatus = entry.latestOperation?.status || '';
    const operationActive = ['RUNNING', 'QUEUED', 'STOPPING'].includes(operationStatus);
    entry.complete = definition.requiredRegions.length === 0 || (
      entry.exists
      && entry.configurationValid
      && entry.missingInstanceCount === 0
      && entry.pendingInstanceCount === 0
      && entry.failedInstanceCount === 0
      && !operationActive
    );
    stackSets.push(entry);
  }

  return {
    payerAccountId,
    memberAccountCount: memberAccounts.length,
    complete: stackSets.every(item => item.complete),
    failed: stackSets.some(item => item.requiredRegions.length > 0 && (
      !item.exists
      || (item.exists && (!item.autoDeploymentEnabled || item.permissionModel !== 'SERVICE_MANAGED'))
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
): Promise<StackSetRepairResult> {
  const status = inspected || await getOnboardingStackSetStatus(
    payerAccountId, aggregatorRegion, localRegions, memberEnabledRegions,
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
    if (stackSet.complete || stackSet.requiredRegions.length === 0) continue;
    if (!stackSet.exists) throw new Error(`StackSet ${stackSet.name} 不存在，需返回部署阶段重建`);
    if (stackSet.permissionModel !== 'SERVICE_MANAGED' || !stackSet.autoDeploymentEnabled) {
      throw new Error(`StackSet ${stackSet.name} 未启用 SERVICE_MANAGED AutoDeployment`);
    }
    if (['RUNNING', 'QUEUED', 'STOPPING'].includes(stackSet.latestOperation?.status || '')) continue;

    if (!stackSet.rootTargeted) {
      const response = await cfn.send(new CreateStackInstancesCommand({
        StackSetName: stackSet.name,
        DeploymentTargets: { OrganizationalUnitIds: [rootOuId], AccountFilterType: 'NONE' },
        Regions: stackSet.requiredRegions,
        OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
        CallAs: 'SELF',
      }));
      return {
        submitted: true,
        stackSetName: stackSet.name,
        operationId: response.OperationId,
        detail: `${stackSet.name} 已重新绑定根 OU 和 ${stackSet.requiredRegions.length} 个目标区域`,
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
