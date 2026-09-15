import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import type { Browser, Page } from 'puppeteer-core';
import { RootEmailError, RootEmailSession } from './root-email-core';

export function rootEmailRuntime() {
  const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => {
    try { if (p) { fs.accessSync(p, fs.constants.X_OK); return true; } } catch {}
    return false;
  });
  const python = process.env.ROOT_EMAIL_PYTHON
    || (process.platform === 'darwin' ? path.join(os.homedir(), '.cache/aws-ocr-lab/venv/bin/python') : '');
  const script = process.env.ROOT_EMAIL_OCR_SCRIPT || path.resolve(__dirname, 'scripts/root-email-ocr.py');
  const display = process.env.ROOT_EMAIL_DISPLAY || (process.platform === 'linux' ? ':99' : '');
  if (!chrome) throw new RootEmailError('未安装 Chrome 或未配置 CHROME_PATH', 503);
  try { fs.accessSync(python, fs.constants.X_OK); fs.accessSync(script, fs.constants.R_OK); }
  catch { throw new RootEmailError('请配置 ROOT_EMAIL_PYTHON 和 OCR 脚本，详见部署文档', 503); }
  if (process.platform === 'linux' && (!/^:\d+$/.test(display) || !fs.existsSync(`/tmp/.X11-unix/X${display.slice(1)}`))) {
    throw new RootEmailError('恢复邮件执行器需要可用的 Xvfb 显示器（ROOT_EMAIL_DISPLAY）', 503);
  }
  return { chrome, python, script, display };
}

export function runRootEmailOcr(image: Buffer | null, signal?: AbortSignal): Promise<{ candidate?: string | null; ready?: boolean }> {
  const runtime = rootEmailRuntime();
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.python, [runtime.script, ...(image ? [] : ['--check'])], {
      stdio: ['pipe', 'pipe', 'pipe'], signal, env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', data => {
      output += data.toString();
      if (output.length > 16_384) child.kill('SIGKILL');
    });
    // Native library diagnostics may contain paths; do not persist or return them in task history.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new RootEmailError('本地 OCR 进程无法启动', 503)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new RootEmailError('本地 OCR 不可用，请检查 Python 依赖和模型文件', 503));
      try { resolve(JSON.parse(output.trim())); }
      catch { reject(new RootEmailError('本地 OCR 返回格式无效', 503)); }
    });
    child.stdin.end(image || undefined);
  });
}

export type RootEmailEntryState = 'waiting' | 'verify' | 'identity' | 'forgot' | 'blocked' | 'changed';
export type RootEmailVerifyAction = 'ready' | 'not_ready' | 'blocked' | 'changed';
export type RootEmailCaptchaResult = 'waiting' | 'sent' | 'identity_verified' | 'invalid' | 'blocked' | 'disabled';

class RootEmailBrowserReadTimeout extends Error {}

