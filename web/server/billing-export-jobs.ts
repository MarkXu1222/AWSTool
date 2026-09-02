import fs from 'fs';
import net from 'net';
import path from 'path';
import {
  BillingExportCancelledError,
  BillingExportProcessCleanupError,
  ExportResult,
  ExportTask,
  cleanupWorkDir,
  exportBillingInvoices,
  getBillingExporterMaxConcurrency,
  preflightBillingExporter,
} from './billing-exporter';
import {
  BillingExportJob,
  createBillingExportJob,
  getBillingExportJob,
  listBillingExportJobs,
  listBillingExportJobsForUser,
  listQueuedBillingExportJobs,
  recoverBillingExportJobs,
  updateBillingExportJob,
  db,
} from './db';

const OUTPUT_ROOT = path.resolve(process.env.BILLING_EXPORT_OUTPUT_DIR
  || path.join(__dirname, '../../data/exports/billing'));
const BILLING_EXPORT_JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const configuredRunnerLockPort = Number(process.env.BILLING_EXPORT_RUNNER_LOCK_PORT || 39173);
const RUNNER_LOCK_PORT = Number.isInteger(configuredRunnerLockPort)
  && configuredRunnerLockPort >= 1024
  && configuredRunnerLockPort <= 65535
  ? configuredRunnerLockPort
  : 39173;
const RUNNER_INTERVAL_MS = 2_000;
const MAX_TASKS = 200;

let runnerStarted = false;
let runnerStopping = false;
let runnerLockServer: net.Server | null = null;
let runnerTimer: ReturnType<typeof setInterval> | null = null;
let tickInProgress = false;
let activeJobId: string | null = null;
let activeController: AbortController | null = null;
let activeRunPromise: Promise<void> | null = null;
let runnerBlockedError: string | null = null;
const activeDownloadLeases = new Map<string, number>();

function nowIso(): string {
  return new Date().toISOString();
}

function jobDir(jobId: string): string {
  if (!BILLING_EXPORT_JOB_ID_RE.test(jobId)) {
    throw new Error(`账单导出任务 ID 无效: ${jobId}`);
  }
  const candidate = path.resolve(OUTPUT_ROOT, jobId);
  if (path.dirname(candidate) !== OUTPUT_ROOT) {
    throw new Error('账单导出目录越界');
  }
  return candidate;
}

function acquireDownloadLease(jobId: string): () => void {
  activeDownloadLeases.set(jobId, (activeDownloadLeases.get(jobId) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeDownloadLeases.get(jobId) || 1) - 1;
    if (remaining > 0) activeDownloadLeases.set(jobId, remaining);
    else activeDownloadLeases.delete(jobId);
  };
}

function normalizeTasks(accountIds: unknown, months: unknown): ExportTask[] {
  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    throw new Error('请选择至少一个账号');
  }
  if (!Array.isArray(months) || months.length === 0) {
    throw new Error('请选择至少一个月份');
  }

  const uniqueAccountIds = [...new Set(accountIds.map(value => String(value).trim()))];
  if (uniqueAccountIds.some(accountId => !/^\d{12}$/.test(accountId))) {
    throw new Error('账号必须是 12 位 AWS 账户 ID');
  }

  const { accounts } = db.getAccountsCache();
  const accountById = new Map<string, any>((accounts || []).map((account: any) => [String(account.Id), account]));
  const unknown = uniqueAccountIds.filter(accountId => !accountById.has(accountId));
  if (unknown.length > 0) {
    throw new Error(`账户不在平台缓存中: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}`);
  }

  const now = new Date();
  const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const normalizedMonthByKey = new Map<string, { year: number; month: number }>();
  for (const rawValue of months) {
    const value = String(rawValue).trim();
    const match = /^(\d{4})-(\d{1,2})$/.exec(value);
    if (!match) throw new Error(`月份格式错误: ${value}`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year < 2000 || month < 1 || month > 12 || Date.UTC(year, month - 1, 1) > currentMonthStart) {
      throw new Error(`月份超出允许范围（不能晚于当前月）: ${value}`);
    }
    const key = `${year}-${String(month).padStart(2, '0')}`;
    normalizedMonthByKey.set(key, { year, month });
  }
  const normalizedMonths = [...normalizedMonthByKey.values()];

  const tasks: ExportTask[] = [];
  for (const accountId of uniqueAccountIds) {
    const account = accountById.get(accountId);
    for (const month of normalizedMonths) {
      tasks.push({
        accountId,
        accountName: account?.Name || undefined,
        year: month.year,
        month: month.month,
      });
    }
  }
  if (tasks.length > MAX_TASKS) {
    throw new Error(`任务过多 (${tasks.length})，请分批（≤${MAX_TASKS}）`);
  }
  return tasks;
}

