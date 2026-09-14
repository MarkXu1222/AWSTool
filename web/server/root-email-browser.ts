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
    if (this.profile) fs.rmSync(this.profile, { recursive: true, force: true });
  }
}
