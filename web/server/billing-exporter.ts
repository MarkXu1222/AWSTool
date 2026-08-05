/**
 * 批量导出 AWS 账单 PDF → zip
 *
 * 产出的是 AWS 自家生成的打印文档（左上角 AWS logo、表头含账单周期/账户 ID/打印日期、
 * 逐条列出每个服务每个区域的费率明细），与手动「打印 → 另存为 PDF」的结果一致。
 *
 * 流程：联邦免登录进账单页 → 等数据加载完 → 点页面「打印」→ 点弹窗「打印」
 *      → AWS 构建打印文档并调用 window.print() → Chrome 静默另存为 PDF
 *
 * 四个关键技术点（都是踩过坑换来的）：
 *
 * 1) 必须 headed + --kiosk-printing。
 *    headless 没有打印子系统，AWS 的打印流程跑不完（window.print 不生效，页面反而被打断）。
 *    服务器上靠 Xvfb 虚拟显示提供 headed 环境，并预设打印首选项把目标锁定「另存为 PDF」，
 *    这样 window.print() 直接落盘、不弹原生预览框。
 *
 * 2) 必须等数据真正加载完再点打印。
 *    首屏出现「账单周期」等文字 ≠ 数据就绪；「最高估算成本」「按服务计费」等区块是异步拉取的。
 *    过早点打印，AWS 拿不到完整数据，打印文档会缺内容甚至整页报错。
 *    这里等的是：加载指示器消失 + 网络空闲 + 固定缓冲。
 *
 * 3) 判断弹窗可见性绝不能用 offsetParent。
 *    AWS 的「打印内容」弹窗是 position:fixed，fixed 元素的 offsetParent 恒为 null，
 *    会被误判成隐藏，导致点到另一个隐藏副本上、弹窗永远不生效。
 *    必须用 getBoundingClientRect + getComputedStyle + elementFromPoint 命中测试。
 *
 * 4) 每个账户必须用独立的浏览器实例（独立 user-data-dir + 独立落盘目录）。
 *    AWS 控制台会话存在 .amazon.com 的 cookie 里，一个 profile 只持有一份会话；
 *    复用同一浏览器顺序处理多个账户，后面的账户会沿用前面账户的会话——
 *    实测导出的多份 PDF 文件名各异但内容全是第一个账户的，属于"看起来成功了"的危险错误。
 *    独立落盘目录同时解决并发时抢文件名的问题。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { getConsoleSigninUrl } from './aws-service';

// Xvfb 虚拟显示。服务器上由 xvfb.service 常驻在 :99；本机（macOS）留空走真实桌面。
const DISPLAY = process.env.BILLING_EXPORT_DISPLAY || (process.platform === 'linux' ? ':99' : '');

// 单账户整体超时（等页面加载 + 等打印落盘）
const PER_ACCOUNT_TIMEOUT = 210_000;
// 网络空闲后再等多久点打印
const SETTLE_MS = Number(process.env.BILLING_EXPORT_SETTLE_MS || 8000);
// 服务器内存有限（2C4G 且 node 常驻占用较大），并发上限压到 3
const MAX_CONCURRENCY = Number(process.env.BILLING_EXPORT_MAX_CONCURRENCY || 3);

function findChrome(): string {
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.env.CHROME_PATH || '',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('未找到 Chrome 可执行文件');
}

export interface ExportTask {
  accountId: string;
  accountName?: string;
  year: number;
  month: number;   // 1-12
}

export interface ExportResult {
  accountId: string;
  accountName?: string;
  year: number;
  month: number;
  filename: string;
  ok: boolean;
  error?: string;
  pages?: number;
}

function billsUrl(year: number, month: number): string {
  return `https://us-east-1.console.aws.amazon.com/billing/home?region=us-east-1#/bills?year=${year}&month=${month}`;
}

function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').slice(0, 80);
}

/** 预置 profile：默认打印目标锁定「另存为 PDF」，指定落盘目录，去掉页眉页脚 */
function seedProfile(profileDir: string, saveDir: string) {
  fs.rmSync(profileDir, { recursive: true, force: true });
  const defDir = path.join(profileDir, 'Default');
  fs.mkdirSync(defDir, { recursive: true });
  const appState = {
    recentDestinations: [{ id: 'Save as PDF', origin: 'local', account: '' }],
    selectedDestinationId: 'Save as PDF',
    version: 2,
    isHeaderFooterEnabled: false,
    isLandscapeEnabled: false,
    isCssBackgroundEnabled: true,
  };
  fs.writeFileSync(path.join(defDir, 'Preferences'), JSON.stringify({
    printing: { print_preview_sticky_settings: { appState: JSON.stringify(appState) } },
    savefile: { default_directory: saveDir },
    download: { default_directory: saveDir, prompt_for_download: false },
  }));
}