function isTerminal(job: BillingExportJob): boolean {
  return ['cancelled', 'completed', 'failed', 'interrupted', 'expired'].includes(job.status);
}

function queuePosition(job: BillingExportJob): number | undefined {
  if (job.status !== 'queued') return undefined;
  const index = listQueuedBillingExportJobs().findIndex(item => item.id === job.id);
  return index >= 0 ? index + 1 : undefined;
}

export function toBillingExportJobView(job: BillingExportJob): BillingExportJob & {
  progress: number;
  etaSeconds?: number;
  queuePosition?: number;
  downloadReady: boolean;
} {
  let etaSeconds: number | undefined;
  if (job.status === 'running' && job.startedAt && job.done > 0 && job.done < job.total) {
    const elapsedSeconds = Math.max(1, (Date.now() - new Date(job.startedAt).getTime()) / 1000);
    etaSeconds = Math.ceil((elapsedSeconds / job.done) * (job.total - job.done));
  }
  const progress = job.phase === 'ready'
    ? 100
    : job.phase === 'packaging'
      ? 98
      : Math.min(95, Math.round((job.done / Math.max(1, job.total)) * 95));
  return {
    ...job,
    progress,
    etaSeconds,
    queuePosition: queuePosition(job),
    // expiresAt 仅作为旧记录兼容字段；新旧 completed 产物都按永久保留语义处理。
    downloadReady: job.status === 'completed' && !!job.downloadFilename,
  };
}

export function submitBillingExport(input: {
  accountIds: unknown;
  months: unknown;
  createdBy: string;
  createdByUserId: string;
}): BillingExportJob {
  if (!runnerStarted || runnerStopping) {
    throw new Error('账单导出 runner 尚未就绪，请稍后重试');
  }
  if (runnerBlockedError) {
    throw new Error(`账单导出 runner 因进程清理异常已暂停，请重启服务后重试：${runnerBlockedError}`);
  }
  // 在 job 入队前即失败，避免用户等到全部 PDF 抓完才知道 Chrome/Xvfb/zip 不可用。
  preflightBillingExporter(OUTPUT_ROOT);
  const tasks = normalizeTasks(input.accountIds, input.months);
  const job = createBillingExportJob({
    createdBy: input.createdBy,
    createdByUserId: input.createdByUserId,
    tasks,
    effectiveConcurrency: getBillingExporterMaxConcurrency(),
  });
  wakeRunner();
  return job;
}

export function getBillingExportJobsForUser(
  username: string,
  userId: string,
  isAdmin: boolean,
  scope: 'mine' | 'all',
  offset: number,
  limit: number,
): ReturnType<typeof listBillingExportJobsForUser> {
  return listBillingExportJobsForUser(username, userId, isAdmin, scope, offset, limit);
}

export function cancelBillingExport(jobId: string): BillingExportJob {
  const job = getBillingExportJob(jobId);
  if (!job) throw new Error('账单导出任务不存在');
  if (isTerminal(job)) throw new Error('任务已经结束，无法取消');
  const cancelRequestedAt = nowIso();
  if (job.status === 'queued') {
    const cancelled = updateBillingExportJob(job.id, {
      status: 'cancelled',
      cancelRequestedAt,
      finishedAt: cancelRequestedAt,
      error: '用户在任务开始前取消',
    });
    try {
      cleanupWorkDir(jobDir(job.id));
      return cancelled;
    } catch (cleanupError: any) {
      console.error(`[BillingExport] queued job ${job.id} 已取消，但工作目录清理失败:`, cleanupError);
      return updateBillingExportJob(job.id, {
        error: `用户在任务开始前取消；临时目录清理失败，将由后台重试：${cleanupError?.message || String(cleanupError)}`,
      });
    }
  }
  const updated = updateBillingExportJob(job.id, { status: 'cancelling', cancelRequestedAt });
  if (activeJobId === job.id) activeController?.abort();
  return updated;
}

