/**
 * 一键提交提额文档到 Support Case
 *
 * 自动化用户的手工流程：生成文档 → 联邦登录打开 Case → 点 Reply →
 * 填 use cases 正文 → 上传 PDF 附件 → 等上传完成 → Submit。
 *
 * 实现要点（沿用 billing-exporter 的经验）：
 * - 不涉及打印子系统 → headless 即可，无需 Xvfb
 * - 会话在 .amazon.com cookie 里 → 每次任务独立 userDataDir
 * - 选择器不依赖 AWS 文案语言：按钮用「英文/中文文案 + role」双重匹配
 * - 上传后固定等待（默认 6s）+ 附件回显检测，双保险
 * - 全程截图留档（/tmp），失败时能回看到底卡在哪一步
 *
 * 任务模型：进程内存 Map（单进程），一次只跑一个，避免 Chrome 并发吃光内存。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { getConsoleSigninUrl } from './aws-service';
import { generateQuotaDoc, getCompanyForAccount } from './doc-generator';

const UPLOAD_SETTLE_MS = Number(process.env.CASE_DOC_UPLOAD_SETTLE_MS || 6000);
const STEP_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 180_000;

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH || '',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) {
    if (!c) continue;
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  throw new Error('未找到可执行的 Chrome（可设 CHROME_PATH）');
}

export type CaseDocJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export interface CaseDocJob {
  id: string;
  status: CaseDocJobStatus;
  step: string;               // 当前/最后执行到的步骤，失败时用于定位
  accountId: string;
  caseId: string;
  createdBy: string;
  error?: string;
  screenshot?: string;        // 失败时的截图路径（服务器本地，仅排障用）
  createdAt: string;
  finishedAt?: string;
}

const jobs = new Map<string, CaseDocJob>();
let runningJob: string | null = null;

export function getCaseDocJob(id: string): CaseDocJob | null {
  return jobs.get(id) || null;
}

export interface CaseDocParams {
  accountId: string;
  accountName?: string;
  caseId: string;             // Support Case displayId
  companyKey?: string;
  serviceCode: string;
  quotaName: string;
  region: string;
  requestedValue: number;
  currentValue?: number;
  message?: string;           // Reply 正文；缺省用内置英文模板
  createdBy: string;
}

// 内置 use cases 正文模板（用户手工流程中写的内容）
function defaultMessage(p: CaseDocParams): string {
  return [
    'Hello,',
    '',
    `Please find attached the detailed use case document for our ${p.quotaName} limit increase request (target: ${p.requestedValue}, region: ${p.region}).`,
    'The document includes our business background, architecture overview and resource breakdown supporting the requested value.',
    '',
    'We would appreciate your review and approval. Thank you!',
  ].join('\n');
}

/** 在页面里按文案点击按钮（fixed 弹层安全：用 getBoundingClientRect 而非 offsetParent） */
async function clickByText(page: Page, patterns: RegExp[], step: string): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  // 服务端 tsconfig 不含 DOM lib，页面脚本用字符串形式（与 billing-exporter 相同做法）
  const pats = JSON.stringify(patterns.map(p => ({ source: p.source, flags: p.flags })));
  const script = `(function(){
    var pats = ${pats}.map(function(p){ return new RegExp(p.source, p.flags); });
    var nodes = Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'));
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var text = ((el.innerText || el.value || '') + '').trim();
      if (!text) continue;
      var hit = false;
      for (var j = 0; j < pats.length; j++) if (pats[j].test(text)) { hit = true; break; }
      if (!hit) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      var st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return text;
    }
    return null;
  })()`;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate(script);
    if (clicked) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`步骤「${step}」超时：页面上找不到目标按钮`);
}

/** 页面正文是否包含指定文本（字符串脚本，避开 DOM 类型依赖） */
async function bodyIncludes(page: Page, needle: string): Promise<boolean> {
  const script = `((document.body && document.body.innerText) || '').includes(${JSON.stringify(needle)})`;
  return page.evaluate(script).then(Boolean).catch(() => false);
}

async function shot(page: Page | undefined, jobId: string, tag: string): Promise<string | undefined> {
  if (!page) return undefined;
  try {
    const p = path.join(os.tmpdir(), `case-doc-${jobId}-${tag}.png`);
    await page.screenshot({ path: p as `${string}.png`, fullPage: false });
    return p;
  } catch { return undefined; }
}

/**
 * 提交一键上传任务。立即返回 jobId，实际流程后台执行，前端轮询 getCaseDocJob。
 */