/** Self-contained browser function: AWS can replace the execution context immediately after Next. */
export function readRootEmailEntryState(): RootEmailEntryState {
  const doc = (globalThis as any).document;
  const text = String(doc.body?.innerText || '');
  if (/too many|rate.?limit|try again later|temporarily blocked/i.test(text)) return 'blocked';
  if (doc.querySelector('#captcha_image')) return 'identity';
  if (/Forgot password\?/i.test(text)) return 'forgot';
  if (!/Making sure it(?:'|’)?s you/i.test(text)) return 'waiting';
  let candidates = 0;
  for (const element of doc.querySelectorAll('button')) {
    const label = String(element.innerText || element.getAttribute('aria-label') || '').trim();
    if (label !== 'Verify' || element.disabled) continue;
    const style = (globalThis as any).getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0) candidates++;
  }
  if (candidates > 1) return 'changed';
  return candidates === 1 ? 'verify' : 'waiting';
}

/** Identify one concrete Verify button handle before the action boundary. */
export function isRootEmailVerificationCandidate(element: any): boolean {
  const label = String(element.innerText || element.getAttribute('aria-label') || '').trim();
  if (label !== 'Verify' || element.disabled) return false;
  const style = (globalThis as any).getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
}

/** Revalidate the same concrete button and its page context immediately before a trusted click. */
export function validateRootEmailVerificationCandidate(candidate: any): RootEmailVerifyAction {
  const doc = (globalThis as any).document;
  const text = String(doc.body?.innerText || '');
  if (/too many|rate.?limit|try again later|temporarily blocked/i.test(text)) return 'blocked';
  if (!/Making sure it(?:'|’)?s you/i.test(text) || doc.querySelector('#captcha_image') || /Forgot password\?/i.test(text)) {
    return 'not_ready';
  }
  let matches = 0;
  let selected = false;
  for (const element of doc.querySelectorAll('button')) {
    const label = String(element.innerText || element.getAttribute('aria-label') || '').trim();
    if (label !== 'Verify' || element.disabled) continue;
    const style = (globalThis as any).getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.visibility === 'hidden' || style.display === 'none' || rect.width <= 0 || rect.height <= 0) continue;
    matches++;
    if (element === candidate) selected = true;
  }
  if (matches > 1) return 'changed';
  return matches === 1 && selected ? 'ready' : 'not_ready';
}

/** Self-contained browser function used repeatedly across CAPTCHA-triggered navigations. */
export function readRootEmailCaptchaResult(identityStage: boolean): RootEmailCaptchaResult {
  const text = String((globalThis as any).document.body?.innerText || '');
  if (/too many|rate.?limit|try again later|temporarily blocked/i.test(text)) return 'blocked';
  if (/Password email sent/i.test(text)) return 'sent';
  if (identityStage && /Forgot password\?/i.test(text)) return 'identity_verified';
  if (/incorrect verification|incorrect captcha|invalid captcha|characters.*(?:incorrect|did not match)|(?:incorrect|invalid).*characters/i.test(text)) return 'invalid';
  if (/password recovery.*(?:disabled|not allowed)|contact.*administrator/i.test(text)) return 'disabled';
  return 'waiting';
}

/** All selectors reflect the AWS root sign-in/recovery UI, not the federated PDF flow. */
export class AwsRootEmailSession implements RootEmailSession {
  private browser?: Browser;
  private page?: Page;
  private profile?: string;
  private captchaPurpose: 'identity' | 'recovery' = 'recovery';
  private expectedEmail = '';
  constructor(private readonly signal: AbortSignal, private readonly authorize: () => void) {}
  private checkedPage() {
    this.signal.throwIfAborted();
    this.authorize();
    if (!this.page) throw new RootEmailError('浏览器尚未就绪', 503);
    const url = new URL(this.page.url());
    if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)?signin\.aws\.amazon\.com$/.test(url.hostname)) {
      throw new RootEmailError('当前页面不是 AWS 官方登录域名，已停止', 422);
    }
    return this.page;
  }
  private async click(name: string) {
    const page = this.checkedPage();
    await page.locator(`::-p-aria(${name})`).click();
  }
  private async pause(milliseconds: number) {
    await new Promise(resolve => setTimeout(resolve, milliseconds));
    this.signal.throwIfAborted();
  }
  private async boundedEvaluate<T>(operation: Promise<T>, deadline: number): Promise<T> {
    const timeoutMs = Math.max(1, Math.min(2_000, deadline - Date.now()));
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new RootEmailBrowserReadTimeout('AWS 页面状态读取超时')), timeoutMs);
          onAbort = () => reject(this.signal.reason || new Error('任务已停止'));
          this.signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) this.signal.removeEventListener('abort', onAbort);
    }
  }
  private async clickVerificationOnce(deadline: number): Promise<boolean> {
    const page = this.checkedPage();
    const handles = await this.boundedEvaluate(page.$$('button'), deadline);
    let candidate: (typeof handles)[number] | undefined;
    let matches = 0;
    try {
      for (const handle of handles) {
        if (await this.boundedEvaluate(handle.evaluate(isRootEmailVerificationCandidate), deadline)) {
          candidate = handle;
          matches++;
        }
      }
      if (matches > 1) throw new RootEmailError('AWS 登录验证页出现多个 Verify 控件，已停止', 422);
      if (!candidate) return false;
      await candidate.scrollIntoView();
      this.checkedPage();
      const state = await this.boundedEvaluate(
        candidate.evaluate(validateRootEmailVerificationCandidate), deadline,
      );
      if (state === 'blocked') throw new RootEmailError('AWS 提示登录验证请求受限，请稍后再试', 429);
      if (state === 'changed') throw new RootEmailError('AWS 登录验证页出现多个 Verify 控件，已停止', 422);
      if (state !== 'ready') return false;
      const box = await candidate.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) return false;
      const trustedPage = this.checkedPage();
      if (Date.now() >= deadline) throw new Error('AWS Verify action deadline exceeded');
      await trustedPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return true;
    } finally {
      await Promise.allSettled(handles.map(handle => handle.dispose()));
    }
  }
  private async waitForEntry(): Promise<'identity' | 'forgot'> {
    const deadline = Date.now() + 30_000;
    let lastBrowserError: unknown;
    let verifyStarted = false;
    while (Date.now() < deadline) {
      try {
        const page = this.checkedPage();
        const result = await this.boundedEvaluate(page.evaluate(readRootEmailEntryState), deadline);
        lastBrowserError = undefined;
        if (result === 'blocked') throw new RootEmailError('AWS 提示登录验证请求受限，请稍后再试', 429);
        if (result === 'changed') throw new RootEmailError('AWS 登录验证页出现多个 Verify 控件，已停止', 422);
        if (result === 'identity' || result === 'forgot') return result;
        if (result === 'verify' && !verifyStarted) {
          // Lock before the side effect: a lost execution-context response must never click twice in this session.
          verifyStarted = true;
          const clicked = await this.clickVerificationOnce(deadline);
          if (!clicked) verifyStarted = false;
        }
      } catch (error) {
        if (error instanceof RootEmailError || error instanceof RootEmailBrowserReadTimeout || this.signal.aborted) throw error;
        lastBrowserError = error;
      }
      await this.pause(250);
    }
    if (lastBrowserError) throw lastBrowserError;
    throw new Error('AWS login entry state did not become explicit');
  }
  private async waitForCaptchaResult(identityStage: boolean): Promise<Exclude<RootEmailCaptchaResult, 'waiting'>> {
    const deadline = Date.now() + 30_000;
    let lastBrowserError: unknown;
    while (Date.now() < deadline) {
      try {
        const result = await this.boundedEvaluate(
          this.checkedPage().evaluate(readRootEmailCaptchaResult, identityStage), deadline,
        );
        lastBrowserError = undefined;
        if (result !== 'waiting') return result;
      } catch (error) {
        if (error instanceof RootEmailError || error instanceof RootEmailBrowserReadTimeout || this.signal.aborted) throw error;
        lastBrowserError = error;
      }
      await this.pause(250);
    }
    if (lastBrowserError) throw lastBrowserError;
    throw new Error('AWS CAPTCHA result did not become explicit');
  }
  private async enterRecoveryCaptcha() {
    const page = this.checkedPage();
    await page.locator('::-p-aria(Forgot password?)').wait();
    const matches = await page.evaluate((address: string) => {
      const doc = (globalThis as any).document;
      return String(doc.body?.innerText || '').toLowerCase().includes(address.toLowerCase());
    }, this.expectedEmail);
    if (!matches) throw new RootEmailError('AWS 页面显示的账户邮箱不匹配', 422);
    await this.click('Forgot password?');
    await page.waitForSelector('#captcha_image', { visible: true });
    this.captchaPurpose = 'recovery';
  }
  async open(email: string) {
    const runtime = rootEmailRuntime();
    const { default: puppeteer } = await import('puppeteer-core');
    this.expectedEmail = email;
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-root-email-'));
    this.browser = await puppeteer.launch({
      executablePath: runtime.chrome, headless: false, userDataDir: this.profile,
      defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
      args: ['--no-first-run', '--no-default-browser-check', '--lang=en-US', '--disable-dev-shm-usage'],
      env: runtime.display ? { ...process.env, DISPLAY: runtime.display } : process.env,
      timeout: 15_000, signal: this.signal,
    });
    this.page = await this.browser.newPage();
    this.page.setDefaultTimeout(25_000);
    this.page.setDefaultNavigationTimeout(30_000);
    await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await this.page.goto('https://console.aws.amazon.com/', { waitUntil: 'domcontentloaded' });
    await this.page.waitForFunction(`!!document.querySelector('#root_account_signin, #root_user_radio_button')`, { signal: this.signal });
    if (await this.page.$('#root_account_signin')) await this.page.click('#root_account_signin');
    await this.page.waitForSelector('#root_user_radio_button', { visible: true });
    this.checkedPage();
    await this.page.click('#root_user_radio_button');
    await this.page.locator('#resolving_input').fill(email);
    await this.page.click('#next_button');
    const entry = await this.waitForEntry();
    if (entry === 'identity') {
      this.captchaPurpose = 'identity';
      return;
    }
    await this.enterRecoveryCaptcha();
  }
  isRecoveryCaptcha() { return this.captchaPurpose === 'recovery'; }
  private async capture() {
    const page = this.checkedPage();
    await page.waitForFunction(`(() => { const i = document.querySelector('#captcha_image'); return i && i.complete && i.naturalWidth > 0; })()`, { signal: this.signal });
    const element = await page.$('#captcha_image');
    if (!element) throw new RootEmailError('验证码类型已变化，需要人工检查', 422);
    try {
      const image = Buffer.from(await element.screenshot({ type: 'png' }));
      return { image, imageId: createHash('sha256').update(image).digest('hex') };
    } finally { await element.dispose(); }
  }
  async recognize() {
    const { image, imageId } = await this.capture();
    const { candidate } = await runRootEmailOcr(image, this.signal);
    return { imageId, candidate: typeof candidate === 'string' ? candidate : null };
  }
  async refresh(previousImageId: string) {
    const page = this.checkedPage();
    await page.locator('::-p-aria(Type the characters as shown above)').fill('');
    // AWS can replace the image itself after rejection; only click refresh if it is still the old one.
    if ((await this.capture()).imageId !== previousImageId) return;
    const previousSrc = await page.$eval('#captcha_image', el => (el as any).src);
    await this.click('Refresh Captcha');
    await page.waitForFunction((src: string) => {
      const image = (globalThis as any).document.querySelector('#captcha_image');
      return image && image.src !== src && image.complete && image.naturalWidth > 0;
    }, { signal: this.signal }, previousSrc);
    if ((await this.capture()).imageId === previousImageId) throw new RootEmailError('验证码刷新后图片未变化，请稍后重试', 422);
  }
  async submit(candidate: string): Promise<'sent' | 'invalid' | 'next_captcha'> {
    const page = this.checkedPage();
    const purpose = this.captchaPurpose;
    await page.locator('::-p-aria(Type the characters as shown above)').fill(candidate);
    await this.click('I’m not a robot');
    const result = await this.waitForCaptchaResult(purpose === 'identity');
    if (result === 'blocked') throw new RootEmailError('AWS 提示限制请求，请稍后再试', 429);
    if (result === 'disabled') throw new RootEmailError('AWS 未允许该账户恢复密码，请检查集中式根访问设置', 422);
    if (result === 'identity_verified') {
      await this.enterRecoveryCaptcha();
      return 'next_captcha';
    }
    return result === 'sent' ? 'sent' : 'invalid';
  }
  async close() {
    try {
      if (this.browser) {
        const child = this.browser.process();
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([this.browser.close(), new Promise<void>(resolve => {
            timeout = setTimeout(() => { child?.kill('SIGKILL'); resolve(); }, 5_000);
          })]);
        } catch { child?.kill('SIGKILL'); }
        finally { if (timeout) clearTimeout(timeout); }
        if (child && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => {
              child.removeListener('exit', exited);
              reject(new Error('Chrome cleanup did not complete'));
            }, 3_000);
            const exited = () => { clearTimeout(deadline); resolve(); };
            child.once('exit', exited);
          });
        }
      }
    } finally {
      if (this.profile) {
        try { fs.rmSync(this.profile, { recursive: true, force: true }); }
        catch { console.error('[RootEmail] 临时浏览器目录清理失败'); }
      }
    }
  }
}