export function getBillingExportDownload(jobId: string): {
  job: BillingExportJob;
  stream: ReturnType<typeof fs.createReadStream>;
  fileSize: number;
  release: () => void;
} {
  const job = getBillingExportJob(jobId);
  if (!job) throw new Error('账单导出任务不存在');
  if (job.status === 'expired') throw new Error('账单导出文件已不可用');
  if (job.status !== 'completed' || !job.downloadFilename) throw new Error('账单导出文件尚未就绪');

  const safeFilename = path.basename(job.downloadFilename);
  if (safeFilename !== job.downloadFilename || !/^[A-Za-z0-9._-]+$/.test(safeFilename)) {
    throw new Error('账单导出文件元数据无效');
  }
  const directory = jobDir(job.id);
  const filePath = path.resolve(directory, safeFilename);
  if (path.dirname(filePath) !== directory) throw new Error('账单导出文件路径越界');

  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      updateBillingExportJob(job.id, { status: 'expired', error: '导出文件已不存在' });
      throw new Error('账单导出文件已不存在');
    }
    throw error;
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('账单导出产物不是普通文件');
    const release = acquireDownloadLease(job.id);
    try {
      const stream = fs.createReadStream(filePath, { fd, autoClose: true });
      return { job, stream, fileSize: stat.size, release };
    } catch (error) {
      release();
      throw error;
    }
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* 保留原始错误 */ }
    throw error;
  }
}

async function runJob(jobId: string): Promise<void> {
  let job = getBillingExportJob(jobId);
  if (!job || job.status !== 'queued') return;

  const startedAt = nowIso();
  job = updateBillingExportJob(job.id, {
    status: 'running',
    phase: 'preflight',
    startedAt,
    error: undefined,
  });
  const controller = new AbortController();
  activeJobId = job.id;
  activeController = controller;

  try {
    preflightBillingExporter(OUTPUT_ROOT);
    const output = await exportBillingInvoices(job.tasks, {
      concurrency: job.effectiveConcurrency,
      signal: controller.signal,
      workDir: jobDir(job.id),
      onPhase: phase => {
        const current = getBillingExportJob(job.id);
        if (!current || current.status === 'cancelling') return;
        updateBillingExportJob(job.id, { phase });
      },
      onProgress: (_done, _total, result: ExportResult) => {
        const current = getBillingExportJob(job.id);
        if (!current || current.status === 'cancelling') return;
        const results = [...current.results, result];
        updateBillingExportJob(job.id, {
          phase: 'capturing',
          results,
          done: results.length,
          ok: results.filter(item => item.ok).length,
          failed: results.filter(item => !item.ok).length,
        });
      },
    });

    const current = getBillingExportJob(job.id);
    if (controller.signal.aborted || current?.status === 'cancelling') {
      throw new BillingExportCancelledError();
    }
    const ok = output.results.filter(result => result.ok).length;
    const failed = output.results.length - ok;
    const downloadFilename = `billing-invoices-${job.id.slice(0, 8)}-${ok}ok-${failed}fail.zip`;
    const finalPath = path.join(output.workDir, downloadFilename);
    fs.renameSync(output.zipPath, finalPath);
    const finishedAt = nowIso();
    updateBillingExportJob(job.id, {
      status: 'completed',
      phase: 'ready',
      results: output.results,
      done: output.results.length,
      ok,
      failed,
      downloadFilename,
      fileSize: fs.statSync(finalPath).size,
      finishedAt,
      expiresAt: undefined,
      error: undefined,
    });
    console.log(`[BillingExport] job ${job.id} completed: ok=${ok} failed=${failed}`);
  } catch (error) {
    let cleanupFailure: unknown;
    try {
      cleanupWorkDir(jobDir(job.id));
    } catch (cleanupError) {
      cleanupFailure = cleanupError;
      console.error(`[BillingExport] job ${job.id} 工作目录清理失败:`, cleanupError);
    }

    const unsafeCleanup = error instanceof BillingExportProcessCleanupError;
    if (unsafeCleanup) {
      runnerBlockedError = error.message;
      console.error(`[BillingExport] CRITICAL: ${error.message}; 后续任务保持 queued，需重启服务`);
    }
    const current = getBillingExportJob(job.id);
    const cancelledByUser = current?.status === 'cancelling';
    const interrupted = !unsafeCleanup && runnerStopping && !cancelledByUser;
    const cancelled = !unsafeCleanup && !interrupted
      && (cancelledByUser || controller.signal.aborted || error instanceof BillingExportCancelledError);
    const failureMessage = error instanceof Error ? error.message : String(error);
    const cleanupMessage = cleanupFailure instanceof Error ? cleanupFailure.message : cleanupFailure ? String(cleanupFailure) : '';
    const status = interrupted ? 'interrupted' : cancelled ? 'cancelled' : 'failed';
    updateBillingExportJob(job.id, {
      status,
      finishedAt: nowIso(),
      error: interrupted
        ? '服务停止中断了正在执行的导出，请重新提交'
        : cancelled
          ? '用户取消了账单导出'
          : [failureMessage, cleanupMessage].filter(Boolean).join('；'),
    });
    console.error(`[BillingExport] job ${job.id} ${status}:`, error);
  } finally {
    activeJobId = null;
    activeController = null;
    wakeRunner();
  }
}

