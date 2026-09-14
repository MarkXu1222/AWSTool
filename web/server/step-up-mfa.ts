import { createHmac, randomBytes } from 'crypto';
import { authenticator } from 'otplib';
import { db, decryptField } from './db';

export class StepUpMfaError extends Error {
  constructor(message: string, public readonly statusCode: number) { super(message); }
}

const ATTEMPT_WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const attempts = new Map<string, number[]>();
const usedTokens = new Map<string, number>();
const replaySalt = randomBytes(32);

function recordAttempt(identity: { id: number | string }, ip?: string): void {
  const now = Date.now();
  const cleanIp = (ip || 'unknown').replace('::ffff:', '');
  for (const key of [`user:${identity.id}`, `ip:${cleanIp}`]) {
    const recent = (attempts.get(key) || []).filter(time => now - time <= ATTEMPT_WINDOW_MS);
    recent.push(now);
    attempts.set(key, recent);
    if (recent.length > MAX_ATTEMPTS) throw new StepUpMfaError('MFA 二次验证尝试过多，请 5 分钟后重试', 429);
  }
  if (attempts.size > 1000) attempts.delete(attempts.keys().next().value!);
}

/** Re-read the current user and consume a fresh TOTP once for a high-risk operation. */
export function verifyStepUpTotp(identity: { id: number | string; username: string }, value: unknown, ip?: string): void {
  recordAttempt(identity, ip);
  const user = db.getUser(identity.username);
  if (!user || String(user.id) !== String(identity.id)) {
    throw new StepUpMfaError('用户身份已变更，请重新登录', 401);
  }
  if (!user.mfa_enabled || !user.mfa_secret) {
    throw new StepUpMfaError('当前用户未绑定 MFA，不能执行此高风险操作', 403);
  }
  const token = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{6}$/.test(token)) throw new StepUpMfaError('请输入 6 位 MFA 验证码', 400);
  if (!authenticator.verify({ token, secret: decryptField(user.mfa_secret) })) {
    // Use 403 rather than 401 so the API client does not discard an otherwise valid JWT.
    throw new StepUpMfaError('MFA 验证码错误', 403);
  }

  const now = Date.now();
  for (const [key, expiresAt] of usedTokens) if (expiresAt <= now) usedTokens.delete(key);
  const replayKey = createHmac('sha256', replaySalt).update(`${user.id}:${token}`).digest('hex');
  if (usedTokens.has(replayKey)) {
    throw new StepUpMfaError('此 MFA 验证码已用于高风险操作，请等待下一组验证码', 409);
  }
  // auth.ts accepts ±2 time steps; retain the token hash beyond that complete acceptance window.
  usedTokens.set(replayKey, now + 5 * 60_000);
}
