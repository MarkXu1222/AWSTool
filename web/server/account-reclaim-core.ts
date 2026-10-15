/**
 * 账户回收 —— 纯类型、状态机与错误说明（.kiro/specs/account-reclaim/design.md §4.1 §5.1 §8）。
 *
 * 本文件不读写 db、不调用外部服务，供编排服务、Root 执行器与权限模块共用。
 * 错误翻译只按 `.code` / `.statusCode` / `.uncertain` 等字段识别来源，不 import 具体 client。
 */
import { randomInt } from 'crypto';
import type { RootEmailJob } from './root-email-core';

export type AccountReclaimAccess = 'none' | 'operate';
export type AccountReclaimStepKey =
  'forward' | 'mailbox_password' | 'root_mfa' | 'root_recovery' | 'aws_password';
export type AccountReclaimStepState =
  'pending' | 'running' | 'succeeded' | 'skipped' | 'failed' | 'unknown' | 'not_run';
export type AccountReclaimStatus =
  'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export interface AccountReclaimActor {
  id: number | string;
  username: string;
  role: string;
  account_reclaim_access?: unknown;
}
export interface AccountReclaimStep {
  key: AccountReclaimStepKey;
  state: AccountReclaimStepState;
  message: string;
  errorCode?: string;
  recommendation?: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
}
export interface AccountReclaimRootAttempt {
  requestId: string;           // 此次单账户 Root 子批次 UUID，先持久化
  rootEmailJobId?: string;
  retryOfJobId?: string;
  createdAt: string;
}
export interface AccountReclaimJob {
  id: string;
  batchId: string;
  accountId: string;
  accountName: string;
  email: string;               // 服务端解析、去首尾空白、转小写
  payer: string;               // payer 配置名
  payerAccountId: string;
  createdBy: string;
  createdByUserId: string;
  createdFromIp?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  status: AccountReclaimStatus;
  steps: AccountReclaimStep[]; // 恰好五项，固定 key 与顺序
  encryptedMailboxPassword?: string;
  rootEmailJobId?: string;     // 当前一次 Root 尝试的指针
  rootAttempts: AccountReclaimRootAttempt[];
  retryCount: number;
  revision: number;            // 更新 CAS，防重复重试与旧回调覆盖
  outcomeRevision: number;     // 初始 0，每次进入 completed/failed/partial 时递增
  outcomeAuditRevision?: number;
  outcomeNotifiedRevision?: number;
}
export interface AccountReclaimProblem {
  errorCode: string;
  message: string;
  recommendation: string;
  uncertain: boolean;
}

// === 对外 DTO（§5.4）：前端 api.ts 镜像这些结构 ===

export type AccountReclaimJobView = Pick<AccountReclaimJob,
  'id' | 'batchId' | 'accountId' | 'accountName' | 'email' | 'payer' | 'payerAccountId'
  | 'createdBy' | 'createdAt' | 'updatedAt' | 'startedAt' | 'finishedAt'
  | 'status' | 'steps' | 'retryCount'> & {
  canRetry: boolean;
  retryAvailableAt?: string;
  manualCaptchaAvailable: boolean;
  manualCaptchaExpiresAt?: string;
  credentialsAvailable: { aws: boolean; mailbox: boolean };
};
export interface AccountReclaimBatchView {
  id: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  status: AccountReclaimStatus;
  total: number;
  queued: number;
  running: number;
  completed: number;
  partial: number;
  failed: number;
  cancelled: number;
  canCancel: boolean;
  jobs: AccountReclaimJobView[];
}
export interface AccountReclaimCatalogQuery {
  q?: string; payer?: string; page?: number; pageSize?: 5 | 20 | 50 | 100;
}
export interface AccountReclaimCatalog {
  payers: string[];
  accounts: Array<{
    accountId: string; accountName: string; email: string; payer: string;
    payerAccountId: string; eligible: boolean; reasonCode?: string; reason?: string;
    restricted?: boolean;
  }>;
  total: number;
  page: number;
  pageSize: 5 | 20 | 50 | 100;
  cachedAt: string;
  maxBatchSize: 20;
  readiness: { ready: boolean; message: string };
}
export interface AccountReclaimCredentials {
  accountId: string; email: string;
  awsPassword: string | null; mailboxPassword: string | null;
  awsMessage: string; mailboxMessage: string;
}

export const ACCOUNT_RECLAIM_MAX_BATCH = 20;
export const ACCOUNT_RECLAIM_STEP_KEYS: readonly AccountReclaimStepKey[] =
  ['forward', 'mailbox_password', 'root_mfa', 'root_recovery', 'aws_password'];
