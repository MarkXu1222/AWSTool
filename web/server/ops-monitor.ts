/**
 * 运维监控 — 进程内指标采集与健康评分（无外部依赖）
 *
 * 设计约束：本系统是单进程 Express + JSON 文件存储，没有 Prometheus/Redis，
 * 所以全部指标保存在进程内存的环形缓冲里（重启清零，与 supportRoleUnavailable 同理）。
 *
 * 采集内容：
 * - 请求指标：由 index.ts 的日志中间件调用 recordRequest()，按分钟聚合 + 按端点聚合
 * - 系统采样：每 60s 采一次 CPU / 内存 / 磁盘 / 事件循环延迟，保留 24h（1440 个点）
 * - 健康评分：100 分制，按阈值扣分并给出扣分原因
 */
import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { Router, Request, Response } from 'express';
import { getSchedulerStatus } from './scheduler';
import { db, listBillingExportJobs, listActiveTagOnboardingJobs } from './db';

// 仅严格 admin 可看运维监控（与 routes/aws.ts 的 requireStrictAdmin 同逻辑：从数据库读当前角色，不信任 JWT 里可能过期的角色）
export function requireOpsAdmin(req: Request, res: Response, next: any) {
  const tokenUser = (req as any).user;
  const currentUser = tokenUser?.username ? db.getUser(tokenUser.username) : null;
  if (!currentUser
    || String(currentUser.id) !== String(tokenUser?.userId)
    || currentUser.username !== tokenUser?.username) {
    return res.status(401).json({ error: '用户身份已变更，请重新登录' });
  }
  if (currentUser.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可访问运维监控' });
  }
  next();
}

// ===== 请求指标 =====

interface EndpointStat {
  count: number;
  err4xx: number;
  err5xx: number;
  totalMs: number;
  maxMs: number;
  // 采样保留最近 200 个耗时用于估算分位数（低流量场景足够精确）
  samples: number[];
}

interface MinuteBucket {
  ts: number; // 分钟对齐的 epoch ms
  count: number;
  err4xx: number;
  err5xx: number;
  totalMs: number;
  // 延迟直方图桶（ms 上界）：10/25/50/100/250/500/1000/2500/5000/Inf
  histogram: number[];
  samples: number[];
  endpoints: Map<string, EndpointStat>;
}

export const HISTOGRAM_BOUNDS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const MAX_MINUTE_BUCKETS = 24 * 60; // 保留 24h
const MAX_SAMPLES_PER_BUCKET = 500;
const MAX_SAMPLES_PER_ENDPOINT = 200;

const minuteBuckets: MinuteBucket[] = [];

