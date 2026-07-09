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

  let page;
  try {
    // 1) 生成 federation signin URL
    const destUrl = buildBillsUrl(task.year, task.month);
    const signinUrl = await getConsoleSigninUrl(task.accountId, destUrl);

    // 2) 打开新 tab
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1800, deviceScaleFactor: 1 });
    // 中文界面，跟用户样例一致
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });

    // 3) 导航到 signin URL，会自动重定向到 destination
    await page.goto(signinUrl, { waitUntil: 'networkidle2', timeout: 90_000 });

    // 4) 等待 Billing 页面关键元素出现（多重兜底）
    //    页面主要文字：账单周期 / Billing period / 预计总计 / Estimated Total
    await page.waitForFunction(
      () => {
        const txt = document.body?.innerText || '';
        return /账单周期|Billing period|预计总计|Estimated Total|按服务计费|Charges by service/i.test(txt);
      },
      { timeout: 60_000 }
    );
    // 给动态图表和汇总额外渲染时间
    await new Promise(r => setTimeout(r, 3000));

    // 5) 生成 PDF (A4，含背景色)
    await page.emulateMediaType('print');
    const outPath = path.join(outDir, filename);
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' },
    });
    result.ok = true;
  } catch (e: any) {
    result.error = e?.message || String(e);
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
  // -j: 只保留文件名不保留路径；-q: 静默
  const zipResult = spawnSync('zip', ['-j', '-q', zipPath, ...fs.readdirSync(pdfDir).map(f => path.join(pdfDir, f))], {
    cwd: workDir,
  });
  if (zipResult.status !== 0) {
    throw new Error(`zip 打包失败: ${zipResult.stderr?.toString() || 'unknown'}`);
  }

  return { zipPath, results, workDir };
}

// 清理工作目录（由调用方在发送完 zip 后调用）
export function cleanupWorkDir(workDir: string) {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
}