export type RootPasswordAutomationOutcome = 'failed' | 'unknown';
export const MAX_ROOT_PASSWORD_BROWSER_ATTEMPTS = 3;
export type RootPasswordAutomationStage = 'validate_link' | 'authorize' | 'runtime' | 'load_driver' | 'launch_browser'
  | 'create_page' | 'configure_page' | 'navigate' | 'wait_form' | 'fill_form' | 'submit' | 'wait_result';
export type RootPasswordAutomationCategory = 'policy' | 'timeout' | 'navigation_aborted' | 'network'
  | 'target_closed' | 'execution_context_changed' | 'browser_error';

type RootPasswordAutomationErrorOptions = {
  stage?: RootPasswordAutomationStage;
  category?: RootPasswordAutomationCategory;
  retryable?: boolean;
};

export class RootPasswordAutomationError extends RootEmailError {
  readonly stage: RootPasswordAutomationStage;
  readonly category: RootPasswordAutomationCategory;
  readonly retryable: boolean;

  constructor(message: string, public readonly outcome: RootPasswordAutomationOutcome,
    options: RootPasswordAutomationErrorOptions = {}) {
    super(message, 422);
    this.stage = options.stage || 'wait_form';
    this.category = options.category || 'policy';
    // Unknown outcomes may have crossed the submit boundary and can never be retried.
    this.retryable = outcome === 'failed' && options.retryable === true;
  }

