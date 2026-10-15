/**
 * AWS Service Layer — reads config from shared config.json
 */
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand, AssumeRootCommand } from '@aws-sdk/client-sts';
import { OrganizationsClient, ListAccountsCommand } from '@aws-sdk/client-organizations';
import { ServiceQuotasClient, ListServiceQuotasCommand, RequestServiceQuotaIncreaseCommand, ListRequestedServiceQuotaChangeHistoryCommand, GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';
import {
  IAMClient,
  GetAccountSummaryCommand,
  GetUserCommand,
  ListMFADevicesCommand,
  ListUsersCommand,
  ListVirtualMFADevicesCommand,
  DeactivateMFADeviceCommand,
  DeleteVirtualMFADeviceCommand,
  DeleteLoginProfileCommand,
  CreateLoginProfileCommand,
  ListAccessKeysCommand,
  GetLoginProfileCommand,
  DeleteAccessKeyCommand,
  DeleteUserCommand,
  ListAttachedUserPoliciesCommand,
  DetachUserPolicyCommand,
  ListUserPoliciesCommand,
  DeleteUserPolicyCommand,
  ListGroupsForUserCommand,
  RemoveUserFromGroupCommand,
  ListSigningCertificatesCommand,
  DeleteSigningCertificateCommand,
  ListSSHPublicKeysCommand,
  DeleteSSHPublicKeyCommand,
  ListServiceSpecificCredentialsCommand,
  DeleteServiceSpecificCredentialCommand,
  DeleteUserPermissionsBoundaryCommand,
} from '@aws-sdk/client-iam';
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand, TerminateInstancesCommand, DeleteVolumeCommand } from '@aws-sdk/client-ec2';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { LambdaClient, ListFunctionsCommand, GetFunctionConfigurationCommand, DeleteFunctionCommand } from '@aws-sdk/client-lambda';
import path from 'path';
import fs from 'fs';
import { db } from './db';
import { getExternalId, isRestricted, isSupportOnlyRestricted } from './restricted-accounts';
import { getActiveGrant, remainingSeconds, TempAdminRequiredError } from './temp-admin';

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
// 专用管理员角色（一级跳，AdministratorAccess，直接信任平台身份）。
// 仅在临时开通期间存在（temp-admin.ts），不再由组织级 StackSet 常驻下发：
// 没有 OrganizationAccountAccessRole 的账户（通常是 INVITED）需要 Admin 时由管理员临时开通。
const ADMIN_ROLE_NAME = config.adminRoleName || process.env.ADMIN_ROLE_NAME || 'admin-console';

// 哪些组织(按 payer 名称)在账户页控制台提供「只读(support-quota) / Admin」双选项。
// 只读 = 一级跳 support-quota；Admin = 默认 OrganizationAccountAccessRole（成员二级跳，管理账户用 role/tool）。
const CONSOLE_ADMIN_PAYERS: string[] = Array.isArray(config.consoleAdminPayers) ? config.consoleAdminPayers : [];

// Payers from config.json or env
let PAYERS: { name: string; roleArn: string }[] = config.payers || [];
if (PAYERS.length === 0) {
  // Fallback to env format: name|arn,name|arn
  PAYERS = (process.env.PAYERS || '').split(',').filter(Boolean).map(p => {
    const [name, roleArn] = p.split('|');
    return { name: name?.trim(), roleArn: roleArn?.trim() };
  }).filter(p => p.name && p.roleArn);
}

function parseAdminRoleExcludedAccounts(value: unknown): Set<string> {
  if (value == null) return new Set();
  if (!Array.isArray(value)) throw new Error('config.adminRoleExcludedAccounts 必须是数组');
  const knownPayers = new Set(PAYERS.map(payer => payer.name));
  const accountIds = new Set<string>();
  value.forEach((item: any, index) => {
    const accountId = String(item?.accountId || '');
    const payer = String(item?.payer || '');
    if (!/^\d{12}$/.test(accountId)) {
      throw new Error(`config.adminRoleExcludedAccounts[${index}].accountId 无效`);
    }
    if (!knownPayers.has(payer)) {
      throw new Error(`config.adminRoleExcludedAccounts[${index}].payer 未配置`);
    }
    accountIds.add(accountId);
  });
  return accountIds;
}

const ADMIN_ROLE_EXCLUDED_ACCOUNT_IDS = parseAdminRoleExcludedAccounts(config.adminRoleExcludedAccounts);
const isAdminRoleExcluded = (accountId: string) => ADMIN_ROLE_EXCLUDED_ACCOUNT_IDS.has(accountId);
/**
 * 平台对该账户没有任何管理员入口：config 显式排除，或为受限的 INVITED 账户
 * （admin-console 已删除且本来就没有 OAAR）。受限的 CREATED 账户仍可经 OAAR 取得 Admin。
 */
const isAdminUnavailable = (accountId: string, joinedMethod?: string) =>
  isAdminRoleExcluded(accountId) || isSupportOnlyRestricted(accountId, joinedMethod);

// Credential cache
const adminCredsCache: Map<string, { creds: any; expiry: number }> = new Map();
const accountPayerMap: Map<string, string> = new Map();
// 记录哪些账号的 support-quota role AssumeRole 失败过 (避免每次都重试消耗 STS 调用)
const supportRoleUnavailable: Set<string> = new Set();

const QUOTA_REGION_CONCURRENCY = 6;
const AWS_REQUEST_TIMEOUT_MS = 30_000;
const CONSOLE_FEDERATION_TIMEOUT_MS = 20_000;
const BEDROCK_REGION_TIMEOUT_MS = 15_000;

/** AWS SDK v3 的 Client 持有 keep-alive socket；每次临时创建后必须主动释放。 */
async function withAwsClient<TClient extends { destroy(): void }, TResult>(
  client: TClient,
  operation: (client: TClient) => Promise<TResult>,
): Promise<TResult> {
  try {
    return await operation(client);
  } finally {
    client.destroy();
  }
}

/** 给整段 AWS 操作设置总 deadline，并确保 timer 不会遗留。 */
async function withAbortTimeout<TResult>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<TResult>,
  externalSignal?: AbortSignal,
): Promise<TResult> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/** 受限并发映射，防止“账户批次 × 区域数”放大为数百条同时连接。 */
async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw rejected.reason;

  return results;
}

// 尝试一级跳: 直接 AssumeRole 到目标账户的 support-quota role
function isPermanentSupportRoleFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('name' in error)) return false;
  const errorName = String((error as { name?: unknown }).name ?? '');
  return errorName === 'AccessDenied' || errorName === 'AccessDeniedException';
}

async function tryAssumeSupportRole(accountId: string) {
  if (!SUPPORT_ROLE_NAME) return null;
  // 受限账户在标记过程中信任策略会切换，短暂拒绝不能把它永久打入不可用（直到进程重启）
  const restricted = isRestricted(accountId);
  if (!restricted && supportRoleUnavailable.has(accountId)) return null;
  try {
    const roleArn = `arn:aws:iam::${accountId}:role/${SUPPORT_ROLE_NAME}`;
    // 敏感权限客户的账户，其角色信任策略要求 sts:ExternalId，不带会被拒
    const externalId = getExternalId(accountId);
    const resp = await withAwsClient(
      new STSClient({ region: DEFAULT_REGION, credentials: BASE_CREDENTIALS }),
      sts => withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal => sts.send(new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `web-${accountId}`,
        DurationSeconds: 3600,
        ...(externalId ? { ExternalId: externalId } : {}),
      }), { abortSignal: signal })),
    );
    return {
      accessKeyId: resp.Credentials!.AccessKeyId!,
      secretAccessKey: resp.Credentials!.SecretAccessKey!,
      sessionToken: resp.Credentials!.SessionToken!,
    };
  } catch (e) {
    // 仅缓存明确的角色/信任拒绝；超时、限流和网络错误必须允许后续重试。
    if (!restricted && isPermanentSupportRoleFailure(e)) supportRoleUnavailable.add(accountId);
    return null;
  }
}

async function getAdminCredsForPayer(
  payerRoleArn: string,
  forceFresh = false,
  timeoutMs = AWS_REQUEST_TIMEOUT_MS,
) {
  const cached = adminCredsCache.get(payerRoleArn);
  if (!forceFresh && cached && Date.now() < cached.expiry) return cached.creds;

  const resp = await withAwsClient(
    new STSClient({ region: DEFAULT_REGION, credentials: BASE_CREDENTIALS }),
    sts => withAbortTimeout(timeoutMs, signal => sts.send(new AssumeRoleCommand({
      RoleArn: payerRoleArn,
      RoleSessionName: 'aws-toolbox-web',
      DurationSeconds: 3600,
    }), { abortSignal: signal })),
  );

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

  if (isRestricted(accountId)) {
    throw new Error(`账户 ${accountId} 为敏感权限客户账户，support-quota 不可用时不回退管理员角色（请检查 ExternalId 与角色状态）`);
  }

  const roleArn = `arn:aws:iam::${accountId}:role/${CHILD_ROLE_NAME}`;

  // Try known payer first
  const knownPayer = accountPayerMap.get(accountId);
  if (knownPayer) {
    const admin = await getAdminCredsForPayer(knownPayer);
    const resp = await withAwsClient(
      new STSClient({ region: DEFAULT_REGION, credentials: admin }),
      sts => withAbortTimeout(
        AWS_REQUEST_TIMEOUT_MS,
        signal => sts.send(
          new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: `web-${accountId}`, DurationSeconds: 3600 }),
          { abortSignal: signal },
        ),
      ),
    );
    console.log(`[assume] ${accountId} → OrganizationAccountAccessRole (二级跳, 已知 payer)`);
    return { accessKeyId: resp.Credentials!.AccessKeyId!, secretAccessKey: resp.Credentials!.SecretAccessKey!, sessionToken: resp.Credentials!.SessionToken! };
  }

  // Try all payers
  for (const payer of PAYERS) {
    try {
      const admin = await getAdminCredsForPayer(payer.roleArn);
      const resp = await withAwsClient(
        new STSClient({ region: DEFAULT_REGION, credentials: admin }),
        sts => withAbortTimeout(
        AWS_REQUEST_TIMEOUT_MS,
        signal => sts.send(
          new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: `web-${accountId}`, DurationSeconds: 3600 }),
          { abortSignal: signal },
        ),
      ),
      );
      accountPayerMap.set(accountId, payer.roleArn);
      console.log(`[assume] ${accountId} → OrganizationAccountAccessRole (二级跳, 探测到 ${payer.name})`);
      return { accessKeyId: resp.Credentials!.AccessKeyId!, secretAccessKey: resp.Credentials!.SecretAccessKey!, sessionToken: resp.Credentials!.SessionToken! };
    } catch { continue; }
  }
  console.log(`[assume] ${accountId} → 全部失败`);
  throw new Error(`无法 AssumeRole 到 ${accountId}`);
}

