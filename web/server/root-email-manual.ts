import { randomUUID } from 'crypto';
import { RootEmailError } from './root-email-core';

export const ROOT_MANUAL_CAPTCHA_TTL_MS = 10 * 60_000;
export type RootManualCaptchaAction = { action: 'refresh' } | { action: 'submit'; captchaAnswer: string };
export interface RootManualCaptchaView {
  challengeId: string;
  image: string;
  purpose: 'identity' | 'recovery';
  expiresAt: string;
}

/** One-use, in-memory handoff. Images and answers never enter the persistent job store. */
export class RootEmailManualInput {
  private pending?: { view: RootManualCaptchaView; resolve: (action: RootManualCaptchaAction) => void };
  constructor(private readonly signal: AbortSignal, private readonly authorize: () => void) {}
  get available() { return !!this.pending; }
  get expiresAt() { return this.pending?.view.expiresAt; }

  view(): RootManualCaptchaView {
    this.signal.throwIfAborted();
    this.authorize();
    if (!this.pending || Date.parse(this.pending.view.expiresAt) <= Date.now()) {
      throw new RootEmailError('人工验证码已过期或正在处理，请刷新任务状态', 409);
    }
    return { ...this.pending.view };
  }
  respond(challengeId: unknown, action: unknown, captchaAnswer?: unknown) {
    const view = this.view();
    if (challengeId !== view.challengeId) throw new RootEmailError('验证码图片已更新，请重新打开手工输入', 409);
    const answer = typeof captchaAnswer === 'string' ? captchaAnswer.trim() : '';
    if (action !== 'refresh' && (action !== 'submit' || !/^[A-Za-z0-9]{6}$/.test(answer))) {
      throw new RootEmailError('请输入图片中的 6 位字母或数字', 400);
    }
    const pending = this.pending!;
    this.pending = undefined; // Seal before resolving, so double clicks and stale clients cannot replay it.
    pending.resolve(action === 'refresh' ? { action } : { action: 'submit', captchaAnswer: answer });
  }
  async wait(image: Buffer, purpose: 'identity' | 'recovery', deadline: number): Promise<RootManualCaptchaAction> {
    this.signal.throwIfAborted();
    this.authorize();
    if (this.pending) throw new RootEmailError('已有人工验证码等待处理', 409);
    if (deadline <= Date.now()) throw new RootEmailError('人工验证码等待超过 10 分钟，任务已停止', 408);
    let timeout: NodeJS.Timeout | undefined;
    let permissions: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<RootManualCaptchaAction>((resolve, reject) => {
        this.pending = { resolve, view: { challengeId: randomUUID(), purpose,
          image: `data:image/png;base64,${image.toString('base64')}`, expiresAt: new Date(deadline).toISOString() } };
        timeout = setTimeout(() => reject(new RootEmailError('人工验证码等待超过 10 分钟，任务已停止', 408)), deadline - Date.now());
        permissions = setInterval(() => { try { this.authorize(); } catch (error) { reject(error); } }, 1_000);
        onAbort = () => reject(this.signal.reason || new RootEmailError('任务已停止'));
        this.signal.addEventListener('abort', onAbort, { once: true });
      });
    } finally {
      this.pending = undefined;
      if (timeout) clearTimeout(timeout);
      if (permissions) clearInterval(permissions);
      if (onAbort) this.signal.removeEventListener('abort', onAbort);
    }
  }
}
