/**
 * AWS Service Layer — reads config from shared config.json
 */
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand, AssumeRootCommand } from '@aws-sdk/client-sts';
import { OrganizationsClient, ListAccountsCommand } from '@aws-sdk/client-organizations';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { ServiceQuotasClient, ListServiceQuotasCommand, RequestServiceQuotaIncreaseCommand, ListRequestedServiceQuotaChangeHistoryCommand, GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';
import { IAMClient, GetAccountSummaryCommand, ListMFADevicesCommand, ListUsersCommand, ListVirtualMFADevicesCommand, DeactivateMFADeviceCommand, DeleteVirtualMFADeviceCommand, DeleteLoginProfileCommand, ListAccessKeysCommand, GetLoginProfileCommand, DeleteAccessKeyCommand } from '@aws-sdk/client-iam';
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand, TerminateInstancesCommand, DeleteVolumeCommand } from '@aws-sdk/client-ec2';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { LambdaClient, ListFunctionsCommand, DeleteFunctionCommand } from '@aws-sdk/client-lambda';
import path from 'path';
import fs from 'fs';
import { db } from './db';
import { getExternalId } from './restricted-accounts';

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
// 用于生成 Admin 临时凭证 / Admin 控制台：INVITED 账户没有 OrganizationAccountAccessRole，
// 只能靠这个由组织级 StackSet 下发的角色进入。
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

// Credential cache
const adminCredsCache: Map<string, { creds: any; expiry: number }> = new Map();
const accountPayerMap: Map<string, string> = new Map();
// 记录哪些账号的 support-quota role AssumeRole 失败过 (避免每次都重试消耗 STS 调用)
const supportRoleUnavailable: Set<string> = new Set();

