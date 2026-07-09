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

    // 走"注入 CSS 隐藏导航"的路径 (headless 中 AWS 打印按钮触发不了正确流程)
    const USE_PRINT_BTN = false;

    // 4.5) 关闭 Cookie 弹窗（首次访问 AWS Console 会有）
    const cookieResult: any = await page.evaluate(`(function(){
      // AWS Cookie Banner: id="awsccc-cb-c"
      var cookieBanner = document.querySelector('#awsccc-cb-c, [id*="awsccc-cb"]');
      if (!cookieBanner) return { found: false };
      // 尝试点击 "Continue" / "接受" / "Accept all" 按钮
      var btns = Array.prototype.slice.call(cookieBanner.querySelectorAll('button'));
      for (var i = 0; i < btns.length; i++) {
        var el = btns[i];
        var txt = (el.textContent || '').trim();
        if (/Accept|Continue|接受|继续/i.test(txt)) {
          el.click();
          return { found: true, clicked: txt.slice(0, 30) };
        }
      }
      // 兜底: 点第一个 button (通常是主 CTA)
      if (btns.length) {
        var t = (btns[0].textContent || '').trim().slice(0, 30);
        btns[0].click();
        return { found: true, clicked: t, via: 'first' };
      }
      return { found: true, clicked: null };
    })()`);
    log(`cookie banner: ${JSON.stringify(cookieResult)}`);
    if (cookieResult && cookieResult.found) {
      await new Promise(r => setTimeout(r, 1500));
    }

    if (USE_PRINT_BTN) {
    // 5) 完整流程 = 两次点击 "打印":
    //    (a) 页面右上角"打印" → 弹出"打印内容"对话框(选摘要/付款信息等区域)
    //    (b) 对话框底部"打印" → 调用 window.print()，浏览器原生 print CSS 会隐藏侧栏
    // click #1: 给 header 的"打印"按钮打标记，用 puppeteer page.click
    log('click #1 preparation: mark page header 打印 btn');
    const mark1: any = await page.evaluate(`(function(){
      var nodes = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"]'));
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var txt = (el.textContent || '').trim();
        var label = el.getAttribute('aria-label') || '';
        if (/^打印$|^Print$/i.test(txt) || /打印|print/i.test(label)) {
          el.setAttribute('data-test-print-header', '1');
          return { marked: true, text: txt.slice(0, 20) };
        }
      }
      return { marked: false };
    })()`);
    log(`mark1: ${JSON.stringify(mark1)}`);
    let click1: any = { clicked: false };
    if (mark1 && mark1.marked) {
      try {
        await page.click('[data-test-print-header="1"]');
        click1 = { clicked: true, text: mark1.text };
      } catch (e: any) { log(`click #1 failed: ${e.message}`); }
    }
    log(`click #1: ${JSON.stringify(click1)}`);

    // 等"打印内容"对话框渲染完
    await new Promise(r => setTimeout(r, 3500));

    // click #2 用 puppeteer page.click (CDP 触发真实鼠标事件, React 会正确处理)
    // 先在 modal 里给"打印"按钮打个标记，再用 selector click
    log('click #2 preparation: mark modal print btn');
    const markResult: any = await page.evaluate(`(function(){
      var mods = Array.prototype.slice.call(document.querySelectorAll('[class*="awsui_modal-content"], [class*="awsui_modal-container"], [class*="awsui_dialog"]'));
      var modal = null;
      for (var k = 0; k < mods.length; k++) {
        var h = mods[k].querySelector('h1,h2,h3');
        var t = h ? h.textContent.trim() : '';
        if (/打印|Print/i.test(t)) { modal = mods[k]; break; }
      }
      if (!modal && mods.length) modal = mods[mods.length - 1];
      if (!modal) return { marked: false, reason: 'no modal' };
      var btns = Array.prototype.slice.call(modal.querySelectorAll('button'));
      var btnDump = btns.map(function(b, i){ return i + ':[' + (b.textContent || '').trim().slice(0, 20) + ']'; }).join(' ');
      for (var j = 0; j < btns.length; j++) {
        var el2 = btns[j];
        var txt2 = (el2.textContent || '').trim();
        if ((/^打印$|^Print$/i.test(txt2) || (txt2.indexOf('打印') >= 0 && txt2.indexOf('取消') < 0)) && txt2.length < 10) {
          el2.setAttribute('data-test-print', '1');
          return { marked: true, text: txt2 };
        }
      }
      return { marked: false, reason: 'no print btn in modal', btnDump: btnDump };
    })()`);
    log(`markResult: ${JSON.stringify(markResult)}`);
    
    let click2: any = { clicked: false };
    if (markResult && markResult.marked) {
      try {
        await page.click('[data-test-print="1"]');
        click2 = { clicked: true, text: markResult.text, via: 'puppeteer-click' };
      } catch (e: any) {
        log(`page.click failed: ${e.message}`);
      }
    }
    /* legacy: 在 evaluate 里 dispatchEvent (可能对某些 React 组件无效)
    const click2_legacy: any = await page.evaluate(`(function(){
      // 只找 AWS Cloudscape (awsui) 的 modal，跳过 Cookie 弹窗 (awsccc-*)
      var modal = document.querySelector('[class*="awsui_modal-content"], [class*="awsui_modal-container"], [class*="awsui_dialog"]');
      if (!modal) {
        // 兜底: 找页面上"最新"出现的"打印"按钮 (通常 modal footer)
        var allBtns = Array.prototype.slice.call(document.querySelectorAll('button'));
        // 反向遍历: modal footer 通常在 DOM 尾部
        for (var i = allBtns.length - 1; i >= 0; i--) {
          var el = allBtns[i];
          var txt = (el.textContent || '').trim();
          if (/^打印$|^Print$/i.test(txt)) {
            el.click();
            return { clicked: true, text: txt.slice(0, 20), via: 'fallback-last' };
          }
        }
        return { clicked: false, reason: 'no modal, no print button in tail' };
      }
      // 找所有 awsui modal，选包含"打印内容"或者按钮里有"打印"的
      var allModals = Array.prototype.slice.call(document.querySelectorAll('[class*="awsui_modal-content"], [class*="awsui_modal-container"], [class*="awsui_dialog"]'));
      var titles = allModals.map(function(m){ 
        var h = m.querySelector('h1,h2,h3'); 
        return h ? h.textContent.trim() : ''; 
      });
      // 优先找标题包含"打印"的 modal
      for (var k = 0; k < allModals.length; k++) {
        var t = titles[k] || '';
        if (/打印|Print/i.test(t)) { modal = allModals[k]; break; }
      }
      var modalTitle = (modal.querySelector('h1,h2,h3') || {}).textContent || '(no title)';
      var btns = Array.prototype.slice.call(modal.querySelectorAll('button'));
      var btnDump = btns.map(function(b, i){
        return i + ':[' + (b.textContent || '').trim().slice(0, 30) + ']';
      }).join(' ');
      function fireRealClick(el) {
        try {
          var rect = el.getBoundingClientRect();
          var x = rect.left + rect.width / 2;
          var y = rect.top + rect.height / 2;
          var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
          el.dispatchEvent(new MouseEvent('pointerdown', opts));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new MouseEvent('pointerup', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
        } catch (e) { try { el.click(); } catch (e2) {} }
      }
      for (var j = 0; j < btns.length; j++) {
        var el2 = btns[j];
        var txt2 = (el2.textContent || '').trim();
        // 匹配 "打印" 或 包含"打印" (排除包含"取消"的)
        if ((/^打印$|^Print$/i.test(txt2) || (txt2.indexOf('打印') >= 0 && txt2.indexOf('取消') < 0)) && txt2.length < 10) {
          fireRealClick(el2);
          return { clicked: true, text: txt2.slice(0, 20), via: 'modal' };
        }
      }
      return { clicked: false, reason: 'no print btn', modalTitle: modalTitle, allModalTitles: titles, btnCount: btns.length, btnDump: btnDump };
    })()`); */
    log(`click #2: ${JSON.stringify(click2)}`);

    // 等 window.print 触发 print CSS 生效
    await new Promise(r => setTimeout(r, 3000));
    const postClick: any = await page.evaluate(`(function(){
      return {
        url: location.href,
        printCalled: window.__printCalled || false,
        title: document.title,
        bodyText: (document.body.innerText || '').slice(0, 300).replace(/\\n/g, ' | ')
      };
    })()`);
    log(`post click #2 diag: ${JSON.stringify(postClick)}`);

    // 检查是否有新 tab / popup 打开（AWS 打印会开新窗口显示打印视图）
    try {
      const pages = await browser.pages();
      log(`total pages/tabs: ${pages.length}`);
      let newPage: any = null;
      for (const p of pages) {
        if (p !== page) { newPage = p; break; }
      }
      if (newPage) {
        const newUrl = newPage.url();
        log(`new tab URL: ${newUrl}`);
        // 在新 tab 上拦截 window.print (可能已经晚了，但值得一试)
        try {
          await newPage.evaluate(`(function(){
            window.__printCalled = false;
            var _p = window.print;
            window.print = function(){ window.__printCalled = true; };
          })();`).catch(() => {});
        } catch {}
        // AWS 打印视图是 document.write 到新 tab
        let waited = 0;
        let ready = false;
        while (waited < 25000) {
          try {
            const info: any = await newPage.evaluate(`(function(){
              var b = document.body;
              return {
                htmlLen: (b && b.innerHTML || '').length,
                textLen: (b && b.innerText || '').length,
                url: location.href,
                readyState: document.readyState,
                hasBills: /账单周期|Billing period|预计总计|Estimated Total|AWS.*预计账单/.test(b && b.innerText || ''),
                childCount: b ? b.children.length : 0,
                title: document.title
              };
            })()`).catch(() => ({htmlLen: 0, hasBills: false, url: '?', childCount: 0}));
            if (waited % 3000 === 0) log(`new tab @${waited}ms: url=${info.url} state=${info.readyState} htmlLen=${info.htmlLen} textLen=${info.textLen} kids=${info.childCount} bills=${info.hasBills}`);
            if (info.hasBills) { ready = true; break; }
          } catch {}
          await new Promise(r => setTimeout(r, 1000));
          waited += 1000;
        }
        log(`new tab ready: ${ready}, waited ${waited}ms`);
        if (ready) {
          await new Promise(r => setTimeout(r, 1500));
          page = newPage;
        }
      }
    } catch (e: any) { log(`tab check err: ${e.message}`); }
    } // end USE_PRINT_BTN

    // 5.a) 通用打印视图: 注入 CSS 强力隐藏导航栏
    log('injecting print CSS...');
    await page.addStyleTag({
      content: `
        /* AWS Console 顶部导航栏 */
        #awsc-nav-header, header[role="banner"],
        [class*="awsui_top-nav"], [id*="awsc-nav-"],
        [aria-label*="Global"], [aria-label*="全局"],
        [class*="awsccc-"] { display: none !important; }
        /* 左侧导航面板 */
        aside, nav, [class*="awsui_navigation"],
        [class*="AppLayoutDrawer"], [class*="AppLayout_navigation"],
        [class*="drawer"], [class*="Drawer"],
        [data-testid*="navigation"], [data-testid*="sidebar"],
        [role="navigation"] { display: none !important; }
        /* 面包屑 */
        [class*="Breadcrumbs"], [class*="breadcrumb"],
        [aria-label*="breadcrumb"] { display: none !important; }
        /* 主内容区拉满，去内边距 */
        [class*="awsui_layout"], [class*="AppLayout_content"],
        [class*="app-layout"], main, [role="main"] {
          padding: 0 !important; margin: 0 !important;
          max-width: 100% !important; width: 100% !important; grid-template-columns: none !important;
        }
        html, body { padding: 0 !important; margin: 0 !important; overflow: visible !important; }
        /* 隐藏所有 fixed / sticky */
        *[style*="position: fixed"], *[style*="position:fixed"],
        *[style*="position: sticky"], *[style*="position:sticky"] {
          position: static !important;
        }
      `
    });

    // 5.b) 精准移除 fixed/sticky positioned 元素 (用 JS，比 CSS 更彻底)
    await page.evaluate(`(function(){
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var s = window.getComputedStyle(el);
        if ((s.position === 'fixed' || s.position === 'sticky')) {
          // 顶部导航栏 / 页面 top bar
          var rect = el.getBoundingClientRect();
          if (rect.top < 100 && rect.width > 500) {
            el.style.display = 'none';
          }
        }
      }
    })();`).catch(() => {});
    await new Promise(r => setTimeout(r, 800));

    // 6) 生成 PDF —— 用 print media 让 AWS 自带的 @media print CSS 生效
    log('generating PDF...');
    await page.emulateMediaType('print');
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
      '--disable-popup-blocking',
      '--enable-features=OverscrollHistoryNavigation',
      '--disable-features=IsolateOrigins',
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