/** 临时管理员凭证签发的可安全暴露错误，路由据此返回准确 HTTP 状态。 */
export class TempCredentialError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 409 | 503,
    public readonly code?: 'TEMP_ADMIN_REQUIRED',
  ) {
    super(message);
    this.name = 'TempCredentialError';
  }
}

function isRetryableStsError(error: any): boolean {
  const name = String(error?.name || '');
  return error?.$retryable != null
    || ['AbortError', 'TimeoutError', 'Throttling', 'ThrottlingException', 'TooManyRequestsException', 'ServiceUnavailableException', 'InternalFailure'].includes(name);
}

/**
 * 生成账户的 Admin 权限临时凭证（1–12 个整数小时）。
 * payer 管理账户固定最多 1 小时。成员账户：临时开通 Admin 期间直跳 admin-console（时长不超过开通剩余时间），
 * 否则经 OrganizationAccountAccessRole 角色链签发（AWS 硬上限 1 小时）。
 */
export async function getTempAdminCredentials(accountId: string, durationHours = 1) {
  if (!Number.isInteger(durationHours) || durationHours < 1 || durationHours > 12) {
    throw new TempCredentialError('Admin 临时凭证有效期必须是 1–12 的整数小时', 400);
  }
  const durationSeconds = durationHours * 60 * 60;
  const format = (resp: any) => ({
    accountId,
    accessKeyId: resp.Credentials!.AccessKeyId!,
    secretAccessKey: resp.Credentials!.SecretAccessKey!,
    sessionToken: resp.Credentials!.SessionToken!,
    expiration: resp.Credentials!.Expiration, // Date → ISO string after JSON 序列化
    region: DEFAULT_REGION,
    durationHours,
  });

  // 情况 1：账户本身就是 payer。role/tool 默认只允许 1 小时；长时凭证仅支持成员账户的一级跳角色。
  const selfPayer = PAYERS.find(p => {
    const m = /arn:aws:iam::(\d+):role\//.exec(p.roleArn);
    return m && m[1] === accountId;
  });
  if (selfPayer) {
    if (durationHours > 1) {
      throw new TempCredentialError('payer 管理账户的 Admin 临时凭证最多 1 小时；长时凭证仅支持处于临时开通 Admin 期间的成员账户', 400);
    }
    try {
      const resp = await withAwsClient(
        new STSClient({ region: DEFAULT_REGION, credentials: BASE_CREDENTIALS }),
        sts => withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal => sts.send(new AssumeRoleCommand({
          RoleArn: selfPayer.roleArn,
          RoleSessionName: `admin-${accountId}`,
          DurationSeconds: durationSeconds,
        }), { abortSignal: signal })),
      );
      console.log(`[temp-cred] ${accountId} → payer admin (selfPayer, ${durationHours}h)`);
      return format(resp);
    } catch (e: any) {
      if (isRetryableStsError(e)) {
        throw new TempCredentialError('AWS STS 暂时不可用或请求超时，请稍后重试', 503);
      }
      throw new TempCredentialError(`无法通过 payer 管理角色生成临时凭证（${e?.name || 'AssumeRoleFailed'}）`, 409);
    }
  }

  if (isAdminUnavailable(accountId)) {
    throw new TempCredentialError('该账户已配置为仅保留 support-quota，不提供 Admin 临时凭证', 409);
  }

  // 敏感权限客户账户的 admin-console 已删除，只能经 OAAR 角色链签发（AWS 硬上限 1 小时）
  const restricted = isRestricted(accountId);
  if (restricted && durationHours > 1) {
    throw new TempCredentialError(
      '该账户为敏感权限客户账户，admin-console 已移除，Admin 临时凭证只能经 OrganizationAccountAccessRole 签发，最长 1 小时',
      409,
    );
  }

  let retryableFailure: any;

  // 情况 2：临时开通 Admin 期间直跳 admin-console。这是唯一支持 >1 小时的成员账户链路，
  // 凭证不得超过开通剩余时间 —— 到期后角色会被删除。没有有效开通时一律不碰 admin-console，
  // 即使账户里残留着它（未经开通的常驻 admin-console 属于待清理的异常）。
  const grant = restricted ? null : getActiveGrant(accountId);
  if (grant) {
    const remaining = remainingSeconds(grant);
    if (remaining < 900) {
      throw new TempCredentialError('临时 Admin 剩余不足 15 分钟，请到期后重新开通', 409);
    }
    const seconds = Math.min(durationSeconds, remaining);
    try {
      const resp = await withAwsClient(
        new STSClient({ region: DEFAULT_REGION, credentials: BASE_CREDENTIALS }),
        sts => withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal => sts.send(new AssumeRoleCommand({
          RoleArn: `arn:aws:iam::${accountId}:role/${ADMIN_ROLE_NAME}`,
          RoleSessionName: `admin-${accountId}`.slice(0, 64),
          DurationSeconds: seconds,
        }), { abortSignal: signal })),
      );
      console.log(`[temp-cred] ${accountId} → ${ADMIN_ROLE_NAME} (临时开通, ${seconds}s)`);
      return { ...format(resp), cappedByTempAdmin: seconds < durationSeconds, tempAdminExpiresAt: grant.expiresAt };
    } catch (e: any) {
      if (durationHours > 1) {
        if (isRetryableStsError(e)) {
          throw new TempCredentialError('AWS STS 暂时不可用或请求超时，请稍后重试', 503);
        }
        throw new TempCredentialError(
          `临时开通期内无法 AssumeRole ${ADMIN_ROLE_NAME}（${e?.name || 'AssumeRoleFailed'}），请确认开通状态`,
          409,
        );
      }
      if (isRetryableStsError(e)) retryableFailure = e;
    }
  } else if (durationHours > 1) {
    throw new TempCredentialError(
      '成员账户的 Admin 临时凭证经 OrganizationAccountAccessRole 签发，最长 1 小时；临时开通 Admin 期间可签发更长凭证（不超过剩余时间）',
      409,
    );
  }

  // 情况 3：1 小时请求可回退到 payer admin → OrganizationAccountAccessRole。
  // 角色链式 AssumeRole 的 AWS 硬上限为 1 小时，长时请求绝不能进入此分支。
  const roleArn = `arn:aws:iam::${accountId}:role/${CHILD_ROLE_NAME}`;
  const knownPayer = accountPayerMap.get(accountId);
  const payerArns = knownPayer
    ? [knownPayer, ...PAYERS.map(p => p.roleArn).filter(a => a !== knownPayer)]
    : PAYERS.map(p => p.roleArn);

  let lastErr: any;
  for (const payerArn of payerArns) {
    try {
      const admin = await getAdminCredsForPayer(payerArn, true);
      const resp = await withAwsClient(
        new STSClient({ region: DEFAULT_REGION, credentials: admin }),
        sts => withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal => sts.send(new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: `admin-${accountId}`,
          DurationSeconds: durationSeconds,
        }), { abortSignal: signal })),
      );
      accountPayerMap.set(accountId, payerArn);
      console.log(`[temp-cred] ${accountId} → OrganizationAccountAccessRole (二级跳, 1h)`);
      return format(resp);
    } catch (e) {
      lastErr = e;
      if (isRetryableStsError(e)) retryableFailure = e;
      continue;
    }
  }
  if (retryableFailure) {
    throw new TempCredentialError('AWS STS 暂时不可用或请求超时，请稍后重试', 503);
  }
  // OAAR 全部明确拒绝：通常是邀请加入、没有 OAAR 的账户，需先临时开通 Admin
  if (restricted) {
    throw new TempCredentialError(
      `无法为账户 ${accountId} 生成管理员临时凭证：${lastErr?.message || '可用管理员角色均尝试失败'}`,
      409,
    );
  }
  throw new TempCredentialError(new TempAdminRequiredError(accountId).message, 409, 'TEMP_ADMIN_REQUIRED');
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
    const resp = await withAwsClient(
      new STSClient({ region: DEFAULT_REGION, credentials: mgmtCreds }),
      sts => withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal => sts.send(new AssumeRootCommand({
        TargetPrincipal: accountId,
        TaskPolicyArn: { arn: taskPolicyArn },
        DurationSeconds: 900,
      }), { abortSignal: signal })),
    );
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
 * 步骤：1) AssumeRoot(IAMDeleteRootUserCredentials) 换取【目标账户】的 root 会话；
 *      2) 在该会话内 ListMFADevices（省略 UserName 即 root 自身）拿到设备 SerialNumber；
 *      3) DeactivateMFADevice + DeleteVirtualMFADevice。
 *
 * 注意：这里必须用目标账户的 root 会话来枚举设备。早期实现用管理账户凭证
 * ListVirtualMFADevices，那列出的是【payer 管理账户自己】的 root MFA，
 * 会导致「拿 A 账户的设备序列号去 B 账户删除」，既删不掉又有误删风险。
 */
export async function deleteRootMFA(accountId: string) {
  // 1) 先换取目标账户的 root 特权会话
  const rootCreds = await assumeRoot(accountId, ROOT_TASK_POLICY.delete);
  const iamRoot = new IAMClient({ region: DEFAULT_REGION, credentials: rootCreds });
  try {
    // 2) 在目标账户 root 会话内枚举它自己的 MFA 设备
    const mfaList = await withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal =>
      iamRoot.send(new ListMFADevicesCommand({}), { abortSignal: signal }));
    const devices = (mfaList.MFADevices || []).filter(d => !!d.SerialNumber);
    if (devices.length === 0) {
      throw Object.assign(new Error(`账户 ${accountId} 的根用户未启用 MFA，无需删除`), {
        code: 'ROOT_MFA_NOT_ENABLED',
      });
    }

    // 3) 逐个停用并删除（root 会话须省略 UserName）
    const removed: string[] = [];
    const failed: { serial: string; reason: string }[] = [];
    for (const d of devices) {
      const serial = d.SerialNumber!;
      // 安全校验：序列号必须属于目标账户，避免跨账户误删
      if (serial.startsWith('arn:') && !serial.includes(`::${accountId}:`) && !serial.includes(`:${accountId}:`)) {
        failed.push({ serial, reason: '该 MFA 序列号不属于目标账户，已跳过' });
        continue;
      }
      try {
        await withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal =>
          iamRoot.send(new DeactivateMFADeviceCommand({ SerialNumber: serial }), { abortSignal: signal }));
        // 仅虚拟设备可删除；硬件 MFA 停用即可
        try {
          await withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal =>
            iamRoot.send(new DeleteVirtualMFADeviceCommand({ SerialNumber: serial }), { abortSignal: signal }));
        } catch { /* 非虚拟设备忽略 */ }
        removed.push(serial);
      } catch (e: any) {
        failed.push({ serial, reason: `${e?.name || 'Error'}: ${e?.message || ''}`.slice(0, 200) });
      }
    }
    if (removed.length === 0 && failed.length > 0) {
      throw new Error(`删除失败：${failed.map(f => `${f.serial} (${f.reason})`).join('; ')}`);
    }
    return { accountId, removed, failed };
  } finally {
    iamRoot.destroy();
  }
}