  /** Permit retries only for classified pre-submit failures, with a strict global attempt cap. */
  canRetry(completedAttempts: number): boolean {
    return completedAttempts >= 1 && completedAttempts < MAX_ROOT_PASSWORD_BROWSER_ATTEMPTS
      && this.outcome === 'failed' && this.retryable;
  }
}

/** Convert raw browser failures into a URL/token-free category suitable for task history and audit. */
export function classifyRootPasswordAutomationError(error: unknown, stage: RootPasswordAutomationStage,
  submitted: boolean): RootPasswordAutomationError {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  const value = `${name} ${message}`;
  const category: RootPasswordAutomationCategory = /ERR_ABORTED/i.test(value) ? 'navigation_aborted'
    : /net::ERR_|Navigation failed/i.test(value) ? 'network'
    : /Target closed|Session closed|browser has disconnected|Connection closed|Protocol error.*Target/i.test(value) ? 'target_closed'
    : /Execution context (?:was destroyed|is not available)|detached frame|frame.*detached|Cannot find context/i.test(value) ? 'execution_context_changed'
    : /TimeoutError|timed out|timeout/i.test(value) ? 'timeout'
    : 'browser_error';
  const retryableStages: RootPasswordAutomationStage[] = [
    'launch_browser', 'create_page', 'configure_page', 'navigate', 'wait_form', 'fill_form',
  ];
  const outcome: RootPasswordAutomationOutcome = submitted ? 'unknown' : 'failed';
  const safeMessage = submitted
    ? `提交新密码后页面异常（${stage}/${category}），状态未知；系统不会自动重试`
    : `AWS 密码页面异常（${stage}/${category}），未提交新密码`;
  return new RootPasswordAutomationError(safeMessage, outcome, {
    stage, category, retryable: !submitted && retryableStages.includes(stage),
  });
}

