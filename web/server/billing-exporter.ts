/**
 * 批量导出 AWS Console → Billing → Bills 页面 PDF
 *
 * 原理：
 * 1. 用 STS federation 生成免登录 signin URL，destination 指向 Billing Bills 页面
 * 2. 用 puppeteer 打开该 URL，等页面渲染完
 * 3. page.pdf() 生成 PDF
 * 4. 所有 PDF 完成后用系统 zip 命令打包
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import puppeteer, { Browser } from 'puppeteer-core';
import { getConsoleSigninUrl } from './aws-service';

// 查找 Chrome 可执行文件（复用 doc-generator 的逻辑）
function findChrome(): string {
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.env.CHROME_PATH || '',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
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
}

// 构建 Bills 页面 destination URL（新版 Billing Console）
function buildBillsUrl(year: number, month: number): string {
  // 新版 Billing Bills 页
  return `https://us-east-1.console.aws.amazon.com/billing/home?region=us-east-1#/bills?year=${year}&month=${month}`;
}

// 净化文件名（去掉不允许字符）
function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').slice(0, 80);
}

// 打开单个账号-月份组合，抓取 PDF，写入 outDir
async function captureOne(browser: Browser, task: ExportTask, outDir: string): Promise<ExportResult> {
  const result: ExportResult = {
    accountId: task.accountId,
    accountName: task.accountName,
    year: task.year,
    month: task.month,
    filename: '',
    ok: false,
  };
  const monthStr = String(task.month).padStart(2, '0');
  const nameBase = safeName(task.accountName ? `${task.accountName}-${task.accountId}` : task.accountId);
  const filename = `${nameBase}-${task.year}-${monthStr}.pdf`;
  result.filename = filename;

  const log = (msg: string) => console.log(`[${task.accountId}/${task.year}-${monthStr}] ${msg}`);
  let page;
  try {
    // 1) 生成 federation signin URL
    log('generating signin URL...');
    const destUrl = buildBillsUrl(task.year, task.month);
    const signinUrl = await getConsoleSigninUrl(task.accountId, destUrl);
    log(`signin URL OK (len=${signinUrl.length})`);

    // 2) 打开新 tab
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1800, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });

    // 提前拦截 window.print()，避免 AWS 打印按钮触发真的调用（headless 下无影响，但保险）
    // 注意：用字符串形式的 evaluate，避免 tsx/esbuild 注入 __name helper 污染浏览器上下文
    await page.evaluateOnNewDocument(`(function(){
      window.__printCalled = false;
      var _p = window.print;
      window.print = function(){ window.__printCalled = true; };
      window.__origPrint = _p;
    })();`);

    // 3) 导航到 signin URL，会自动重定向到 destination
    log('navigating...');
    await page.goto(signinUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    log(`navigated, current URL: ${page.url()}`);

    // 等一会儿让 SPA JS 加载
    await new Promise(r => setTimeout(r, 5000));
    log(`after 5s wait, URL: ${page.url()}`);

    // 4) 等待 Billing 页面关键元素出现 —— 用字符串 waitForFunction 避开 __name 问题
    try {
      await page.waitForFunction(
        `(function(){ var t = (document.body && document.body.innerText) || ''; return /账单周期|Billing period|预计总计|Estimated Total|按服务计费|Charges by service/i.test(t); })()`,
        { timeout: 60_000 }
      );
      log('key text detected');
    } catch (waitErr: any) {
      log(`waitForFunction timeout: ${waitErr.message}`);
      const bodyText: any = await page.evaluate(`document.body ? document.body.innerText.slice(0,500) : '(empty)'`).catch(() => '(err)');
      log(`page body preview: ${String(bodyText).replace(/\n/g, ' | ').slice(0, 300)}`);
      const snapDir = path.dirname(outDir);
      try {
        await page.screenshot({ path: path.join(snapDir, `snapshot-${task.accountId}-${task.year}-${monthStr}.png`), fullPage: true });
        log('screenshot saved');
      } catch {}
      throw waitErr;
    }
    // 页面首次渲染后再等一会儿，让金额/表格数据加载完
    await new Promise(r => setTimeout(r, 3000));

    // 5) 模拟点击 AWS "打印" 按钮 —— 触发 AWS 自己的打印视图切换
    //    用字符串形式 evaluate，避开 tsx/esbuild __name helper 污染
    const clicked: any = await page.evaluate(`(function(){
      var nodes = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"], a'));
      var found = null;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var txt = (el.textContent || '').trim();
        var label = el.getAttribute('aria-label') || '';
        if (/^打印$|^Print$/i.test(txt) || /打印|print/i.test(label)) { found = el; break; }
      }
      if (found) {
        found.click();
        return { clicked: true, text: (found.textContent || '').trim().slice(0, 20), label: found.getAttribute('aria-label') };
      }
      return { clicked: false };
    })()`);
    log(`print button click: ${JSON.stringify(clicked)}`);

    if (clicked && clicked.clicked) {
      // 等 AWS 应用打印布局（切换 DOM / 加 class / 触发 print media）
      await new Promise(r => setTimeout(r, 2500));
      const printed: any = await page.evaluate(`window.__printCalled || false`);
      log(`window.print called by AWS? ${printed}`);
    }

    // 6) 生成 PDF —— 用 print media（跟 window.print 行为一致，让 AWS 的 @media print CSS 生效）
    log('generating PDF...');
    await page.emulateMediaType('print');
    // print media 切换后再给点时间稳定
    await new Promise(r => setTimeout(r, 800));
    const outPath = path.join(outDir, filename);
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' },
    });
    log(`PDF saved: ${filename}`);
    result.ok = true;
  } catch (e: any) {
    result.error = e?.message || String(e);
    log(`FAIL: ${result.error}`);
  } finally {
    try { if (page) await page.close(); } catch {}
  }
  return result;
}

// 并发执行器（简单 semaphore）
async function runPool<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
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
 * 主入口：执行批量导出并返回打包好的 zip 路径 + 每项结果
 * @param tasks 任务清单
 * @param concurrency 并发数（默认 5，最大 15）
 * @param onProgress 每完成一个任务回调（用于 SSE 进度上报，可选）
 */
