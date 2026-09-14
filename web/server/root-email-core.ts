import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export type RootEmailStatus = 'queued' | 'running' | 'email_sent' | 'waiting_mail' | 'link_ready' | 'mail_failed' | 'failed' | 'cancelled' | 'interrupted';
export type RootEmailPhase = 'queued' | 'opening' | 'captcha' | 'submitting' | 'waiting_mail' | 'done';
export interface RootEmailJob {
  id: string;
  accountId: string;
  email: string;
  createdBy: string;
  createdByUserId: string;
  status: RootEmailStatus;
  phase: RootEmailPhase;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  detail: string;
  batchId?: string;
  payerAccountId?: string;
  payerName?: string;
  requestedAt?: string;
  mailCursor?: number;
  mailNextCheckAt?: string;
  mailDeadlineAt?: string;
  mailKey?: string;
  mailReceivedAt?: string;
}

export class RootEmailError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}

export const isPendingEmailJob = (job: RootEmailJob) => ['queued', 'running', 'waiting_mail'].includes(job.status);
export const MAX_ROOT_EMAIL_TASKS = 500;
type RootEmailInput = Pick<RootEmailJob, 'accountId' | 'email' | 'createdBy' | 'createdByUserId'>;
export type RootEmailBatchMeta = Required<Pick<RootEmailJob, 'batchId' | 'payerAccountId' | 'payerName'>>;

export function selectRootEmailTargets(accounts: any[], payer: { name: string; accountId: string }, values: unknown) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_ROOT_EMAIL_TASKS
    || values.some(id => typeof id !== 'string' || !/^\d{12}$/.test(id))) {
    throw new RootEmailError(`请选择 1–${MAX_ROOT_EMAIL_TASKS} 个有效账户`);
  }
  return [...new Set<string>(values)].map(accountId => {
    const account = accounts.find(a => a.Id === accountId);
    if (!account || account._payer !== payer.name || account._isPayer || accountId === payer.accountId) {
      throw new RootEmailError(`账户 ${accountId} 不属于所选 payer 的成员账户`, 409);
    }
    if ((account.State || account.Status) !== 'ACTIVE') throw new RootEmailError(`账户 ${accountId} 不是 ACTIVE 状态`, 409);
    const email = String(account.Email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RootEmailError(`账户 ${accountId} 缺少有效的根邮箱`);
    return { accountId, email };
  });
}

