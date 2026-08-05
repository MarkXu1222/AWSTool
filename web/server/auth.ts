import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { db } from './db';
import { encryptField, decryptField } from './db';
import path from 'path';
import fs from 'fs';

// Allow 2 steps before/after (150 second window) to handle time drift and slow input
authenticator.options = { window: 2 };

// === 页面访问权限：所有可分配的页面 key（需与前端 MainLayout.navItems.key 保持一致）===
export const ALL_PAGE_KEYS = [
  'dashboard', 'accounts', 'quotas', 'regions',
  'billing', 'cleanup', 'tagcompliance', 'audit', 'settings',
];

// 规范化前端传来的 allowedPages：过滤非法 key，去重
function normalizeAllowedPages(input: any): string[] | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) return null;
  const set = new Set<string>();
  for (const key of input) {
    if (typeof key === 'string' && ALL_PAGE_KEYS.includes(key)) set.add(key);
  }
  return Array.from(set);
}

// 计算用户的最终可见页面列表：admin 拥有全部；viewer/partadmin 按 allowed_pages（旧数据无值视为全部）
function resolveAllowedPages(user: any): string[] {
  if (!user) return [];
  if (user.role === 'admin') return [...ALL_PAGE_KEYS];
  const stored = (user as any).allowed_pages;
  if (Array.isArray(stored)) return stored.filter((k: any) => typeof k === 'string' && ALL_PAGE_KEYS.includes(k));
  return [...ALL_PAGE_KEYS]; // 旧数据兼容：未设置视为全部
}

// 根用户凭证操作权限（独立于页面权限）：admin 恒有；其他角色按 root_access 显式授予。
// 控制账户"根用户"tab 的三个敏感功能：生成 Admin 临时凭证 / 删除 Root MFA / 恢复根密码。
export function resolveRootAccess(user: any): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (user as any).root_access === true;
}

// 批量 payer 提额权限（独立于页面权限，必须显式授予）。
// 该功能会对整个组织下所有账户批量提交提额请求，影响面大，故单独管控：
// admin 恒有；其他角色只有被显式勾选 bulk_quota_access 才可见、可用。
// 注意：它不在 ALL_PAGE_KEYS 里，因此无法通过「页面权限」复选框间接获得。
export function resolveBulkQuotaAccess(user: any): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (user as any).bulk_quota_access === true;
}

// 允许的用户角色
const VALID_ROLES = ['admin', 'partadmin', 'viewer'] as const;

// Load shared config for JWT secret and admin password
const CONFIG_PATH = path.join(__dirname, '../../config.json');
let config: any = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}

const JWT_SECRET = config.web?.jwtSecret || process.env.JWT_SECRET || (() => {
  // Auto-generate a secure JWT secret if not configured
  const crypto = require('crypto');
  const generated = crypto.randomBytes(32).toString('hex');
  console.warn('⚠️  No JWT_SECRET configured. Using auto-generated secret (sessions will reset on restart).');
  return generated;
})();
const TOKEN_EXPIRY = '2h';
const ADMIN_PASSWORD = config.web?.adminPassword || process.env.ADMIN_PASSWORD || 'admin123';

export const authRouter = Router();

function ensureAdminExists() {
  if (!db.getUser('admin')) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
    db.createUser({ username: 'admin', password_hash: hash, role: 'admin', mfa_enabled: false, mfa_secret: null });
    console.log(`⚠️  Admin user created. Password from config.json`);
  }
}

// Login
authRouter.post('/login', (req: Request, res: Response) => {
  ensureAdminExists();
  const { username, password, totpCode } = req.body;

  const user = db.getUser(username);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: '用户名或密码错误' });

  // MFA check
  if (user.mfa_enabled && user.mfa_secret) {
    if (!totpCode) return res.json({ requireMFA: true, message: '请输入 MFA 验证码' });
    const decryptedSecret = decryptField(user.mfa_secret);
    if (!authenticator.verify({ token: totpCode, secret: decryptedSecret })) {
      return res.status(401).json({ error: 'MFA 验证码错误' });
    }
  }

  const token = jwt.sign({ userId: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  db.addAuditLog(user.id, 'LOGIN', `IP: ${req.ip}`, user.username, req.ip);
  res.json({ token, username: user.username, role: user.role, mfaEnabled: !!user.mfa_enabled });
});