// 归一化端点：把路径里的账户 ID / UUID / 长十六进制换成占位符，避免端点无限膨胀
function normalizeEndpoint(rawPath: string): string {
  const p = rawPath.split('?')[0];
  return p.split('/').map(seg => {
    if (/^\d{6,}$/.test(seg)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ':id';
    return seg;
  }).join('/');
}

function currentBucket(): MinuteBucket {
  const ts = Math.floor(Date.now() / 60_000) * 60_000;
  const last = minuteBuckets[minuteBuckets.length - 1];
  if (last && last.ts === ts) return last;
  const bucket: MinuteBucket = {
    ts, count: 0, err4xx: 0, err5xx: 0, totalMs: 0,
    histogram: new Array(HISTOGRAM_BOUNDS.length + 1).fill(0),
    samples: [],
    endpoints: new Map(),
  };
  minuteBuckets.push(bucket);
  if (minuteBuckets.length > MAX_MINUTE_BUCKETS) minuteBuckets.splice(0, minuteBuckets.length - MAX_MINUTE_BUCKETS);
  return bucket;
}

export function recordRequest(method: string, rawPath: string, status: number, durationMs: number) {
  // 只统计 API 请求；监控自身的轮询不计入，避免自我污染
  if (!rawPath.startsWith('/api/') || rawPath.startsWith('/api/ops')) return;
  const bucket = currentBucket();
  bucket.count += 1;
  bucket.totalMs += durationMs;
  if (status >= 500) bucket.err5xx += 1;
  else if (status >= 400) bucket.err4xx += 1;
  let hi = HISTOGRAM_BOUNDS.findIndex(b => durationMs <= b);
  if (hi === -1) hi = HISTOGRAM_BOUNDS.length;
  bucket.histogram[hi] += 1;
  if (bucket.samples.length < MAX_SAMPLES_PER_BUCKET) bucket.samples.push(durationMs);

  const key = `${method} ${normalizeEndpoint(rawPath)}`;
  let stat = bucket.endpoints.get(key);
  if (!stat) {
    stat = { count: 0, err4xx: 0, err5xx: 0, totalMs: 0, maxMs: 0, samples: [] };
    bucket.endpoints.set(key, stat);
  }
  stat.count += 1;
  stat.totalMs += durationMs;
  stat.maxMs = Math.max(stat.maxMs, durationMs);
  if (status >= 500) stat.err5xx += 1;
  else if (status >= 400) stat.err4xx += 1;
  if (stat.samples.length < MAX_SAMPLES_PER_ENDPOINT) stat.samples.push(durationMs);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// ===== 系统采样 =====

interface SystemSample {
  ts: number;
  cpuPct: number;      // 全机 CPU 使用率
  memPct: number;      // 全机内存使用率
  diskPct: number;     // data 目录所在盘使用率
  loopLagMs: number;   // 事件循环延迟（均值）
  rssMb: number;       // 本进程 RSS
}

const systemSamples: SystemSample[] = [];
const MAX_SYSTEM_SAMPLES = 24 * 60; // 60s 一个点，保留 24h

let prevCpuTimes: { idle: number; total: number } | null = null;
function sampleCpuPct(): number {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  const prev = prevCpuTimes;
  prevCpuTimes = { idle, total };
  if (!prev || total <= prev.total) return 0;
  const dTotal = total - prev.total;
  const dIdle = idle - prev.idle;
  return Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
}

// 事件循环延迟：每秒记录 setInterval 的实际漂移
let loopLagSamples: number[] = [];
let loopLagTimer: NodeJS.Timeout | null = null;
function startLoopLagProbe() {
  let expected = Date.now() + 1000;
  loopLagTimer = setInterval(() => {
    const lag = Math.max(0, Date.now() - expected);
    loopLagSamples.push(lag);
    if (loopLagSamples.length > 120) loopLagSamples.splice(0, loopLagSamples.length - 120);
    expected = Date.now() + 1000;
  }, 1000);
  loopLagTimer.unref?.();
}

// 磁盘用量：df 输出缓存 60s（macOS/Linux 通用）
const DATA_DIR = path.join(__dirname, '../../data');
let diskCache: { ts: number; usedPct: number; usedBytes: number; totalBytes: number } = { ts: 0, usedPct: 0, usedBytes: 0, totalBytes: 0 };
function refreshDisk(): Promise<void> {
  return new Promise(resolve => {
    execFile('df', ['-k', DATA_DIR], { timeout: 5000 }, (err, stdout) => {
      if (!err && stdout) {
        const lines = stdout.trim().split('\n');
        const parts = lines[lines.length - 1].split(/\s+/);
        // df -k: Filesystem 1024-blocks Used Available Capacity ...
        const totalKb = Number(parts[1]);
        const usedKb = Number(parts[2]);
        if (Number.isFinite(totalKb) && Number.isFinite(usedKb) && totalKb > 0) {
          diskCache = {
            ts: Date.now(),
            usedPct: (usedKb / totalKb) * 100,
            usedBytes: usedKb * 1024,
            totalBytes: totalKb * 1024,
          };
        }
      }
      resolve();
    });
  });
}

let samplerTimer: NodeJS.Timeout | null = null;
async function takeSystemSample() {
  if (Date.now() - diskCache.ts > 55_000) await refreshDisk();
  const mem = process.memoryUsage();
  const lagAvg = loopLagSamples.length
    ? loopLagSamples.reduce((a, b) => a + b, 0) / loopLagSamples.length
    : 0;
  systemSamples.push({
    ts: Date.now(),
    cpuPct: sampleCpuPct(),
    memPct: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100,
    diskPct: diskCache.usedPct,
    loopLagMs: lagAvg,
    rssMb: mem.rss / 1024 / 1024,
  });
  if (systemSamples.length > MAX_SYSTEM_SAMPLES) systemSamples.splice(0, systemSamples.length - MAX_SYSTEM_SAMPLES);
}

export function startOpsMonitor() {
  startLoopLagProbe();
  sampleCpuPct(); // 建立基线，首个采样点才有 delta
  void takeSystemSample();
  samplerTimer = setInterval(() => { void takeSystemSample(); }, 60_000);
  samplerTimer.unref?.();
  console.log('[OpsMonitor] 指标采集已启动（每 60s 采样，保留 24h）');
}

export function stopOpsMonitor() {
  if (samplerTimer) clearInterval(samplerTimer);
  if (loopLagTimer) clearInterval(loopLagTimer);
}

// ===== 数据库与备份状态 =====

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/db.json');
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');

function getDbStats() {
  let dbBytes = 0;
  try { dbBytes = fs.statSync(DB_PATH).size; } catch {}
  let backups = 0;
  let latestBackupAt: string | null = null;
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json'));
    backups = files.length;
    let latest = 0;
    for (const f of files) {
      try {
        const m = fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs;
        if (m > latest) latest = m;
      } catch {}
    }
    if (latest) latestBackupAt = new Date(latest).toISOString();
  } catch {}
  return { dbBytes, backups, latestBackupAt };
}

// ===== 后台任务状态 =====

function getJobsStatus() {
  let billing = { queued: 0, running: 0, recentFailed: 0 };
  try {
    const jobs = listBillingExportJobs();
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    billing = {
      queued: jobs.filter(j => j.status === 'queued').length,
      running: jobs.filter(j => j.status === 'running' || j.status === 'cancelling').length,
      recentFailed: jobs.filter(j => (j.status === 'failed' || j.status === 'interrupted')
        && Date.parse((j as any).updatedAt || (j as any).createdAt || '') > dayAgo).length,
    };
  } catch {}
  let tagOnboarding = { active: 0, waitingRetry: 0 };
  try {
    const jobs = listActiveTagOnboardingJobs();
    tagOnboarding = {
      active: jobs.filter(j => j.status === 'queued' || j.status === 'running').length,
      waitingRetry: jobs.filter(j => j.status === 'waiting_retry').length,
    };
  } catch {}
  return { billing, tagOnboarding };
}

// ===== 健康评分 =====

interface HealthDeduction { reason: string; points: number }

function computeHealth(
  latest: SystemSample | undefined,
  windowAgg: { count: number; err5xx: number },
  scheduler: ReturnType<typeof getSchedulerStatus>,
  dbBytes: number,
) {
  const deductions: HealthDeduction[] = [];
  if (latest) {
    if (latest.cpuPct > 90) deductions.push({ reason: `CPU 使用率 ${latest.cpuPct.toFixed(1)}% 过高`, points: 20 });
    else if (latest.cpuPct > 75) deductions.push({ reason: `CPU 使用率 ${latest.cpuPct.toFixed(1)}% 偏高`, points: 10 });
    if (latest.memPct > 92) deductions.push({ reason: `内存使用率 ${latest.memPct.toFixed(1)}% 过高`, points: 20 });
    else if (latest.memPct > 82) deductions.push({ reason: `内存使用率 ${latest.memPct.toFixed(1)}% 偏高`, points: 10 });
    if (latest.diskPct > 90) deductions.push({ reason: `磁盘使用率 ${latest.diskPct.toFixed(1)}% 过高`, points: 25 });
    else if (latest.diskPct > 80) deductions.push({ reason: `磁盘使用率 ${latest.diskPct.toFixed(1)}% 偏高`, points: 10 });
    if (latest.loopLagMs > 200) deductions.push({ reason: `事件循环延迟 ${latest.loopLagMs.toFixed(0)}ms（进程阻塞）`, points: 15 });
    else if (latest.loopLagMs > 80) deductions.push({ reason: `事件循环延迟 ${latest.loopLagMs.toFixed(0)}ms 偏高`, points: 5 });
  }
  if (windowAgg.err5xx > 0) {
    deductions.push({ reason: `窗口内出现 ${windowAgg.err5xx} 次 5xx`, points: Math.min(20, windowAgg.err5xx * 2) });
  }
  // 账户同步正常 30 分钟一次，超过 2 小时未成功视为 scheduler 异常
  if (scheduler.lastAccountsSync) {
    const age = Date.now() - Date.parse(scheduler.lastAccountsSync);
    if (age > 2 * 3600 * 1000) deductions.push({ reason: '账户同步超过 2 小时未成功', points: 10 });
  }
  if (dbBytes > 50 * 1024 * 1024) deductions.push({ reason: 'db.json 超过 50MB，读写会变慢', points: 5 });
  const score = Math.max(0, 100 - deductions.reduce((a, d) => a + d.points, 0));
  const level = score >= 90 ? 'ok' : score >= 70 ? 'warn' : 'critical';
  return { score, level, deductions };
}

// ===== 聚合与路由 =====

const RANGE_MS: Record<string, number> = {
  '1h': 3600_000,
  '6h': 6 * 3600_000,
  '24h': 24 * 3600_000,
};

export const opsRouter = Router();

opsRouter.get('/overview', (req: Request, res: Response) => {
  const range = String(req.query.range || '1h');
  const windowMs = RANGE_MS[range] || RANGE_MS['1h'];
  const since = Date.now() - windowMs;

  // 请求窗口聚合
  const buckets = minuteBuckets.filter(b => b.ts >= since);
  const agg = { count: 0, err4xx: 0, err5xx: 0, totalMs: 0 };
  const histogram = new Array(HISTOGRAM_BOUNDS.length + 1).fill(0);
  const allSamples: number[] = [];
  const endpointMap = new Map<string, EndpointStat>();
  for (const b of buckets) {
    agg.count += b.count;
    agg.err4xx += b.err4xx;
    agg.err5xx += b.err5xx;
    agg.totalMs += b.totalMs;
    b.histogram.forEach((v, i) => { histogram[i] += v; });
    for (const s of b.samples) allSamples.push(s);
    for (const [key, st] of b.endpoints) {
      let acc = endpointMap.get(key);
      if (!acc) {
        acc = { count: 0, err4xx: 0, err5xx: 0, totalMs: 0, maxMs: 0, samples: [] };
        endpointMap.set(key, acc);
      }
      acc.count += st.count;
      acc.err4xx += st.err4xx;
      acc.err5xx += st.err5xx;
      acc.totalMs += st.totalMs;
      acc.maxMs = Math.max(acc.maxMs, st.maxMs);
      for (const s of st.samples) acc.samples.push(s);
    }
  }
  allSamples.sort((a, b) => a - b);

  const endpoints = Array.from(endpointMap.entries()).map(([endpoint, st]) => {
    const sorted = [...st.samples].sort((a, b) => a - b);
    return {
      endpoint,
      count: st.count,
      errorRate: st.count ? (st.err4xx + st.err5xx) / st.count : 0,
      err4xx: st.err4xx,
      err5xx: st.err5xx,
      avgMs: st.count ? st.totalMs / st.count : 0,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      maxMs: st.maxMs,
    };
  }).sort((a, b) => b.count - a.count).slice(0, 50);

  // 请求速率趋势（每分钟）
  const requestTrend = buckets.map(b => ({
    ts: b.ts, count: b.count, err5xx: b.err5xx,
    avgMs: b.count ? b.totalMs / b.count : 0,
  }));

  const trend = systemSamples.filter(s => s.ts >= since);
  const latest = systemSamples[systemSamples.length - 1];
  const scheduler = getSchedulerStatus();
  const dbStats = getDbStats();
  const health = computeHealth(latest, agg, scheduler, dbStats.dbBytes);
  const mem = process.memoryUsage();

  res.json({
    success: true,
    data: {
      sampledAt: new Date().toISOString(),
      range,
      health,
      system: {
        cpuPct: latest?.cpuPct ?? 0,
        cpuCores: os.cpus().length,
        loadAvg: os.loadavg(),
        memUsedBytes: os.totalmem() - os.freemem(),
        memTotalBytes: os.totalmem(),
        diskUsedBytes: diskCache.usedBytes,
        diskTotalBytes: diskCache.totalBytes,
        diskPct: diskCache.usedPct,
      },
      process: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        uptimeSec: Math.floor(process.uptime()),
        loopLagMs: latest?.loopLagMs ?? 0,
        nodeVersion: process.version,
        pid: process.pid,
      },
      db: dbStats,
      scheduler,
      jobs: getJobsStatus(),
      requests: {
        total: agg.count,
        err4xx: agg.err4xx,
        err5xx: agg.err5xx,
        errorRate: agg.count ? (agg.err4xx + agg.err5xx) / agg.count : 0,
        avgMs: agg.count ? agg.totalMs / agg.count : 0,
        p50Ms: percentile(allSamples, 50),
        p95Ms: percentile(allSamples, 95),
        p99Ms: percentile(allSamples, 99),
      },
      latencyHistogram: {
        bounds: HISTOGRAM_BOUNDS,
        counts: histogram,
      },
      requestTrend,
      trend: trend.map(s => ({
        ts: s.ts,
        cpuPct: Number(s.cpuPct.toFixed(2)),
        memPct: Number(s.memPct.toFixed(2)),
        diskPct: Number(s.diskPct.toFixed(2)),
        loopLagMs: Number(s.loopLagMs.toFixed(1)),
        rssMb: Number(s.rssMb.toFixed(1)),
      })),
      endpoints,
    },
  });
});