export async function exportBillingInvoices(
  tasks: ExportTask[],
  concurrency = 10,
  onProgress?: (done: number, total: number, result: ExportResult) => void,
): Promise<{ zipPath: string; results: ExportResult[]; workDir: string }> {
  if (!tasks.length) throw new Error('任务列表为空');
  const cap = Math.max(1, Math.min(15, concurrency));

  // 临时工作目录
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-export-'));
  const pdfDir = path.join(workDir, 'pdfs');
  fs.mkdirSync(pdfDir, { recursive: true });

  // 启动 puppeteer（复用一个 Browser 实例，多 tab 并行）
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  let done = 0;
  let results: ExportResult[] = [];
  try {
    results = await runPool(tasks, cap, async (task) => {
      const r = await captureOne(browser, task, pdfDir);
      done += 1;
      if (onProgress) {
        try { onProgress(done, tasks.length, r); } catch {}
      }
      return r;
    });
  } finally {
    try { await browser.close(); } catch {}
  }

  // 用系统 zip 命令打包（不引入 archiver 依赖）
  const zipPath = path.join(workDir, `billing-invoices-${Date.now()}.zip`);
  const pdfFiles = fs.readdirSync(pdfDir);

  // 写一份 summary.txt 到 zip 里（成功/失败清单）
  const summaryPath = path.join(pdfDir, '_summary.txt');
  const lines = [`Batch export summary  (${new Date().toISOString()})`, ''];
  lines.push(`Total: ${results.length}  OK: ${results.filter(r => r.ok).length}  Fail: ${results.filter(r => !r.ok).length}`);
  lines.push('');
  for (const r of results) {
    lines.push(`[${r.ok ? 'OK' : 'FAIL'}] ${r.filename}${r.ok ? '' : '  -- ' + (r.error || 'unknown')}`);
  }
  fs.writeFileSync(summaryPath, lines.join('\n') + '\n');

  const zipInputs = fs.readdirSync(pdfDir).map(f => path.join(pdfDir, f));
  // -j: 只保留文件名不保留路径
  const zipResult = spawnSync('zip', ['-j', zipPath, ...zipInputs], {
    cwd: workDir,
    encoding: 'utf-8',
  });
  if (zipResult.status !== 0) {
    throw new Error(`zip 打包失败 (exit=${zipResult.status}): stderr=${zipResult.stderr || ''} stdout=${zipResult.stdout || ''}`);
  }

  if (pdfFiles.length === 0) {
    // 所有任务都失败了，仍然返回 zip（含 summary.txt），但同时提示错误概况
    const firstErr = results.find(r => r.error)?.error || 'unknown';
    console.warn(`[billing-exporter] 全部任务失败，首个错误: ${firstErr}`);
  }

  return { zipPath, results, workDir };
}

// 清理工作目录（由调用方在发送完 zip 后调用）
export function cleanupWorkDir(workDir: string) {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
}
