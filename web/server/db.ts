/**
 * Simple JSON file-based store — no native dependencies needed
 */
import fs from 'fs';
import path from 'path';
import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, randomUUID } from 'crypto';
import { isRootResetAccess } from './root-reset-permissions';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/db.json');

// Encryption key for sensitive fields (MFA secrets) — independent from JWT.
// Root passwords use purpose-separated keys and retain previous keys for decryption after rotation.
const MAX_PREVIOUS_ENCRYPTION_KEYS = 8;
let appConfig: any = {};
try {
  appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
} catch { /* Environment-only deployments remain supported. */ }

const configuredEncryptionKey = appConfig.web?.encryptionKey;
const dedicatedEncryptionKeySource = typeof configuredEncryptionKey === 'string' && configuredEncryptionKey.length > 0
  ? configuredEncryptionKey
  : process.env.ENCRYPTION_KEY;
const encryptionKeyPreviousConfig = appConfig.web?.encryptionKeyPrevious;
const legacyFieldFallbackSource = typeof appConfig.web?.jwtSecret === 'string' && appConfig.web.jwtSecret.length > 0
  ? appConfig.web.jwtSecret
  : 'default-fallback-key-32chars-xxx';

export interface DerivedEncryptionKey {
  keyId: string;
  key: Buffer;
}

function validateEncryptionPurpose(purpose: string): void {
  if (!/^[a-z0-9-]{3,64}$/.test(purpose)) throw new Error('加密密钥用途无效');
}

function derivePurposeKey(source: string, purpose: string): Buffer {
  const baseKey = createHash('sha256').update(source).digest();
  return createHmac('sha256', baseKey).update(`awstool:${purpose}:v1`, 'utf8').digest();
}

/** Build and validate a current-first purpose-specific keyring without exposing source key material. */
export function deriveEncryptionKeyringFromSources(
  currentSource: unknown,
  previousSources: unknown,
  purpose: string,
): DerivedEncryptionKey[] {
  validateEncryptionPurpose(purpose);
  if (typeof currentSource !== 'string' || currentSource.length < 32 || currentSource.length > 4096) {
    throw new Error('Root 密码永久存储要求配置 32–4096 字符的 web.encryptionKey 或 ENCRYPTION_KEY');
  }
  if (previousSources !== undefined && !Array.isArray(previousSources)) {
    throw new Error('web.encryptionKeyPrevious 必须是字符串数组');
  }
  const previous = (previousSources || []) as unknown[];
  if (previous.length > MAX_PREVIOUS_ENCRYPTION_KEYS) {
    throw new Error(`web.encryptionKeyPrevious 最多允许 ${MAX_PREVIOUS_ENCRYPTION_KEYS} 个历史密钥`);
  }
  if (previous.some(source => typeof source !== 'string' || source.length < 32 || source.length > 4096)) {
    throw new Error('web.encryptionKeyPrevious 中每个历史密钥必须为 32–4096 字符');
  }
  const sources = [currentSource, ...previous] as string[];
  if (new Set(sources).size !== sources.length) throw new Error('当前与历史 encryptionKey 不得重复');

  const keys = sources.map(source => {
    const key = derivePurposeKey(source, purpose);
    return { keyId: createHash('sha256').update(key).digest('hex').slice(0, 16), key };
  });
  if (new Set(keys.map(item => item.keyId)).size !== keys.length) throw new Error('encryptionKey key ID 冲突');
  return keys;
}

/** Return the current-first purpose-specific keyring. Previous keys are decrypt-only. */
export function deriveEncryptionKeyring(purpose: string): DerivedEncryptionKey[] {
  return deriveEncryptionKeyringFromSources(dedicatedEncryptionKeySource, encryptionKeyPreviousConfig, purpose);
}

/** Derive the current purpose-specific key while preserving the pre-keyring API. */
export function deriveEncryptionKey(purpose: string): Buffer {
  return deriveEncryptionKeyring(purpose)[0].key;
}

export type EncryptedFieldKind = 'mfa' | 'external-id';

function validateDecryptedField(value: string, kind: EncryptedFieldKind): boolean {
  if (kind === 'mfa') return value.length >= 16 && value.length <= 128 && /^[A-Z2-7]+={0,6}$/i.test(value);
  return value.length >= 2 && value.length <= 1224 && /^[A-Za-z0-9_+=,.@:/-]+$/.test(value);
}

function encryptedFieldKeys(kind: EncryptedFieldKind): DerivedEncryptionKey[] {
  // JWT/default values are legacy CBC read candidates only; authenticated writes always require a dedicated current key.
  return deriveEncryptionKeyringFromSources(dedicatedEncryptionKeySource, encryptionKeyPreviousConfig, `field-${kind}`);
}

/** Return whether a typed field is already authenticated with the current write key. */
export function encryptedFieldUsesCurrentKey(data: string, kind: EncryptedFieldKind): boolean {
  const parts = data.split(':');
  return parts.length === 6 && parts[0] === 'gcmf1' && parts[1] === encryptedFieldKeys(kind)[0].keyId
    && parts[2] === kind;
}

