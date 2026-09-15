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

/** All selectors reflect the AWS root sign-in/recovery UI, not the federated PDF flow. */
export class AwsRootEmailSession implements RootEmailSession {
  private browser?: Browser;
  private page?: Page;
  private profile?: string;
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
  async open(email: string) {
    const runtime = rootEmailRuntime();
    const { default: puppeteer } = await import('puppeteer-core');
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
    if (await this.page.$('#root_account_signin')) await this.click('Sign in using root user email');
    await this.page.waitForSelector('#root_user_radio_button', { visible: true });
    this.checkedPage();
    await this.page.click('#root_user_radio_button');
    await this.page.locator('::-p-aria(Email address)').fill(email);
    await this.click('Next');
    await this.page.locator('::-p-aria(Forgot password?)').wait();
    // Re-check the account displayed by AWS before requesting its password recovery.
    const matches = await this.page.evaluate((address: string) => {
      const doc = (globalThis as any).document;
      return doc.body.innerText.toLowerCase().includes(address.toLowerCase());
    }, email);
    if (!matches) throw new RootEmailError('AWS 页面显示的账户邮箱不匹配', 422);
    await this.click('Forgot password?');
    await this.page.waitForSelector('#captcha_image', { visible: true });
  }
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
  async submit(candidate: string): Promise<'sent' | 'invalid'> {
    const page = this.checkedPage();
    await page.locator('::-p-aria(Type the characters as shown above)').fill(candidate);
    await this.click('I’m not a robot');
    const state = await page.waitForFunction(`(() => {
      const text = document.body.innerText;
      if (/Password email sent/.test(text)) return 'sent';
      if (/too many|rate.?limit|try again later|temporarily blocked/i.test(text)) return 'blocked';
      if (/incorrect verification|incorrect captcha|invalid captcha|characters.*(?:incorrect|did not match)|(?:incorrect|invalid).*characters/i.test(text)) return 'invalid';
      if (/password recovery.*(?:disabled|not allowed)|contact.*administrator/i.test(text)) return 'disabled';
      return false;
    })()`, { timeout: 30_000, signal: this.signal });
    const result = await state.jsonValue();
    await state.dispose();
    if (result === 'blocked') throw new RootEmailError('AWS 提示限制请求，请稍后再试', 429);
    if (result === 'disabled') throw new RootEmailError('AWS 未允许该账户恢复密码，请检查集中式根访问设置', 422);
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

  /** Permit at most one retry, and only for a classified pre-submit browser failure. */
  canRetry(completedAttempts: number): boolean {
    return completedAttempts === 1 && this.outcome === 'failed' && this.retryable;
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
    : /Execution context was destroyed|frame was detached|Cannot find context/i.test(value) ? 'execution_context_changed'
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
  beforeRetry(error: RootPasswordAutomationError): boolean | Promise<boolean>;
  beforeSecondAttempt(): void | Promise<void>;
}

/** Strict reset-link automation. It never retries after the submit button may have been clicked. */
export class AwsRootPasswordSession {
  private browser?: Browser;
  private page?: Page;
  private profile?: string;
  private submitted = false;

  /** Run no more than two browser attempts; the second exists only for a classified pre-submit failure. */
  static async runWithSafeRetry<T extends RootPasswordAttemptSession>(createSession: () => T,
    resetUrl: string, password: string, hooks: RootPasswordAttemptHooks): Promise<RootPasswordAttemptResult<T>> {
    let session: T | undefined;
    try {
      session = createSession();
      await session.setPassword(resetUrl, password);
      return { kind: 'success', session };
    } catch (error) {
      if (!(error instanceof RootPasswordAutomationError) || !error.canRetry(1)) {
        return { kind: 'failed', session, error };
      }
      let proceed: boolean;
      try { proceed = await hooks.beforeRetry(error); }
      catch (hookError) { return { kind: 'failed', session, error: hookError }; }
      if (!proceed) return { kind: 'stopped', session };
      try {
        await session!.close();
        session = undefined;
        await hooks.beforeSecondAttempt();
      } catch (preparationError) {
        return { kind: 'failed', session, error: preparationError };
      }
      try {
        session = createSession();
        await session.setPassword(resetUrl, password);
        return { kind: 'success', session };
      } catch (secondError) {
        return { kind: 'failed', session, error: secondError };
      }
    }
  }

  constructor(private readonly signal: AbortSignal, private readonly authorize: () => void) {}

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

  private async pageState(): Promise<'waiting' | 'ready' | 'success' | 'rejected' | 'changed'> {
    const page = this.checkedPage();
    return page.evaluate(() => {
      const doc = (globalThis as any).document;
      const text = String(doc.body?.innerText || '');
      if (/password (?:has been|was) (?:successfully )?reset|password reset (?:was )?successful|new password (?:has been|was) saved|you can now sign in with your new password/i.test(text)) return 'success';
      if (/reset link (?:is |has )?(?:invalid|expired|already used)|link (?:is |has )?(?:invalid|expired|already been used)|request a new password reset|passwords? do not match|password.*(?:does not meet|requirements|invalid)/i.test(text)) return 'rejected';
      const visible = (element: any) => {
        const style = (globalThis as any).getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && !element.disabled;
      };
      const fields = [...doc.querySelectorAll('input[type="password"]')].filter(visible);
      const buttons = [...doc.querySelectorAll('button, input[type="submit"]')].filter(visible).filter((element: any) => {
        const label = String(element.innerText || element.value || element.getAttribute('aria-label') || '').trim();
        return /^(reset password|save new password|change password|submit)$/i.test(label);
      });
      if (fields.length > 2 || buttons.length > 1) return 'changed';
      return fields.length === 2 && buttons.length === 1 ? 'ready' : 'waiting';
    });
  }

  private async waitFor(expected: 'ready' | 'success', timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.pageState();
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
      const filled = await page.evaluate((value: string) => {
        const doc = (globalThis as any).document;
        const visible = (element: any) => {
          const style = (globalThis as any).getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && !element.disabled;
        };
        const fields = [...doc.querySelectorAll('input[type="password"]')].filter(visible) as any[];
        if (fields.length !== 2) return false;
        const setter = Object.getOwnPropertyDescriptor((globalThis as any).HTMLInputElement.prototype, 'value')?.set;
        if (!setter) return false;
        for (const field of fields) {
          setter.call(field, value);
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return fields.every(field => field.value === value);
      }, password);
      if (!filled) throw new RootPasswordAutomationError('无法安全识别并填写两处新密码输入框', 'failed');
      this.signal.throwIfAborted();
      stage = 'authorize';
      this.authorize();

      // Conservative boundary: any failure after this point is unknown, even if evaluate fails before returning.
      stage = 'submit';
      this.submitted = true;
      const clicked = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const visible = (element: any) => {
          const style = (globalThis as any).getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && !element.disabled;
        };
        const buttons = [...doc.querySelectorAll('button, input[type="submit"]')].filter(visible).filter((element: any) => {
          const label = String(element.innerText || element.value || element.getAttribute('aria-label') || '').trim();
          return /^(reset password|save new password|change password|submit)$/i.test(label);
        }) as any[];
        if (buttons.length !== 1) return false;
        buttons[0].click();
        return true;
      });
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
