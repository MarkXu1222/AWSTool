import { createHash, createHmac, randomBytes } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import type { MailApiConfig } from './mail-api';
import { readMailApiSsmConfig } from './mail-api-config';

export interface MailboxAdminLookupItem {
  email: string; domainHosted: boolean; exists: boolean; active: boolean; forwards: string[];
}
export interface MailboxAdminDeleteResult { deleted: number; removed: string[] }
export interface MailboxAdminPasswordResult { updated: true; sessionsKicked: number }

export class MailboxAdminApiError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode: number,
    readonly uncertain: boolean, readonly retryAfterMs: number = 0) {
    super(message);
    this.name = 'MailboxAdminApiError';
  }
}

const BASE_URL = 'https://admin.yottahub.ai';
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KNOWN_CODES = new Set([
  'INVALID_REQUEST', 'INVALID_EMAIL', 'INVALID_PASSWORD', 'SCOPE_DENIED', 'DOMAIN_NOT_HOSTED',
  'MAILBOX_NOT_FOUND', 'MAILBOX_DISABLED', 'AUTH_FAILED', 'IP_NOT_ALLOWED', 'NOT_FOUND',
  'HTTPS_REQUIRED', 'INTERNAL_ERROR',
]);

let ssmCache: { parameter: string; expires: number; value: Promise<MailApiConfig> } | undefined;

export function mailboxAdminApiConfigured(): boolean {
  const parameter = process.env.MAIL_ADMIN_API_SSM_PARAMETER?.trim();
  return !!parameter && parameter !== process.env.MAIL_API_SSM_PARAMETER?.trim();
}

async function adminConfig(): Promise<MailApiConfig> {
  const parameter = process.env.MAIL_ADMIN_API_SSM_PARAMETER?.trim();
  if (!parameter || parameter === process.env.MAIL_API_SSM_PARAMETER?.trim()) {
    throw new MailboxAdminApiError('邮箱写接口凭据未配置或与只读凭据共用', 'MAILBOX_CONFIG_UNAVAILABLE', 503, false);
  }
  if (!ssmCache || ssmCache.parameter !== parameter || ssmCache.expires <= Date.now()) {
    const entry = { parameter, expires: Date.now() + 600_000, value: readMailApiSsmConfig(parameter) };
    entry.value = entry.value.catch(() => {
      if (ssmCache === entry) ssmCache = undefined;
      throw new MailboxAdminApiError('邮箱写接口安全配置读取失败', 'MAILBOX_CONFIG_UNAVAILABLE', 503, false);
    });
    ssmCache = entry;
  }
  return ssmCache.value;
}

function normalizeEmail(value: string): string {
  if (typeof value !== 'string') throw new MailboxAdminApiError('邮箱格式无效', 'INVALID_EMAIL', 400, false);
  const email = value.trim().toLowerCase();
  if (!EMAIL.test(email) || /[\u0000-\u001f\u007f]/.test(email)) {
    throw new MailboxAdminApiError('邮箱格式无效', 'INVALID_EMAIL', 400, false);
  }
  return email;
}

function validDestinationList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(v));
}

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  const raw = header !== null && header.trim() !== '' && Number.isFinite(seconds)
    ? seconds * 1000 : Date.parse(header || '') - Date.now();
  return Math.min(600_000, Math.max(1_000, Number.isFinite(raw) ? raw : 60_000));
}

function invalidResponse(write: boolean, statusCode: number): MailboxAdminApiError {
  return new MailboxAdminApiError('邮箱接口响应格式无效', 'MAILBOX_INVALID_RESPONSE', statusCode, write);
}

function nonJsonResponse(write: boolean, statusCode: number): MailboxAdminApiError {
  if (statusCode >= 400 && statusCode < 500) {
    const fallback: Record<number, string> = { 400: 'INVALID_REQUEST', 401: 'AUTH_FAILED',
      403: 'IP_NOT_ALLOWED', 404: 'NOT_FOUND' };
    return providerError(fallback[statusCode] || 'INVALID_REQUEST', statusCode, undefined);
  }
  return invalidResponse(write, statusCode);
}

function providerError(code: string, statusCode: number, msg: unknown): MailboxAdminApiError {
  const known = KNOWN_CODES.has(code) ? code : 'INTERNAL_ERROR';
  let message = '邮箱接口请求失败';
  if (known === 'INTERNAL_ERROR') {
    message = statusCode === 500 && typeof msg === 'string' && msg.startsWith('doveadm who failed')
      ? '查询在线会话失败'
      : statusCode === 500 && typeof msg === 'string' && msg.startsWith('doveadm kick failed')
        ? '踢出旧会话失败' : '邮箱服务内部错误';
  }
  return new MailboxAdminApiError(message, known, statusCode, false);
}

/** Separate credentials and queue from the read-only mail index client. */
export class MailboxAdminApiClient {
  private tail: Promise<unknown> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(private readonly config: () => Promise<MailApiConfig> = adminConfig,
    private readonly transport: typeof fetch = fetch, private readonly intervalMs = 1_250,
    private readonly timeoutMs = 15_000) {}