/**
 * 允许成员账户根用户通过标准「忘记密码」流程恢复密码。
 *
 * AssumeRoot(IAMCreateRootUserPassword) 返回仅限该特权任务的 root 会话；
 * CreateLoginProfile 必须省略 UserName 和 Password，由 AWS 启用根邮箱恢复流程。
 * 若登录密码已存在则明确返回冲突，绝不删除或覆盖现有密码。
 */
export async function recoverRootPassword(accountId: string) {
  const rootCreds = await assumeRoot(accountId, ROOT_TASK_POLICY.createPassword);
  const iamRoot = new IAMClient({ region: DEFAULT_REGION, credentials: rootCreds });
  try {
    await withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal =>
      iamRoot.send(new CreateLoginProfileCommand({}), { abortSignal: signal }));
    return { accountId, ok: true, recoveryAllowed: true };
  } catch (e: any) {
    if (e?.name === 'EntityAlreadyExistsException' || e?.name === 'EntityAlreadyExists') {
      throw Object.assign(new Error('该账户已具备 Root 密码恢复条件，请直接使用根邮箱执行「忘记密码」流程'), {
        code: 'ROOT_PASSWORD_ALREADY_EXISTS',
      });
    }
    throw e;
  } finally {
    iamRoot.destroy();
  }
}

/**
 * 权威实时读取成员账户根用户凭证：AssumeRoot(IAMAuditRootUserCredentials) 会话内
 * 直接 ListAccessKeys / ListMFADevices / GetLoginProfile（均省略 UserName，即 root 本身）。
 * 返回真实的访问密钥列表(含 ID/状态)、MFA 设备、密码是否存在。
 * 每个调用单独 try/catch：若审计策略未授予某项读权限，只把该项标为 error，其余仍可用。
 */
export async function auditRootCredentials(accountId: string) {
  const rootCreds = await assumeRoot(accountId, ROOT_TASK_POLICY.audit);
  const iam = new IAMClient({ region: DEFAULT_REGION, credentials: rootCreds });
  const out: any = { accountId, accessKeys: [], mfaDevices: [], passwordEnabled: null };

  try {
    const r = await iam.send(new ListAccessKeysCommand({}));
    out.accessKeys = (r.AccessKeyMetadata || []).map(k => ({
      id: k.AccessKeyId,
      status: k.Status,
      createDate: k.CreateDate ? new Date(k.CreateDate).toISOString() : null,
    }));
  } catch (e: any) { out.accessKeysError = e?.name || String(e); }

  try {
    const r = await iam.send(new ListMFADevicesCommand({}));
    out.mfaDevices = (r.MFADevices || []).map(d => ({ serial: d.SerialNumber }));
  } catch (e: any) { out.mfaError = e?.name || String(e); }

  try {
    await iam.send(new GetLoginProfileCommand({}));
    out.passwordEnabled = true;
  } catch (e: any) {
    if (e?.name === 'NoSuchEntityException' || e?.name === 'NoSuchEntity') out.passwordEnabled = false;
    else out.passwordError = e?.name || String(e);
  }

  return out;
}

/**
 * 删除成员账户根用户的指定访问密钥。
 * AssumeRoot(IAMDeleteRootUserCredentials) 会话内 DeleteAccessKey（省略 UserName，即 root 本身）。
 */
export async function deleteRootAccessKey(accountId: string, accessKeyId: string) {
  const rootCreds = await assumeRoot(accountId, ROOT_TASK_POLICY.delete);
  const iam = new IAMClient({ region: DEFAULT_REGION, credentials: rootCreds });
  await iam.send(new DeleteAccessKeyCommand({ AccessKeyId: accessKeyId }));
  return { accountId, accessKeyId, deleted: true };
}



// ===== Exported service functions =====

export async function testConnection() {
  const timeoutMs = 8000;
  // 各 payer 并行检测，共享单个 8s 时间预算，避免个别账号拖慢整体。
  return Promise.all(PAYERS.map(async (payer) => {
    const startedAt = Date.now();
    try {
      const creds = await getAdminCredsForPayer(payer.roleArn, false, timeoutMs);
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      const identity = await withAwsClient(
        new STSClient({ region: DEFAULT_REGION, credentials: creds }),
        sts => withAbortTimeout(remainingMs, signal => sts.send(
          new GetCallerIdentityCommand({}),
          { abortSignal: signal },
        )),
      );
      return { name: payer.name, account: identity.Account, ok: true };
    } catch (e: any) {
      return { name: payer.name, error: e.message, ok: false };
    }
  }));
}