/** Dedicated metadata store; contains no browser profiles, tokens, passwords or email bodies. */
export class RootEmailStore {
  private jobs: RootEmailJob[];
  constructor(private readonly filename: string) {
    const value = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : [];
    if (!Array.isArray(value) || value.some(j => !j || typeof j.id !== 'string'
      || !/^\d{12}$/.test(j.accountId) || typeof j.email !== 'string'
      || !['queued', 'running', 'email_sent', 'waiting_mail', 'link_ready', 'mail_failed', 'failed', 'cancelled', 'interrupted'].includes(j.status))) {
      throw new Error('恢复邮件任务文件格式无效，已拒绝覆盖');
    }
    this.jobs = value;
  }
  list(): RootEmailJob[] { return structuredClone(this.jobs); }
  get(id: string): RootEmailJob | undefined { return this.list().find(j => j.id === id); }
  private save(next: RootEmailJob[]) {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.filename);
      this.jobs = next;
      const dir = fs.openSync(path.dirname(this.filename), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  update(id: string, patch: Partial<RootEmailJob>): RootEmailJob {
    const next = this.list();
    const job = next.find(j => j.id === id);
    if (!job) throw new RootEmailError('任务不存在', 404);
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.save(next);
    return structuredClone(job);
  }
  private validate(input: RootEmailInput) {
    if (!/^\d{12}$/.test(input.accountId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
      throw new RootEmailError('账户 ID 或根邮箱无效');
    }
    if (this.jobs.some(j => j.accountId === input.accountId && isPendingEmailJob(j))) {
      throw new RootEmailError(`账户 ${input.accountId} 已有恢复邮件任务，请等待结果`, 409);
    }
    if (this.jobs.some(j => j.accountId === input.accountId && Date.now() - Date.parse(j.createdAt) < 60_000)) {
      throw new RootEmailError(`账户 ${input.accountId} 请至少间隔 60 秒再创建恢复邮件任务`, 429);
    }
  }
  private makeJob(input: RootEmailInput): RootEmailJob {
    const now = new Date().toISOString();
    return { ...input, id: randomUUID(), status: 'queued', phase: 'queued', attempts: 0,
      createdAt: now, updatedAt: now, detail: '等待发送恢复邮件' };
  }
  create(input: RootEmailInput): RootEmailJob {
    this.validate(input);
    if (this.jobs.filter(isPendingEmailJob).length >= MAX_ROOT_EMAIL_TASKS) throw new RootEmailError('队列已满，请稍后重试', 429);
    const job = this.makeJob(input);
    this.save([...this.jobs, job]);
    return structuredClone(job);
  }
  /** Validate every target before one atomic write. A repeated request ID cannot send twice. */
  createBatch(inputs: RootEmailInput[], meta: RootEmailBatchMeta): { jobs: RootEmailJob[]; reused: boolean } {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meta.batchId)
      || !/^\d{12}$/.test(meta.payerAccountId) || !meta.payerName
      || !inputs.length || inputs.length > MAX_ROOT_EMAIL_TASKS
      || new Set(inputs.map(i => i.accountId)).size !== inputs.length
      || new Set(inputs.map(i => i.createdByUserId)).size !== 1) throw new RootEmailError('批次参数无效');
    const previous = this.jobs.filter(j => j.batchId === meta.batchId);
    if (previous.length) {
      if (previous.length !== inputs.length || previous.some(j => j.payerAccountId !== meta.payerAccountId
        || j.createdByUserId !== inputs[0].createdByUserId || !inputs.some(i => i.accountId === j.accountId))) {
        throw new RootEmailError('请求标识已用于另一个批次，请刷新后重试', 409);
      }
      return { jobs: structuredClone(previous), reused: true };
    }
    for (const input of inputs) this.validate(input);
    if (this.jobs.filter(isPendingEmailJob).length + inputs.length > MAX_ROOT_EMAIL_TASKS) {
      throw new RootEmailError(`当前队列容量不足（上限 ${MAX_ROOT_EMAIL_TASKS} 个账户），本批次未创建`, 429);
    }
    const jobs = inputs.map(input => ({ ...this.makeJob(input), ...meta }));
    this.save([...this.jobs, ...jobs]);
    return { jobs: structuredClone(jobs), reused: false };
  }
  cancelQueuedBatch(batchId: string) {
    this.save(this.jobs.map(j => j.batchId === batchId && ['queued', 'waiting_mail'].includes(j.status)
      ? { ...j, status: 'cancelled', updatedAt: new Date().toISOString(),
        detail: j.sentAt ? '已停止等待邮件；恢复邮件此前已发送' : '批次已停止，此账户未发送邮件' } : j));
  }
  recover() {
    if (!this.jobs.some(j => ['queued', 'running'].includes(j.status))) return;
    this.save(this.jobs.map(j => ['queued', 'running'].includes(j.status) ? { ...j, status: 'interrupted',
      updatedAt: new Date().toISOString(), detail: '服务重启，任务已中断；请先检查收件箱，再决定是否重新发送' } : j));
  }
}

export interface RootEmailSession {
  open(email: string): Promise<void>;
  recognize(): Promise<{ candidate: string | null; imageId: string }>;
  refresh(previousImageId: string): Promise<void>;
  submit(candidate: string): Promise<'sent' | 'invalid'>;
  close(): Promise<void>;
}

/** Only an explicit AWS rejection permits another attempt. Timeouts are ambiguous. */
export async function sendRootEmail(input: {
  email: string;
  session: RootEmailSession;
  signal: AbortSignal;
  authorize: () => void;
  progress: (phase: RootEmailPhase, attempts: number, detail: string) => void;
}): Promise<void> {
  const { session, signal, progress } = input;
  const check = () => { signal.throwIfAborted(); input.authorize(); };
  check();
  progress('opening', 0, '正在打开 AWS 根用户密码恢复页面');
  await session.open(input.email);
  for (let attempt = 1; attempt <= 3; attempt++) {
    check();
    progress('captcha', attempt, `正在识别第 ${attempt} 张验证码（最多 3 张）`);
    const { candidate, imageId } = await session.recognize();
    check();
    if (candidate && /^[a-zA-Z0-9]{6}$/.test(candidate)) {
      progress('submitting', attempt, '正在提交验证码；等待 AWS 确认邮件已发送');
      check();
      if (await session.submit(candidate) === 'sent') return;
    }
    if (attempt < 3) {
      check();
      await session.refresh(imageId);
    }
  }
  throw new RootEmailError('3 张验证码均未通过，请稍后重试', 422);
}