/** Encrypt a typed sensitive field with key-ID authenticated AES-256-GCM. */
export function encryptField(text: string, kind: EncryptedFieldKind): string {
  if (!validateDecryptedField(text, kind)) throw new Error('敏感字段明文格式无效');
  const current = encryptedFieldKeys(kind)[0];
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.key, iv);
  cipher.setAAD(Buffer.from(`awstool:field:v1:${kind}:${current.keyId}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['gcmf1', current.keyId, kind, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url')].join(':');
}

/** Decrypt a legacy CBC field only when one candidate yields valid typed plaintext. */
export function decryptLegacyFieldWithKeys(
  data: string,
  kind: EncryptedFieldKind,
  candidateKeys: readonly Buffer[],
): string {
  const [ivHex, encrypted, extra] = data.split(':');
  if (!candidateKeys.length || candidateKeys.some(key => key.length !== 32)
    || !/^[0-9a-f]{32}$/i.test(ivHex) || !encrypted || !/^[0-9a-f]+$/i.test(encrypted)
    || encrypted.length % 32 !== 0 || extra !== undefined) throw new Error('旧版敏感字段密文格式无效');
  for (const key of candidateKeys) {
    try {
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString('utf8');
      if (validateDecryptedField(plaintext, kind)) return plaintext;
    } catch { /* Wrong legacy keys are rejected by padding and strict typed plaintext validation. */ }
  }
  throw new Error('旧版敏感字段无法使用当前密钥环解密');
}

/** Authenticate the current field format, or strictly validate legacy CBC plaintext before accepting a rotation key. */
export function decryptField(data: string, kind: EncryptedFieldKind): string {
  if (!data.includes(':')) {
    if (!validateDecryptedField(data, kind)) throw new Error('敏感字段明文格式无效');
    return data; // Plaintext migration compatibility.
  }
  const parts = data.split(':');
  if (parts[0] === 'gcmf1') {
    const [format, keyId, storedKind, ivValue, tagValue, ciphertextValue, extra] = parts;
    if (format !== 'gcmf1' || !/^[0-9a-f]{16}$/.test(keyId) || storedKind !== kind
      || !ivValue || !tagValue || !ciphertextValue || extra !== undefined) throw new Error('敏感字段密文格式无效');
    const selected = encryptedFieldKeys(kind).find(item => item.keyId === keyId);
    if (!selected) throw new Error('敏感字段密文引用未配置的 key ID');
    const iv = Buffer.from(ivValue, 'base64url');
    const tag = Buffer.from(tagValue, 'base64url');
    const ciphertext = Buffer.from(ciphertextValue, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error('敏感字段密文参数无效');
    try {
      const decipher = createDecipheriv('aes-256-gcm', selected.key, iv);
      decipher.setAAD(Buffer.from(`awstool:field:v1:${kind}:${keyId}`, 'utf8'));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      if (!validateDecryptedField(plaintext, kind)) throw new Error('invalid plaintext');
      return plaintext;
    } catch { throw new Error('敏感字段密文认证失败'); }
  }

  const previousSources = Array.isArray(encryptionKeyPreviousConfig) ? encryptionKeyPreviousConfig as unknown[] : [];
  // Validate a dedicated current write key before migrating any unauthenticated legacy record.
  deriveEncryptionKeyringFromSources(dedicatedEncryptionKeySource, previousSources, `field-${kind}`);
  const sources = [...new Set([
    dedicatedEncryptionKeySource as string,
    ...previousSources as string[],
    legacyFieldFallbackSource,
  ])];
  return decryptLegacyFieldWithKeys(data, kind,
    sources.map(source => createHash('sha256').update(source).digest()));
}

export type TagOnboardingStatus = 'queued' | 'running' | 'waiting_retry' | 'completed' | 'failed';
export type TagOnboardingPhase =
  | 'provision_org'
  | 'wait_management_index'
  | 'deploy_re_indexes'
  | 'wait_stacksets'
  | 'upsert_org_config'
  | 'verify'
  | 'done';
export type TagOnboardingStepStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed';

export interface TagOnboardingStep {
  key: TagOnboardingPhase;
  label: string;
  status: TagOnboardingStepStatus;
  detail?: string;
  updatedAt?: string;
}

export interface TagOnboardingFailure {
  code: string;
  phase: TagOnboardingPhase;
  reason: string;
  resolutionSteps: string[];
  automaticRetry: boolean;
  manualRetryAllowed: boolean;
  awsMessage?: string;
  affectedRegions?: string[];
  affectedAccountsByRegion?: Record<string, string[]>;
}

export interface TagOnboardingJob {
  id: string;
  payerAccountId: string;
  tagValue: string;
  /**
   * 额外自定义标签（可选）。MAP 主标签 map-migrated 之外，
   * 每个组织可再打一组自定义 kv，用于成本归集等场景。
   */
  extraTagKey?: string;
  extraTagValue?: string;
  status: TagOnboardingStatus;
  phase: TagOnboardingPhase;
  progress: number;
  steps: TagOnboardingStep[];
  artifacts: {
    orgId?: string;
    rootOuId?: string;
    searchRoleArn?: string;
    viewArn?: string;
    aggregatorRegion?: string;
    localRegions?: string[];
    memberEnabledRegions?: Record<string, string[]>;
  };
  attempts: Partial<Record<TagOnboardingPhase, number>>;
  phaseStartedAt: string;
  nextRunAt?: string;
  lastError?: string;
  failure?: TagOnboardingFailure;
  requestedBy?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type BillingExportJobStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'expired';
export type BillingExportJobPhase = 'preflight' | 'capturing' | 'packaging' | 'ready';

export interface BillingExportTask {
  accountId: string;
  accountName?: string;
  year: number;
  month: number;
}

export interface BillingExportResult extends BillingExportTask {
  filename: string;
  ok: boolean;
  error?: string;
  pages?: number;
}

export interface BillingExportJob {
  id: string;
  createdBy: string;
  createdByUserId?: string;
  status: BillingExportJobStatus;
  phase: BillingExportJobPhase;
  tasks: BillingExportTask[];
  total: number;
  done: number;
  ok: number;
  failed: number;
  effectiveConcurrency: number;
  results: BillingExportResult[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  expiresAt?: string;
  downloadFilename?: string;
  fileSize?: number;
  error?: string;
}

export type PocCalculatorStatus = 'reserved' | 'calculator_ready' | 'application_created' | 'failed';

export interface PocCalculatorLedgerEntry {
  id: string;
  source: 'generated' | 'manual';
  status: PocCalculatorStatus;
  attempt: number;
  seed: string | null;
  opportunityId: string;
  awsAccountId: string;
  activityName: string;
  region: string;
  mrrUsd: number;
  target: number | null;
  total: number | null;
  signature: string | null;
  calculatorKey: string | null;
  calculatorUrl: string | null;
  applicationId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

interface DBSchema {
  users: any[];
  quota_requests: any[];
  audit_log: any[];
  region_data: any[];
  accounts_cache: any[];
  accounts_cache_time: string;
  tag_onboarding_jobs: TagOnboardingJob[];
  billing_export_jobs: BillingExportJob[];
  poc_calculator_ledger: PocCalculatorLedgerEntry[];
  [key: string]: any;
}

const ARRAY_FIELDS = [
  'users', 'quota_requests', 'audit_log', 'region_data', 'accounts_cache', 'tag_onboarding_jobs',
  'billing_export_jobs', 'poc_calculator_ledger',
] as const;

// In-memory cache to avoid reading file on every request
let cache: DBSchema | null = null;
let cacheTime = 0;

function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function emptyDB(): DBSchema {
  return {
    users: [], quota_requests: [], audit_log: [], region_data: [], accounts_cache: [],
    accounts_cache_time: '', tag_onboarding_jobs: [], billing_export_jobs: [], poc_calculator_ledger: [],
  };
}

function normalizeDB(parsed: unknown): DBSchema {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('数据库根节点必须是 JSON 对象');
  }
  const data = parsed as DBSchema;
  for (const field of ARRAY_FIELDS) {
    if (data[field] === undefined) data[field] = [];
    if (!Array.isArray(data[field])) throw new Error(`数据库字段 ${field} 必须是数组`);
  }
  if (data.accounts_cache_time === undefined) data.accounts_cache_time = '';
  if (typeof data.accounts_cache_time !== 'string') throw new Error('数据库字段 accounts_cache_time 必须是字符串');
  return data;
}

function readDB(): DBSchema {
  maybeBackup();
  // Return cache if written within last 5 seconds (same process)
  if (cache && Date.now() - cacheTime < 5000) return cache;

  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    if (process.env.ALLOW_DB_INITIALIZATION !== 'true') {
      throw new Error(`数据库文件不存在，已拒绝自动创建空库: ${DB_PATH}；首次安装请显式设置 ALLOW_DB_INITIALIZATION=true`);
    }
    cache = emptyDB();
    cacheTime = Date.now();
    return cache;
  }
  try {
    cache = normalizeDB(JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')));
    cacheTime = Date.now();
    return cache;
  } catch (error: any) {
    cache = null;
    cacheTime = 0;
    const message = error instanceof SyntaxError ? `JSON 解析失败: ${error.message}` : error.message;
    console.error(`[DB] ${DB_PATH} 无法读取，已停止写入以保护现有数据: ${message}`);
    throw new Error(`数据库文件损坏或格式异常，已拒绝继续操作: ${message}`);
  }
}

function writeDB(data: DBSchema) {
  ensureDir();
  const serialized = JSON.stringify(data, null, 2);
  const tempPath = `${DB_PATH}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, serialized, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, DB_PATH);
    // rename 的原子性只保证不会出现半截 JSON；目录 fsync 进一步保证断电后目录项落盘。
    try {
      const dirFd = fs.openSync(path.dirname(DB_PATH), 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (error: any) {
      console.warn(`[DB] 目录 fsync 不可用，已降级为原子 rename: ${error.message}`);
    }
    cache = data;
    cacheTime = Date.now();
  } catch (error) {
    try { if (fd !== null) fs.closeSync(fd); } catch { /* 保留原始错误 */ }
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* 保留原始错误 */ }
    throw error;
  }
}