export async function listAccounts() {
  const allAccounts: any[] = [];
  for (const payer of PAYERS) {
    // payer(组织管理)账户 ID：从 role ARN 里解析，用于标记该组织的管理账户
    const payerIdMatch = /arn:aws:iam::(\d+):role\//.exec(payer.roleArn);
    const payerAccountId = payerIdMatch ? payerIdMatch[1] : null;
    // 该组织是否提供控制台双选项（部署了 support-quota + admin-console 专用角色）
    const consoleDual = CONSOLE_ADMIN_PAYERS.includes(payer.name);
    try {
      const admin = await getAdminCredsForPayer(payer.roleArn);
      const client = new OrganizationsClient({ region: 'us-east-1', credentials: admin });
      let nextToken: string | undefined;
      do {
        const resp = await client.send(new ListAccountsCommand({ NextToken: nextToken }));
        for (const a of resp.Accounts || []) {
          const adminRoleExcluded = Boolean(a.Id && isAdminUnavailable(a.Id, a.JoinedMethod));
          allAccounts.push({
            ...a,
            _payer: payer.name,
            _isPayer: payerAccountId != null && a.Id === payerAccountId,
            _consoleDual: consoleDual && !adminRoleExcluded,
            _adminRoleExcluded: adminRoleExcluded,
          });
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

/** 平台已配置的 payer 列表（名称 + 账户 ID），供批量提额等按组织操作的功能使用 */
export function listConfiguredPayers(): { name: string; accountId: string; roleArn: string }[] {
  return PAYERS.map(p => {
    const m = /arn:aws:iam::(\d+):role\//.exec(p.roleArn || '');
    return { name: p.name, accountId: m ? m[1] : '', roleArn: p.roleArn };
  }).filter(p => p.accountId);
}

/**
 * 直接向某个 payer 的 Organizations 查询其组织下账户（不依赖账户缓存，
 * 新加入的 payer 也能立即拿到最新列表）。返回 ACTIVE 账户，并标出哪个是管理账户。
 */
export async function listOrgAccountsForPayer(payerAccountId: string) {
  const payer = PAYERS.find(p => (p.roleArn || '').includes(`:${payerAccountId}:`));
  if (!payer) throw new Error(`payer ${payerAccountId} 不在平台配置中`);
  const admin = await getAdminCredsForPayer(payer.roleArn);
  const client = new OrganizationsClient({ region: DEFAULT_REGION, credentials: admin });
  const accounts: any[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await client.send(new ListAccountsCommand({ NextToken: nextToken }));
    for (const a of resp.Accounts || []) {
      if ((a.Status || (a as any).State) !== 'ACTIVE') continue;
      accounts.push({
        Id: a.Id,
        Name: a.Name,
        Email: a.Email,
        isPayer: a.Id === payerAccountId,
      });
      if (a.Id) accountPayerMap.set(a.Id, payer.roleArn);
    }
    nextToken = resp.NextToken;
  } while (nextToken);
  return { payerName: payer.name, payerAccountId, accounts };
}

export async function listServiceQuotas(accountId: string, serviceCode: string, region?: string) {
  const creds = await assumeToAccount(accountId);
  return withAwsClient(
    new ServiceQuotasClient({ region: region || DEFAULT_REGION, credentials: creds, maxAttempts: 2 }),
    client => withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, async signal => {
      const quotas: any[] = [];
      let nextToken: string | undefined;
      do {
        const resp = await client.send(
          new ListServiceQuotasCommand({ ServiceCode: serviceCode, NextToken: nextToken }),
          { abortSignal: signal },
        );
        if (resp.Quotas) quotas.push(...resp.Quotas);
        nextToken = resp.NextToken;
      } while (nextToken);
      return quotas;
    }),
  );
}

// ============================================================
// Bedrock 配额（TPM / RPM / TPD）
// AWS 的 Bedrock 配额名是一整句话，例如：
//   "On-demand model inference tokens per minute for Anthropic Claude 3.5 Sonnet (doubled for cross-region calls)"
// 需要从中解析出「指标类型 / 推理范围(scope) / 模型名 / provider」，再透视成一行三列(TPM/RPM/TPD)。
// ============================================================
// Account-Level = 账户级跨模型总配额（不限定推理范围），与其余按范围划分的 scope 并列
const BEDROCK_QUOTA_SCOPES = ['Global Cross-Region', 'Cross-Region', 'On-Demand', 'Latency-Optimized', 'Account-Level', 'Other'];
// 模型名 → 规范 provider。按关键词匹配（含模型家族别名），避免出现 "GPT-5.4"/"Stable" 这类
// 由“取首个单词”产生的伪 provider，也避免 MiniMax/Minimax 大小写重复项。
const BEDROCK_PROVIDER_HINTS: Array<[string, string]> = [
  // 账户级总配额跨所有厂商，归到服务级而不是某个 provider（主判定在调用处按 QuotaCode）
  ['cross-model', 'Bedrock (服务级)'],
  ['guardrail', 'Bedrock (服务级)'],
  ['anthropic', 'Anthropic'], ['claude', 'Anthropic'],
  ['nova', 'Amazon'], ['titan', 'Amazon'], ['amazon', 'Amazon'],
  ['llama', 'Meta'], ['meta', 'Meta'],
  ['pixtral', 'Mistral'], ['magistral', 'Mistral'], ['ministral', 'Mistral'],
  ['voxtral', 'Mistral'], ['devstral', 'Mistral'], ['mistral', 'Mistral'],
  ['cohere', 'Cohere'], ['command', 'Cohere'],
  ['jamba', 'AI21'], ['ai21', 'AI21'],
  ['stable diffusion', 'Stability'], ['stable image', 'Stability'], ['sdxl', 'Stability'],
  ['stability', 'Stability'], ['stable', 'Stability'],
  ['deepseek', 'DeepSeek'],
  ['qwen', 'Qwen'],
  ['palmyra', 'Writer'], ['writer', 'Writer'],
  ['luma', 'Luma'],
  ['gpt', 'OpenAI'], ['openai', 'OpenAI'],
  ['marengo', 'TwelveLabs'], ['pegasus', 'TwelveLabs'], ['twelve', 'TwelveLabs'],
  ['gemma', 'Google'], ['gemini', 'Google'], ['google', 'Google'],
  ['kimi', 'Moonshot'], ['moonshot', 'Moonshot'],
  ['minimax', 'MiniMax'],
  ['nemotron', 'NVIDIA'], ['nvidia', 'NVIDIA'],
  ['z.ai', 'Z.ai'], ['zhipu', 'Z.ai'], ['glm', 'Z.ai'],
];

function inferBedrockProvider(...values: string[]): string {
  const hay = values.filter(Boolean).join(' ').toLowerCase();
  for (const [needle, label] of BEDROCK_PROVIDER_HINTS) {
    if (hay.includes(needle)) return label;
  }
  // 认不出来就归为 Other（模型名仍然完整展示），不猜首个单词以免产生伪 provider
  return 'Other';
}

const BEDROCK_METRIC_PHRASE = /\s*(?:tokens per minute|requests per minute|tokens per day)\s*/i;

/**
 * 账户级跨模型总配额（AWS 2026 新增），配额名不带 "for <模型>"。
 * 它约束的是整个账户所有模型的合计用量，与逐模型配额是两个维度，
 * 交付/提额时都要单独看，所以这里保留完整名称、不按普通模型行解析。
 *
 * ⚠️ 必须按 QuotaCode 识别，名称只作兜底：AWS 已改过一次名
 *   2026-09 "Cross-Model Account-Level Tokens Per Day"
 *   2026-10 "Cross-Model Max Tokens Per Day"            （同一个 L-E3F10727）
 * 旧正则只认 "account-level"，改名后它落进 scope=Other，账户级 TPD 回填整体失效：
 * 配额页新 Claude 型号 TPD 显示「-」，交付表 TPD 写成 0。
 */
export const BEDROCK_ACCOUNT_LEVEL_TPD_CODE = 'L-E3F10727';
const BEDROCK_ACCOUNT_LEVEL_RE = /^\s*cross-model\b/i;

export function isBedrockAccountLevelQuota(quotaName: string, quotaCode?: string): boolean {
  return quotaCode === BEDROCK_ACCOUNT_LEVEL_TPD_CODE || BEDROCK_ACCOUNT_LEVEL_RE.test(quotaName);
}

/** 从配额名里提取模型名："... tokens per minute for <模型名>" */
function extractBedrockModelName(quotaName: string, quotaCode?: string): string {
  // 账户级总配额没有模型维度，保留原名（去掉指标短语会丢语义）
  if (isBedrockAccountLevelQuota(quotaName, quotaCode)) return quotaName.trim();

  const m = /(?:tokens per minute|requests per minute|tokens per day)\s+for\s+(.+)/i.exec(quotaName);
  let model: string;
  if (m) {
    model = m[1];
  } else {
    // 服务级配额（如 Guardrails）没有 "for <模型>" 结构：剥掉前缀与指标短语，保留动作名
    model = quotaName;
    const prefixes = [
      'Global cross-region model inference ', 'Cross-region model inference ',
      'On-demand latency-optimized model inference ', 'On-demand model inference ',
      'Model invocation max ',
    ];
    for (const p of prefixes) {
      if (model.toLowerCase().startsWith(p.toLowerCase())) { model = model.slice(p.length); break; }
    }
    model = model
      .replace(/^\(Guardrails\)\s*/i, '')
      .replace(/^On-demand\s+/i, '')
      .replace(BEDROCK_METRIC_PHRASE, ' ')
      .trim();
  }
  return model.replace(/\s*\(doubled for cross-region calls\)/i, '').replace(/\s+/g, ' ').trim();
}

/** 判定指标类型与推理范围。注意 scope 判定顺序：global cross-region 必须先于 cross-region */
export function classifyBedrockQuota(quotaName: string, quotaCode?: string): { metric: 'TPM' | 'RPM' | 'TPD' | null; scope: string } {
  const nl = quotaName.toLowerCase();
  let metric: 'TPM' | 'RPM' | 'TPD' | null = null;
  if (nl.includes('tokens per minute')) metric = 'TPM';
  else if (nl.includes('requests per minute')) metric = 'RPM';
  else if (nl.includes('tokens per day')) metric = 'TPD';

  // 账户级总配额优先判定：它不限定任何推理范围，落到下面的分支会被归成 Other。
  if (isBedrockAccountLevelQuota(quotaName, quotaCode)) return { metric, scope: 'Account-Level' };

  let scope = 'Other';
  if (nl.includes('global cross-region')) scope = 'Global Cross-Region';
  else if (nl.includes('cross-region')) scope = 'Cross-Region';
  else if (nl.includes('latency-optimized')) scope = 'Latency-Optimized';
  else if (nl.includes('on-demand')) scope = 'On-Demand';
  return { metric, scope };
}

/**
 * 查询指定账户在多个区域的 Bedrock 按需推理配额。
 * 区域间并发；单个区域失败(未开通/无权限)只记录错误，不影响其它区域。
 * 每行保留各指标的 QuotaCode 与 Adjustable，因此前端可直接一键提额。
 */
export async function listBedrockQuotas(accountId: string, regions?: string[]) {
  const creds = await assumeToAccount(accountId);
  const requestedRegions = regions && regions.length ? regions : ['us-east-1'];
  const targetRegions = [...new Set(requestedRegions)];
  if (targetRegions.length > 30) throw new Error('一次最多查询 30 个 Bedrock 区域');

  const errors: Array<{ region: string; message: string }> = [];
  const rowMap = new Map<string, any>();

  await mapWithConcurrency(targetRegions, QUOTA_REGION_CONCURRENCY, async region => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BEDROCK_REGION_TIMEOUT_MS);
    const client = new ServiceQuotasClient({ region, credentials: creds, maxAttempts: 2 });
    try {
      let nextToken: string | undefined;
      do {
        const resp = await client.send(
          new ListServiceQuotasCommand({ ServiceCode: 'bedrock', MaxResults: 100, NextToken: nextToken }),
          { abortSignal: controller.signal },
        );
        for (const q of resp.Quotas || []) {
          const name = q.QuotaName || '';
          const nl = name.toLowerCase();
          if (!/tokens per minute|requests per minute|tokens per day/.test(nl)) continue;
          // 只看按需推理配额，排除批量/预置/微调
          if (/batch|provisioned|customization|fine-tun/.test(nl)) continue;

          const { metric, scope } = classifyBedrockQuota(name, q.QuotaCode);
          if (!metric) continue;
          const model = extractBedrockModelName(name, q.QuotaCode);
          // 账户级总配额跨所有厂商，固定归到服务级（名称已改过一次，不靠关键词猜）
          const provider = scope === 'Account-Level' ? 'Bedrock (服务级)' : inferBedrockProvider(model, name);
          const key = `${region}|${provider}|${model}|${scope}`;
          let row = rowMap.get(key);
          if (!row) {
            row = { region, provider, model, scope, metrics: {} as Record<string, any> };
            rowMap.set(key, row);
          }
          const value = Number(q.Value ?? 0);
          const prev = row.metrics[metric];
          // 同一 key 可能命中多条同类型配额，保留较大值
          if (!prev || value > prev.value) {
            row.metrics[metric] = {
              value,
              quotaCode: q.QuotaCode || '',
              quotaName: name,
              adjustable: !!q.Adjustable,
              unit: q.Unit || '',
            };
          }
        }
        nextToken = resp.NextToken;
      } while (nextToken);
    } catch (e: any) {
      const message = e?.name === 'AbortError'
        ? `查询超时（${BEDROCK_REGION_TIMEOUT_MS / 1000} 秒）`
        : (e?.message || String(e));
      errors.push({ region, message });
    } finally {
      clearTimeout(timer);
      client.destroy();
    }
  });

  // 账户级跨模型 TPD 回退。
  // AWS 给较新的 Claude 型号不再单独发 TPD 配额，真正生效的日限额是
  // "Cross-Model Account-Level Tokens Per Day"（L-E3F10727）。若只把它当成独立一行，
  // 逐模型行的 TPD 会显示为"-"，看起来像"没有日限额"，与实际完全相反。
  // 所以这里给缺 TPD 的行补上所在区域的账户级值，并打 inherited 标记：
  //  - 该额度由账户内所有模型共享，不是每个模型各自独享，前端必须区分显示；
  //  - adjustable 置 false，避免从某个模型行误提"这个模型的 TPD"——
  //    真要提额得走 Account-Level 那一行，改的是全账户的总盘子。
  const accountTpdByRegion = new Map<string, any>();
  for (const row of rowMap.values()) {
    if (row.scope !== 'Account-Level') continue;
    const m = row.metrics?.TPD;
    if (m?.value == null) continue;
    const prev = accountTpdByRegion.get(row.region);
    if (!prev || m.value > prev.value) accountTpdByRegion.set(row.region, m);
  }
  for (const row of rowMap.values()) {
    if (row.scope === 'Account-Level') continue;
    if (row.metrics.TPD) continue;
    const shared = accountTpdByRegion.get(row.region);
    if (!shared) continue;
    row.metrics.TPD = {
      value: shared.value,
      quotaCode: shared.quotaCode,
      quotaName: shared.quotaName,
      adjustable: false,
      unit: shared.unit,
      inherited: true,
    };
  }

  const scopeOrder = new Map(BEDROCK_QUOTA_SCOPES.map((s, i) => [s, i] as [string, number]));
  const rows = [...rowMap.values()].sort((a, b) =>
    a.region.localeCompare(b.region) ||
    a.provider.localeCompare(b.provider) ||
    a.model.localeCompare(b.model) ||
    ((scopeOrder.get(a.scope) ?? 99) - (scopeOrder.get(b.scope) ?? 99)),
  );
  return { rows, errors, regions: targetRegions, scopes: BEDROCK_QUOTA_SCOPES };
}

/**
 * 读取单个配额在指定账户/区域的当前生效值。
 * 返回 null 表示该账户/区域没有这个配额（服务未在该区域提供等），调用方据此跳过。
 */
export async function getServiceQuotaValue(accountId: string, serviceCode: string, quotaCode: string, region?: string) {
  const creds = await assumeToAccount(accountId);
  const client = new ServiceQuotasClient({ region: region || DEFAULT_REGION, credentials: creds });
  try {
    const resp = await withAbortTimeout(
      AWS_REQUEST_TIMEOUT_MS,
      signal => client.send(
        new GetServiceQuotaCommand({ ServiceCode: serviceCode, QuotaCode: quotaCode }),
        { abortSignal: signal },
      ),
    );
    const q = resp.Quota;
    if (!q) return null;
    return { value: Number(q.Value ?? 0), adjustable: !!q.Adjustable, unit: q.Unit || '', quotaName: q.QuotaName || '' };
  } catch (e: any) {
    if (e?.name === 'NoSuchResourceException') return null;
    // opt-in 区域未在该账户启用时，STS 凭证不被该区域接受。
    // 这不是错误，属于「该账户在此区域不可用」，交由调用方按跳过处理。
    if (e?.name === 'UnrecognizedClientException' || e?.name === 'InvalidClientTokenId'
      || e?.name === 'AuthFailure' || e?.name === 'OptInRequired') {
      return { value: -1, adjustable: false, unit: '', quotaName: '', regionNotEnabled: true } as any;
    }
    throw e;
  } finally {
    client.destroy();
  }
}

/** 在指定账户/区域按配额名解析出 QuotaCode（QuotaCode 跨账户一致，可复用到全组织） */
export async function resolveQuotaCodeByName(accountId: string, serviceCode: string, quotaName: string, region?: string) {
  const quotas = await listServiceQuotas(accountId, serviceCode, region);
  const target = quotaName.trim().toLowerCase();
  // 精确 → 配额名包含目标 → 目标包含配额名（如传 "Lightsail Instances" 匹配实际名 "Instances"）
  const found = quotas.find((q: any) => String(q.QuotaName || '').toLowerCase() === target)
    || quotas.find((q: any) => String(q.QuotaName || '').toLowerCase().includes(target))
    || quotas.find((q: any) => {
      const n = String(q.QuotaName || '').toLowerCase();
      return n.length >= 4 && target.includes(n);
    });
  if (!found) return null;
  return { quotaCode: found.QuotaCode as string, quotaName: found.QuotaName as string, value: Number(found.Value ?? 0), adjustable: !!found.Adjustable };
}

export async function requestQuotaIncrease(accountId: string, serviceCode: string, quotaCode: string, desiredValue: number, region?: string) {
  const creds = await assumeToAccount(accountId);
  return withAwsClient(
    new ServiceQuotasClient({ region: region || DEFAULT_REGION, credentials: creds, maxAttempts: 2 }),
    async client => {
      const resp = await withAbortTimeout(
        AWS_REQUEST_TIMEOUT_MS,
        signal => client.send(new RequestServiceQuotaIncreaseCommand({
          ServiceCode: serviceCode,
          QuotaCode: quotaCode,
          DesiredValue: desiredValue,
        }), { abortSignal: signal }),
      );
      return resp.RequestedQuota;
    },
  );
}

export async function listQuotaRequests(accountId: string) {
  const creds = await assumeToAccount(accountId);
  const allRequests: any[] = [];

  // 查询所有支持区域，但限制单账户并发，避免 scheduler 的“账户批次 × 区域数”连接爆炸。
  const regions = [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1', 'eu-central-1',
    'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4', 'ap-southeast-5',
    'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
    'ap-south-1', 'ap-south-2', 'ap-east-1', 'ap-east-2',
    'sa-east-1', 'ca-central-1', 'ca-west-1',
    'af-south-1', 'me-south-1', 'me-central-1',
    'eu-south-1', 'eu-south-2', 'eu-central-2',
    'il-central-1', 'ap-southeast-6', 'ap-southeast-7', 'mx-central-1',
  ];

  const timeoutMs = 8000;
  const results = await mapWithConcurrency(regions, QUOTA_REGION_CONCURRENCY, async region => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const client = new ServiceQuotasClient({ region, credentials: creds, maxAttempts: 2 });
    try {
      const resp = await client.send(
        new ListRequestedServiceQuotaChangeHistoryCommand({}),
        { abortSignal: controller.signal },
      );
      return (resp.RequestedQuotas || []).map(r => ({
        ...r,
        _accountId: accountId,
        _region: region,
        _currentValue: null,
      }));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
      client.destroy();
    }
  });

  for (const requests of results) allRequests.push(...requests);
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
  const previousCurrentValues = new Map<string, number>();
  for (const record of db.getQuotaRequests()) {
    if (record.account_id === accountId && record.id && record.current_value != null) {
      previousCurrentValues.set(String(record.id), record.current_value);
    }
  }
  
  const byRegion: Record<string, any[]> = {};
  for (const r of requests) {
    const region = r._region || r.region || 'us-east-1';
    if (!byRegion[region]) byRegion[region] = [];
    byRegion[region].push(r);
  }

  const entries = Object.entries(byRegion);
  await mapWithConcurrency(entries, QUOTA_REGION_CONCURRENCY, async ([region, reqs]) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BEDROCK_REGION_TIMEOUT_MS);
    const client = new ServiceQuotasClient({ region, credentials: creds, maxAttempts: 2 });
    try {
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
          const resp = await client.send(
            new GetServiceQuotaCommand({ ServiceCode: sc, QuotaCode: qc }),
            { abortSignal: controller.signal },
          );
          valueMap[key] = resp.Quota?.Value ?? null;
        } catch { valueMap[key] = null; }
      }
      for (const r of reqs) {
        const key = `${r.ServiceCode || r.service_code}|${r.QuotaCode || r.quota_code}`;
        const requestId = r.Id || r.id;
        const previousCurrentValue = requestId
          ? previousCurrentValues.get(String(requestId))
          : undefined;
        r._currentValue = valueMap[key] ?? r._currentValue ?? previousCurrentValue ?? null;
      }
    } finally {
      clearTimeout(timer);
      client.destroy();
    }
  });

  return requests;
}