// 页面内可见性判定。不用 offsetParent —— position:fixed 元素的 offsetParent 恒为 null。
const VIS_HELPER = `
window.__vis = function(el){
  if(!el) return false;
  var r = el.getBoundingClientRect();
  if (r.width <= 1 || r.height <= 1) return false;
  if (r.bottom < 0 || r.right < 0) return false;
  var s = window.getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  if (parseFloat(s.opacity || '1') === 0) return false;
  return true;
};
window.__hittable = function(el){
  var r = el.getBoundingClientRect();
  var x = r.left + r.width/2, y = r.top + r.height/2;
  if (x<0||y<0||x>window.innerWidth||y>window.innerHeight) return false;
  var top = document.elementFromPoint(x,y);
  while(top){ if(top===el) return true; top = top.parentElement; }
  return false;
};
`;

const inflight = new WeakMap<Page, number>();
const lastActivity = new WeakMap<Page, number>();

async function waitNetworkIdle(page: Page, idleMs: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = inflight.get(page) ?? 0;
    const quiet = Date.now() - (lastActivity.get(page) ?? 0);
    if (n <= 0 && quiet >= idleMs) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

function listPdfs(dir: string): Set<string> {
  try { return new Set(fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf'))); }
  catch { return new Set(); }
}

/** 等目录里出现新 PDF 且大小稳定 */
async function waitForNewPdf(dir: string, before: Set<string>, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of listPdfs(dir)) {
      if (before.has(f)) continue;
      const p = path.join(dir, f);
      try {
        const s1 = fs.statSync(p).size;
        await new Promise(r => setTimeout(r, 900));
        if (fs.existsSync(p) && fs.statSync(p).size === s1 && s1 > 1000) return f;
      } catch { /* 正在写，下一轮再看 */ }
    }
    await new Promise(r => setTimeout(r, 600));
  }
  return null;
}

function pdfPageCount(buf: Buffer): number {
  return buf.toString('latin1').split('/Type /Page').length - 1;
}

/** 处理单个账户：独立浏览器 + 独立落盘目录 */
async function captureOne(task: ExportTask, outDir: string): Promise<ExportResult> {
  const { accountId, year, month } = task;
  const mm = String(month).padStart(2, '0');
  const nameBase = safeName(task.accountName ? `${task.accountName}-${accountId}` : accountId);
  const filename = `${nameBase}-${year}-${mm}.pdf`;
  const result: ExportResult = { ...task, filename, ok: false };
  const log = (m: string) => console.log(`[billing-export][${accountId}/${year}-${mm}] ${m}`);

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `bill-profile-${accountId}-`));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `bill-out-${accountId}-`));
  seedProfile(profileDir, tmpDir);

  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    const dest = billsUrl(year, month);
    const signin = await getConsoleSigninUrl(accountId, dest, 'auto');

    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: false,                 // 必须 headed，靠 Xvfb 提供显示
      userDataDir: profileDir,
      env: DISPLAY ? { ...process.env, DISPLAY } : process.env,
      args: [
        '--kiosk-printing',            // window.print() 直接落盘
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
        '--window-size=1440,900',
      ],
      defaultViewport: null,
    });

    page = await browser.newPage();
    inflight.set(page, 0);
    lastActivity.set(page, Date.now());
    page.on('request', () => {
      inflight.set(page!, (inflight.get(page!) || 0) + 1);
      lastActivity.set(page!, Date.now());
    });
    const settle = () => {
      inflight.set(page!, Math.max(0, (inflight.get(page!) || 0) - 1));
      lastActivity.set(page!, Date.now());
    };
    page.on('requestfinished', settle);
    page.on('requestfailed', settle);
    await page.evaluateOnNewDocument(VIS_HELPER);
    await page.setViewport({ width: 1440, height: 900 });

    // 导航与内容就绪解耦：AWS 控制台 SPA 常常 goto 超时但 URL 已到位
    const READY = `(function(){
      var t=(document.body&&document.body.innerText)||'';
      if(/无法加载您的页面|Unable to load|正在调查问题/i.test(t)) return false;
      return /账单周期|Billing period|预计总计|Estimated Total/i.test(t);
    })()`;
    let ready = false;
    for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
      try {
        await page.goto(attempt === 1 ? signin : dest, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch { /* 超时不代表失败，继续等内容 */ }
      try { await page.waitForFunction(READY, { timeout: 45000 }); ready = true; }
      catch {
        const errPage = await page.evaluate(
          `/无法加载您的页面|Unable to load|正在调查问题/i.test(document.body.innerText||'')`).catch(() => false);
        if (errPage) await new Promise(r => setTimeout(r, 8000));   // AWS 侧疑似限流，退避
      }
    }
    if (!ready) throw new Error('账单内容未渲染（AWS 侧限流或故障）');
    await page.bringToFront();   // kiosk 打印要求标签在前台
    log('账单首屏已出');

    // 等数据真正加载完
    try {
      await page.waitForFunction(`(function(){
        var sp=document.querySelectorAll('[class*="awsui_spinner"],[class*="awsui_loading"],[aria-busy="true"]');
        for(var i=0;i<sp.length;i++){var r=sp[i].getBoundingClientRect();if(r.width>1&&r.height>1) return false;}
        return true;
      })()`, { timeout: 60000, polling: 500 });
    } catch { /* 指示器没消失也继续，靠网络空闲兜底 */ }
    await waitNetworkIdle(page, 2500, 60000);
    await new Promise(r => setTimeout(r, SETTLE_MS));

    const errNow = await page.evaluate(
      `/无法加载您的页面|Unable to load|正在调查问题/i.test(document.body.innerText||'')`).catch(() => false);
    if (errNow) throw new Error('页面在等待期间变为错误页');

    // 防串号：页面显示的账户必须是目标账户
    const shown: any = await page.evaluate(`(function(){
      var m=(document.body.innerText||'').match(/\\b(\\d{12})\\b/g);
      return m ? Array.from(new Set(m)).slice(0,6) : [];
    })()`).catch(() => []);
    if (Array.isArray(shown) && shown.length && !shown.includes(accountId)) {
      throw new Error(`会话串号：页面显示 ${shown.join('/')}，目标 ${accountId}`);
    }

    // 点页面右上角「打印」
    const m1 = await page.evaluate(`(function(){
      var nodes=document.querySelectorAll('button,[role="button"]');
      for(var i=0;i<nodes.length;i++){
        var el=nodes[i], t=(el.textContent||'').trim();
        if(!/^打印$|^Print$/i.test(t)) continue;
        if(!window.__vis(el)) continue;
        el.setAttribute('data-bp1','1');
        return true;
      }
      return false;
    })()`);
    if (!m1) throw new Error('找不到可见的「打印」按钮');
    await page.click('[data-bp1="1"]');

    // 等「打印内容」弹窗（fixed 定位，按尺寸+样式判定可见）
    await page.waitForFunction(`(function(){
      var ms=document.querySelectorAll('[role="dialog"],[class*="awsui_dialog"],[class*="awsui_modal-content"]');
      for(var i=0;i<ms.length;i++){
        if(!window.__vis(ms[i])) continue;
        var h=ms[i].querySelector('h1,h2,h3');
        if(/打印内容|Print/i.test(h?(h.textContent||''):'')) return true;
      }
      return false;
    })()`, { timeout: 25000 });

    // 锁定面积最大的那个可见弹窗（隐藏副本会被 __vis 过滤掉）
    await page.evaluate(`(function(){
      var ms=document.querySelectorAll('[role="dialog"],[class*="awsui_dialog"],[class*="awsui_modal-content"]');
      var best=null, area=0;
      for(var i=0;i<ms.length;i++){
        if(!window.__vis(ms[i])) continue;
        var h=ms[i].querySelector('h1,h2,h3');
        if(!/打印内容|Print/i.test(h?(h.textContent||''):'')) continue;
        var r=ms[i].getBoundingClientRect();
        if(r.width*r.height>area){ area=r.width*r.height; best=ms[i]; }
      }
      if(best) best.setAttribute('data-bp-modal','1');
    })()`);

    // 打开默认关闭的区块（按服务计费/按账户计费/节省成本），账单才完整
    const turned: any = await page.evaluate(`(function(){
      var m=document.querySelector('[data-bp-modal="1"]');
      if(!m) return 0;
      var cbs=m.querySelectorAll('input[type=checkbox]'), n=0;
      for(var i=0;i<cbs.length;i++){
        if(cbs[i].checked||cbs[i].disabled) continue;
        var host=cbs[i].closest('label')||cbs[i].parentElement;
        try{ (host||cbs[i]).click(); n++; }catch(e){}
      }
      return n;
    })()`);
    if (turned) await new Promise(r => setTimeout(r, 2000));

    // 点弹窗里的「打印」。AWS 会构建打印文档并自行调用 window.print()，kiosk 落盘。
    const btn: any = await page.evaluate(`(function(){
      var m=document.querySelector('[data-bp-modal="1"]');
      if(!m) return {ok:false};
      var bs=m.querySelectorAll('button');
      for(var j=0;j<bs.length;j++){
        var t=(bs[j].textContent||'').trim();
        if(!/^打印$|^Print$/i.test(t)) continue;
        if(!window.__vis(bs[j])) continue;
        bs[j].setAttribute('data-bp2','1');
        return {ok:true, hittable: window.__hittable(bs[j])};
      }
      return {ok:false};
    })()`);
    if (!btn.ok) throw new Error('弹窗内找不到可点的打印按钮');

    const before = listPdfs(tmpDir);
    if (btn.hittable) await page.click('[data-bp2="1"]');
    else await page.evaluate(`document.querySelector('[data-bp2="1"]').click()`);
    log('已点弹窗「打印」，等待落盘');

    const produced = await waitForNewPdf(tmpDir, before, PER_ACCOUNT_TIMEOUT);
    if (!produced) throw new Error('超时未生成 PDF');

    // 搬到输出目录并校验：印到网页外壳时通常只有 1 页
    const to = path.join(outDir, filename);
    fs.copyFileSync(path.join(tmpDir, produced), to);
    const buf = fs.readFileSync(to);
    const pages = pdfPageCount(buf);
    if (pages <= 1) {
      fs.rmSync(to, { force: true });
      throw new Error(`产出疑似废纸（仅 ${pages} 页），已丢弃`);
    }
    result.ok = true;
    result.pages = pages;
    log(`完成 ${(buf.length / 1024).toFixed(0)}KB ${pages} 页`);
  } catch (e: any) {
    result.error = e?.message || String(e);
    log(`失败: ${result.error}`);
  } finally {
    try { if (page) await page.close(); } catch { }
    try { if (browser) await browser.close(); } catch { }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  }
  return result;
}