function cloneJob(job: TagOnboardingJob): TagOnboardingJob {
  return JSON.parse(JSON.stringify(job));
}

export class TagOnboardingConflictError extends Error {
  code = 'TAG_ONBOARDING_CONFLICT';
  constructor(public readonly activeJob: TagOnboardingJob) {
    super(`payer ${activeJob.payerAccountId} 已有使用其它 tag_value 的接入任务`);
  }
}

export function createOrReuseTagOnboardingJob(input: {
  payerAccountId: string;
  tagValue: string;
  extraTagKey?: string;
  extraTagValue?: string;
  steps: TagOnboardingStep[];
  requestedBy?: string;
}): { job: TagOnboardingJob; reused: boolean } {
  const data = readDB();
  const active = data.tag_onboarding_jobs.find(job =>
    job.payerAccountId === input.payerAccountId
    && ['queued', 'running', 'waiting_retry'].includes(job.status));
  if (active) {
    // 标签参数不一致就是另一次意图，必须冲突而不是复用 —— 复用会让
    // 用户新填的额外标签被静默丢弃，任务跑完却是旧配置。
    const sameTag = active.tagValue === input.tagValue
      && (active.extraTagKey || '') === (input.extraTagKey || '')
      && (active.extraTagValue || '') === (input.extraTagValue || '');
    if (!sameTag) throw new TagOnboardingConflictError(cloneJob(active));
    return { job: cloneJob(active), reused: true };
  }

  // 只复用仍在执行的任务。已完成记录仅用于审计；再次提交会新建任务并重新验证环境漂移。
  const now = new Date().toISOString();
  const job: TagOnboardingJob = {
    id: randomUUID(),
    payerAccountId: input.payerAccountId,
    tagValue: input.tagValue,
    extraTagKey: input.extraTagKey,
    extraTagValue: input.extraTagValue,
    status: 'queued',
    phase: 'provision_org',
    progress: 0,
    steps: input.steps,
    artifacts: {},
    attempts: {},
    phaseStartedAt: now,
    nextRunAt: now,
    requestedBy: input.requestedBy,
    createdAt: now,
    updatedAt: now,
  };
  data.tag_onboarding_jobs.push(job);
  // 避免任务历史无限增长；每个 payer 保留的最近记录已足够审计与排障。
  if (data.tag_onboarding_jobs.length > 500) {
    data.tag_onboarding_jobs = data.tag_onboarding_jobs
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-500);
  }
  writeDB(data);
  return { job: cloneJob(job), reused: false };
}

