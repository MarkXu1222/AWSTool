import { createHash, createHmac, randomBytes } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import type { RootRecoveryMail } from './root-mail-links';
import { readMailApiSsmConfig } from './mail-api-config';

export interface MailApiConfig { keyId: string; secret: string }
export interface MailRecord {
  id: number; msg_key: string; domain: string; direction: string; timestamp: number;
  from: string; to: string; subject: string;
}
export interface MailList { list: MailRecord[]; next_since: number; has_more: boolean }
export class MailApiError extends Error {
  constructor(message: string, public retryAfterMs = 0) { super(message); }
}

let ssmCache: { parameter: string; expires: number; value: Promise<MailApiConfig> } | undefined;
export function mailApiConfigured() { return !!(process.env.MAIL_API_SECRET?.trim() || process.env.MAIL_API_SSM_PARAMETER); }
export async function mailApiConfig(): Promise<MailApiConfig> {
  const keyId = process.env.MAIL_API_KEY_ID || 'toolbox';
  const secret = process.env.MAIL_API_SECRET?.trim();
  if (secret) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) throw new MailApiError('邮箱 API key_id 配置无效');
    return { keyId, secret };
  }
  const parameter = process.env.MAIL_API_SSM_PARAMETER;
  if (!parameter) throw new MailApiError('邮箱 API 后端凭据未配置');
  if (!ssmCache || ssmCache.parameter !== parameter || ssmCache.expires <= Date.now()) {
    ssmCache = { parameter, expires: Date.now() + 600_000, value: readMailApiSsmConfig(parameter).catch(() => {
      ssmCache = undefined;
      throw new MailApiError('邮箱 API 安全配置读取失败，请检查 Parameter Store 和 AWS CLI', 30_000);
    }) };
  }
  return ssmCache.value;
}

export function mailSignature(secret: string, path: string, timestamp: string, nonce: string) {
  const bodyHash = createHash('sha256').update('').digest('hex');
  return createHmac('sha256', secret).update(`GET|${path}|${timestamp}|${nonce}|${bodyHash}`).digest('hex');
}

export function mailRecipients(value: string): string[] {
  return [...new Set((value.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+/g) || []).map(s => s.toLowerCase()))];
}
export function mailRecordMatches(record: MailRecord, email: string, requestedAt: string) {
  const requested = Date.parse(requestedAt);
  return record.direction === 'receive' && record.domain.toLowerCase() === email.split('@')[1].toLowerCase()
    && mailRecipients(record.to).includes(email.toLowerCase()) && Number.isFinite(requested)
    && record.timestamp * 1000 >= requested && record.timestamp * 1000 <= Date.now() + 60_000;
}

/** Shared client serializes requests to stay below the provider's 60/minute key limit. */
export class MailApiClient {
  private tail: Promise<unknown> = Promise.resolve();
  private nextRequestAt = 0;
  constructor(private readonly config: () => MailApiConfig | Promise<MailApiConfig> = mailApiConfig,
    private readonly transport: typeof fetch = fetch, private readonly intervalMs = 1_250) {}

  private request(action: 'list' | 'detail', params: Record<string, string>, signal?: AbortSignal): Promise<any> {
    const run = async () => {
      signal?.throwIfAborted();
      const wait = this.nextRequestAt - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      const config = await this.config();
      const path = `/Api/Maillog/${action}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(16).toString('hex');
      this.nextRequestAt = Date.now() + this.intervalMs;
      const timeout = AbortSignal.timeout(15_000);
      let response: Response;
      try {
        response = await this.transport(`https://admin.yottahub.ai${path}?${new URLSearchParams(params)}`, {
          method: 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { 'X-Api-Key': config.keyId, 'X-Timestamp': timestamp, 'X-Nonce': nonce,
            'X-Signature': mailSignature(config.secret, path, timestamp, nonce) },
        });
      } catch { signal?.throwIfAborted(); throw new MailApiError('邮箱 API 连接失败，将稍后重试', 30_000); }
      if (response.status === 429) {
        const retryHeader = response.headers.get('retry-after') || '60';
        const seconds = Number(retryHeader);
        const retry = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryHeader) - Date.now();
        const retryAfter = Math.min(600_000, Math.max(60_000, Number.isFinite(retry) ? retry : 60_000));
        this.nextRequestAt = Date.now() + retryAfter;
        await response.body?.cancel();
        throw new MailApiError('邮箱 API 限流，正在等待重试', retryAfter);
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new MailApiError('邮箱 API 鉴权失败，请检查密钥、签名或服务器时间');
        if (response.status === 403) throw new MailApiError('邮箱 API 拒绝访问，请检查出口 IP 和域名权限');
        if (response.status === 404) throw new MailApiError('邮件记录或原文件不存在');
        throw new MailApiError('邮箱 API 服务异常', response.status >= 500 ? 30_000 : 0);
      }
      // Bound JSON responses as well as the provider's 5 MB decoded message limit.
      const reader = response.body?.getReader();
      if (!reader) throw new MailApiError('邮箱 API 返回空响应');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 16_000_000) { await reader.cancel(); throw new MailApiError('邮箱 API 响应过大'); }
          chunks.push(part.value);
        }
      } catch (error) {
        if (error instanceof MailApiError) throw error;
        signal?.throwIfAborted(); throw new MailApiError('邮箱 API 响应读取中断', 30_000);
      } finally { reader.releaseLock(); }
      let data: any;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new MailApiError('邮箱 API 返回了非 JSON 内容'); }
      if (data?.status !== 1 || !data.data) throw new MailApiError('邮箱 API 返回业务错误，请检查服务端配置');
      return data.data;
    };
    const promise = this.tail.then(run, run);
    this.tail = promise.catch(() => {});
    return promise;
  }

  async list(email: string, since: number, signal?: AbortSignal): Promise<MailList> {
    const data = await this.request('list', { since_id: String(since), limit: '100', direction: 'receive',
      domain: email.split('@')[1], search: email }, signal);
    if (!Array.isArray(data.list) || data.list.length > 200 || !Number.isSafeInteger(data.next_since)
      || data.next_since < since || typeof data.has_more !== 'boolean'
      || data.list.some((r: any) => !r || !Number.isSafeInteger(r.id) || r.id <= since || r.id > data.next_since
        || !/^[a-f0-9]{64}$/i.test(r.msg_key) || !Number.isFinite(r.timestamp)
        || !['domain', 'direction', 'to', 'from', 'subject'].every(k => typeof r[k] === 'string'))) {
      throw new MailApiError('邮箱 API 列表或游标格式无效');
    }
    // The live provider reports has_more=true on an empty filtered page even
    // when next_since does not advance. Poll later instead of spinning forever.
    return { list: data.list, next_since: data.next_since,
      has_more: data.has_more && data.next_since > since };
  }
  async detail(key: string, signal?: AbortSignal): Promise<RootRecoveryMail> {
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new MailApiError('邮件标识格式无效');
    const data = await this.request('detail', { msg_key: key }, signal);
    if (data.msg_key !== key || data.direction !== 'receive' || typeof data.to !== 'string'
      || !Number.isFinite(data.timestamp) || !Number.isSafeInteger(data.id)
      || (data.body_text != null && typeof data.body_text !== 'string')
      || (data.body_html != null && typeof data.body_html !== 'string')) throw new MailApiError('邮箱 API 邮件详情格式无效');
    return { id: String(data.id), recipients: mailRecipients(data.to), receivedAt: new Date(data.timestamp * 1000).toISOString(),
      text: data.body_text || '', html: data.body_html || '' };
  }
}

export const mailbox = new MailApiClient();