// Setup MFA
authRouter.post('/mfa/setup', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET) as any;
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(decoded.username, 'AWS-Toolbox', secret);
    QRCode.toDataURL(otpauth, (err, url) => {
      if (err) return res.status(500).json({ error: 'QR failed' });
      res.json({ secret, qrCode: url });
    });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

// Confirm MFA
authRouter.post('/mfa/confirm', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET) as any;
    const { secret, code } = req.body;
    if (!authenticator.verify({ token: code, secret })) return res.status(400).json({ error: '验证码错误' });
    db.updateUser(decoded.userId, { mfa_secret: encryptField(secret), mfa_enabled: true });
    res.json({ success: true });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

// Check auth
authRouter.get('/me', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET) as any;
    const user = db.getUser(decoded.username);
    res.json({
      username: decoded.username,
      // 角色以数据库为准，不用 JWT 里可能已过期的值：
      // 用户被降权后，其未过期 token 不应继续按旧角色渲染 UI。
      // 与 requireRootAccess / requireAuditAccess 的取值方式保持一致。
      role: user?.role ?? decoded.role,
      mfaEnabled: !!user?.mfa_enabled,
      allowedPages: resolveAllowedPages(user),
      rootAccess: resolveRootAccess(user),
      bulkQuotaAccess: resolveBulkQuotaAccess(user),
    });
  } catch { res.status(401).json({ error: 'Token expired' }); }
});

// Change password
authRouter.post('/change-password', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET) as any;
    const { currentPassword, newPassword } = req.body;
    const user = db.getUser(decoded.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: '当前密码错误' });
    }
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: '新密码至少 6 位' });
    }
    const hash = bcrypt.hashSync(newPassword, 12);
    db.updateUser(user.id, { password_hash: hash });
    db.addAuditLog(user.id, 'PASSWORD_CHANGE', `修改了自己的密码`, decoded.username, req.ip);
    res.json({ success: true, message: '密码已修改' });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

// === User Management (admin only) ===

// List all users
authRouter.get('/users', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET) as any;
    if (decoded.role !== 'admin') return res.status(403).json({ error: '无权限' });
    res.json({ success: true, data: db.getAllUsers() });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

// Create user
authRouter.post('/users', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET) as any;
    if (decoded.role !== 'admin') return res.status(403).json({ error: '无权限' });
    const { username, password, role, allowedPages, rootAccess, bulkQuotaAccess } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
    if (db.getUser(username)) return res.status(400).json({ error: '用户已存在' });
    const normalizedRole = role || 'viewer';
    if (!(VALID_ROLES as readonly string[]).includes(normalizedRole)) {
      return res.status(400).json({ error: '角色无效' });
    }
    // admin 忽略 allowed_pages（视为全部）；partadmin/viewer 按传入的规范化后存储
    const normalizedPages = normalizedRole === 'admin' ? null : normalizeAllowedPages(allowedPages);
    const hash = bcrypt.hashSync(password, 12);
    db.createUser({
      username,
      password_hash: hash,
      role: normalizedRole,
      mfa_enabled: false,
      mfa_secret: null,
      allowed_pages: normalizedPages,
      root_access: !!rootAccess, // admin 恒有（resolveRootAccess 里按角色判定），此处仅对非 admin 生效
      bulk_quota_access: !!bulkQuotaAccess, // 批量 payer 提额，同样 admin 恒有
    });
    db.addAuditLog(decoded.userId, 'USER_CREATE', `创建用户 ${username} (${normalizedRole}${rootAccess ? ', 根用户权限' : ''}${bulkQuotaAccess ? ', 批量提额权限' : ''})`, decoded.username, req.ip);
    res.json({ success: true, message: `用户 ${username} 已创建` });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

