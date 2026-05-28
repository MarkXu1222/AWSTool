import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import { authRouter, authMiddleware } from './auth';
import { awsRouter } from './routes/aws';
import { regionsRouter } from './routes/regions';
import { migrateEncryptMFASecrets } from './db';

const app = express();
app.set('trust proxy', 1);

// Gzip compression
app.use(compression());
const configPath = path.join(__dirname, '../../config.json');
let appConfig: any = {};
try { appConfig = JSON.parse(require('fs').readFileSync(configPath, 'utf-8')); } catch {}
const PORT = appConfig.web?.port || process.env.PORT || 3000;

// Migrate plaintext MFA secrets on startup
migrateEncryptMFASecrets();

// Security — CSP relaxed for SPA (inline scripts from Vite build)
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || true, // Same-origin requests don't need CORS; keep open for now
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

// Protected API routes
app.use('/api/aws', authMiddleware, awsRouter);
app.use('/api/regions', authMiddleware, regionsRouter);

// Serve static frontend
import fs from 'fs';
const possiblePaths = [
  path.join(__dirname, '../dist/client'),    // tsx dev mode (running from server/)
  path.join(__dirname, '../client'),          // compiled mode (running from dist/server/)
];
const clientDist = possiblePaths.find(p => fs.existsSync(path.join(p, 'index.html'))) || possiblePaths[0];
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  const indexPath = path.join(clientDist, 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(404).send('Frontend not built. Run: npx vite build --config client/vite.config.ts');
});

app.listen(PORT, () => {
  console.log(`🚀 AWS Toolbox Web running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
});
