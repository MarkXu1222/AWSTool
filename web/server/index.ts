import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import { authRouter, authMiddleware } from './auth';
import { auditMiddleware } from './audit';
import { awsRouter } from './routes/aws';
import { regionsRouter } from './routes/regions';
import { bedrockRouter } from './routes/bedrock';
import { migrateEncryptMFASecrets, backupDB } from './db';
import { startScheduler, getSchedulerStatus } from './scheduler';
import { startTagOnboardingRunner } from './tag-onboarding';
import { startBillingExportRunner, stopBillingExportRunner } from './billing-export-jobs';
import { opsRouter, requireOpsAccess, recordRequest, startOpsMonitor, stopOpsMonitor } from './ops-monitor';
import { recordHttpStatus } from './security-alerts';

const app = express();
app.set('trust proxy', 1);

// Gzip compression (skip SSE streams)
app.use(compression({
  filter: (req, res) => {
    if (req.path.includes('sync-stream')) return false;
    return compression.filter(req, res);
  }
}));
const configPath = path.join(__dirname, '../../config.json');
let appConfig: any = {};
try { appConfig = JSON.parse(require('fs').readFileSync(configPath, 'utf-8')); } catch {}
const PORT = appConfig.web?.port || process.env.PORT || 3000;

// Migrate plaintext MFA secrets on startup
migrateEncryptMFASecrets();
// Backup DB on every startup (before any sync runs)
backupDB();

// Security — CSP relaxed for SPA (inline scripts from Vite build)
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      'https://markxu.co',
      'https://www.markxu.co',
      'http://markxu.co',
      'http://localhost:8000',
      'http://localhost:8001',
      'http://127.0.0.1:8000',
      'http://localhost:3000',
    ];
    // 允许无 Origin（curl / 移动端 App）与白名单来源。
    // 关键：未列入的来源用 callback(null, false) 优雅拒绝（不附加 CORS 头），
    // 绝不 throw —— 抛错会被 Express 当成 500，导致同源静态资源(带 crossorigin 的 JS/CSS)
    // 请求返回 500，整站白屏（例如直连 IP / www. / http:// 等来源访问时）。
    if (!origin || allowed.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
  // 交付表格下载是二进制 body，条数/缺失型号/零配额等元信息只能走响应头回传。
  // 跨域下自定义响应头默认对 JS 不可见，必须显式 expose。
  exposedHeaders: [
    'X-Delivery-Variant', 'X-Delivery-Rows',
    'X-Delivery-Zero-Quota', 'X-Delivery-Missing',
  ],
}));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.startsWith('/api/')) {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
      // 运维监控：记录请求指标（/api/ops 自身会在内部被排除）
      try { recordRequest(req.method, req.path, res.statusCode, duration); } catch {}
      // 安全告警：429 滥用 / 5xx 突增阈值检测
      try { recordHttpStatus(res.statusCode, req.path, req.ip); } catch {}
    }
  });
  next();
});

// Rate limiting — 读写分离：
// GET（读多、含监控 30s 轮询与多标签页并用）放宽到 300/min；
// 写操作维持 100/min 不变，防止误操作/滥用批量写。
app.use('/api/', rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300,
  skip: (req) => req.method !== 'GET',
  message: { error: 'Too many requests, try again later' },
}));
app.use('/api/', rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100,
  skip: (req) => req.method === 'GET',
  message: { error: 'Too many requests, try again later' },
}));

// Login rate limit (stricter)
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: '登录尝试过多，请 15 分钟后重试' },
}));

// Auth routes (no auth needed)
app.use('/api/auth', authRouter);

// Protected API routes (audit middleware records all authenticated API calls)
app.use('/api/aws', authMiddleware, auditMiddleware, awsRouter);
app.use('/api/regions', authMiddleware, auditMiddleware, regionsRouter);
// Bedrock 工具（Profile 管理/批量创建/FTU/数据共享/IAM/交付表格）。
// 用独立前缀 /api/bedrock 挂载，避免与 awsRouter 的 /aws/bedrock/quotas 路径歧义。
app.use('/api/bedrock', authMiddleware, auditMiddleware, bedrockRouter);

// Scheduler status endpoint
app.get('/api/scheduler/status', authMiddleware, (_req, res) => {
  res.json({ success: true, data: getSchedulerStatus() });
});

// 运维监控（admin 恒有，其他角色需显式页面授权；不走 auditMiddleware，避免高频轮询刷爆审计日志）
app.use('/api/ops', authMiddleware, requireOpsAccess, opsRouter);

// API 兜底 404 —— 必须在 SPA fallback 之前。
// 否则未匹配的 /api/* （扫描器探测 /api/v1/.env 之类）会掉进 app.get('*')
// 拿到 200 + index.html：不泄露数据，但 200 会鼓励扫描器持续加大探测。
app.all('/api/*', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Serve static frontend
import fs from 'fs';
const possiblePaths = [
  path.join(__dirname, '../dist/client'),    // tsx dev mode (running from server/)
  path.join(__dirname, '../client'),          // compiled mode (running from dist/server/)
];
const clientDist = possiblePaths.find(p => fs.existsSync(path.join(p, 'index.html'))) || possiblePaths[0];
app.use(express.static(clientDist, {
  setHeaders: (res, filePath) => {
    // index.html 绝不缓存：部署后浏览器/CDN 若仍用旧 index.html, 会加载已不存在的旧 hash 资源 → 白屏。
    // 带内容 hash 的 JS/CSS 可安全长期缓存(文件名变了自然失效)。
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/assets[\\/][^\\/]+-[\w-]{8,}\.(js|css)$/.test(filePath)) {
      // vite 产物：/assets/index-<hash>.js|css → 一年 immutable。
      // 之前是 max-age=0，2MB bundle 每次访问都要重新下载/校验，跨境网络下首屏极慢。
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.(png|ico|svg|woff2?)$/.test(filePath)) {
      // 图标等无 hash 静态资源：缓存 1 天（改动少，可接受的过期窗口）
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));
app.get('*', (_req, res) => {
  const indexPath = path.join(clientDist, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built. Run: npx vite build --config client/vite.config.ts');
  }
});

const server = app.listen(Number(PORT), '127.0.0.1', async () => {
  console.log(`🚀 AWS Toolbox Web running on http://127.0.0.1:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  try {
    // 先取得 billing runner 的 OS 单实例锁；失败时不允许此进程继续提供可能竞争写 DB 的 API。
    await startBillingExportRunner();
    startScheduler();
    startTagOnboardingRunner();
    startOpsMonitor();
  } catch (error) {
    console.error('[Startup] 后台 runner 启动失败，服务将退出:', error);
    server.close(() => process.exit(1));
  }
});

let shutdownPromise: Promise<void> | null = null;
function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`[Shutdown] 收到 ${signal}，停止接收请求并清理账单导出进程`);
    try { stopOpsMonitor(); } catch {}
    const closeServer = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('优雅停机超过 30 秒')), 30_000);
      timer.unref?.();
    });
    try {
      await Promise.race([
        Promise.all([stopBillingExportRunner(), closeServer]),
        deadline,
      ]);
      console.log('[Shutdown] 账单导出进程与 HTTP server 已安全停止');
      process.exit(0);
    } catch (error) {
      console.error('[Shutdown] 优雅停机失败:', error);
      process.exit(1);
    }
  })();
  return shutdownPromise;
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