  private request(path: '/Api/Mailbox/lookup' | '/Api/Mailbox/forwards/delete' | '/Api/Mailbox/password',
    payload: unknown, write: boolean, signal?: AbortSignal): Promise<unknown> {
    const run = async () => {
      signal?.throwIfAborted();
      const wait = this.nextRequestAt - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      signal?.throwIfAborted();
      const config = await this.config();
      signal?.throwIfAborted();
      const body = JSON.stringify(payload);
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        throw new MailboxAdminApiError('邮箱接口请求过大', 'INVALID_REQUEST', 400, false);
      }
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const hash = createHash('sha256').update(body).digest('hex');
      const signature = createHmac('sha256', config.secret)
        .update(`POST|${path}|${timestamp}|${nonce}|${hash}`).digest('hex');
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      this.nextRequestAt = Date.now() + this.intervalMs;

      let response: Response;
      try {
        response = await this.transport(`${BASE_URL}${path}`, {
          method: 'POST', redirect: 'error', signal: combined, body,
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.keyId,
            'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature },
        });
      } catch {
        throw new MailboxAdminApiError('邮箱接口连接中断，结果未知', 'MAILBOX_WRITE_UNKNOWN', 0, write);
      }
      if (response.status === 429) {
        const retry = retryAfterMs(response.headers.get('Retry-After'));
        this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + retry);
        await response.body?.cancel().catch(() => {});
        throw new MailboxAdminApiError('邮箱接口限流', 'RATE_LIMITED', 429, false, retry);
      }
      if (response.redirected || response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw invalidResponse(write, response.status);
      }

      const reader = response.body?.getReader();
      if (!reader) throw nonJsonResponse(write, response.status);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new MailboxAdminApiError('邮箱接口响应中断，结果未知',
          'MAILBOX_WRITE_UNKNOWN', response.status, write));
        combined.addEventListener('abort', onAbort, { once: true });
        if (combined.aborted) onAbort();
      });
      try {
        while (true) {
          const part = await Promise.race([reader.read(), aborted]);
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > MAX_RESPONSE_BYTES) throw invalidResponse(write, response.status);
          chunks.push(part.value);
        }
      } catch (error) {
        if (error instanceof MailboxAdminApiError) throw error;
        throw new MailboxAdminApiError('邮箱接口响应中断，结果未知', 'MAILBOX_WRITE_UNKNOWN', response.status, write);
      } finally {
        if (onAbort) combined.removeEventListener('abort', onAbort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      let envelope: unknown;
      try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw nonJsonResponse(write, response.status); }
      if (!envelope || typeof envelope !== 'object') throw invalidResponse(write, response.status);
      const result = envelope as Record<string, unknown>;
      if (result.status === 0 && typeof result.code === 'string') {
        throw providerError(result.code, response.status, path.endsWith('/password') ? result.msg : undefined);
      }
      if (!response.ok) {
        const fallback: Record<number, string> = { 400: 'INVALID_REQUEST', 401: 'AUTH_FAILED',
          403: 'IP_NOT_ALLOWED', 404: 'NOT_FOUND' };
        throw providerError(fallback[response.status] || 'INTERNAL_ERROR', response.status, undefined);
      }
      if (result.status !== 1 || !result.data || typeof result.data !== 'object') {
        throw invalidResponse(write, response.status);
      }
      return result.data;
    };
    const pending = this.tail.then(run, run);
    this.tail = pending.catch(() => {});
    return pending;
  }

  async lookup(emails: string[], signal?: AbortSignal): Promise<MailboxAdminLookupItem[]> {
    if (!Array.isArray(emails) || emails.length === 0) {
      throw new MailboxAdminApiError('邮箱列表无效', 'INVALID_REQUEST', 400, false);
    }
    const normalized = [...new Set(emails.map(normalizeEmail))];
    if (normalized.length > 100) throw new MailboxAdminApiError('邮箱列表过长', 'INVALID_REQUEST', 400, false);
    const data = await this.request('/Api/Mailbox/lookup', { emails: normalized }, false, signal) as Record<string, unknown>;
    const items = data.items;
    if (!Array.isArray(items) || items.length !== normalized.length) throw invalidResponse(false, 200);
    const seen = new Set<string>();
    for (const [index, value] of items.entries()) {
      if (!value || typeof value !== 'object') throw invalidResponse(false, 200);
      const item = value as Record<string, unknown>;
      if (typeof item.email !== 'string' || item.email !== normalized[index] || seen.has(item.email)
        || typeof item.domainHosted !== 'boolean' || typeof item.exists !== 'boolean'
        || typeof item.active !== 'boolean' || !validDestinationList(item.forwards)) throw invalidResponse(false, 200);
      seen.add(item.email);
    }
    return items as MailboxAdminLookupItem[];
  }

  async deleteForwards(email: string, signal?: AbortSignal): Promise<MailboxAdminDeleteResult> {
    const data = await this.request('/Api/Mailbox/forwards/delete', { email: normalizeEmail(email) }, true, signal) as Record<string, unknown>;
    if (!Number.isSafeInteger(data.deleted) || (data.deleted as number) < 0 || !validDestinationList(data.removed)) {
      throw invalidResponse(true, 200);
    }
    return data as unknown as MailboxAdminDeleteResult;
  }

  async setPassword(email: string, password: string, signal?: AbortSignal): Promise<MailboxAdminPasswordResult> {
    if (typeof password !== 'string' || password.length < 12 || password.length > 32
      || !/^[!-~]+$/.test(password) || /['"\\`]/.test(password)) {
      throw new MailboxAdminApiError('邮箱密码格式无效', 'INVALID_PASSWORD', 400, false);
    }
    const data = await this.request('/Api/Mailbox/password', { email: normalizeEmail(email), password }, true, signal) as Record<string, unknown>;
    if (data.updated !== true || !Number.isSafeInteger(data.sessionsKicked) || (data.sessionsKicked as number) < 0) {
      throw invalidResponse(true, 200);
    }
    return data as unknown as MailboxAdminPasswordResult;
  }
}

export const mailboxAdmin = new MailboxAdminApiClient();