/** Preserve policy errors before submission, but make every post-submit policy failure unknown. */
export function normalizeRootPasswordAutomationError(error: unknown, stage: RootPasswordAutomationStage,
  submitted: boolean): RootEmailError {
  if (error instanceof RootPasswordAutomationError) return error;
  if (error instanceof RootEmailError) {
    if (!submitted) return error;
    return new RootPasswordAutomationError(
      `提交新密码后安全校验中止（${stage}/policy），状态未知；系统不会自动重试`,
      'unknown', { stage, category: 'policy' });
  }
  return classifyRootPasswordAutomationError(error, stage, submitted);
}

export interface RootPasswordAttemptSession {
  setPassword(resetUrl: string, password: string): Promise<void>;
  close(): Promise<void>;
}

export type RootPasswordAttemptResult<T extends RootPasswordAttemptSession> =
  | { kind: 'success'; session: T }
  | { kind: 'failed'; session?: T; error: unknown }
  | { kind: 'stopped'; session?: T };

export interface RootPasswordAttemptHooks {
  beforeRetry(error: RootPasswordAutomationError, completedAttempts: number): boolean | Promise<boolean>;
  beforeNextAttempt(nextAttempt: number): void | Promise<void>;
}

export type RootPasswordPageState = 'waiting' | 'ready' | 'success' | 'rejected' | 'changed';