export const ACCOUNT_RECLAIM_STEP_LABELS: Readonly<Record<AccountReclaimStepKey, string>> = {
  forward: '删除邮箱转发',
  mailbox_password: '修改邮箱密码',
  root_mfa: '删除 Root MFA',
  root_recovery: '允许恢复密码',
  aws_password: '修改 AWS Root 密码',
};
export const ACCOUNT_RECLAIM_RESTRICTED_REASON = '受限账户（敏感权限客户）仅 Admin 可回收';
export const ACCOUNT_RECLAIM_PASSWORD_UNKNOWN_ADVICE = '邮箱已收回，请用根邮箱手工执行 AWS 忘记密码并确认结果';

export function accountReclaimStepNumber(key: AccountReclaimStepKey): number {
  return ACCOUNT_RECLAIM_STEP_KEYS.indexOf(key) + 1;
}

export function createAccountReclaimSteps(): AccountReclaimStep[] {
  return ACCOUNT_RECLAIM_STEP_KEYS.map(key => ({ key, state: 'pending', message: '待执行', attempts: 0 }));
}

// === 邮箱密码：16 位，A-Z a-z 0-9 与 !@#%^*-_=+ 各至少一位（mailbox-api-spec §4.3） ===

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const SYMBOLS = '!@#%^*-_=+';
const MAILBOX_PASSWORD_LENGTH = 16;
const MAILBOX_PASSWORD_CHARSET = UPPER + LOWER + DIGITS + SYMBOLS;

export function isValidMailboxPassword(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== MAILBOX_PASSWORD_LENGTH) return false;
  if ([...value].some(ch => !MAILBOX_PASSWORD_CHARSET.includes(ch))) return false;
  return [UPPER, LOWER, DIGITS, SYMBOLS].every(set => [...value].some(ch => set.includes(ch)));
}

export function generateMailboxPassword(): string {
  const pick = (set: string) => set[randomInt(set.length)];
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < MAILBOX_PASSWORD_LENGTH) chars.push(pick(MAILBOX_PASSWORD_CHARSET));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// === 错误翻译（§8.2） ===