export function getTagOnboardingJob(jobId: string): TagOnboardingJob | null {
  const job = readDB().tag_onboarding_jobs.find(item => item.id === jobId);
  return job ? cloneJob(job) : null;
}

export function getLatestTagOnboardingJob(payerAccountId: string): TagOnboardingJob | null {
  const job = [...readDB().tag_onboarding_jobs]
    .filter(item => item.payerAccountId === payerAccountId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return job ? cloneJob(job) : null;
}

export function listActiveTagOnboardingJobs(): TagOnboardingJob[] {
  return readDB().tag_onboarding_jobs
    .filter(job => ['queued', 'running', 'waiting_retry'].includes(job.status))
    .map(cloneJob);
}

export function updateTagOnboardingJob(jobId: string, updates: Partial<TagOnboardingJob>): TagOnboardingJob {
  const data = readDB();
  const job = data.tag_onboarding_jobs.find(item => item.id === jobId);
  if (!job) throw new Error(`MAP 接入任务不存在: ${jobId}`);
  const artifacts = updates.artifacts ? { ...job.artifacts, ...updates.artifacts } : job.artifacts;
  Object.assign(job, updates, { artifacts, id: job.id, payerAccountId: job.payerAccountId, updatedAt: new Date().toISOString() });
  writeDB(data);
  return cloneJob(job);
}

export function retryTagOnboardingJob(jobId: string): TagOnboardingJob {
  const current = getTagOnboardingJob(jobId);
  if (!current) throw new Error('MAP 接入任务不存在');
  if (!['failed', 'waiting_retry'].includes(current.status)) {
    throw new Error('只有失败或等待自动重试的 MAP 接入任务可以重试');
  }
  const now = new Date().toISOString();
  const steps = current.steps.map(step => step.key === current.phase
    ? { ...step, status: 'pending' as const, detail: '已请求重试', updatedAt: now }
    : step);
  return updateTagOnboardingJob(jobId, {
    status: 'queued', steps, lastError: undefined, failure: undefined, nextRunAt: now,
    phaseStartedAt: now,
    attempts: { ...current.attempts, [current.phase]: 0 },
  });
}

export function recoverTagOnboardingJobs(): number {
  const data = readDB();
  let recovered = 0;
  const now = new Date().toISOString();
  for (const job of data.tag_onboarding_jobs) {
    if (job.status !== 'running') continue;
    job.status = 'queued';
    job.nextRunAt = now;
    job.updatedAt = now;
    job.steps = job.steps.map(step => step.key === job.phase && step.status === 'running'
      ? { ...step, status: 'pending', detail: '服务重启后自动恢复', updatedAt: now }
      : step);
    recovered++;
  }
  if (recovered > 0) writeDB(data);
  return recovered;
}

function cloneBillingExportJob(job: BillingExportJob): BillingExportJob {
  return JSON.parse(JSON.stringify(job));
}

const BILLING_EXPORT_ACTIVE_STATUSES = new Set<BillingExportJobStatus>(['queued', 'running', 'cancelling']);
const configuredBillingExportQueueLimit = Number(process.env.BILLING_EXPORT_MAX_QUEUED_JOBS || 10);
const BILLING_EXPORT_MAX_QUEUED_JOBS = Number.isFinite(configuredBillingExportQueueLimit)
  ? Math.max(1, Math.min(100, Math.floor(configuredBillingExportQueueLimit)))
  : 10;

export class BillingExportQueueConflictError extends Error {
  code: 'BILLING_EXPORT_OWNER_ACTIVE' | 'BILLING_EXPORT_QUEUE_FULL';
  activeJobId?: string;

  constructor(code: 'BILLING_EXPORT_OWNER_ACTIVE' | 'BILLING_EXPORT_QUEUE_FULL', activeJobId?: string) {
    super(code === 'BILLING_EXPORT_OWNER_ACTIVE'
      ? '你已有正在排队或执行的账单导出任务，请等待完成或先取消'
      : `账单导出队列已满（最多 ${BILLING_EXPORT_MAX_QUEUED_JOBS} 个排队任务），请稍后重试`);
    this.name = 'BillingExportQueueConflictError';
    this.code = code;
    this.activeJobId = activeJobId;
  }
}

export function createBillingExportJob(input: {
  createdBy: string;
  createdByUserId: string;
  tasks: BillingExportTask[];
  effectiveConcurrency: number;
}): BillingExportJob {
  const data = readDB();
  const createdByUserId = input.createdByUserId.trim();
  if (!createdByUserId) throw new Error('创建账单导出任务时缺少稳定用户 ID');

  // 校验和写入之间没有 await，确保同一 Node 进程内并发提交不会越过队列上限。
  const ownerActiveJob = data.billing_export_jobs.find(item => {
    if (!BILLING_EXPORT_ACTIVE_STATUSES.has(item.status)) return false;
    return item.createdByUserId != null
      ? item.createdByUserId === createdByUserId
      : item.createdBy === input.createdBy;
  });
  if (ownerActiveJob) {
    throw new BillingExportQueueConflictError('BILLING_EXPORT_OWNER_ACTIVE', ownerActiveJob.id);
  }
  const queuedCount = data.billing_export_jobs.filter(item => item.status === 'queued').length;
  if (queuedCount >= BILLING_EXPORT_MAX_QUEUED_JOBS) {
    throw new BillingExportQueueConflictError('BILLING_EXPORT_QUEUE_FULL');
  }

  const now = new Date().toISOString();
  const job: BillingExportJob = {
    id: randomUUID(),
    createdBy: input.createdBy,
    createdByUserId,
    status: 'queued',
    phase: 'preflight',
    tasks: input.tasks,
    total: input.tasks.length,
    done: 0,
    ok: 0,
    failed: 0,
    effectiveConcurrency: input.effectiveConcurrency,
    results: [],
    createdAt: now,
    updatedAt: now,
  };
  data.billing_export_jobs.push(job);
  // 账单导出是长期可追溯记录：任务元数据不做隐式裁剪，避免记录与服务器 ZIP 失去关联。
  writeDB(data);
  return cloneBillingExportJob(job);
}

export function getBillingExportJob(jobId: string): BillingExportJob | null {
  const job = readDB().billing_export_jobs.find(item => item.id === jobId);
  return job ? cloneBillingExportJob(job) : null;
}

export function listBillingExportJobs(): BillingExportJob[] {
  return readDB().billing_export_jobs.map(cloneBillingExportJob);
}

export type BillingExportJobListScope = 'mine' | 'all';

export interface BillingExportJobPage {
  jobs: BillingExportJob[];
  total: number;
  offset: number;
  limit: number;
}

export function listBillingExportJobsForUser(
  username: string,
  userId: string,
  isAdmin: boolean,
  scope: BillingExportJobListScope = 'mine',
  offset = 0,
  limit = 20,
): BillingExportJobPage {
  const listAll = isAdmin && scope === 'all';
  const filtered = readDB().billing_export_jobs
    .filter(job => listAll
      || (job.createdByUserId != null ? job.createdByUserId === userId : job.createdBy === username))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const safeOffset = Math.max(0, Math.floor(offset) || 0);
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 20));
  return {
    jobs: filtered.slice(safeOffset, safeOffset + safeLimit).map(cloneBillingExportJob),
    total: filtered.length,
    offset: safeOffset,
    limit: safeLimit,
  };
}