/** Puppeteer serializes this function into Chrome; it must not depend on module helpers or nested callbacks. */
export function readRootPasswordPageState(): RootPasswordPageState {
  const doc = (globalThis as any).document;
  const text = String(doc.body?.innerText || '');
  if (/password (?:has been|was) (?:successfully )?reset|password reset (?:was )?successful|new password (?:has been|was) saved|you can now sign in with your new password/i.test(text)) return 'success';
  if (/reset link (?:is |has )?(?:invalid|expired|already used)|link (?:is |has )?(?:invalid|expired|already been used)|request a new password reset|passwords? do not match|password.*(?:does not meet|requirements|invalid)/i.test(text)) return 'rejected';
  const fields: any[] = [];
  for (const element of doc.querySelectorAll('input[type="password"]')) {
    const style = (globalThis as any).getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && !element.disabled) {
      fields.push(element);
    }
  }
  const buttons: any[] = [];
  for (const element of doc.querySelectorAll('button, input[type="submit"]')) {
    const style = (globalThis as any).getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.visibility === 'hidden' || style.display === 'none' || rect.width <= 0 || rect.height <= 0 || element.disabled) continue;
    const label = String(element.innerText || element.value || element.getAttribute('aria-label') || '').trim();
    if (/^(reset password|set new password|save new password|change password|submit)$/i.test(label)) buttons.push(element);
  }
  if (fields.length > 2 || buttons.length > 1) return 'changed';
  return fields.length === 2 && buttons.length === 1 ? 'ready' : 'waiting';
}

/** Fill exactly two visible password fields without closures that tsx could rewrite with __name. */
export function fillRootPasswordFields(value: string): boolean {
  const doc = (globalThis as any).document;
  const fields: any[] = [];
  for (const element of doc.querySelectorAll('input[type="password"]')) {
    const style = (globalThis as any).getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && !element.disabled) {
      fields.push(element);
    }
  }
  if (fields.length !== 2) return false;
  const setter = Object.getOwnPropertyDescriptor((globalThis as any).HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return false;
  for (const field of fields) {
    setter.call(field, value);
    field.dispatchEvent(new (globalThis as any).Event('input', { bubbles: true }));
    field.dispatchEvent(new (globalThis as any).Event('change', { bubbles: true }));
  }
  for (const field of fields) if (field.value !== value) return false;
  return true;
}