async function runPool<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async (_, w) => {
    await new Promise(r => setTimeout(r, w * 2500));   // 错开启动，避免几个 Chrome 一起抢资源
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 主入口：批量导出并打包 zip
 * @param concurrency 并发账户数，服务器内存有限，实际会被压到 MAX_CONCURRENCY
 */
export async function exportBillingInvoices(
  tasks: ExportTask[],
  concurrency = 2,
  onProgress?: (done: number, total: number, result: ExportResult) => void,
): Promise<{ zipPath: string; results: ExportResult[]; workDir: string }> {
  if (!tasks.length) throw new Error('任务列表为空');
  const cap = Math.max(1, Math.min(MAX_CONCURRENCY, concurrency));

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-export-'));
  const pdfDir = path.join(workDir, 'pdfs');
  fs.mkdirSync(pdfDir, { recursive: true });
  console.log(`[billing-export] ${tasks.length} 个任务，并发 ${cap}，DISPLAY=${DISPLAY || '(本机桌面)'}`);

  let done = 0;
  // 每个账户各自起停浏览器（会话隔离），失败重试 2 次
  const results = await runPool(tasks, cap, async (task) => {
    let r = await captureOne(task, pdfDir);
    for (let t = 2; !r.ok && t <= 2; t++) {
      await new Promise(res => setTimeout(res, 6000));
      r = await captureOne(task, pdfDir);
    }
    done += 1;
    if (onProgress) { try { onProgress(done, tasks.length, r); } catch { } }
    return r;
  });

  // summary
  const lines = [
    `账单批量导出汇总  ${new Date().toISOString()}`, '',
    `总数 ${results.length}   成功 ${results.filter(r => r.ok).length}   失败 ${results.filter(r => !r.ok).length}`, '',
  ];
  for (const r of results) {
    lines.push(`[${r.ok ? 'OK' : 'FAIL'}] ${r.filename}${r.ok ? `  ${r.pages} 页` : '  -- ' + (r.error || 'unknown')}`);
  }
  fs.writeFileSync(path.join(pdfDir, '_summary.txt'), lines.join('\n') + '\n');

  const zipPath = path.join(workDir, `billing-invoices-${Date.now()}.zip`);
  const zipInputs = fs.readdirSync(pdfDir).map(f => path.join(pdfDir, f));
  const z = spawnSync('zip', ['-j', zipPath, ...zipInputs], { cwd: workDir, encoding: 'utf-8' });
  if (z.status !== 0) {
    throw new Error(`zip 打包失败 (exit=${z.status}): ${z.stderr || z.stdout || ''}`);
  }
  return { zipPath, results, workDir };
}

export function cleanupWorkDir(workDir: string) {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { }
}