export function listQueuedBillingExportJobs(): BillingExportJob[] {
  return readDB().billing_export_jobs
    .filter(job => job.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(cloneBillingExportJob);
}

export function updateBillingExportJob(jobId: string, updates: Partial<BillingExportJob>): BillingExportJob {
  const data = readDB();
  const job = data.billing_export_jobs.find(item => item.id === jobId);
  if (!job) throw new Error(`账单导出任务不存在: ${jobId}`);
  const immutable = {
    id: job.id,
    createdBy: job.createdBy,
    createdByUserId: job.createdByUserId,
    tasks: job.tasks,
    createdAt: job.createdAt,
  };
  Object.assign(job, updates, immutable, { updatedAt: new Date().toISOString() });
  writeDB(data);
  return cloneBillingExportJob(job);
}

export function recoverBillingExportJobs(): number {
  const data = readDB();
  let interrupted = 0;
  const now = new Date().toISOString();
  for (const job of data.billing_export_jobs) {
    if (!['running', 'cancelling'].includes(job.status)) continue;
    job.status = 'interrupted';
    job.finishedAt = now;
    job.updatedAt = now;
    job.error = '服务重启中断了正在执行的导出，请重新提交';
    interrupted++;
  }
  if (interrupted > 0) writeDB(data);
  return interrupted;
}

export interface PocCalculatorReserveInput {
  opportunityId: string;
  awsAccountId: string;
  activityName: string;
  region: string;
  mrrUsd: number;
  createdBy: string;
}

export interface PocCalculatorCandidate {
  target: number;
  total: number;
  signature: string;
}

/** Generate, compare against every priced ledger entry, and reserve synchronously. */
export function reservePocCalculator<T extends PocCalculatorCandidate>(
  input: PocCalculatorReserveInput,
  generate: (seed: string) => T,
  maxAttempts = 20,
): { entry: PocCalculatorLedgerEntry; result: T } {
  const data = readDB();
  const id = randomUUID();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const seed = `${id}#${attempt}`;
    const result = generate(seed);
    const duplicate = data.poc_calculator_ledger.some(entry => entry.total !== null && entry.signature !== null
      && (Math.round(entry.total * 100) === Math.round(result.total * 100)
        || entry.signature === result.signature));
    if (duplicate) continue;

    const now = new Date().toISOString();
    const entry: PocCalculatorLedgerEntry = {
      id, source: 'generated', status: 'reserved', attempt, seed,
      opportunityId: input.opportunityId, awsAccountId: input.awsAccountId,
      activityName: input.activityName, region: input.region, mrrUsd: input.mrrUsd,
      target: result.target, total: result.total, signature: result.signature,
      calculatorKey: null, calculatorUrl: null, applicationId: null,
      createdBy: input.createdBy, createdAt: now, updatedAt: now, error: null,
    };
    data.poc_calculator_ledger.push(entry);
    writeDB(data);
    return { entry: { ...entry }, result };
  }
  throw new Error(`连续 ${maxAttempts} 次生成的计算器都与已有记录重复，请重试`);
}