export function submitCaseDoc(params: CaseDocParams): CaseDocJob {
  if (runningJob && jobs.get(runningJob)?.status === 'running') {
    throw Object.assign(new Error('已有一个提交任务在执行中，请稍后再试'), { code: 'CASE_DOC_BUSY' });
  }
  const job: CaseDocJob = {
    id: randomUUID(),
    status: 'queued',
    step: 'queued',
    accountId: params.accountId,
    caseId: params.caseId,
    createdBy: params.createdBy,
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  runningJob = job.id;
  // 只保留最近 50 条任务记录
  if (jobs.size > 50) {
    const oldest = Array.from(jobs.keys()).slice(0, jobs.size - 50);
    for (const k of oldest) if (k !== runningJob) jobs.delete(k);
  }
  void runJob(job, params).finally(() => {
    if (runningJob === job.id) runningJob = null;
  });
  return job;
}

async function runJob(job: CaseDocJob, params: CaseDocParams): Promise<void> {
  job.status = 'running';
  const setStep = (s: string) => { job.step = s; console.log(`[case-doc][${job.id.slice(0, 8)}] ${s}`); };
  let browser: Browser | undefined;
  let page: Page | undefined;
  let pdfPath: string | undefined;
  let profileDir: string | undefined;
  const totalTimer = setTimeout(() => {
    job.status = 'failed';
    job.error = `整体超时（${TOTAL_TIMEOUT_MS / 1000}s）`;
    if (browser) void browser.close().catch(() => undefined);
  }, TOTAL_TIMEOUT_MS);
  totalTimer.unref?.();

  try {
    // 1) 生成 PDF（与手动下载同一渲染管线）
    setStep('生成提额文档');
    const pdf = await generateQuotaDoc({
      accountId: params.accountId,
      accountName: params.accountName,
      companyKey: params.companyKey,
      serviceCode: params.serviceCode,
      quotaName: params.quotaName,
      region: params.region,
      requestedValue: params.requestedValue,
      currentValue: params.currentValue,
    });
    const company = params.companyKey || getCompanyForAccount(params.accountId)?.key || 'doc';
    const pdfName = `${company}-${params.quotaName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}-${params.requestedValue}-${params.region}.pdf`;
    pdfPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'case-doc-')), pdfName);
    fs.writeFileSync(pdfPath, pdf);

    // 2) 联邦登录直达 Case 页（沿用现有链路；support 只读会话足以回帖）
    setStep('生成免登录链接');
    const dest = `https://support.console.aws.amazon.com/support/home#/case/?displayId=${params.caseId}`;
    const signin = await getConsoleSigninUrl(params.accountId, dest, 'support');

    setStep('启动浏览器');
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-doc-profile-'));
    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
      userDataDir: profileDir,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900', '--lang=en-US'],
      defaultViewport: { width: 1440, height: 900 },
      timeout: 20_000,
    });
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    setStep('打开 Support Case 页面');
    await page.goto(signin, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_MS });
    // Case 详情是 SPA 异步渲染的，等 Reply 按钮出现即视为就绪
    setStep('等待 Case 页面就绪');
    await page.waitForFunction(
      `/Reply|回复/i.test((document.body && document.body.innerText) || '')`,
      { timeout: STEP_TIMEOUT_MS * 2 },
    );

    // 3) 点 Reply
    setStep('点击 Reply');
    await clickByText(page, [/^Reply$/i, /^回复$/], 'Reply');

    // 4) 填正文
    setStep('填写 use cases 正文');
    await page.waitForSelector('textarea', { timeout: STEP_TIMEOUT_MS });
    await page.focus('textarea');
    await page.keyboard.type(params.message || defaultMessage(params), { delay: 2 });

    // 5) 上传附件：Support 回帖表单带 input[type=file]
    setStep('上传附件');
    const fileInput = await page.waitForSelector('input[type="file"]', { timeout: STEP_TIMEOUT_MS });
    if (!fileInput) throw new Error('找不到文件上传控件');
    await (fileInput as any).uploadFile(pdfPath);

    // 6) 等上传完成：固定等待（用户经验值 ~5s）+ 附件名回显双保险
    setStep(`等待上传完成（${UPLOAD_SETTLE_MS / 1000}s + 回显检测）`);
    await new Promise(r => setTimeout(r, UPLOAD_SETTLE_MS));
    let echoed = await bodyIncludes(page, pdfName);
    if (!echoed) {
      // 再宽限一轮；仍无回显则失败（宁可不提交，不能盲提空附件）
      await new Promise(r => setTimeout(r, UPLOAD_SETTLE_MS));
      echoed = await bodyIncludes(page, pdfName);
      if (!echoed) {
        job.screenshot = await shot(page, job.id, 'upload-missing');
        throw new Error('附件未出现在页面上（可能上传失败或超出大小限制），已中止，不会盲目提交');
      }
    }

    // 7) Submit
    setStep('点击 Submit');
    await clickByText(page, [/^Submit$/i, /^提交$/], 'Submit');

    // 8) 确认提交生效：Reply 表单消失或出现成功提示
    setStep('确认提交结果');
    await page.waitForFunction(
      `(function(){
        var t = (document.body && document.body.innerText) || '';
        var formGone = !document.querySelector('textarea');
        return formGone || /submitted|已提交|Correspondence/i.test(t);
      })()`,
      { timeout: STEP_TIMEOUT_MS },
    ).catch(async () => {
      job.screenshot = await shot(page, job.id, 'submit-unconfirmed');
      throw new Error('Submit 后未检测到成功信号，请打开 Case 人工确认（回复可能已提交也可能没有）');
    });

    job.status = 'completed';
    job.step = '完成';
    job.finishedAt = new Date().toISOString();
    console.log(`[case-doc][${job.id.slice(0, 8)}] ✅ Case ${params.caseId} 文档已提交`);
  } catch (e: any) {
    // 整体超时定时器可能已把状态置为 failed 并写了 error，避免覆盖
    if ((job.status as CaseDocJobStatus) !== 'failed') {
      job.status = 'failed';
      job.error = e?.message || String(e);
    }
    job.finishedAt = new Date().toISOString();
    if (!job.screenshot) job.screenshot = await shot(page, job.id, 'failed');
    console.error(`[case-doc][${job.id.slice(0, 8)}] ❌ ${job.step}: ${job.error}`);
  } finally {
    clearTimeout(totalTimer);
    if (browser) await browser.close().catch(() => undefined);
    // 清理临时文件（截图留着排障）
    try { if (pdfPath) fs.rmSync(path.dirname(pdfPath), { recursive: true, force: true }); } catch { /* 忽略 */ }
    try { if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}