export async function getAccountDetail(accountId: string) {
  let iamCreds: any;
  try { iamCreds = await assumeToAccount(accountId); } catch { iamCreds = await getAdminCredsForPayer(PAYERS[0]?.roleArn); }

  const detail: any = { mfa: null, iamSummary: null };

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

export const CLEANUP_WINDOW_DAYS = 7;
const CLEANUP_WINDOW_MS = CLEANUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const CLEANUP_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type CleanupResourceType = 'EC2' | 'EBS' | 'S3' | 'Lambda' | 'IAMUser';
export type CleanupTimeBasis = 'launchTime' | 'createTime' | 'creationDate' | 'lastModified';

export interface CleanupIamDetails {
  username: string;
  userId: string;
  arn: string;
  path: string;
  createDate: string;
  passwordEnabled: boolean;
  passwordLastUsed?: string;
  accessKeys: { id: string; status: string; createDate?: string }[];
  mfaDevices: { serialNumber: string; enableDate?: string }[];
  groups: string[];
  attachedPolicies: { name: string; arn: string }[];
  inlinePolicies: string[];
  permissionsBoundary?: string;
  dependencies: {
    loginProfile: number;
    accessKeys: number;
    mfaDevices: number;
    groups: number;
    attachedPolicies: number;
    inlinePolicies: number;
    signingCertificates: number;
    sshPublicKeys: number;
    serviceSpecificCredentials: number;
    permissionsBoundary: number;
  };
}

export interface CleanupResource {
  key: string;
  type: CleanupResourceType;
  id: string;
  name: string;
  arn: string;
  details: string;
  eventTime: string;
  timeBasis: CleanupTimeBasis;
  scope: 'regional' | 'global';
  deletable: boolean;
  iamDetails?: CleanupIamDetails;
}

export interface CleanupScanResult {
  resources: CleanupResource[];
  warnings: string[];
  cutoff: string;
  windowDays: number;
}

export interface IamCleanupSummary {
  loginProfiles: number;
  accessKeys: number;
  mfaDevices: number;
  virtualMfaDevices: number;
  attachedPolicies: number;
  inlinePolicies: number;
  groups: number;
  signingCertificates: number;
  sshPublicKeys: number;
  serviceSpecificCredentials: number;
  permissionsBoundaries: number;
}

export interface CleanupDeleteResult {
  id: string;
  type: string;
  name?: string;
  ok: boolean;
  error?: string;
  alreadyAbsent?: boolean;
  iamCleanup?: IamCleanupSummary;
}

function cleanupErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const value = error as { name?: unknown; message?: unknown };
  const name = typeof value.name === 'string' ? value.name : 'AWS 错误';
  const message = typeof value.message === 'string' ? value.message : '';
  return `${name}${message ? `: ${message}` : ''}`.slice(0, 400);
}

function isNoSuchEntity(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; message?: unknown };
  const errorName = typeof value.name === 'string' ? value.name : '';
  return errorName === 'NoSuchEntity'
    || errorName === 'NoSuchEntityException'
    || (typeof value.message === 'string' && value.message.includes('NoSuchEntity'));
}

function isRecentCleanupTime(value: Date | string | undefined, cutoffMs: number, nowMs = Date.now()): boolean {
  if (!value) return false;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) && time >= cutoffMs && time <= nowMs + CLEANUP_FUTURE_SKEW_MS;
}

function assertRecentCleanupTime(value: Date | string | undefined, label: string): void {
  const cutoffMs = Date.now() - CLEANUP_WINDOW_MS;
  if (!isRecentCleanupTime(value, cutoffMs)) {
    throw new Error(`拒绝删除 ${label}：资源时间不在最近 ${CLEANUP_WINDOW_DAYS} 天内，或 AWS 未返回可验证时间`);
  }
}

async function collectMarkerPages<T>(
  loadPage: (marker?: string) => Promise<{ items: T[]; marker?: string; truncated?: boolean }>,
): Promise<T[]> {
  const items: T[] = [];
  let marker: string | undefined;
  do {
    const page = await loadPage(marker);
    items.push(...page.items);
    marker = page.truncated ? page.marker : undefined;
  } while (marker);
  return items;
}

