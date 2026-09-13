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

/**
 * 真实鼠标坐标点击（awsui/React 按钮对 JS el.click() 可能不触发合成事件，
 * 实测 Submit 按钮 JS click 无效 —— 必须用 page.mouse 在按钮中心真点）。
 * 返回是否找到并点击了目标。
 */
async function realClickByText(page: Page, patterns: RegExp[], step: string): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  const pats = JSON.stringify(patterns.map(p => ({ source: p.source, flags: p.flags })));
  // elementFromPoint 命中测试（billing-exporter 教训 #3 的延伸）：
  // 控制台的引导 tour（"Service menu"）带全屏透明遮罩，会吞掉坐标点击。
  // 找到按钮后先测中心点实际命中的元素；被遮挡就把遮挡层（挂在 body 下的 portal）整个移除再点。
  const findScript = `(function(){
    var pats = ${pats}.map(function(p){ return new RegExp(p.source, p.flags); });
    var nodes = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');
    var candidates = [];
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
      candidates.push({ el: el, text: text, rect: r, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' });
    }
    if (!candidates.length) return null;
    // 优先选可用（非 disabled）且在文档中最靠后的（Reply 表单渲染在 correspondence 之前、页面主体最后）
    var pick = null;
    for (var m = candidates.length - 1; m >= 0; m--) if (!candidates[m].disabled) { pick = candidates[m]; break; }
    if (!pick) pick = candidates[candidates.length - 1];
    var el2 = pick.el;
    el2.scrollIntoView({ block: 'center' });
    var r2 = el2.getBoundingClientRect();
    var cx = r2.left + r2.width / 2, cy = r2.top + r2.height / 2;
    // 命中测试：中心点被别的元素挡住 → 移除遮挡层（最多剥 3 层）
    var blockers = [];
    for (var k = 0; k < 3; k++) {
      var at = document.elementFromPoint(cx, cy);
      if (!at || at === el2 || el2.contains(at) || at.contains(el2)) break;
      blockers.push(at.tagName + '.' + (at.className || '').toString().slice(0, 60));
      var blocker = at;
      while (blocker.parentElement && blocker.parentElement !== document.body) blocker = blocker.parentElement;
      if (blocker && blocker !== document.body && !blocker.contains(el2)) blocker.remove();
      else break;
    }
    var r3 = el2.getBoundingClientRect();
    var finalAt = document.elementFromPoint(r3.left + r3.width / 2, r3.top + r3.height / 2);
    var mine = !!(finalAt && (finalAt === el2 || el2.contains(finalAt) || finalAt.contains(el2)));
    try { el2.focus(); } catch (e) {}
    return {
      x: r3.left + r3.width / 2, y: r3.top + r3.height / 2, text: pick.text,
      tag: el2.tagName, disabled: pick.disabled, hitOk: mine, blockers: blockers,
      all: candidates.map(function(c){ return c.text + '@' + Math.round(c.rect.left) + ',' + Math.round(c.rect.top) + (c.disabled ? '(disabled)' : ''); }),
    };
  })()`;
  while (Date.now() < deadline) {
    const target: any = await page.evaluate(findScript).catch(() => null);
    if (target) {
      console.log(`[case-doc] realClick「${step}」→ ${target.tag}"${target.text}" @(${Math.round(target.x)},${Math.round(target.y)}) hitOk=${target.hitOk} disabled=${target.disabled} blockers=${JSON.stringify(target.blockers)} all=${JSON.stringify(target.all)}`);
      // 埋点：记录 click 事件实际落点，验证坐标点击真的打到了目标按钮
      await page.evaluate(`window.__lastClick = null; document.addEventListener('click', function(e){
        var t = e.target; window.__lastClick = t.tagName + '"' + ((t.innerText || '').trim().slice(0, 30)) + '"';
      }, { capture: true })`).catch(() => undefined);
      await page.mouse.click(target.x, target.y);
      const landed = await page.evaluate(`window.__lastClick`).catch(() => null);
      console.log(`[case-doc] realClick「${step}」click 事件落点: ${landed || '(未触发!)'}`);
      // 兜底：真实键盘 Enter 发给已 focus 的按钮（不受任何遮罩影响）。
      // 若鼠标点击已生效、按钮随表单收起，则 Enter 落空无副作用。
      await new Promise(r => setTimeout(r, 1500));
      const still = await page.evaluate(
        `(function(){ var a = document.activeElement; return !!(a && /${patterns[0].source.replace(/\\/g, '\\\\')}/i.test((a.innerText || a.value || '').trim())); })()`,
      ).catch(() => false);
      if (still) {
        console.log(`[case-doc] realClick「${step}」鼠标点击后按钮仍持有焦点，追加 Enter 键兜底`);
        await page.keyboard.press('Enter');
      }
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`步骤「${step}」超时：页面上找不到目标按钮`);
}