function updatePocCalculatorEntry(
  id: string,
  updates: Partial<PocCalculatorLedgerEntry>,
): PocCalculatorLedgerEntry {
  const data = readDB();
  const entry = data.poc_calculator_ledger.find(item => item.id === id);
  if (!entry) throw new Error('计算器台账记录不存在');
  Object.assign(entry, updates, { updatedAt: new Date().toISOString() });
  writeDB(data);
  return { ...entry };
}

/** Record the calculator.aws key and URL after successful verification. */
export function markPocCalculatorReady(
  id: string,
  r: { calculatorKey: string; calculatorUrl: string },
): PocCalculatorLedgerEntry {
  return updatePocCalculatorEntry(id, { status: 'calculator_ready', ...r });
}

/** Link the successfully created benefit application to its ledger entry. */
export function markPocCalculatorApplication(id: string, applicationId: string): PocCalculatorLedgerEntry {
  return updatePocCalculatorEntry(id, { status: 'application_created', applicationId });
}

/** Retain a failed entry and its uniqueness fields for subsequent comparisons. */
export function markPocCalculatorFailed(id: string, error: string): PocCalculatorLedgerEntry {
  return updatePocCalculatorEntry(id, { status: 'failed', error: error.slice(0, 500) });
}

/** Track a user-supplied calculator URL without generation or uniqueness checks. */
export function recordManualPocCalculator(
  input: PocCalculatorReserveInput & { calculatorUrl: string },
): PocCalculatorLedgerEntry {
  const data = readDB();
  const now = new Date().toISOString();
  const entry: PocCalculatorLedgerEntry = {
    id: randomUUID(), source: 'manual', status: 'calculator_ready', attempt: 0, seed: null,
    opportunityId: input.opportunityId, awsAccountId: input.awsAccountId,
    activityName: input.activityName, region: input.region, mrrUsd: input.mrrUsd,
    target: null, total: null, signature: null, calculatorKey: null,
    calculatorUrl: input.calculatorUrl, applicationId: null,
    createdBy: input.createdBy, createdAt: now, updatedAt: now, error: null,
  };
  data.poc_calculator_ledger.push(entry);
  writeDB(data);
  return { ...entry };
}

/** List every ledger entry, including failed and manually supplied calculators. */
export function listPocCalculatorEntries(): PocCalculatorLedgerEntry[] {
  return readDB().poc_calculator_ledger.map(entry => ({ ...entry }));
}

// === Auto-backup: keep validated daily rotating copies of both permanent stores ===
const BACKUP_RETENTION_DAYS = 7;
let lastBackupDay = '';

export class PermanentStoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentStoreIntegrityError';
  }
}

function backupFilename(prefix: string, day: string): string {
  return `${prefix}-${day}.json`;
}

function prepareJsonBackupSource(filename: string, permanentRootStore: boolean): Buffer {
  const content = fs.readFileSync(filename);
  if (!content.length) throw new Error(`${path.basename(filename)} 为空，已拒绝覆盖有效备份`);
  const parsed = JSON.parse(content.toString('utf8'));
  if (!permanentRootStore) return content;
  if (!Array.isArray(parsed)) throw new Error('root-email-jobs.json 必须是任务数组');
  const sanitized = parsed.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('root-email-jobs.json 包含无效任务');
    const job = value as Record<string, unknown>;
    if (job.encryptedPassword === undefined) return job;
    const legacyDisclosed = job.credentialRetentionPolicy !== 'permanent'
      && Boolean(job.credentialDownloadedAt || job.credentialDownloadClaimId
        || job.credentialOwnerDownloadedAt || job.credentialAdminDownloadedAt
        || job.credentialOwnerDownloadClaim || job.credentialAdminDownloadClaim);
    if (job.status === 'password_set' && !legacyDisclosed) {
      return { ...job, credentialRetentionPolicy: 'permanent' };
    }
    // Pre-submit passwords and previously consumed legacy credentials must never enter durable backups.
    const safe = { ...job };
    delete safe.encryptedPassword;
    delete safe.credentialRetentionPolicy;
    return safe;
  });
  return Buffer.from(JSON.stringify(sanitized), 'utf8');
}