async function getCleanupIamDetails(
  iam: IAMClient,
  user: {
    UserName?: string;
    UserId?: string;
    Arn?: string;
    Path?: string;
    CreateDate?: Date;
    PasswordLastUsed?: Date;
    PermissionsBoundary?: { PermissionsBoundaryArn?: string };
  },
  warnings: string[],
): Promise<CleanupIamDetails> {
  const username = user.UserName!;
  const readDetail = async <T>(label: string, operation: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      warnings.push(`IAM 用户 ${username} 的${label}读取失败：${cleanupErrorMessage(error)}`);
      return fallback;
    }
  };

  let passwordEnabled = false;
  try {
    await iam.send(new GetLoginProfileCommand({ UserName: username }));
    passwordEnabled = true;
  } catch (error) {
    if (!isNoSuchEntity(error)) {
      warnings.push(`IAM 用户 ${username} 的登录配置读取失败：${cleanupErrorMessage(error)}`);
    }
  }

  const [accessKeys, mfaDevices, groups, attachedPolicies, inlinePolicies, signingCertificates, sshPublicKeys, serviceCredentials] = await Promise.all([
    readDetail('访问密钥', () => collectMarkerPages(async marker => {
      const page = await iam.send(new ListAccessKeysCommand({ UserName: username, Marker: marker }));
      return { items: page.AccessKeyMetadata || [], marker: page.Marker, truncated: page.IsTruncated };
    }), []),
    readDetail('MFA 设备', () => collectMarkerPages(async marker => {
      const page = await iam.send(new ListMFADevicesCommand({ UserName: username, Marker: marker }));
      return { items: page.MFADevices || [], marker: page.Marker, truncated: page.IsTruncated };
    }), []),
    readDetail('用户组', () => collectMarkerPages(async marker => {
      const page = await iam.send(new ListGroupsForUserCommand({ UserName: username, Marker: marker }));
      return { items: page.Groups || [], marker: page.Marker, truncated: page.IsTruncated };
    }), []),
    readDetail('托管策略', () => collectMarkerPages(async marker => {
      const page = await iam.send(new ListAttachedUserPoliciesCommand({ UserName: username, Marker: marker }));
      return { items: page.AttachedPolicies || [], marker: page.Marker, truncated: page.IsTruncated };
    }), []),
    readDetail('内联策略', () => collectMarkerPages(async marker => {
      const page = await iam.send(new ListUserPoliciesCommand({ UserName: username, Marker: marker }));
      return { items: page.PolicyNames || [], marker: page.Marker, truncated: page.IsTruncated };
    }), []),
    readDetail('签名证书', () => collectMarkerPages(async marker => {
      const page = await iam.send(new ListSigningCertificatesCommand({ UserName: username, Marker: marker }));
      return { items: page.Certificates || [], marker: page.Marker, truncated: page.IsTruncated };
    }), []),
    readDetail('SSH 公钥', () => collectMarkerPages(async marker => {
      const page = await iam.send(new ListSSHPublicKeysCommand({ UserName: username, Marker: marker }));
      return { items: page.SSHPublicKeys || [], marker: page.Marker, truncated: page.IsTruncated };
    }), []),
    readDetail('服务专用凭证', () => collectMarkerPages(async marker => {
      const page = await iam.send(new ListServiceSpecificCredentialsCommand({ UserName: username, Marker: marker }));
      return { items: page.ServiceSpecificCredentials || [], marker: page.Marker, truncated: page.IsTruncated };
    }), []),
  ]);

  const boundary = user.PermissionsBoundary?.PermissionsBoundaryArn;
  return {
    username,
    userId: user.UserId || '',
    arn: user.Arn || '',
    path: user.Path || '/',
    createDate: user.CreateDate!.toISOString(),
    passwordEnabled,
    passwordLastUsed: user.PasswordLastUsed?.toISOString(),
    accessKeys: accessKeys.map(key => ({
      id: key.AccessKeyId || '',
      status: key.Status || 'Unknown',
      createDate: key.CreateDate?.toISOString(),
    })),
    mfaDevices: mfaDevices.map(device => ({
      serialNumber: device.SerialNumber || '',
      enableDate: device.EnableDate?.toISOString(),
    })),
    groups: groups.map(group => group.GroupName || '').filter(Boolean),
    attachedPolicies: attachedPolicies.map(policy => ({
      name: policy.PolicyName || '',
      arn: policy.PolicyArn || '',
    })),
    inlinePolicies: inlinePolicies.filter(Boolean),
    permissionsBoundary: boundary,
    dependencies: {
      loginProfile: passwordEnabled ? 1 : 0,
      accessKeys: accessKeys.length,
      mfaDevices: mfaDevices.length,
      groups: groups.length,
      attachedPolicies: attachedPolicies.length,
      inlinePolicies: inlinePolicies.length,
      signingCertificates: signingCertificates.length,
      sshPublicKeys: sshPublicKeys.length,
      serviceSpecificCredentials: serviceCredentials.length,
      permissionsBoundary: boundary ? 1 : 0,
    },
  };
}

/**
 * 扫描选定区域及全局服务中最近 7 天创建/启动的资源。
 * Lambda 没有创建时间，因此按 LastModified 过滤并明确标记为“最近修改”。
 * 单个服务无权限或失败时返回 warning，避免把 AccessDenied 误报成“没有资源”。
 */
export async function scanResources(accountId: string, region: string): Promise<CleanupScanResult> {
  const creds = await assumeToAccount(accountId);
  const resources: CleanupResource[] = [];
  const warnings: string[] = [];
  const nowMs = Date.now();
  const cutoffMs = nowMs - CLEANUP_WINDOW_MS;

  try {
    await withAwsClient(new EC2Client({ region, credentials: creds }), async ec2 => {
      let nextToken: string | undefined;
      do {
        const page = await ec2.send(new DescribeInstancesCommand({ NextToken: nextToken }));
        for (const reservation of page.Reservations || []) {
          for (const instance of reservation.Instances || []) {
            if (!instance.InstanceId || instance.State?.Name === 'terminated'
              || !isRecentCleanupTime(instance.LaunchTime, cutoffMs, nowMs)) continue;
            resources.push({
              key: `EC2:${instance.InstanceId}`,
              type: 'EC2',
              id: instance.InstanceId,
              name: instance.Tags?.find(tag => tag.Key === 'Name')?.Value || instance.InstanceId,
              arn: '',
              details: `${instance.InstanceType || '未知规格'} | ${instance.State?.Name || 'unknown'}`,
              eventTime: instance.LaunchTime!.toISOString(),
              timeBasis: 'launchTime',
              scope: 'regional',
              deletable: true,
            });
          }
        }
        nextToken = page.NextToken;
      } while (nextToken);
    });
  } catch (error) {
    warnings.push(`EC2 扫描失败：${cleanupErrorMessage(error)}`);
  }

  try {
    await withAwsClient(new EC2Client({ region, credentials: creds }), async ec2 => {
      let nextToken: string | undefined;
      do {
        const page = await ec2.send(new DescribeVolumesCommand({ NextToken: nextToken }));
        for (const volume of page.Volumes || []) {
          if (!volume.VolumeId || !isRecentCleanupTime(volume.CreateTime, cutoffMs, nowMs)) continue;
          resources.push({
            key: `EBS:${volume.VolumeId}`,
            type: 'EBS',
            id: volume.VolumeId,
            name: volume.Tags?.find(tag => tag.Key === 'Name')?.Value || volume.VolumeId,
            arn: '',
            details: `${volume.Size || 0}GB | ${volume.State || 'unknown'}`,
            eventTime: volume.CreateTime!.toISOString(),
            timeBasis: 'createTime',
            scope: 'regional',
            deletable: true,
          });
        }
        nextToken = page.NextToken;
      } while (nextToken);
    });
  } catch (error) {
    warnings.push(`EBS 扫描失败：${cleanupErrorMessage(error)}`);
  }

  try {
    await withAwsClient(new S3Client({ region: 'us-east-1', credentials: creds }), async s3 => {
      const page = await s3.send(new ListBucketsCommand({}));
      for (const bucket of page.Buckets || []) {
        if (!bucket.Name || !isRecentCleanupTime(bucket.CreationDate, cutoffMs, nowMs)) continue;
        resources.push({
          key: `S3:${bucket.Name}`,
          type: 'S3',
          id: bucket.Name,
          name: bucket.Name,
          arn: `arn:aws:s3:::${bucket.Name}`,
          details: 'S3 桶不可在平台删除，请前往 AWS 控制台确认桶内数据',
          eventTime: bucket.CreationDate!.toISOString(),
          timeBasis: 'creationDate',
          scope: 'global',
          deletable: false,
        });
      }
    });
  } catch (error) {
    warnings.push(`S3 扫描失败：${cleanupErrorMessage(error)}`);
  }

  try {
    await withAwsClient(new LambdaClient({ region, credentials: creds }), async lambda => {
      let marker: string | undefined;
      do {
        const page = await lambda.send(new ListFunctionsCommand({ Marker: marker }));
        for (const fn of page.Functions || []) {
          if (!fn.FunctionName || !isRecentCleanupTime(fn.LastModified, cutoffMs, nowMs)) continue;
          resources.push({
            key: `Lambda:${fn.FunctionName}`,
            type: 'Lambda',
            id: fn.FunctionName,
            name: fn.FunctionName,
            arn: fn.FunctionArn || '',
            details: `${fn.Runtime || '未知运行时'} | ${fn.MemorySize || 0}MB`,
            eventTime: new Date(fn.LastModified!).toISOString(),
            timeBasis: 'lastModified',
            scope: 'regional',
            deletable: true,
          });
        }
        marker = page.NextMarker;
      } while (marker);
    });
  } catch (error) {
    warnings.push(`Lambda 扫描失败：${cleanupErrorMessage(error)}`);
  }

  try {
    await withAwsClient(new IAMClient({ region: 'us-east-1', credentials: creds }), async iam => {
      const users = await collectMarkerPages(async marker => {
        const page = await iam.send(new ListUsersCommand({ Marker: marker }));
        return { items: page.Users || [], marker: page.Marker, truncated: page.IsTruncated };
      });
      for (const user of users) {
        if (!user.UserName || !isRecentCleanupTime(user.CreateDate, cutoffMs, nowMs)) continue;
        const iamDetails = await getCleanupIamDetails(iam, user, warnings);
        resources.push({
          key: `IAMUser:${user.UserName}`,
          type: 'IAMUser',
          id: user.UserName,
          name: user.UserName,
          arn: user.Arn || '',
          details: `密码:${iamDetails.passwordEnabled ? '有' : '无'} | Access Key:${iamDetails.accessKeys.length} | MFA:${iamDetails.mfaDevices.length} | 用户组:${iamDetails.groups.length}`,
          eventTime: user.CreateDate!.toISOString(),
          timeBasis: 'createTime',
          scope: 'global',
          deletable: true,
          iamDetails,
        });
      }
    });
  } catch (error) {
    warnings.push(`IAM 用户扫描失败：${cleanupErrorMessage(error)}`);
  }

  resources.sort((a, b) => Date.parse(b.eventTime) - Date.parse(a.eventTime));
  return {
    resources,
    warnings,
    cutoff: new Date(cutoffMs).toISOString(),
    windowDays: CLEANUP_WINDOW_DAYS,
  };
}

