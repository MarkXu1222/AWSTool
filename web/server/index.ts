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
import { migrateEncryptMFASecrets, backupDB } from './db';
import { startScheduler, getSchedulerStatus } from './scheduler';

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
}));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.startsWith('/api/')) {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// Rate limiting
app.use('/api/', rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100,
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

// Scheduler status endpoint
app.get('/api/scheduler/status', authMiddleware, (_req, res) => {
  res.json({ success: true, data: getSchedulerStatus() });
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

app.listen(Number(PORT), '127.0.0.1', () => {
  console.log(`🚀 AWS Toolbox Web running on http://127.0.0.1:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  // Start background data sync
  startScheduler();
});