// Update user (role / allowedPages)
authRouter.put('/users/:id', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET) as any;
    if (decoded.role !== 'admin') return res.status(403).json({ error: '无权限' });
    const userId = parseInt(String(req.params.id), 10);
    if (Number.isNaN(userId)) return res.status(400).json({ error: 'ID 无效' });
    const data = (db as any).getAllUsers().find((u: any) => u.id === userId);
    if (!data) return res.status(404).json({ error: '用户不存在' });

    const { role, allowedPages, rootAccess, bulkQuotaAccess } = req.body;
    const updates: any = {};

    if (role !== undefined) {
      if (!(VALID_ROLES as readonly string[]).includes(role)) return res.status(400).json({ error: '角色无效' });
      // 不允许把自己降级
      if (userId === decoded.userId && role !== 'admin') {
        return res.status(400).json({ error: '不能修改自己的角色' });
      }
      updates.role = role;
    }

    const finalRole = updates.role ?? data.role;
    if (finalRole === 'admin') {
      // admin 拥有全部页面，清空 allowed_pages
      updates.allowed_pages = null;
    } else if (allowedPages !== undefined) {
      updates.allowed_pages = normalizeAllowedPages(allowedPages);
    }

    // 根用户凭证权限（独立开关）；admin 恒有，此处对非 admin 生效
    if (rootAccess !== undefined) {
      updates.root_access = !!rootAccess;
    }
    // 批量 payer 提额权限（独立开关）
    if (bulkQuotaAccess !== undefined) {
      updates.bulk_quota_access = !!bulkQuotaAccess;
    }

    db.updateUser(userId, updates);
    db.addAuditLog(
      decoded.userId,
      'USER_UPDATE',
      `更新用户 ${data.username}: role=${finalRole}, pages=${JSON.stringify(updates.allowed_pages ?? 'unchanged')}, 根用户权限=${updates.root_access ?? 'unchanged'}, 批量提额权限=${updates.bulk_quota_access ?? 'unchanged'}`,
      decoded.username,
      req.ip,
    );
    res.json({ success: true, message: '已更新' });
  } catch (e: any) { res.status(401).json({ error: e?.message || 'Invalid token' }); }
});

// Delete user
authRouter.delete('/users/:id', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET) as any;
    if (decoded.role !== 'admin') return res.status(403).json({ error: '无权限' });
    const userId = parseInt(String(req.params.id), 10);
    if (userId === decoded.userId) return res.status(400).json({ error: '不能删除自己' });
    db.deleteUser(userId);
    db.addAuditLog(decoded.userId, 'USER_DELETE', `删除用户 ID: ${userId}`, decoded.username, req.ip);
    res.json({ success: true });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

// Reset user password (admin)
authRouter.post('/users/:id/reset-password', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET) as any;
    if (decoded.role !== 'admin') return res.status(403).json({ error: '无权限' });
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    const userId = parseInt(String(req.params.id), 10);
    const hash = bcrypt.hashSync(newPassword, 12);
    db.updateUser(userId, { password_hash: hash });
    db.addAuditLog(decoded.userId, 'PASSWORD_RESET', `重置用户 ID: ${userId} 的密码`, decoded.username, req.ip);
    res.json({ success: true, message: '密码已重置' });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

// Auth middleware
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  // Support token via query param (for SSE/EventSource which can't set headers)
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.token as string);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    (req as any).user = decoded;
    // 强制 MFA：未绑定 MFA 的用户不能访问受保护的业务接口
    const user = db.getUser(decoded.username);
    if (!user?.mfa_enabled) {
      return res.status(403).json({ error: 'MFA_REQUIRED', message: '请先绑定 MFA 后再使用系统' });
    }
    next();
  } catch { return res.status(401).json({ error: 'Token expired' }); }
}