async function ignoreMissingIamEntity(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!isNoSuchEntity(error)) throw error;
  }
}

async function deleteRecentIamUser(iam: IAMClient, username: string): Promise<{
  alreadyAbsent: boolean;
  cleanup: IamCleanupSummary;
}> {
  const cleanup: IamCleanupSummary = {
    loginProfiles: 0,
    accessKeys: 0,
    mfaDevices: 0,
    virtualMfaDevices: 0,
    attachedPolicies: 0,
    inlinePolicies: 0,
    groups: 0,
    signingCertificates: 0,
    sshPublicKeys: 0,
    serviceSpecificCredentials: 0,
    permissionsBoundaries: 0,
  };

  let user;
  try {
    user = (await iam.send(new GetUserCommand({ UserName: username }))).User;
  } catch (error) {
    if (isNoSuchEntity(error)) return { alreadyAbsent: true, cleanup };
    throw error;
  }
  if (!user) throw new Error(`IAM 用户 ${username} 不存在`);
  assertRecentCleanupTime(user.CreateDate, `IAM 用户 ${username}`);

  try {
    await iam.send(new GetLoginProfileCommand({ UserName: username }));
    await ignoreMissingIamEntity(() => iam.send(new DeleteLoginProfileCommand({ UserName: username })));
    cleanup.loginProfiles = 1;
  } catch (error) {
    if (!isNoSuchEntity(error)) throw error;
  }

  const accessKeys = await collectMarkerPages(async marker => {
    const page = await iam.send(new ListAccessKeysCommand({ UserName: username, Marker: marker }));
    return { items: page.AccessKeyMetadata || [], marker: page.Marker, truncated: page.IsTruncated };
  });
  for (const key of accessKeys) {
    if (!key.AccessKeyId) continue;
    await ignoreMissingIamEntity(() => iam.send(new DeleteAccessKeyCommand({ UserName: username, AccessKeyId: key.AccessKeyId })));
    cleanup.accessKeys++;
  }

  const mfaDevices = await collectMarkerPages(async marker => {
    const page = await iam.send(new ListMFADevicesCommand({ UserName: username, Marker: marker }));
    return { items: page.MFADevices || [], marker: page.Marker, truncated: page.IsTruncated };
  });
  for (const device of mfaDevices) {
    if (!device.SerialNumber) continue;
    await ignoreMissingIamEntity(() => iam.send(new DeactivateMFADeviceCommand({ UserName: username, SerialNumber: device.SerialNumber })));
    cleanup.mfaDevices++;
    if (/^arn:[^:]+:iam::\d{12}:mfa\//.test(device.SerialNumber)) {
      await ignoreMissingIamEntity(() => iam.send(new DeleteVirtualMFADeviceCommand({ SerialNumber: device.SerialNumber })));
      cleanup.virtualMfaDevices++;
    }
  }

  const attachedPolicies = await collectMarkerPages(async marker => {
    const page = await iam.send(new ListAttachedUserPoliciesCommand({ UserName: username, Marker: marker }));
    return { items: page.AttachedPolicies || [], marker: page.Marker, truncated: page.IsTruncated };
  });
  for (const policy of attachedPolicies) {
    if (!policy.PolicyArn) continue;
    await ignoreMissingIamEntity(() => iam.send(new DetachUserPolicyCommand({ UserName: username, PolicyArn: policy.PolicyArn })));
    cleanup.attachedPolicies++;
  }

  const inlinePolicies = await collectMarkerPages(async marker => {
    const page = await iam.send(new ListUserPoliciesCommand({ UserName: username, Marker: marker }));
    return { items: page.PolicyNames || [], marker: page.Marker, truncated: page.IsTruncated };
  });
  for (const policyName of inlinePolicies) {
    await ignoreMissingIamEntity(() => iam.send(new DeleteUserPolicyCommand({ UserName: username, PolicyName: policyName })));
    cleanup.inlinePolicies++;
  }

  const groups = await collectMarkerPages(async marker => {
    const page = await iam.send(new ListGroupsForUserCommand({ UserName: username, Marker: marker }));
    return { items: page.Groups || [], marker: page.Marker, truncated: page.IsTruncated };
  });
  for (const group of groups) {
    if (!group.GroupName) continue;
    await ignoreMissingIamEntity(() => iam.send(new RemoveUserFromGroupCommand({ UserName: username, GroupName: group.GroupName })));
    cleanup.groups++;
  }

  const certificates = await collectMarkerPages(async marker => {
    const page = await iam.send(new ListSigningCertificatesCommand({ UserName: username, Marker: marker }));
    return { items: page.Certificates || [], marker: page.Marker, truncated: page.IsTruncated };
  });
  for (const certificate of certificates) {
    if (!certificate.CertificateId) continue;
    await ignoreMissingIamEntity(() => iam.send(new DeleteSigningCertificateCommand({ UserName: username, CertificateId: certificate.CertificateId })));
    cleanup.signingCertificates++;
  }

  const sshKeys = await collectMarkerPages(async marker => {
    const page = await iam.send(new ListSSHPublicKeysCommand({ UserName: username, Marker: marker }));
    return { items: page.SSHPublicKeys || [], marker: page.Marker, truncated: page.IsTruncated };
  });
  for (const key of sshKeys) {
    if (!key.SSHPublicKeyId) continue;
    await ignoreMissingIamEntity(() => iam.send(new DeleteSSHPublicKeyCommand({ UserName: username, SSHPublicKeyId: key.SSHPublicKeyId })));
    cleanup.sshPublicKeys++;
  }

  const serviceCredentials = await collectMarkerPages(async marker => {
    const page = await iam.send(new ListServiceSpecificCredentialsCommand({ UserName: username, Marker: marker }));
    return { items: page.ServiceSpecificCredentials || [], marker: page.Marker, truncated: page.IsTruncated };
  });
  for (const credential of serviceCredentials) {
    if (!credential.ServiceSpecificCredentialId) continue;
    await ignoreMissingIamEntity(() => iam.send(new DeleteServiceSpecificCredentialCommand({
      UserName: username,
      ServiceSpecificCredentialId: credential.ServiceSpecificCredentialId,
    })));
    cleanup.serviceSpecificCredentials++;
  }

  if (user.PermissionsBoundary?.PermissionsBoundaryArn) {
    await ignoreMissingIamEntity(() => iam.send(new DeleteUserPermissionsBoundaryCommand({ UserName: username })));
    cleanup.permissionsBoundaries = 1;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await iam.send(new DeleteUserCommand({ UserName: username }));
      return { alreadyAbsent: false, cleanup };
    } catch (error: any) {
      if (isNoSuchEntity(error)) return { alreadyAbsent: true, cleanup };
      if (!['DeleteConflict', 'DeleteConflictException'].includes(error?.name) || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  throw new Error(`删除 IAM 用户 ${username} 失败`);
}

/**
 * 删除用户主动勾选的最近 7 天资源。每项删除前都从 AWS 重新读取时间，
 * 防止伪造请求绕过扫描窗口。IAM 用户由路由额外限制为 strict admin，
 * 并在服务端重新枚举、清理全部依赖后删除；S3 永不在此接口删除。
 */
export async function deleteResources(
  accountId: string,
  region: string,
  resources: { type: CleanupResourceType; id: string; name?: string }[],
): Promise<CleanupDeleteResult[]> {
  const admin = await getTempAdminCredentials(accountId);
  const creds = {
    accessKeyId: admin.accessKeyId,
    secretAccessKey: admin.secretAccessKey,
    sessionToken: admin.sessionToken,
  };
  const ec2 = new EC2Client({ region, credentials: creds });
  const lambda = new LambdaClient({ region, credentials: creds });
  const iam = new IAMClient({ region: 'us-east-1', credentials: creds });

  const results: CleanupDeleteResult[] = [];
  try {
    for (const resource of resources) {
      try {
        if (resource.type === 'EC2') {
          const page = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [resource.id] }));
          const instance = page.Reservations?.flatMap(item => item.Instances || [])[0];
          if (!instance) throw new Error(`EC2 ${resource.id} 不存在`);
          assertRecentCleanupTime(instance.LaunchTime, `EC2 ${resource.id}`);
          await ec2.send(new TerminateInstancesCommand({ InstanceIds: [resource.id] }));
        } else if (resource.type === 'EBS') {
          const page = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [resource.id] }));
          const volume = page.Volumes?.[0];
          if (!volume) throw new Error(`EBS ${resource.id} 不存在`);
          assertRecentCleanupTime(volume.CreateTime, `EBS ${resource.id}`);
          await ec2.send(new DeleteVolumeCommand({ VolumeId: resource.id }));
        } else if (resource.type === 'Lambda') {
          const fn = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: resource.id }));
          assertRecentCleanupTime(fn.LastModified, `Lambda ${resource.id}（最近修改时间）`);
          await lambda.send(new DeleteFunctionCommand({ FunctionName: resource.id }));
        } else if (resource.type === 'IAMUser') {
          const deleted = await deleteRecentIamUser(iam, resource.id);
          results.push({
            id: resource.id,
            type: resource.type,
            name: resource.name,
            ok: true,
            alreadyAbsent: deleted.alreadyAbsent,
            iamCleanup: deleted.cleanup,
          });
          continue;
        } else {
          results.push({
            id: resource.id,
            type: resource.type,
            name: resource.name,
            ok: false,
            error: `暂不支持删除 ${resource.type}（请在控制台操作）`,
          });
          continue;
        }
        results.push({ id: resource.id, type: resource.type, name: resource.name, ok: true });
      } catch (error) {
        results.push({
          id: resource.id,
          type: resource.type,
          name: resource.name,
          ok: false,
          error: cleanupErrorMessage(error),
        });
      }
    }
  } finally {
    ec2.destroy();
    lambda.destroy();
    iam.destroy();
  }
  return results;
}

/**
 * 严格一级跳假设指定角色（供控制台登录用）。直接用平台基础凭证 AssumeRole 到
 * arn:aws:iam::<accountId>:role/<roleName>，失败时抛出明确错误（不做静默兜底），
 * 以便前端能区分「该账户未部署该角色」与其它问题。不使用 supportRoleUnavailable 缓存，
 * 保证刚创建的角色能立即生效。
 */