async function tick(): Promise<void> {
  if (!runnerStarted || runnerStopping || runnerBlockedError || tickInProgress || activeJobId || activeRunPromise) return;
  tickInProgress = true;
  try {
    const next = listQueuedBillingExportJobs()[0];
    if (next) {
      const runPromise = runJob(next.id);
      activeRunPromise = runPromise;
      void runPromise.catch(error => {
        console.error(`[BillingExport] job ${next.id} runner 未处理异常:`, error);
      }).finally(() => {
        if (activeRunPromise === runPromise) activeRunPromise = null;
        wakeRunner();
      });
    }
  } finally {
    tickInProgress = false;
  }
}

function cleanupTransientWorkDirectories(): void {
  // 仅清理明确未完成的任务目录；completed、legacy expired 和 orphan 目录都永久保留，避免误删历史 ZIP。
  for (const job of listBillingExportJobs()) {
    if (!['cancelled', 'failed', 'interrupted'].includes(job.status)) continue;
    try {
      cleanupWorkDir(jobDir(job.id));
    } catch (error) {
      console.error(`[BillingExport] 清理未完成任务目录 ${job.id} 失败:`, error);
    }
  }
}

function wakeRunner(): void {
  if (runnerStarted && !runnerStopping) void tick();
}

function preflightOutputDirectoryOnly(): void {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true, mode: 0o700 });
  fs.accessSync(OUTPUT_ROOT, fs.constants.W_OK);
}

function acquireRunnerLock(): Promise<void> {
  if (runnerLockServer) return Promise.resolve();
  const lockServer = net.createServer();
  return new Promise((resolve, reject) => {
    const onStartupError = (error: NodeJS.ErrnoException) => {
      lockServer.removeAllListeners();
      const detail = error.code === 'EADDRINUSE'
        ? `账单导出仅支持单 Node/PM2 实例；本机锁端口 ${RUNNER_LOCK_PORT} 已被占用`
        : `无法取得账单导出 runner 单实例锁: ${error.message}`;
      reject(new Error(detail));
    };
    lockServer.once('error', onStartupError);
    lockServer.listen({ host: '127.0.0.1', port: RUNNER_LOCK_PORT, exclusive: true }, () => {
      lockServer.removeListener('error', onStartupError);
      lockServer.on('error', error => {
        runnerBlockedError = `runner 单实例锁异常: ${error.message}`;
        runnerStopping = true;
        runnerStarted = false;
        activeController?.abort();
        console.error(`[BillingExport] CRITICAL: ${runnerBlockedError}`);
      });
      lockServer.unref();
      runnerLockServer = lockServer;
      resolve();
    });
  });
}

function releaseRunnerLock(): Promise<void> {
  const lockServer = runnerLockServer;
  runnerLockServer = null;
  if (!lockServer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    lockServer.close(error => error ? reject(error) : resolve());
  });
}

export async function startBillingExportRunner(): Promise<void> {
  if (runnerStarted) return;
  preflightOutputDirectoryOnly();
  await acquireRunnerLock();
  runnerStopping = false;
  try {
    const interrupted = recoverBillingExportJobs();
    if (interrupted > 0) console.warn(`[BillingExport] 已将 ${interrupted} 个重启中断任务标记为 interrupted`);
    cleanupTransientWorkDirectories();
    runnerStarted = true;
    void tick();
    runnerTimer = setInterval(() => void tick(), RUNNER_INTERVAL_MS);
    runnerTimer.unref?.();
  } catch (error) {
    runnerStarted = false;
    await releaseRunnerLock().catch(releaseError => {
      console.error('[BillingExport] runner 启动失败后的单实例锁释放也失败:', releaseError);
    });
    throw error;
  }
}

export async function stopBillingExportRunner(): Promise<void> {
  if (!runnerStarted && !runnerLockServer) return;
  runnerStopping = true;
  runnerStarted = false;
  if (runnerTimer) clearInterval(runnerTimer);
  runnerTimer = null;

  const running = activeRunPromise;
  activeController?.abort();
  try {
    if (running) await running;
  } finally {
    if (activeRunPromise === running) activeRunPromise = null;
    await releaseRunnerLock();
  }
}

export { getBillingExportJob };
