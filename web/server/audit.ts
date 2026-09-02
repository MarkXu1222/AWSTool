// 统一 API 审计中间件：记录所有已鉴权用户的 API 调用
// 挂在 authMiddleware 之后（保证 req.user 存在），业务代码显式 addAuditLog 时
// 只需设置 res.locals.audited = true，本中间件会自动跳过以避免重复记录。
import { Request, Response, NextFunction } from 'express';
import { db } from './db';

// 噪音路径：轮询/连接测试/查看审计日志本身等，全部跳过
const NOISE_SUFFIXES = [
  '/connection',       // /api/aws/connection —— 前端每次进设置页会打一次
  '/audit',            // /api/aws/audit —— 查看审计页时不要把翻页也刷进日志
  '/scheduler/status', // 后台调度状态
];

// 敏感字段：body/query 中出现这些 key 会被替换成 ***
const SENSITIVE_KEYS = new Set([
  'password', 'newPassword', 'currentPassword',
  'secret', 'mfa_secret', 'totpCode', 'token',
  'accessKeyId', 'secretAccessKey', 'jwtSecret',
  'encryptionKey', 'adminPassword',
]);

function maskSensitive(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(maskSensitive);
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k)) out[k] = '***';
    else if (v && typeof v === 'object') out[k] = maskSensitive(v);
    else out[k] = v;
  }
  return out;
}

function isNoise(method: string, path: string): boolean {
  if (NOISE_SUFFIXES.some(sfx => path.endsWith(sfx))) return true;
  // 账单 job 列表和状态每 2 秒轮询，不写审计；下载路径会显式记录。
  return method === 'GET' && /^\/billing\/export-jobs(?:\/[^/]+)?$/.test(path);
}

export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  // SSE 流不记（长连接，无意义）
  if (req.path.includes('sync-stream')) return next();
  if (isNoise(req.method, req.path)) return next();

  const start = Date.now();

  res.on('finish', () => {
    // 业务代码已显式记录 → 跳过避免重复
    if ((res.locals as any).audited) return;
    const user = (req as any).user;
    // 未鉴权请求不记（比如 login 失败前）
    if (!user) return;

    const method = req.method;
    // req.baseUrl 类似 '/api/aws'，req.path 类似 '/accounts'
    const fullPath = (req.baseUrl || '') + req.path;

    // 组合请求参数（脱敏后）
    const paramsCombined: any = {};
    if (req.params && Object.keys(req.params).length > 0) {
      paramsCombined.route = req.params;
    }
    if (req.query && Object.keys(req.query).length > 0) {
      paramsCombined.query = maskSensitive(req.query);
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && req.body && Object.keys(req.body).length > 0) {
      paramsCombined.body = maskSensitive(req.body);
    }

    const duration = Date.now() - start;
    try {
      db.addAuditLog(
        user.userId,
        'API_CALL',
        `${method} ${fullPath} → ${res.statusCode} (${duration}ms)`,
        user.username,
        req.ip,
        {
          method,
          path: fullPath,
          status: res.statusCode,
          duration_ms: duration,
          params: paramsCombined,
        },
      );
    } catch (error) {
      // finish 事件中的异常不能再向 Express 传播，否则会变成未捕获异常并影响进程。
      console.error(`[Audit] 写入失败: ${method} ${fullPath}`, error);
    }
  });

  next();
}