async function assumeRoleStrict(
  accountId: string,
  roleName: string,
  sessionPrefix: string,
  externalSignal?: AbortSignal,
) {
  const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
  // 受限账户的 support-quota 要求 ExternalId；admin 类角色不受此约束，带上也无害
  const externalId = roleName === SUPPORT_ROLE_NAME ? getExternalId(accountId) : undefined;
  const resp = await withAwsClient(
    new STSClient({ region: DEFAULT_REGION, credentials: BASE_CREDENTIALS }),
    sts => withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal => sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `${sessionPrefix}-${accountId}`.slice(0, 64),
      DurationSeconds: 3600,
      ...(externalId ? { ExternalId: externalId } : {}),
    }), { abortSignal: signal }), externalSignal),
  );
  return {
    accessKeyId: resp.Credentials!.AccessKeyId!,
    secretAccessKey: resp.Credentials!.SecretAccessKey!,
    sessionToken: resp.Credentials!.SessionToken!,
  };
}

/**
 * 严格使用成员账户的最小权限 support-quota 角色，不回退到 payer 管理员链路。
 * 供仅需只读校验的后台流程使用；角色不可用时由调用方按失败处理。
 */
export async function assumeSupportRoleStrict(accountId: string) {
  if (!/^\d{12}$/.test(accountId)) throw new Error('账户 ID 必须是 12 位数字');
  return assumeRoleStrict(accountId, SUPPORT_ROLE_NAME, 'support-readonly');
}

/**
 * Admin 控制台凭证。
 * - accountId 是某 payer 的管理账户：管理账户没有 OAAR，用该 payer 的 role/tool（管理员一级跳）。
 * - 成员账户处于临时开通期：直跳 admin-console，会话不超过开通剩余时间。
 * - 否则：payer admin 凭证 → 二级跳 OrganizationAccountAccessRole；进不去则提示临时开通。
 */
async function assumeAdminViaOAAR(accountId: string) {
  const ADMIN_CHILD_ROLE = 'OrganizationAccountAccessRole';
  const selfPayer = PAYERS.find(p => {
    const m = /arn:aws:iam::(\d+):role\//.exec(p.roleArn);
    return m && m[1] === accountId;
  });
  if (selfPayer) {
    return await getAdminCredsForPayer(selfPayer.roleArn);
  }
  if (isAdminUnavailable(accountId)) {
    throw new Error(`账户 ${accountId} 已配置为仅保留 support-quota，Admin 控制台不可用`);
  }

  // 临时开通期内直跳 admin-console（INVITED 账户没有 OAAR）；没有有效开通时不碰它。
  // 受限账户不提供临时开通，直接走 OAAR。
  const restricted = isRestricted(accountId);
  const grant = restricted ? null : getActiveGrant(accountId);
  let grantErr: any;
  if (grant) {
    const remaining = remainingSeconds(grant);
    // 记录仍在、无法重新开通：不能提示「请临时开通」
    if (remaining < 900) throw new Error('临时 Admin 剩余不足 15 分钟，请到期回收后重新开通');
    try {
      const resp = await withAwsClient(
        new STSClient({ region: DEFAULT_REGION, credentials: BASE_CREDENTIALS }),
        sts => withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal => sts.send(new AssumeRoleCommand({
          RoleArn: `arn:aws:iam::${accountId}:role/${ADMIN_ROLE_NAME}`,
          RoleSessionName: `console-admin-${accountId}`.slice(0, 64),
          DurationSeconds: Math.min(3600, remaining),
        }), { abortSignal: signal })),
      );
      return {
        accessKeyId: resp.Credentials!.AccessKeyId!,
        secretAccessKey: resp.Credentials!.SecretAccessKey!,
        sessionToken: resp.Credentials!.SessionToken!,
      };
    } catch (e) { grantErr = e; /* 开通状态与实际不符时先回退 OAAR */ }
  }

  const known = accountPayerMap.get(accountId) || getPayerRoleArnForAccount(accountId);
  const payerArns = known
    ? [known, ...PAYERS.map(p => p.roleArn).filter(a => a !== known)]
    : PAYERS.map(p => p.roleArn);
  let lastErr: any;
  for (const payerArn of payerArns) {
    try {
      const admin = await getAdminCredsForPayer(payerArn);
      const resp = await withAwsClient(
        new STSClient({ region: DEFAULT_REGION, credentials: admin }),
        sts => withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal => sts.send(new AssumeRoleCommand({
          RoleArn: `arn:aws:iam::${accountId}:role/${ADMIN_CHILD_ROLE}`,
          RoleSessionName: `console-admin-${accountId}`.slice(0, 64),
          DurationSeconds: 3600,
        }), { abortSignal: signal })),
      );
      accountPayerMap.set(accountId, payerArn);
      return {
        accessKeyId: resp.Credentials!.AccessKeyId!,
        secretAccessKey: resp.Credentials!.SecretAccessKey!,
        sessionToken: resp.Credentials!.SessionToken!,
      };
    } catch (e) { lastErr = e; continue; }
  }
  if (restricted) {
    throw new Error(
      `无法以 Admin 权限登录账户 ${accountId} 的控制台：未能经 OrganizationAccountAccessRole 假设` +
      `（${lastErr?.name || lastErr?.message || '所有 payer 均尝试失败'}）。`,
    );
  }
  if (grant) {
    throw new Error(`临时开通期内无法 AssumeRole ${ADMIN_ROLE_NAME}（${grantErr?.name || 'AssumeRoleFailed'}），请检查开通状态或提前关闭后重新开通`);
  }
  throw new TempAdminRequiredError(accountId);
}

/**
 * 取 payer 管理账户的控制台凭证。
 *
 * payer 上没有 support-quota（StackSet 不覆盖管理账户，也不单独为其创建），
 * 所以只能用 role/tool。但 role/tool 是 AdministratorAccess，直接拿来当「只读」入口
 * 名不副实，因此 mode='readonly' 时附加 ReadOnlyAccess 作为 session policy：
 * 最终会话权限 = 角色权限 ∩ session policy = 只读。
 * 这是 STS 层面的硬限制，不是界面层的约束，非特权用户拿到的会话确实无法写。
 */
async function assumePayerForConsole(
  payerRoleArn: string,
  mode: 'admin' | 'readonly',
  externalSignal?: AbortSignal,
) {
  const resp = await withAwsClient(
    new STSClient({ region: DEFAULT_REGION, credentials: BASE_CREDENTIALS }),
    sts => withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal => sts.send(new AssumeRoleCommand({
      RoleArn: payerRoleArn,
      RoleSessionName: mode === 'admin' ? 'console-payer-admin' : 'console-payer-readonly',
      DurationSeconds: 3600,
      ...(mode === 'readonly'
        ? { PolicyArns: [{ arn: 'arn:aws:iam::aws:policy/ReadOnlyAccess' }] }
        : {}),
    }), { abortSignal: signal }), externalSignal),
  );
  return {
    accessKeyId: resp.Credentials!.AccessKeyId!,
    secretAccessKey: resp.Credentials!.SecretAccessKey!,
    sessionToken: resp.Credentials!.SessionToken!,
  };
}

/**
 * Generate a federated AWS Console sign-in URL for a child account.
 * Lets the user open the account's console (e.g. a Support case) without manual login.
 * Uses STS federation — free, no Business plan required.
 *
 * access:
 *   - 'auto'（默认）→ 原有回退链（support-quota 一级跳 → payer tool → 子角色二级跳），
 *                     供未部署专用角色的普通账户使用，保证控制台始终能打开。
 *   - 'support'     → 一级跳专用 support-quota 角色（只读 + Support + 配额）
 *   - 'admin'       → 默认 OrganizationAccountAccessRole（成员二级跳；payer 管理账户用 role/tool）
 */
export async function getConsoleSigninUrl(
  accountId: string,
  destinationUrl: string,
  access: 'auto' | 'support' | 'admin' = 'auto',
  signal?: AbortSignal,
) {
  // payer 管理账户上不存在 support-quota：SERVICE_MANAGED StackSet 不覆盖管理账户，
  // 我们也不为 payer 单独创建该角色。它的入口统一走 role/tool，
  // 只读需求用 STS session policy 把会话权限压到 ReadOnlyAccess（硬限制，非仅界面约束）。
  const selfPayer = PAYERS.find(p => {
    const m = /arn:aws:iam::(\d+):role\//.exec(p.roleArn);
    return m && m[1] === accountId;
  });

  // admin-only 排除的成员账户必须显式走 support，禁止 auto 在 support 失败后回退 OAAR Admin。
  // payer 管理账户不属于成员 StackSet 范围，保持原有 role/tool 行为。
  if (!selfPayer && isAdminUnavailable(accountId) && access !== 'support') {
    throw new Error(`账户 ${accountId} 已配置为仅保留 support-quota，控制台仅允许只读模式`);
  }

  // Get temporary credentials for the target account
  let creds;
  if (selfPayer) {
    creds = await assumePayerForConsole(selfPayer.roleArn, access === 'admin' ? 'admin' : 'readonly', signal);
  } else if (access === 'admin') {
    // Admin：默认 OrganizationAccountAccessRole
    creds = await assumeAdminViaOAAR(accountId);
  } else if (access === 'support') {
    // 只读：一级跳专用 support-quota 角色
    try {
      creds = await assumeRoleStrict(accountId, SUPPORT_ROLE_NAME, 'console-support', signal);
    } catch (e: any) {
      throw new Error(
        `无法以 只读(support-quota) 权限登录账户 ${accountId} 的控制台：` +
        `未能假设角色 role/${SUPPORT_ROLE_NAME}（${e?.name || e?.message || '假设失败'}）。` +
        `请确认该账户已部署 ${SUPPORT_ROLE_NAME} 角色并信任平台身份。`,
      );
    }
  } else {
    // auto：沿用原有回退链，兼容未部署专用角色的普通账户
    creds = await assumeToAccount(accountId);
  }

  // Step 1: Get a sign-in token from AWS federation endpoint
  const sessionJson = JSON.stringify({
    sessionId: creds.accessKeyId,
    sessionKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  });

  const getTokenUrl = `https://signin.aws.amazon.com/federation?Action=getSigninToken&Session=${encodeURIComponent(sessionJson)}`;
  const { SigninToken } = await withAbortTimeout(
    CONSOLE_FEDERATION_TIMEOUT_MS,
    async requestSignal => {
      const tokenResp = await fetch(getTokenUrl, { signal: requestSignal });
      if (!tokenResp.ok) {
        throw new Error(`获取登录令牌失败: ${tokenResp.status}`);
      }
      return tokenResp.json() as Promise<{ SigninToken: string }>;
    },
    signal,
  );

  // Step 2: Build the login URL with the token + destination
  const loginUrl = `https://signin.aws.amazon.com/federation?Action=login` +
    `&Issuer=${encodeURIComponent('AWS-Toolbox')}` +
    `&Destination=${encodeURIComponent(destinationUrl)}` +
    `&SigninToken=${SigninToken}`;

  return loginUrl;
}

export { PAYERS, DEFAULT_REGION, assumeToAccount };