function createInitialRootStore(filename: string): void {
  const temporary = `${filename}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, '[]', 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, filename); }
  finally { try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve creation result. */ } }
}

/** Back up db.json and its sibling Root credential store after validating both source files. */
export function backupJsonStores(dbPath: string, now = new Date()): string[] {
  if (!fs.existsSync(dbPath)) return [];
  const parent = path.dirname(dbPath);
  const backupDir = path.join(parent, 'backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(backupDir, 0o700); } catch { /* Best effort on filesystems without POSIX modes. */ }

  const day = now.toISOString().slice(0, 10);
  const rootStorePath = path.join(parent, 'root-email-jobs.json');
  if (!fs.existsSync(rootStorePath)) {
    const priorRootBackups = fs.readdirSync(backupDir).some(file => /^root-email-jobs-\d{4}-\d{2}-\d{2}\.json$/.test(file));
    if (priorRootBackups) throw new PermanentStoreIntegrityError(
      'root-email-jobs.json 缺失但存在历史备份，已拒绝创建空库并停止启动',
    );
    createInitialRootStore(rootStorePath);
  }
  const candidates = [
    { source: dbPath, prefix: 'db', permanentRootStore: false },
    { source: rootStorePath, prefix: 'root-email-jobs', permanentRootStore: true },
  ];
  const staged: Array<{ temporary: string; destination: string }> = [];
  const destinations: string[] = [];
  try {
    for (const item of candidates) {
      const destination = path.join(backupDir, backupFilename(item.prefix, day));
      destinations.push(destination);
      if (fs.existsSync(destination)) {
        // A same-day restart must never replace an earlier recovery point before ciphertext authentication completes.
        prepareJsonBackupSource(destination, item.permanentRootStore);
        continue;
      }
      const content = prepareJsonBackupSource(item.source, item.permanentRootStore);
      const temporary = `${destination}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      staged.push({ temporary, destination });
    }
    for (const item of staged) fs.renameSync(item.temporary, item.destination);
    try {
      const dirFd = fs.openSync(backupDir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (error: any) {
      console.warn(`[DB Backup] 目录 fsync 不可用: ${error.message}`);
    }
  } catch (error) {
    for (const item of staged) {
      try { fs.rmSync(item.temporary, { force: true }); } catch { /* Preserve the original backup error. */ }
    }
    throw error;
  }

  for (const prefix of ['db', 'root-email-jobs']) {
    const pattern = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.json$`);
    const files = fs.readdirSync(backupDir).filter(file => pattern.test(file)).sort();
    while (files.length > BACKUP_RETENTION_DAYS) {
      const old = files.shift();
      if (old) fs.unlinkSync(path.join(backupDir, old));
    }
  }
  return destinations;
}

export function backupDB(now = new Date()) {
  try {
    const backedUp = backupJsonStores(DB_PATH, now);
    if (backedUp.length === 2) lastBackupDay = now.toISOString().slice(0, 10);
  } catch (error: any) {
    console.error('[DB Backup] failed:', error.message);
    if (error instanceof PermanentStoreIntegrityError) throw error;
  }
}

// Long-running processes create a new pair on the first DB read of each UTC day.
export function maybeBackup() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastBackupDay) backupDB();
}

// === Query helpers (simple) ===

export const db = {
  getUser(username: string) {
    const data = readDB();
    return data.users.find(u => u.username === username) || null;
  },

  createUser(user: any) {
    const data = readDB();
    user.id = Date.now();
    user.created_at = new Date().toISOString();
    data.users.push(user);
    writeDB(data);
    return user;
  },

  updateUser(id: number, updates: any) {
    const data = readDB();
    const idx = data.users.findIndex(u => u.id === id);
    if (idx >= 0) { Object.assign(data.users[idx], updates); writeDB(data); }
  },

  // Quota requests — sorted by created_at descending (newest first)
  getQuotaRequests() {
    return readDB().quota_requests.sort((a, b) => {
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });
  },

  upsertQuotaRequest(record: any) {
    const data = readDB();
    const idx = data.quota_requests.findIndex(r => r.id === record.id);
    if (idx >= 0) {
      // Update fields but don't overwrite current_value with null
      const existing = data.quota_requests[idx];
      for (const [key, value] of Object.entries(record)) {
        if (key === 'current_value' && (value === null || value === undefined)) continue; // Don't overwrite with null
        (existing as any)[key] = value;
      }
      existing.updated_at = new Date().toISOString();
    } else {
      record.created_at = record.created_at || new Date().toISOString();
      record.updated_at = new Date().toISOString();
      data.quota_requests.push(record);
    }
    writeDB(data);
  },

  // Audit log
  addAuditLog(
    userId: number | null,
    action: string,
    detail: string,
    username?: string,
    ip?: string,
    extras?: { method?: string; path?: string; status?: number; duration_ms?: number; params?: any },
  ) {
    const data = readDB();
    const cleanIp = ip ? ip.replace('::ffff:', '') : null;
    const lastAuditId = data.audit_log.reduce(
      (max, log) => Math.max(max, Number(log.id) || 0),
      0,
    );
    const auditId = Math.max(Date.now(), lastAuditId + 1);
    const entry: any = {
      id: auditId,
      user_id: userId,
      username: username || null,
      action,
      detail,
      ip: cleanIp,
      created_at: new Date().toISOString(),
    };
    if (extras) {
      if (extras.method !== undefined) entry.method = extras.method;
      if (extras.path !== undefined) entry.path = extras.path;
      if (extras.status !== undefined) entry.status = extras.status;
      if (extras.duration_ms !== undefined) entry.duration_ms = extras.duration_ms;
      if (extras.params !== undefined) entry.params = extras.params;
    }
    data.audit_log.push(entry);
    if (data.audit_log.length > 5000) data.audit_log = data.audit_log.slice(-5000);
    writeDB(data);
    // 2026-09-15：移除敏感操作实时飞书推送（原 onAuditAction 钩子）。
    // 审计写入本身不受影响，所有动作仍完整落库，追溯请查审计页。
  },

  getAuditLog(limit = 100) {
    const data = readDB();
    const logs = data.audit_log.slice(-limit).reverse();
    // Resolve usernames
    return logs.map(log => {
      if (!log.username && log.user_id) {
        const user = data.users.find(u => u.id === log.user_id);
        log.username = user?.username || 'unknown';
      }
      return log;
    });
  },

  // User management
  getAllUsers() {
    return readDB().users.map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      mfa_enabled: u.mfa_enabled,
      allowed_pages: (u as any).allowed_pages ?? null,
      root_access: (u as any).root_access === true,
      bulk_quota_access: (u as any).bulk_quota_access === true,
      root_reset_access: isRootResetAccess((u as any).root_reset_access) ? (u as any).root_reset_access : 'none',
      created_at: u.created_at,
    }));
  },

  deleteUser(id: number) {
    const data = readDB();
    data.users = data.users.filter(u => u.id !== id);
    writeDB(data);
  },

  // Accounts cache — for instant loading
  getAccountsCache() {
    const data = readDB();
    return { accounts: data.accounts_cache || [], cachedAt: data.accounts_cache_time || '' };
  },

  setAccountsCache(accounts: any[]) {
    const data = readDB();
    data.accounts_cache = accounts;
    data.accounts_cache_time = new Date().toISOString();
    writeDB(data);
  },

  // Region data
  getRegionData() {
    const data = readDB();
    return data.region_data || [];
  },

  // 敏感权限客户账户 —— 已收窄平台权限并启用 ExternalId 的账户
  getRestrictedAccounts(): any[] {
    const data = readDB() as any;
    return data.restricted_accounts || [];
  },

  upsertRestrictedAccounts(records: any[]) {
    if (!records?.length) return;
    const data = readDB() as any;
    if (!data.restricted_accounts) data.restricted_accounts = [];
    const idx = new Map<string, number>();
    data.restricted_accounts.forEach((r: any, i: number) => idx.set(r.account_id, i));
    for (const rec of records) {
      const i = idx.get(rec.account_id);
      if (i !== undefined) data.restricted_accounts[i] = { ...data.restricted_accounts[i], ...rec };
      else {
        idx.set(rec.account_id, data.restricted_accounts.length);
        data.restricted_accounts.push(rec);
      }
    }
    writeDB(data);
  },

  deleteRestrictedAccount(accountId: string) {
    const data = readDB() as any;
    if (!data.restricted_accounts) return;
    data.restricted_accounts = data.restricted_accounts.filter((r: any) => r.account_id !== accountId);
    writeDB(data);
  },

  // 离场账户 —— 已不在任何被管理组织内的账户，保留轨迹用于追溯遗留数据
  getDepartedAccounts(): any[] {
    const data = readDB() as any;
    return data.departed_accounts || [];
  },

  upsertDepartedAccounts(records: any[]) {
    if (!records?.length) return;
    const data = readDB() as any;
    if (!data.departed_accounts) data.departed_accounts = [];
    const idx = new Map<string, number>();
    data.departed_accounts.forEach((r: any, i: number) => idx.set(r.account_id, i));
    for (const rec of records) {
      const i = idx.get(rec.account_id);
      if (i !== undefined) data.departed_accounts[i] = { ...data.departed_accounts[i], ...rec };
      else {
        idx.set(rec.account_id, data.departed_accounts.length);
        data.departed_accounts.push(rec);
      }
    }
    writeDB(data);
  },

  // 账户角色自愈状态 —— 记录每个账户的 support-quota / admin-console 可用性
  getAccountRoles(): any[] {
    const data = readDB() as any;
    return data.account_roles || [];
  },

  upsertAccountRole(record: any) {
    db.upsertAccountRoles([record]);
  },

  // 批量写入 —— 单条写会让每个账户都 stringify 一遍整个 db，几千账户时无法接受
  upsertAccountRoles(records: any[]) {
    if (!records?.length) return;
    const data = readDB() as any;
    if (!data.account_roles) data.account_roles = [];
    const idxMap = new Map<string, number>();
    data.account_roles.forEach((r: any, i: number) => idxMap.set(r.account_id, i));
    for (const rec of records) {
      const i = idxMap.get(rec.account_id);
      if (i !== undefined) data.account_roles[i] = { ...data.account_roles[i], ...rec };
      else {
        idxMap.set(rec.account_id, data.account_roles.length);
        data.account_roles.push(rec);
      }
    }
    writeDB(data);
  },

  upsertRegionData(accountId: string, regions: { region: string; status: string }[]) {
    const data = readDB();
    if (!data.region_data) data.region_data = [];
    const idx = data.region_data.findIndex((r: any) => r.account_id === accountId);
    if (idx >= 0) {
      const existing = data.region_data[idx];
      for (const r of regions) {
        const ri = (existing.regions || []).findIndex((er: any) => er.region === r.region);
        if (ri >= 0) existing.regions[ri] = r;
        else existing.regions.push(r);
      }
      existing.updated_at = new Date().toISOString();
    } else {
      data.region_data.push({ account_id: accountId, regions, updated_at: new Date().toISOString() });
    }
    writeDB(data);
  },
};

// Migration: authenticate plaintext/legacy fields and re-encrypt historical key IDs with the current key.
export function migrateEncryptMFASecrets() {
  const data = readDB();
  let mfaMigrated = 0;
  let externalIdsMigrated = 0;
  for (const user of data.users) {
    if (!user.mfa_secret) continue;
    const plaintext = decryptField(user.mfa_secret, 'mfa');
    if (encryptedFieldUsesCurrentKey(user.mfa_secret, 'mfa')) continue;
    user.mfa_secret = encryptField(plaintext, 'mfa');
    mfaMigrated++;
  }
  for (const record of data.restricted_accounts || []) {
    if (!record.external_id_enc) continue;
    const plaintext = decryptField(record.external_id_enc, 'external-id');
    if (encryptedFieldUsesCurrentKey(record.external_id_enc, 'external-id')) continue;
    record.external_id_enc = encryptField(plaintext, 'external-id');
    externalIdsMigrated++;
  }
  if (mfaMigrated > 0 || externalIdsMigrated > 0) {
    const now = new Date().toISOString();
    const lastAuditId = data.audit_log.reduce((max, log) => Math.max(max, Number(log.id) || 0), 0);
    data.audit_log.push({
      id: Math.max(Date.now(), lastAuditId + 1),
      user_id: null,
      username: 'system',
      action: 'ENCRYPTION_KEY_ROTATION_MIGRATE',
      detail: `已将 ${mfaMigrated} 个 MFA 密钥和 ${externalIdsMigrated} 个 ExternalId 原子重加密到 current key`,
      ip: null,
      created_at: now,
    });
    if (data.audit_log.length > 5000) data.audit_log = data.audit_log.slice(-5000);
    // Sensitive fields and their audit event share one durable DB replacement.
    writeDB(data);
    console.log(`✅ Re-encrypted sensitive fields: MFA=${mfaMigrated}, ExternalId=${externalIdsMigrated}`);
  }
}