/** 关闭 AWS 控制台的引导/公告弹层（Service menu tour 等），失败忽略 */
async function dismissOverlays(page: Page): Promise<void> {
  try { await page.keyboard.press('Escape'); } catch { /* 忽略 */ }
  // "不再显示" / "Dismiss alert" 一类的关闭按钮
  const script = `(function(){
    var sels = document.querySelectorAll('button[aria-label*="Dismiss"], button[aria-label*="Close"], button[aria-label*="关闭"]');
    var n = 0;
    for (var i = 0; i < sels.length; i++) {
      var r = sels[i].getBoundingClientRect();
      if (r.width > 2 && r.height > 2) { sels[i].click(); n++; }
    }
    return n;
  })()`;
  await page.evaluate(script).catch(() => 0);
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
    // 监听写操作请求，Submit 点击后据此判断提交 API 是否成功（也用于排障）
    page.on('response', (res) => {
      const req = res.request();
      if (req.method() !== 'POST' && req.method() !== 'PUT') return;
      const url = req.url();
      if (!/support\.us-east-1\.amazonaws\.com|attachments\.support/i.test(url)) return;
      const target = req.headers()['x-amz-target'] || '';
      console.log(`[case-doc][net] ${req.method()} ${res.status()} ${target || url.slice(0, 100)}`);
      // AddCommunicationToCase 的响应无论成败都打出来（判断真实提交是否生效的核心依据）
      if (res.status() >= 400 || /AddCommunication|ResolveCase/i.test(target)) {
        res.text().then(t => console.log(`[case-doc][net]   body: ${t.slice(0, 300)}`)).catch(() => undefined);
      }
    });

    setStep('打开 Support Case 页面');
    await page.goto(signin, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_MS });
    // Case 详情是 SPA 异步渲染的，等 Reply 按钮出现即视为就绪
    setStep('等待 Case 页面就绪');
    await page.waitForFunction(
      `/Reply|回复/i.test((document.body && document.body.innerText) || '')`,
      { timeout: STEP_TIMEOUT_MS * 2 },
    );

    // 3) 点 Reply（同样用真实鼠标点击，awsui 按钮 JS click 不可靠）
    setStep('点击 Reply');
    await dismissOverlays(page);
    await realClickByText(page, [/^Reply$/i, /^回复$/], 'Reply');

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

    // 6) 等上传真正完成。
    // ⚠️ 文件名回显 ≠ 上传完成：文件一选中就进附件表格了，但后台还在
    // GetAttachmentUploadLinks → PUT → CompleteAttachmentUpload 流程中。
    // 上传未完成时点 Submit 会被前端静默忽略（实测网络日志：AddCommunicationToCase 根本没发出）。
    // 必须等附件状态列变成 "Upload completed" 再继续。
    setStep('等待附件上传完成（Upload completed）');
    await page.waitForFunction(
      `(function(){
        var t = (document.body && document.body.innerText) || '';
        if (t.indexOf(${JSON.stringify(pdfName)}) < 0) return false;   // 附件行必须在
        if (/Upload failed|上传失败/i.test(t)) return false;
        return /Upload completed|上传完成/i.test(t);
      })()`,
      { timeout: STEP_TIMEOUT_MS * 2, polling: 1000 },
    ).catch(async () => {
      job.screenshot = await shot(page, job.id, 'upload-missing');
      throw new Error('附件未达到 Upload completed 状态（可能上传失败或超出大小限制），已中止，不会盲目提交');
    });
    // 状态刚翻转时前端可能还在收尾（CompleteAttachmentUpload 回包），再稳 2s
    await new Promise(r => setTimeout(r, 2000));

    // 7) Submit —— 必须用真实鼠标坐标点击：
    // awsui(React) 的 Submit 按钮对 JS el.click() 不响应（本地实测：JS click 后表单纹丝不动），
    // 只有 page.mouse 的真实事件流（mousedown/mouseup/click）才会触发提交。
    setStep('点击 Submit');
    await dismissOverlays(page);   // 先关掉可能遮挡的引导弹层（Service menu tour 等）
    await realClickByText(page, [/^Submit$/i, /^提交$/], 'Submit');

    // 8) 确认提交生效。
    // ⚠️ 唯一可靠信号是 Reply 表单（textarea）真正消失/清空收起。
    // 绝不能用页面文案 "Correspondence" 判断 —— 那是 Case 页固有区块标题，恒为 true，
    // 曾导致 Submit 实际没生效也报成功（0.22.x 的线上事故）。
    setStep('确认提交结果');
    await page.waitForFunction(
      `(function(){
        var ta = document.querySelector('textarea');
        if (!ta) return true;                       // 表单整个消失 = 已提交收起
        var r = ta.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return true; // 表单被隐藏
        return false;
      })()`,
      { timeout: STEP_TIMEOUT_MS, polling: 1000 },
    ).catch(async () => {
      // 表单还在：把页面上的错误提示带回来，方便定位（附件超限/验证失败/按钮无效）
      const errText = await page!.evaluate(
        `(function(){
          var els = document.querySelectorAll('[class*="error"], [class*="alert"], [role="alert"]');
          var out = [];
          for (var i = 0; i < els.length; i++) {
            var t = (els[i].innerText || '').trim();
            if (t && t.length < 200) out.push(t);
          }
          return out.slice(0, 3).join(' | ');
        })()`,
      ).catch(() => '');
      job.screenshot = await shot(page, job.id, 'submit-unconfirmed');
      throw new Error(`Submit 后 Reply 表单仍未收起，提交很可能没有生效${errText ? `；页面提示: ${errText}` : ''}。请打开 Case 人工确认`);
    });

    // 双重校验：刷新等待后正文关键词应出现在往来记录里（表单收起后正文进入 correspondence 历史）
    setStep('二次校验回帖已入库');
    await new Promise(r => setTimeout(r, 4000));
    const replyEchoed = await bodyIncludes(page, pdfName);
    if (!replyEchoed) {
      // 附件名没出现在正文历史中不一定失败（AWS 可能折叠附件），只记警告不判失败
      console.warn(`[case-doc][${job.id.slice(0, 8)}] 二次校验未在页面找到附件名（可能被折叠），以表单收起信号为准`);
    }

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