/** Click exactly one visible, explicitly labelled password-submit control. */
export function clickRootPasswordSubmit(): boolean {
  const doc = (globalThis as any).document;
  const buttons: any[] = [];
  for (const element of doc.querySelectorAll('button, input[type="submit"]')) {
    const style = (globalThis as any).getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.visibility === 'hidden' || style.display === 'none' || rect.width <= 0 || rect.height <= 0 || element.disabled) continue;
    const label = String(element.innerText || element.value || element.getAttribute('aria-label') || '').trim();
    if (/^(reset password|set new password|save new password|change password|submit)$/i.test(label)) buttons.push(element);
  }
  if (buttons.length !== 1) return false;
  buttons[0].click();
  return true;
}

/** Strict reset-link automation. It never retries after the submit button may have been clicked. */
export class AwsRootPasswordSession {
  private browser?: Browser;
  private page?: Page;
  private profile?: string;
  private submitted = false;

  /** Run up to three browser attempts, but only while every failure is classified pre-submit. */
  static async runWithSafeRetry<T extends RootPasswordAttemptSession>(createSession: () => T,
    resetUrl: string, password: string, hooks: RootPasswordAttemptHooks): Promise<RootPasswordAttemptResult<T>> {
    let session: T | undefined;
    for (let attempt = 1; attempt <= MAX_ROOT_PASSWORD_BROWSER_ATTEMPTS; attempt++) {
      try {
        session = createSession();
        await session.setPassword(resetUrl, password);
        return { kind: 'success', session };
      } catch (error) {
        if (!(error instanceof RootPasswordAutomationError) || !error.canRetry(attempt)) {
          return { kind: 'failed', session, error };
        }
        let proceed: boolean;
        try { proceed = await hooks.beforeRetry(error, attempt); }
        catch (hookError) { return { kind: 'failed', session, error: hookError }; }
        if (!proceed) return { kind: 'stopped', session };
        try {
          await session!.close();
          session = undefined;
          await hooks.beforeNextAttempt(attempt + 1);
        } catch (preparationError) {
          return { kind: 'failed', session, error: preparationError };
        }
      }
    }
    return { kind: 'failed', session, error: new RootPasswordAutomationError(
      '密码页面安全重试次数已耗尽，未提交新密码', 'failed') };
  }

  constructor(private readonly signal: AbortSignal, private readonly authorize: () => void,
    private readonly beforeSubmit: () => void = () => {}) {}

  private checkedPage(): Page {
    this.signal.throwIfAborted();
    this.authorize();
    if (!this.page) throw new RootPasswordAutomationError('密码设置浏览器尚未就绪', 'failed');
    const url = new URL(this.page.url());
    if (url.protocol !== 'https:' || url.hostname !== 'signin.aws.amazon.com' || url.port || url.username || url.password) {
      throw new RootPasswordAutomationError('密码设置页面离开 AWS 官方登录域名，已停止', this.submitted ? 'unknown' : 'failed');
    }
    return this.page;
  }

