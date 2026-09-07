/**
 * Simple JSON file-based store — no native dependencies needed
 */
import fs from 'fs';
import path from 'path';
import { createCipheriv, createDecipheriv, randomBytes, createHash, randomUUID } from 'crypto';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/db.json');

// Encryption key for sensitive fields (MFA secrets) — independent from JWT
let ENC_KEY: Buffer;
try {
  const configPath = path.join(__dirname, '../../config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const source = config.web?.encryptionKey  // Dedicated key (preferred)
    || process.env.ENCRYPTION_KEY
    || config.web?.jwtSecret                // Fallback for backward compat
    || 'default-fallback-key-32chars-xxx';
  ENC_KEY = createHash('sha256').update(source).digest();
} catch {
  ENC_KEY = createHash('sha256').update('default-fallback-key-32chars-xxx').digest();
}

export function encryptField(text: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', ENC_KEY, iv);
  return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
}

export function decryptField(data: string): string {
  try {
    const [ivHex, encrypted] = data.split(':');
    if (!ivHex || !encrypted) return data; // Not encrypted, return as-is (migration)
    const decipher = createDecipheriv('aes-256-cbc', ENC_KEY, Buffer.from(ivHex, 'hex'));
    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
  } catch {
    return data; // Return raw if decryption fails (not yet encrypted)
  }
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

interface DBSchema {
  users: any[];
  quota_requests: any[];
  audit_log: any[];
  region_data: any[];
  accounts_cache: any[];
  accounts_cache_time: string;
  tag_onboarding_jobs: TagOnboardingJob[];
  billing_export_jobs: BillingExportJob[];
  [key: string]: any;
}

const ARRAY_FIELDS = [
  'users', 'quota_requests', 'audit_log', 'region_data', 'accounts_cache', 'tag_onboarding_jobs',
  'billing_export_jobs',
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
    accounts_cache_time: '', tag_onboarding_jobs: [], billing_export_jobs: [],
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
  steps: TagOnboardingStep[];
  requestedBy?: string;
}): { job: TagOnboardingJob; reused: boolean } {
  const data = readDB();
  const active = data.tag_onboarding_jobs.find(job =>
    job.payerAccountId === input.payerAccountId
    && ['queued', 'running', 'waiting_retry'].includes(job.status));
  if (active) {
    if (active.tagValue !== input.tagValue) throw new TagOnboardingConflictError(cloneJob(active));
    return { job: cloneJob(active), reused: true };
  }

  // 只复用仍在执行的任务。已完成记录仅用于审计；再次提交会新建任务并重新验证环境漂移。
  const now = new Date().toISOString();
  const job: TagOnboardingJob = {
    id: randomUUID(),
    payerAccountId: input.payerAccountId,
    tagValue: input.tagValue,
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

// === Auto-backup: keep a daily rotating copy of the DB ===
let lastBackupDay = '';
export function backupDB() {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const dir = path.join(path.dirname(DB_PATH), 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const dest = path.join(dir, `db-${today}.json`);
    fs.copyFileSync(DB_PATH, dest);
    // Keep only last 7 daily backups
    const files = fs.readdirSync(dir).filter(f => f.startsWith('db-') && f.endsWith('.json')).sort();
    while (files.length > 7) {
      const old = files.shift();
      if (old) fs.unlinkSync(path.join(dir, old));
    }
    lastBackupDay = today;
  } catch (e: any) {
    console.error('[DB Backup] failed:', e.message);
  }
}

// Run backup at most once per day, triggered on read
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

  // Dashboard cache — cost summary for instant loading
  getDashboardCache() {
    const data = readDB() as any;
    return data.dashboard_cache || null;
  },

  setDashboardCache(summary: any) {
    const data = readDB() as any;
    data.dashboard_cache = { ...summary, cachedAt: new Date().toISOString() };
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

// Migration: encrypt any plaintext MFA secrets on startup
export function migrateEncryptMFASecrets() {
  const data = readDB();
  let changed = false;
  for (const user of data.users) {
    if (user.mfa_secret && !user.mfa_secret.includes(':')) {
      user.mfa_secret = encryptField(user.mfa_secret);
      changed = true;
      console.log(`✅ Migrated MFA secret for user: ${user.username}`);
    }
  }
  if (changed) writeDB(data);
}