const QUOTA_REGION_CONCURRENCY = 6;
const AWS_REQUEST_TIMEOUT_MS = 30_000;
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
): Promise<TResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
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
  if (supportRoleUnavailable.has(accountId)) return null;
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
    if (isPermanentSupportRoleFailure(e)) supportRoleUnavailable.add(accountId);
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
  constructor(message: string, public readonly statusCode: 400 | 409 | 503) {
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
 * payer 管理账户固定最多 1 小时；成员账户超过 1 小时只允许长期平台身份直接 AssumeRole 到 admin-console。
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
      throw new TempCredentialError('payer 管理账户的 Admin 临时凭证最多 1 小时；长时凭证仅支持已部署 admin-console 的成员账户', 400);
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

  let retryableFailure: any;

  // 情况 2：成员账户优先一级跳专用 admin-console。只有这条从长期 IAM 用户发起的直接链路支持 >1 小时。
  // INVITED 账户没有 OrganizationAccountAccessRole，也依赖这个由组织级 StackSet 下发的角色进入。
  try {
    const resp = await withAwsClient(
      new STSClient({ region: DEFAULT_REGION, credentials: BASE_CREDENTIALS }),
      sts => withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal => sts.send(new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${accountId}:role/${ADMIN_ROLE_NAME}`,
        RoleSessionName: `admin-${accountId}`.slice(0, 64),
        DurationSeconds: durationSeconds,
      }), { abortSignal: signal })),
    );
    console.log(`[temp-cred] ${accountId} → ${ADMIN_ROLE_NAME} (一级跳, ${durationHours}h)`);
    return format(resp);
  } catch (e: any) {
    if (durationHours > 1) {
      if (isRetryableStsError(e)) {
        throw new TempCredentialError('AWS STS 暂时不可用或请求超时，请稍后重试', 503);
      }
      throw new TempCredentialError(
        `无法生成 ${durationHours} 小时凭证：请确认目标账户的 ${ADMIN_ROLE_NAME} 直接信任平台身份，且 MaxSessionDuration 不低于 ${durationHours} 小时（${e?.name || 'AssumeRoleFailed'}）`,
        409,
      );
    }
    if (isRetryableStsError(e)) retryableFailure = e;
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
  throw new TempCredentialError(
    `无法为账户 ${accountId} 生成管理员临时凭证：${lastErr?.message || '可用管理员角色均尝试失败'}`,
    409,
  );
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

  // 2) 在目标账户 root 会话内枚举它自己的 MFA 设备
  const mfaList = await iamRoot.send(new ListMFADevicesCommand({}));
  const devices = (mfaList.MFADevices || []).filter(d => !!d.SerialNumber);
  if (devices.length === 0) {
    throw new Error(`账户 ${accountId} 的根用户未启用 MFA，无需删除`);
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
      await iamRoot.send(new DeactivateMFADeviceCommand({ SerialNumber: serial }));
      // 仅虚拟设备可删除；硬件 MFA 停用即可
      try { await iamRoot.send(new DeleteVirtualMFADeviceCommand({ SerialNumber: serial })); } catch { /* 非虚拟设备忽略 */ }
      removed.push(serial);
    } catch (e: any) {
      failed.push({ serial, reason: `${e?.name || 'Error'}: ${e?.message || ''}`.slice(0, 200) });
    }
  }
  if (removed.length === 0 && failed.length > 0) {
    throw new Error(`删除失败：${failed.map(f => `${f.serial} (${f.reason})`).join('; ')}`);
  }
  return { accountId, removed, failed };
}

/**
 * 允许恢复成员账户根用户密码。
 *
 * 做法：AssumeRoot(IAMDeleteRootUserCredentials) → DeleteLoginProfile（省略 UserName 即 root 本身），
 * 即【删除该账户根用户现有的密码】。删除后根用户处于「无密码」状态，
 * 之后到该账户登录页用根邮箱走「忘记密码」，AWS 会发重置邮件，由所有者自行设置新密码。
 *
 * 为什么不是 CreateLoginProfile：那是给 root 直接设一个新密码，
 * 且在已有密码时会报 EntityAlreadyExists；我们要的是把密码控制权交还给邮箱持有者。
 */
export async function recoverRootPassword(accountId: string) {
  const rootCreds = await assumeRoot(accountId, ROOT_TASK_POLICY.delete);
  const iamRoot = new IAMClient({ region: DEFAULT_REGION, credentials: rootCreds });
  try {
    await iamRoot.send(new DeleteLoginProfileCommand({}));
  } catch (e: any) {
    // 本来就没有密码：已经是可走「忘记密码」的状态，视为幂等成功
    if (e?.name === 'NoSuchEntityException' || e?.name === 'NoSuchEntity') {
      return { accountId, ok: true, alreadyNoPassword: true };
    }
    throw e;
  }
  return { accountId, ok: true, alreadyNoPassword: false };
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
          allAccounts.push({ ...a, _payer: payer.name, _isPayer: payerAccountId != null && a.Id === payerAccountId, _consoleDual: consoleDual });
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

/**
 * 账单分析（资源清理第一步）：基于 Cost Explorer 真实账单，同时按「服务」和「区域」两个维度汇总。
 * - 用 getPayerRoleArnForAccount 精确定位账户所属 payer（管理账户），避免用错 payer 导致查不到数据。
 * - GroupBy SERVICE + REGION 一次取回，聚合出 byService / byRegion；分页取全。
 * - 全局/无区域服务归到 "global"（Route53/CloudFront/税费等）。
 */
export async function getBillingBreakdown(accountId: string, startDate: string, endDate: string) {
  const payerRole = getPayerRoleArnForAccount(accountId) || PAYERS[0]?.roleArn;
  if (!payerRole) throw new Error('未找到该账户所属 payer');
  const admin = await getAdminCredsForPayer(payerRole);
  const ce = new CostExplorerClient({ region: 'us-east-1', credentials: admin });

  const byService: Record<string, number> = {};
  const byRegion: Record<string, number> = {};
  let total = 0;
  let nextToken: string | undefined;
  do {
    const resp = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: startDate, End: endDate },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }, { Type: 'DIMENSION', Key: 'REGION' }],
      Filter: { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [accountId] } },
      NextPageToken: nextToken,
    }));
    (resp.ResultsByTime || []).forEach(p => (p.Groups || []).forEach(g => {
      const cost = parseFloat(g.Metrics?.UnblendedCost?.Amount || '0');
      if (cost <= 0) return;
      const service = g.Keys?.[0] || '(unknown)';
      let region = g.Keys?.[1] || '';
      if (!region || region === 'NoRegion' || region === 'global') region = 'global';
      byService[service] = (byService[service] || 0) + cost;
      byRegion[region] = (byRegion[region] || 0) + cost;
      total += cost;
    }));
    nextToken = (resp as any).NextPageToken;
  } while (nextToken);

  return {
    total,
    period: `${startDate} ~ ${endDate}`,
    byService: Object.entries(byService).map(([name, cost]) => ({ name, cost })).sort((a, b) => b.cost - a.cost),
    byRegion: Object.entries(byRegion).map(([region, cost]) => ({ region, cost })).sort((a, b) => b.cost - a.cost),
  };
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
const BEDROCK_QUOTA_SCOPES = ['Global Cross-Region', 'Cross-Region', 'On-Demand', 'Latency-Optimized', 'Other'];
// 模型名 → 规范 provider。按关键词匹配（含模型家族别名），避免出现 "GPT-5.4"/"Stable" 这类
// 由“取首个单词”产生的伪 provider，也避免 MiniMax/Minimax 大小写重复项。
const BEDROCK_PROVIDER_HINTS: Array<[string, string]> = [
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

/** 从配额名里提取模型名："... tokens per minute for <模型名>" */
function extractBedrockModelName(quotaName: string): string {
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
function classifyBedrockQuota(quotaName: string): { metric: 'TPM' | 'RPM' | 'TPD' | null; scope: string } {
  const nl = quotaName.toLowerCase();
  let metric: 'TPM' | 'RPM' | 'TPD' | null = null;
  if (nl.includes('tokens per minute')) metric = 'TPM';
  else if (nl.includes('requests per minute')) metric = 'RPM';
  else if (nl.includes('tokens per day')) metric = 'TPD';

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

          const { metric, scope } = classifyBedrockQuota(name);
          if (!metric) continue;
          const model = extractBedrockModelName(name);
          const provider = inferBedrockProvider(model, name);
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
  const found = quotas.find((q: any) => String(q.QuotaName || '').toLowerCase() === target)
    || quotas.find((q: any) => String(q.QuotaName || '').toLowerCase().includes(target));
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
 * 删除资源清理里选中的资源（资源清理最后一步）。用管理员凭证执行:
 * EC2 → TerminateInstances, EBS → DeleteVolume(仅未挂载可删), Lambda → DeleteFunction。
 * S3 暂不支持(删桶会丢数据/需先清空,风险高)。逐个执行并返回每个资源的成败。
 */
export async function deleteResources(
  accountId: string,
  region: string,
  resources: { type: string; id: string; name?: string }[],
) {
  const admin = await getTempAdminCredentials(accountId);
  const creds = { accessKeyId: admin.accessKeyId, secretAccessKey: admin.secretAccessKey, sessionToken: admin.sessionToken };
  const ec2 = new EC2Client({ region, credentials: creds });
  const lambda = new LambdaClient({ region, credentials: creds });

  const results: { id: string; type: string; name?: string; ok: boolean; error?: string }[] = [];
  for (const r of resources) {
    try {
      if (r.type === 'EC2') {
        await ec2.send(new TerminateInstancesCommand({ InstanceIds: [r.id] }));
      } else if (r.type === 'EBS') {
        await ec2.send(new DeleteVolumeCommand({ VolumeId: r.id }));
      } else if (r.type === 'Lambda') {
        await lambda.send(new DeleteFunctionCommand({ FunctionName: r.id }));
      } else {
        results.push({ id: r.id, type: r.type, name: r.name, ok: false, error: `暂不支持删除 ${r.type}（请在控制台操作）` });
        continue;
      }
      results.push({ id: r.id, type: r.type, name: r.name, ok: true });
    } catch (e: any) {
      results.push({ id: r.id, type: r.type, name: r.name, ok: false, error: e?.message || String(e) });
    }
  }
  return results;
}

/**
 * 严格一级跳假设指定角色（供控制台登录用）。直接用平台基础凭证 AssumeRole 到
 * arn:aws:iam::<accountId>:role/<roleName>，失败时抛出明确错误（不做静默兜底），
 * 以便前端能区分「该账户未部署该角色」与其它问题。不使用 supportRoleUnavailable 缓存，
 * 保证刚创建的角色能立即生效。
 */
async function assumeRoleStrict(accountId: string, roleName: string, sessionPrefix: string) {
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
    }), { abortSignal: signal })),
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
 * Admin 控制台凭证：使用默认 OrganizationAccountAccessRole。
 * - accountId 是某 payer 的管理账户：管理账户没有 OAAR，用该 payer 的 role/tool（管理员一级跳）。
 * - 否则(成员账户)：payer admin 凭证 → 二级跳 OrganizationAccountAccessRole。
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

  // 优先一级跳专用 admin-console（INVITED 账户没有 OrganizationAccountAccessRole）
  try {
    const resp = await withAwsClient(
      new STSClient({ region: DEFAULT_REGION, credentials: BASE_CREDENTIALS }),
      sts => withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal => sts.send(new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${accountId}:role/${ADMIN_ROLE_NAME}`,
        RoleSessionName: `console-admin-${accountId}`.slice(0, 64),
        DurationSeconds: 3600,
      }), { abortSignal: signal })),
    );
    return {
      accessKeyId: resp.Credentials!.AccessKeyId!,
      secretAccessKey: resp.Credentials!.SecretAccessKey!,
      sessionToken: resp.Credentials!.SessionToken!,
    };
  } catch { /* 未部署则回退二级跳 */ }

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
  throw new Error(
    `无法以 Admin 权限登录账户 ${accountId} 的控制台：未能经 OrganizationAccountAccessRole 假设` +
    `（${lastErr?.name || lastErr?.message || '所有 payer 均尝试失败'}）。`,
  );
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
async function assumePayerForConsole(payerRoleArn: string, mode: 'admin' | 'readonly') {
  const resp = await withAwsClient(
    new STSClient({ region: DEFAULT_REGION, credentials: BASE_CREDENTIALS }),
    sts => withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, signal => sts.send(new AssumeRoleCommand({
      RoleArn: payerRoleArn,
      RoleSessionName: mode === 'admin' ? 'console-payer-admin' : 'console-payer-readonly',
      DurationSeconds: 3600,
      ...(mode === 'readonly'
        ? { PolicyArns: [{ arn: 'arn:aws:iam::aws:policy/ReadOnlyAccess' }] }
        : {}),
    }), { abortSignal: signal })),
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
) {
  // payer 管理账户上不存在 support-quota：SERVICE_MANAGED StackSet 不覆盖管理账户，
  // 我们也不为 payer 单独创建该角色。它的入口统一走 role/tool，
  // 只读需求用 STS session policy 把会话权限压到 ReadOnlyAccess（硬限制，非仅界面约束）。
  const selfPayer = PAYERS.find(p => {
    const m = /arn:aws:iam::(\d+):role\//.exec(p.roleArn);
    return m && m[1] === accountId;
  });

  // Get temporary credentials for the target account
  let creds;
  if (selfPayer) {
    creds = await assumePayerForConsole(selfPayer.roleArn, access === 'admin' ? 'admin' : 'readonly');
  } else if (access === 'admin') {
    // Admin：默认 OrganizationAccountAccessRole
    creds = await assumeAdminViaOAAR(accountId);
  } else if (access === 'support') {
    // 只读：一级跳专用 support-quota 角色
    try {
      creds = await assumeRoleStrict(accountId, SUPPORT_ROLE_NAME, 'console-support');
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