/** 外部原因只保留可读部分：去 URL、去疑似密钥串，限 200 字。不是简单截断。 */
export function sanitizeAccountReclaimReason(value: unknown): string {
  const text = String(value ?? '')
    .replace(/https?:\/\/\S+/gi, '[链接已隐藏]')
    .replace(/\b(password|secret|token|signature|captcha)\b\s*[:=]\s*\S+/gi, '$1=[已隐藏]')
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, '[已隐藏]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const MAILBOX_INTERNAL_SUBACTIONS = new Set(['查询在线会话失败', '踢出旧会话失败']);

type ProblemDef = { message: string; recommendation: string; uncertain?: boolean };
const KNOWN_PROBLEMS: Record<string, ProblemDef> = {
  PAYER_NOT_SUPPORTED: { message: '不支持回收 payer 管理账户', recommendation: '请选择组织内的成员账户' },
  ACCOUNT_NOT_ACTIVE: { message: '账户不是 ACTIVE 状态', recommendation: '刷新账户同步后再确认' },
  ACCOUNT_NOT_MEMBER: { message: '账户不在已配置的组织内或归属无法确认', recommendation: '刷新账户同步后再确认' },
  ACCOUNT_RESTRICTED: {
    message: ACCOUNT_RECLAIM_RESTRICTED_REASON,
    recommendation: '请由 Admin 创建或重试回收；回收功能不会自动解除受限标记',
  },
  DOMAIN_NOT_HOSTED: { message: '根邮箱域名未托管在邮箱平台', recommendation: '先修复邮箱配置，再创建回收' },
  MAILBOX_NOT_FOUND: { message: '根邮箱在邮箱平台不存在', recommendation: '先修复邮箱配置，再创建回收' },
  MAILBOX_DISABLED: { message: '根邮箱已被禁用', recommendation: '先在邮箱平台启用该邮箱，再重试' },
  MAILBOX_SHARED: { message: '多个账户共用同一根邮箱', recommendation: '先完成邮箱归属拆分，再创建回收' },
  AUTH_FAILED: { message: '邮箱接口鉴权失败', recommendation: '由邮箱维护者核对 token 与服务器时间后重试' },
  SCOPE_DENIED: { message: '邮箱接口 token 缺少所需 scope', recommendation: '由邮箱维护者核对 toolbox-reclaim 的 scopes' },
  IP_NOT_ALLOWED: { message: '工具箱出口 IP 不在邮箱接口白名单', recommendation: '由邮箱维护者核对白名单' },
  RATE_LIMITED: { message: '邮箱接口限流', recommendation: '等待提示时间后，用新的 TOTP 重试本步骤' },
  MAILBOX_WRITE_UNKNOWN: {
    message: '邮箱接口超时或响应中断，变更结果未知',
    recommendation: '用已保存的同一参数经 TOTP 幂等重试；确认前后续步骤不会执行',
    uncertain: true,
  },
  MAILBOX_INVALID_RESPONSE: {
    message: '邮箱接口返回了无法识别的响应，变更结果未知',
    recommendation: '由维护者核对邮箱接口版本后，经 TOTP 幂等重试',
    uncertain: true,
  },
  MAILBOX_CONFIG_UNAVAILABLE: { message: '邮箱写接口配置不可用', recommendation: '由维护者核对 SSM 参数与环境变量' },
  INTERNAL_ERROR: { message: '邮箱服务内部错误', recommendation: '修复邮箱侧后经 TOTP 重试；在此之前不能认为邮箱已收回' },
  INVALID_REQUEST: { message: '邮箱接口拒绝了请求格式', recommendation: '属于工具箱侧问题，请联系维护者' },
  INVALID_EMAIL: { message: '根邮箱格式不被邮箱平台接受', recommendation: '核对账户根邮箱后重试' },
  INVALID_PASSWORD: { message: '新邮箱密码不满足邮箱平台约束', recommendation: '属于工具箱侧问题，请联系维护者' },
  NOT_FOUND: { message: '邮箱接口路径不存在', recommendation: '由维护者核对邮箱接口 Base URL 与路径' },
  HTTPS_REQUIRED: { message: '邮箱接口要求 HTTPS', recommendation: '由维护者核对邮箱接口地址配置' },
  ROOT_MFA_PARTIAL_FAILURE: { message: '部分 Root MFA 设备停用失败', recommendation: '修复后用新的 TOTP 重试第 3 步' },
  AccessDenied: {
    message: 'payer、AssumeRoot 或特权动作被拒绝',
    recommendation: '由维护者核对组织集中式根访问、payer 角色权限与 SCP；不会自动扩大权限',
  },
  ACCOUNT_CHANGED: { message: '账户邮箱、归属或状态已变化', recommendation: '按最新信息重新确认后再显式重试' },
  CREATOR_PERMISSION_REVOKED: { message: '批次创建者的回收权限已撤销或身份已变化', recommendation: '恢复授权后再显式重试' },
  ROOT_JOB_LINK_INVALID: { message: '无法可靠关联原 Root 改密任务', recommendation: '保留记录并人工核查，系统不会自动补发' },
  ROOT_CREDENTIAL_UNAVAILABLE: { message: 'Root 改密已结束但永久凭证不可读取', recommendation: '保留记录并人工核查' },
  ROOT_RUNTIME_UNAVAILABLE: { message: 'Root 改密执行器未就绪', recommendation: '由维护者检查浏览器、OCR 与邮件索引配置后重试' },
  ROOT_ENQUEUE_REJECTED: { message: 'Root 改密任务未能入队', recommendation: '等待提示条件解除后，用新的 TOTP 重试第 5 步' },
  SERVICE_INTERRUPTED: { message: '服务中断，步骤结果未知', recommendation: '服务恢复后会幂等核验；如仍未知请经 TOTP 重试' },
  UNEXPECTED_ERROR: { message: '未预期错误', recommendation: '查看原因后经 TOTP 重试；多次失败请联系维护者' },
};

const UNCERTAIN_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET']);

function problem(code: string, detail?: string, overrides: Partial<ProblemDef> = {}): AccountReclaimProblem {
  const def = KNOWN_PROBLEMS[code] || KNOWN_PROBLEMS.UNEXPECTED_ERROR;
  const message = overrides.message ?? def.message;
  return {
    errorCode: KNOWN_PROBLEMS[code] ? code : 'UNEXPECTED_ERROR',
    message: detail ? `${message}：${detail}` : message,
    recommendation: overrides.recommendation ?? def.recommendation,
    uncertain: overrides.uncertain ?? def.uncertain ?? false,
  };
}

/** Translate any step error into a stored, user-readable problem. Never echoes request bodies or secrets. */
export function translateAccountReclaimError(
  step: AccountReclaimStepKey, error: unknown,
): AccountReclaimProblem {
  const e = (error && typeof error === 'object' ? error : {}) as Record<string, any>;
  const code = typeof e.code === 'string' ? e.code : '';
  const name = typeof e.name === 'string' ? e.name : '';
  const writeStep = step !== 'aws_password';

  if (code === 'INTERNAL_ERROR') {
    const sub = typeof e.message === 'string' && MAILBOX_INTERNAL_SUBACTIONS.has(e.message) ? e.message : '';
    return problem('INTERNAL_ERROR', undefined, {
      message: sub
        ? `邮箱服务内部错误（${sub}）${step === 'mailbox_password' ? '，新密码已写入' : ''}`
        : '邮箱服务内部错误',
      recommendation: step === 'mailbox_password'
        ? '修复邮箱侧后经 TOTP 重试（使用同一密码，幂等）；在此之前不能认为邮箱已收回'
        : '修复邮箱侧后经 TOTP 重试；在此之前不能认为邮箱已收回',
      uncertain: false,
    });
  }
  if (code === 'RATE_LIMITED') {
    const waitMs = Number(e.retryAfterMs) || 0;
    const at = waitMs > 0 ? `，约 ${Math.ceil(waitMs / 1000)} 秒后可重试` : '';
    return problem('RATE_LIMITED', undefined, { message: `邮箱接口限流${at}` });
  }
  if (code === 'AccessDenied' || code === 'AccessDeniedException'
    || name === 'AccessDenied' || name === 'AccessDeniedException') {
    return problem('AccessDenied');
  }
  if (code && KNOWN_PROBLEMS[code]) {
    const detail = code === 'ROOT_MFA_PARTIAL_FAILURE' || code === 'ROOT_ENQUEUE_REJECTED'
      ? sanitizeAccountReclaimReason(e.message) : undefined;
    return problem(code, detail || undefined);
  }
  if (e.uncertain === true) return problem('MAILBOX_WRITE_UNKNOWN');

  // Requests that never got a server response leave external writes in an unknown state.
  const networkUnknown = name === 'TimeoutError' || name === 'AbortError'
    || UNCERTAIN_NETWORK_CODES.has(code) || UNCERTAIN_NETWORK_CODES.has(String(e.errno || ''));
  if (networkUnknown && writeStep) {
    return problem('UNEXPECTED_ERROR', undefined, {
      message: `${ACCOUNT_RECLAIM_STEP_LABELS[step]}请求超时或连接中断，结果未知`,
      recommendation: '经 TOTP 幂等重试；确认前后续步骤不会执行',
      uncertain: true,
    });
  }
  const detail = sanitizeAccountReclaimReason(e.message || (error instanceof Error ? '' : error));
  return problem('UNEXPECTED_ERROR', detail || undefined);
}

// === Root 任务结果归并（§8.1） ===

export type AccountReclaimRootResult = 'pending' | 'succeeded' | 'failed' | 'unknown';

type RootSnapshot = Pick<RootEmailJob, 'status' | 'autoSetPassword' | 'passwordSubmitAttempted'
  | 'credentialRetentionPolicy' | 'encryptedPassword'>;

function rootIsPending(root: RootSnapshot): boolean {
  return ['queued', 'running', 'waiting_mail', 'setting_password'].includes(root.status)
    || (root.status === 'link_ready' && root.autoSetPassword === true);
}

export function classifyAccountReclaimRootResult(root: RootSnapshot): AccountReclaimRootResult {
  if (rootIsPending(root)) return 'pending';
  if (root.status === 'password_set') {
    return root.credentialRetentionPolicy === 'permanent' && !!root.encryptedPassword ? 'succeeded' : 'unknown';
  }
  // Any terminal state after a possible password submission lacks evidence of the final password.
  if (root.passwordSubmitAttempted === true) return 'unknown';
  if (['failed', 'password_failed', 'mail_failed'].includes(root.status)) return 'failed';
  if (['cancelled', 'interrupted'].includes(root.status)) {
    return root.passwordSubmitAttempted === false ? 'failed' : 'unknown';
  }
  return 'unknown'; // password_unknown, email_sent, link_ready without auto-set
}

/** Map a settled Root job to the step-5 problem shown to the operator. */
export function describeAccountReclaimRootProblem(
  root: RootSnapshot & Pick<RootEmailJob, 'detail'>,
): AccountReclaimProblem {
  const detail = sanitizeAccountReclaimReason(root.detail);
  if (root.status === 'password_set') return problem('ROOT_CREDENTIAL_UNAVAILABLE');
  if (root.status === 'password_unknown' || root.passwordSubmitAttempted === true) {
    return {
      errorCode: 'ROOT_PASSWORD_UNKNOWN',
      message: `新密码可能已提交，但结果无法确认${detail ? `：${detail}` : ''}`,
      recommendation: ACCOUNT_RECLAIM_PASSWORD_UNKNOWN_ADVICE,
      uncertain: true,
    };
  }
  if (root.status === 'email_sent' || root.status === 'link_ready') return problem('ROOT_JOB_LINK_INVALID', detail);
  const kind = classifyAccountReclaimRootResult(root);
  return {
    errorCode: `ROOT_${root.status.toUpperCase()}`,
    message: `Root 改密未完成${detail ? `：${detail}` : ''}`,
    recommendation: kind === 'failed'
      ? '若页面显示可重试，等待冷却后用新的 TOTP 重试第 5 步；否则用根邮箱手工执行忘记密码'
      : ACCOUNT_RECLAIM_PASSWORD_UNKNOWN_ADVICE,
    uncertain: kind !== 'failed',
  };
}

// === 步骤与状态推导 ===

export function isAccountReclaimPending(job: Pick<AccountReclaimJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'running';
}

export function isAccountReclaimTerminal(status: AccountReclaimStatus): boolean {
  return status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled';
}

const stepDone = (step: AccountReclaimStep) => step.state === 'succeeded' || step.state === 'skipped';
const stepBlocked = (step: AccountReclaimStep) => step.state === 'failed' || step.state === 'unknown';

export function notRunMessage(blocking: AccountReclaimStepKey, state: 'failed' | 'unknown'): string {
  return `因第 ${accountReclaimStepNumber(blocking)} 步〔${ACCOUNT_RECLAIM_STEP_LABELS[blocking]}〕${state === 'failed' ? '失败' : '结果未知'}未执行`;
}

/** Record a failed/unknown step and mark every later step not_run with the blocking step named. */
export function blockAccountReclaimSteps(
  steps: AccountReclaimStep[], key: AccountReclaimStepKey, issue: AccountReclaimProblem, at: string,
): AccountReclaimStep[] {
  const index = ACCOUNT_RECLAIM_STEP_KEYS.indexOf(key);
  const state = issue.uncertain ? 'unknown' : 'failed';
  return steps.map((step, i) => {
    if (i === index) {
      return { ...step, state, message: issue.message, errorCode: issue.errorCode,
        recommendation: issue.recommendation, finishedAt: at };
    }
    if (i > index) {
      return { key: step.key, state: 'not_run', message: notRunMessage(key, state), attempts: step.attempts };
    }
    return step;
  });
}

/** Reset only the blocking step and the not_run steps after it; succeeded/skipped steps are kept. */
export function resetAccountReclaimStepsForRetry(steps: AccountReclaimStep[]): AccountReclaimStep[] {
  const index = steps.findIndex(stepBlocked);
  if (index < 0) return steps.map(step => ({ ...step }));
  return steps.map((step, i) => i < index ? { ...step }
    : { key: step.key, state: 'pending', message: '待重试', attempts: step.attempts });
}

/** The first step that still needs work, or null when every step is settled. */
export function nextAccountReclaimStep(steps: AccountReclaimStep[]): AccountReclaimStepKey | null {
  for (const step of steps) {
    if (stepDone(step)) continue;
    if (step.state === 'pending' || step.state === 'running') return step.key;
    return null;
  }
  return null;
}

/** Steps 1–4 blocked → failed; step 5 blocked → partial; all done → completed. */
export function deriveAccountReclaimStatus(steps: AccountReclaimStep[]): AccountReclaimStatus | null {
  const blockedAt = steps.findIndex(stepBlocked);
  if (blockedAt >= 0) return blockedAt < ACCOUNT_RECLAIM_STEP_KEYS.length - 1 ? 'failed' : 'partial';
  if (steps.length === ACCOUNT_RECLAIM_STEP_KEYS.length && steps.every(stepDone)) return 'completed';
  return null;
}

/** Batch status per §4.1: any unfinished → queued/running; otherwise derive from terminal mix. */
export function summarizeAccountReclaimBatchStatus(
  jobs: Array<Pick<AccountReclaimJob, 'status'>>,
): AccountReclaimStatus {
  if (!jobs.length) return 'cancelled';
  if (jobs.some(job => job.status === 'running')) return 'running';
  if (jobs.some(job => job.status === 'queued')) {
    return jobs.some(job => job.status !== 'queued') ? 'running' : 'queued';
  }
  if (jobs.every(job => job.status === 'completed')) return 'completed';
  if (jobs.every(job => job.status === 'cancelled')) return 'cancelled';
  if (jobs.every(job => job.status === 'failed')) return 'failed';
  return 'partial';
}
