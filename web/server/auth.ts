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
  db.addAuditLog(user.id, 'LOGIN', `IP: ${req.ip}`, user.username);
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
    res.json({ username: decoded.username, role: decoded.role, mfaEnabled: !!user?.mfa_enabled });
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
    db.addAuditLog(user.id, 'PASSWORD_CHANGE', `修改了自己的密码`, decoded.username);
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
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
    if (db.getUser(username)) return res.status(400).json({ error: '用户已存在' });
    const hash = bcrypt.hashSync(password, 12);
    db.createUser({ username, password_hash: hash, role: role || 'viewer', mfa_enabled: false, mfa_secret: null });
    db.addAuditLog(decoded.userId, 'USER_CREATE', `创建用户 ${username} (${role || 'viewer'})`, decoded.username);
    res.json({ success: true, message: `用户 ${username} 已创建` });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

// Delete user
authRouter.delete('/users/:id', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET) as any;
    if (decoded.role !== 'admin') return res.status(403).json({ error: '无权限' });
    const userId = parseInt(req.params.id);
    if (userId === decoded.userId) return res.status(400).json({ error: '不能删除自己' });
    db.deleteUser(userId);
    db.addAuditLog(decoded.userId, 'USER_DELETE', `删除用户 ID: ${userId}`, decoded.username);
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
    const userId = parseInt(req.params.id);
    const hash = bcrypt.hashSync(newPassword, 12);
    db.updateUser(userId, { password_hash: hash });
    db.addAuditLog(decoded.userId, 'PASSWORD_RESET', `重置用户 ID: ${userId} 的密码`, decoded.username);
    res.json({ success: true, message: '密码已重置' });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

// Auth middleware
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET) as any;
    (req as any).user = decoded;
    next();
  } catch { return res.status(401).json({ error: 'Token expired' }); }
}