  private async pause(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, milliseconds);
      const aborted = () => { clearTimeout(timer); reject(this.signal.reason || new Error('任务已停止')); };
      function done() { signalCleanup(); resolve(); }
      const signalCleanup = () => this.signal.removeEventListener('abort', aborted);
      this.signal.addEventListener('abort', aborted, { once: true });
    });
  }

  private async pageState(): Promise<RootPasswordPageState> {
    return this.checkedPage().evaluate(readRootPasswordPageState);
  }

  private async waitFor(expected: 'ready' | 'success', timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let transientReadFailures = 0;
    while (Date.now() < deadline) {
      let state: Awaited<ReturnType<AwsRootPasswordSession['pageState']>>;
      try {
        state = await this.pageState();
      } catch (error) {
        // Valid reset links can briefly detach the execution context after DOMContentLoaded.
        // Only that classified pre-submit race is tolerated, with one cumulative budget for the whole wait.
        const category = error instanceof RootEmailError ? 'policy'
          : classifyRootPasswordAutomationError(error, 'wait_form', false).category;
        if (this.submitted || error instanceof RootEmailError || category !== 'execution_context_changed'
          || ++transientReadFailures > 6) throw error;
        await this.pause(400);
        continue;
      }
      if (state === expected) return;
      if (state === 'changed') throw new RootPasswordAutomationError('AWS 密码页面结构与安全选择器不一致，已停止', this.submitted ? 'unknown' : 'failed');
      if (state === 'rejected') throw new RootPasswordAutomationError(
        this.submitted ? 'AWS 拒绝了新密码或重置链接，密码未确认设置' : 'AWS 重置链接无效、过期或已使用', 'failed');
      await this.pause(500);
    }
    throw new RootPasswordAutomationError(
      this.submitted ? '提交新密码后未收到明确结果，状态未知；系统不会自动重试' : 'AWS 密码设置页面未在预期时间就绪',
      this.submitted ? 'unknown' : 'failed');
  }

  async setPassword(resetUrl: string, password: string): Promise<void> {
    let stage: RootPasswordAutomationStage = 'validate_link';
    try {
      const { validateRootResetLink } = await import('./root-mail-links');
      const validated = validateRootResetLink(resetUrl);
      if (!validated) throw new RootPasswordAutomationError('恢复邮件中的 AWS 重置链接未通过严格校验', 'failed');
      this.signal.throwIfAborted();
      stage = 'authorize';
      this.authorize();
      stage = 'runtime';
      const runtime = rootEmailRuntime();
      stage = 'load_driver';
      const { default: puppeteer } = await import('puppeteer-core');
      this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-root-password-'));
      stage = 'launch_browser';
      this.browser = await puppeteer.launch({
        executablePath: runtime.chrome, headless: false, userDataDir: this.profile,
        defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
        args: ['--no-first-run', '--no-default-browser-check', '--lang=en-US', '--disable-dev-shm-usage'],
        env: runtime.display ? { ...process.env, DISPLAY: runtime.display } : process.env,
        timeout: 15_000, signal: this.signal,
      });
      stage = 'create_page';
      this.page = await this.browser.newPage();
      this.page.setDefaultTimeout(25_000);
      this.page.setDefaultNavigationTimeout(30_000);
      stage = 'configure_page';
      await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      stage = 'navigate';
      await this.page.goto(validated, { waitUntil: 'domcontentloaded' });
      this.checkedPage();
      stage = 'wait_form';
      await this.waitFor('ready', 30_000);

      const page = this.checkedPage();
      stage = 'fill_form';
      const filled = await page.evaluate(fillRootPasswordFields, password);
      if (!filled) throw new RootPasswordAutomationError('无法安全识别并填写两处新密码输入框', 'failed');
      this.signal.throwIfAborted();
      stage = 'authorize';
      this.authorize();

      // Conservative boundary: any failure after this point is unknown, even if evaluate fails before returning.
      stage = 'submit';
      this.beforeSubmit();
      this.submitted = true;
      const clicked = await page.evaluate(clickRootPasswordSubmit);
      if (!clicked) throw new RootPasswordAutomationError('提交按钮状态已变化，密码设置结果未知；系统不会自动重试', 'unknown');
      stage = 'wait_result';
      await this.waitFor('success', 45_000);
    } catch (error) {
      throw normalizeRootPasswordAutomationError(error, stage, this.submitted);
    }
  }

  async close(): Promise<void> {
    try {
      if (this.browser) {
        const child = this.browser.process();
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([this.browser.close(), new Promise<void>(resolve => {
            timeout = setTimeout(() => { child?.kill('SIGKILL'); resolve(); }, 5_000);
          })]);
        } catch { child?.kill('SIGKILL'); }
        finally { if (timeout) clearTimeout(timeout); }
        if (child && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => {
              child.removeListener('exit', exited);
              reject(new Error('Chrome cleanup did not complete'));
            }, 3_000);
            const exited = () => { clearTimeout(deadline); resolve(); };
            child.once('exit', exited);
          });
        }
      }
    } finally {
      if (this.profile) {
        try { fs.rmSync(this.profile, { recursive: true, force: true }); }
        catch { console.error('[RootEmail] 临时密码浏览器目录清理失败'); }
      }
    }
  }
}
