/**
 * 批量导出 AWS 账单 PDF —— 复刻手动「打印 → 另存为 PDF」的完整流程
 *
 * 产出的是 AWS 自家生成的打印文档：左上角 AWS logo，表头含账单周期/账户 ID/打印日期，
 * 逐条列出每个服务每个区域的费率明细。不是网页截图。
 *
 * 流程：
 *   联邦免登录进账单页 → 点页面「打印」→ 弹窗里打开全部区块 → 点弹窗「打印」
 *   → AWS 构建打印文档 → window.print() → Chrome 静默另存为 PDF
 *
 * 两个关键技术点：
 *   1) 原生打印预览弹窗脱离 DOM 树点不到。用 --kiosk-printing 配合预设打印首选项
 *      （默认目标锁定「另存为 PDF」），页面调用 window.print() 时 Chrome 直接落盘。
 *      必须 headed 模式，headless 没有打印子系统。
 *   2) 判断弹窗可见性绝不能用 offsetParent —— AWS 弹窗是 position:fixed，
 *      fixed 元素的 offsetParent 恒为 null，会被误判成隐藏。必须用
 *      getBoundingClientRect + getComputedStyle + elementFromPoint 命中测试。
 *
 * 用法（在 web/ 目录下执行）：
 *   npx tsx scripts/print-bills.mts --month 2026-7 --accounts 906282069664
 *   npx tsx scripts/print-bills.mts --month 2026-7 --file /tmp/accounts.txt
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { getConsoleSigninUrl } from '../server/aws-service';

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const opt = (f: string, d?: string) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const monthArg = opt('--month', '');
if (!/^\d{4}-\d{1,2}$/.test(monthArg || '')) {
  console.error('必须指定账期，格式 --month YYYY-M，例如 --month 2026-7');
  process.exit(1);
}
const [YEAR, MONTH] = monthArg!.split('-').map(Number);

let accounts: string[] = [];
const accArg = opt('--accounts');
const fileArg = opt('--file');
if (accArg) accounts = accArg.split(',').map(s => s.trim());
else if (fileArg) accounts = fs.readFileSync(fileArg, 'utf8').split('\n').map(s => s.trim());
accounts = accounts.filter(s => /^\d{12}$/.test(s));
if (!accounts.length) {
  console.error('未提供有效账户，用 --accounts 逗号分隔 或 --file 每行一个');
  process.exit(1);
}

const KEEP_OPEN = flag('--keep-open');
const DEBUG = flag('--debug');                 // 输出页面异常与 console 错误
const SUMMARY_ONLY = flag('--summary-only');   // 只印默认区块，不打开明细
// 默认 auto：先试 support-quota（够用），失败自动回退 payer tool / OAAR。
// 不要默认 admin —— 很多账户没有 OrganizationAccountAccessRole，会直接 AccessDenied。
const ACCESS = (opt('--access', 'auto') as 'auto' | 'support' | 'admin');
// 网络空闲后再等多久才点打印（毫秒）。等太短会拿到未加载完的数据。
const SETTLE_MS = Number(opt('--settle', '8')) * 1000;
// 并发账户数。每个账户一个独立 Chrome 实例，调高会明显吃内存并更易触发 AWS 限流。
const CONCURRENCY = Math.max(1, Math.min(6, Number(opt('--concurrency', '3'))));
const PER_TIMEOUT = Number(opt('--timeout', '180')) * 1000;

const mm = String(MONTH).padStart(2, '0');
const SAVE_DIR = opt('--out', path.join(os.homedir(), 'Downloads', `aws-bills-${YEAR}-${mm}`))!;
fs.mkdirSync(SAVE_DIR, { recursive: true });

const log = (m: string) => console.log(`${new Date().toTimeString().slice(0, 8)} ${m}`);

// ---------------- Chrome ----------------
function findChrome(): string {
  for (const c of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    process.env.CHROME_PATH || '',
  ]) if (c && fs.existsSync(c)) return c;
  throw new Error('未找到 Chrome');
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

// ---------------- 页面内可见性判定（注入为全局函数复用） ----------------
// 不用 offsetParent：position:fixed 元素的 offsetParent 恒为 null
const VIS_HELPER = `
window.__vis = function(el){
  if(!el) return false;
  var r = el.getBoundingClientRect();
  if (r.width <= 1 || r.height <= 1) return false;
  if (r.bottom < 0 || r.right < 0) return false;
  if (r.top > (window.innerHeight||0) + 2000) return false;
  var s = window.getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  if (parseFloat(s.opacity || '1') === 0) return false;
  return true;
};
// 命中测试：中心点的最顶层元素是否就是它（或其子孙），保证坐标点击点得到
window.__hittable = function(el){
  var r = el.getBoundingClientRect();
  var x = r.left + r.width/2, y = r.top + r.height/2;
  if (x<0||y<0||x>window.innerWidth||y>window.innerHeight) return false;
  var top = document.elementFromPoint(x,y);
  while(top){ if(top===el) return true; top = top.parentElement; }
  return false;
};
`;

function listPdfs(dir: string): Set<string> {
  try { return new Set(fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf'))); }
  catch { return new Set(); }
}

// 在途请求跟踪（每个 page 一份）
const inflight = new WeakMap<Page, number>();
const lastActivity = new WeakMap<Page, number>();

/** 等网络空闲：在途请求为 0 且持续 idleMs 无新活动 */
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

async function waitForNewPdf(dir: string, before: Set<string>, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of listPdfs(dir)) {
      if (before.has(f)) continue;
      const p = path.join(dir, f);
      try {
        const s1 = fs.statSync(p).size;
        await new Promise(r => setTimeout(r, 1000));
        if (fs.existsSync(p) && fs.statSync(p).size === s1 && s1 > 1000) return f;
      } catch { /* 文件正在写，下一轮再看 */ }
    }
    await new Promise(r => setTimeout(r, 700));
  }
  return null;
}

// ---------------- 单账户 ----------------
async function printOne(browser: Browser, accountId: string, tmpDir: string): Promise<{ ok: boolean; file?: string; error?: string }> {
  const tag = `[${accountId}]`;
  let page: Page | undefined;
  try {
    const dest = `https://us-east-1.console.aws.amazon.com/billing/home?region=us-east-1#/bills?year=${YEAR}&month=${MONTH}`;
    const signin = await getConsoleSigninUrl(accountId, dest, ACCESS);

    page = await browser.newPage();
    // 跟踪在途请求数，用于判断"数据是否真的加载完"
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
    if (DEBUG) {
      page.on('pageerror', (e) => log(`${tag} [页面异常] ${String(e.message).slice(0, 200)}`));
      // 记录被拒的接口，定位打印文档缺数据的原因
      page.on('response', async (res) => {
        const st = res.status();
        if (st < 400) return;
        const u = res.url();
        let body = '';
        try { body = (await res.text()).slice(0, 220).replace(/\s+/g, ' '); } catch { }
        log(`${tag} [HTTP ${st}] ${u.slice(0, 130)}`);
        if (body) log(`${tag}          响应: ${body}`);
      });
    }
    await page.setViewport({ width: 1440, height: 900 });

    // AWS 控制台 SPA 首屏不稳：goto 可能超时但 URL 已到位。把导航与内容就绪解耦。
    // 就绪条件：出现账单关键文字，且没有 AWS 的「无法加载页面」错误条
    const READY = `(function(){
      var t=(document.body&&document.body.innerText)||'';
      if(/无法加载您的页面|Unable to load|正在调查问题/i.test(t)) return false;
      return /账单周期|Billing period|预计总计|Estimated Total/i.test(t);
    })()`;
    let ready = false;
    for (let attempt = 1; attempt <= 4 && !ready; attempt++) {
      try {
        log(`${tag} 打开账单页${attempt > 1 ? `（第 ${attempt} 次）` : ''}...`);
        await page.goto(attempt === 1 ? signin : dest, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch {
        log(`${tag} 导航超时，继续等内容`);
      }
      try { await page.waitForFunction(READY, { timeout: 45000 }); ready = true; }
      catch {
        const errPage = await page.evaluate(
          `/无法加载您的页面|Unable to load|正在调查问题/i.test(document.body.innerText||'')`).catch(() => false);
        log(`${tag} ${errPage ? 'AWS 返回页面加载失败，等待后重试' : '内容未就绪'}`);
        if (errPage) await new Promise(r => setTimeout(r, 8000));   // 退避，疑似限流
      }
    }
    if (!ready) throw new Error('账单内容始终未渲染（尝试 4 次，可能是 AWS 侧限流或故障）');
    // kiosk 打印要求标签页在前台，后台标签的 window.print() 会被 Chrome 忽略
    await page.bringToFront();
    log(`${tag} 账单首屏已出（标签已置前台）`);

    // 关键：首屏文字出现 ≠ 数据加载完。
    // 「按服务提供商列出的最高估算成本」「按服务计费」等区块是异步拉取的，
    // 数据未到位就点打印，AWS 拿不到完整数据 → 打印文档缺内容甚至报错。
    // 所以要等：转圈消失 + 网络空闲 + 额外缓冲。
    try {
      await page.waitForFunction(`(function(){
        var sp=document.querySelectorAll('[class*="awsui_spinner"],[class*="awsui_loading"],[aria-busy="true"]');
        for(var i=0;i<sp.length;i++){
          var r=sp[i].getBoundingClientRect();
          if(r.width>1&&r.height>1) return false;
        }
        return true;
      })()`, { timeout: 60000, polling: 500 });
      log(`${tag} 加载指示器已消失`);
    } catch {
      log(`${tag} 仍有加载指示器，继续等网络空闲`);
    }

    // 网络空闲：连续 IDLE_MS 内没有新的在途请求
    const idleOk = await waitNetworkIdle(page, 2500, 60000);
    log(`${tag} ${idleOk ? '网络已空闲' : '网络未完全空闲，继续'}`);

    // 再给一段固定缓冲，让最后一批渲染落定
    log(`${tag} 缓冲 ${SETTLE_MS / 1000}s 后点打印`);
    await new Promise(r => setTimeout(r, SETTLE_MS));

    // 点打印前确认页面没有变成错误页
    const errNow = await page.evaluate(
      `/无法加载您的页面|Unable to load|正在调查问题/i.test(document.body.innerText||'')`).catch(() => false);
    if (errNow) throw new Error('页面在等待期间变为错误页');

    // Cookie 同意条会挡住打印按钮
    await page.evaluate(`(function(){
      var c=document.querySelector('#awsccc-cb-c,[id*="awsccc-cb"]');
      if(!c) return;
      var b=c.querySelectorAll('button');
      for(var i=0;i<b.length;i++){
        var t=(b[i].textContent||'').trim();
        if(/Accept|Continue|接受|继续/i.test(t)){ b[i].click(); return; }
      }
    })()`);
    await new Promise(r => setTimeout(r, 1200));

    // --- 第 1 步：点页面右上角「打印」 ---
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
    if (!m1) throw new Error('页面上找不到可见的「打印」按钮');
    await page.click('[data-bp1="1"]');
    log(`${tag} 已点页面「打印」`);

    // --- 第 2 步：等「打印内容」弹窗（fixed 定位，必须用尺寸+样式判定可见） ---
    await page.waitForFunction(`(function(){
      var ms=document.querySelectorAll('[role="dialog"],[class*="awsui_dialog"],[class*="awsui_modal-content"]');
      for(var i=0;i<ms.length;i++){
        if(!window.__vis(ms[i])) continue;
        var h=ms[i].querySelector('h1,h2,h3');
        if(/打印内容|Print/i.test(h?(h.textContent||''):'')) return true;
      }
      return false;
    })()`, { timeout: 25000 });

    // 标记这个可见弹窗，后续操作都限定在它内部
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
    const modalInfo: any = await page.evaluate(`(function(){
      var m=document.querySelector('[data-bp-modal="1"]');
      if(!m) return null;
      var r=m.getBoundingClientRect();
      var cbs=m.querySelectorAll('input[type=checkbox]');
      var on=0; for(var i=0;i<cbs.length;i++) if(cbs[i].checked) on++;
      return { w:Math.round(r.width), h:Math.round(r.height), total:cbs.length, checked:on };
    })()`);
    if (!modalInfo) throw new Error('未能锁定可见的「打印内容」弹窗');
    log(`${tag} 弹窗就位 ${modalInfo.w}x${modalInfo.h}，区块 ${modalInfo.checked}/${modalInfo.total} 已开`);

    // --- 打开默认关闭的区块（按服务计费/按账户计费/节省成本），账单才完整 ---
    if (!SUMMARY_ONLY) {
      const turned: any = await page.evaluate(`(function(){
        var m=document.querySelector('[data-bp-modal="1"]');
        if(!m) return {n:0};
        var cbs=m.querySelectorAll('input[type=checkbox]'), n=0;
        for(var i=0;i<cbs.length;i++){
          if(cbs[i].checked||cbs[i].disabled) continue;
          var host=cbs[i].closest('label')||cbs[i].parentElement;
          try{ (host||cbs[i]).click(); n++; }catch(e){}
        }
        var on=0; for(var j=0;j<cbs.length;j++) if(cbs[j].checked) on++;
        return {n:n, checked:on, total:cbs.length};
      })()`);
      if (turned.n) {
        log(`${tag} 打开 ${turned.n} 个区块 → 现在 ${turned.checked}/${turned.total} 已开`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // --- 第 3 步：点弹窗里的「打印」，AWS 由此构建打印文档 ---
    const btn: any = await page.evaluate(`(function(){
      var m=document.querySelector('[data-bp-modal="1"]');
      if(!m) return {ok:false,reason:'modal gone'};
      var bs=m.querySelectorAll('button');
      for(var j=0;j<bs.length;j++){
        var t=(bs[j].textContent||'').trim();
        if(!/^打印$|^Print$/i.test(t)) continue;
        if(!window.__vis(bs[j])) continue;
        bs[j].setAttribute('data-bp2','1');
        return {ok:true, hittable: window.__hittable(bs[j])};
      }
      return {ok:false,reason:'no visible print button in modal'};
    })()`);
    if (!btn.ok) throw new Error(`弹窗内找不到可点的打印按钮（${btn.reason}）`);

    // 纯手动模拟：点完之后完全不干预，让 AWS 自己走完打印流程。
    // 只装一个观测探针，记录 AWS 是否真的调用了 window.print()，以及打印文档何时进出 DOM。
    await page.evaluate(`(function(){
      window.__awsPrintCalls = 0;
      window.__docAppearedAt = 0;
      window.__docGoneAt = 0;
      var _p = window.print;
      window.print = function(){
        window.__awsPrintCalls++;
        return _p.apply(window, arguments);      // 真正交给 Chrome，kiosk 会落盘
      };
      var seen = false;
      setInterval(function(){
        var has = /打印日期|Print date/i.test(document.body.innerHTML);
        if (has && !seen) { seen = true; window.__docAppearedAt = Date.now(); }
        if (!has && seen && !window.__docGoneAt) { window.__docGoneAt = Date.now(); }
      }, 200);
    })()`);

    // 落盘目录按账户隔离，这样多个账户可以并发打印而不抢文件名
    const before = listPdfs(tmpDir);
    if (btn.hittable) {
      await page.click('[data-bp2="1"]');            // 真实鼠标事件，React 最稳
    } else {
      // 被遮挡时退回 DOM click
      await page.evaluate(`document.querySelector('[data-bp2="1"]').click()`);
    }
    log(`${tag} 已点弹窗「打印」，等打印文档出现即就地打印...`);

    // --- 第 4 步：等 AWS 生成打印文档 ---
    // 「打印日期」只出现在打印文档里，是最可靠的完成信号。
    // 该文档在屏幕媒体下隐藏，所以查 innerHTML 而不是 innerText。
    // AWS 点完「打印」会把打印文档注入 DOM，但实测它不会真正调用 window.print()
    // （printCalls 恒为 0，单等文件 3 分钟也不落盘）。而该文档存在的时间是有限的，
    // 过一会儿会被移除。所以必须：等文档成形 → 等内容稳定 → 立刻自己触发打印。
    // 触发早了印出半成品，晚了文档已被移除、印出只有侧边栏的废纸。
    // 防串号：确认页面顶部显示的就是目标账户。
    // 会话串了的话页面会是别的账户，印出来文件名对、数据错。
    const shown: any = await page.evaluate(`(function(){
      var t=document.body.innerText||'';
      var m=t.match(/\\b(\\d{12})\\b/g);
      return m ? Array.from(new Set(m)).slice(0,6) : [];
    })()`).catch(() => []);
    if (Array.isArray(shown) && shown.length && !shown.includes(accountId)) {
      throw new Error(`会话串号：页面显示账户 ${shown.join('/')}，目标是 ${accountId}`);
    }

    // 边等文件边观测，弄清 AWS 到底有没有自己调用打印
    const deadline = Date.now() + PER_TIMEOUT;
    let produced: string | null = null;
    while (Date.now() < deadline && !produced) {
      const st: any = await page.evaluate(`(function(){
        return { calls: window.__awsPrintCalls,
                 appeared: window.__docAppearedAt, gone: window.__docGoneAt,
                 len: document.body.innerHTML.length };
      })()`).catch(() => null);
      if (st) {
        log(`${tag} 观测 AWS调用打印=${st.calls} 文档${st.appeared ? '已出现' : '未出现'}` +
          `${st.gone ? '(已被移除)' : ''} DOM=${st.len}`);
      }
      produced = await waitForNewPdf(tmpDir, before, 5000);
    }
    if (!produced) throw new Error('超时未生成 PDF');

    // 从账户私有落盘目录搬到最终目录，并改成可辨识的名字
    const target = `${accountId}-${YEAR}-${mm}.pdf`;
    const from = path.join(tmpDir, produced);
    const to = path.join(SAVE_DIR, target);
    try {
      if (fs.existsSync(to)) fs.rmSync(to);
      fs.renameSync(from, to);
    } catch {
      try { fs.copyFileSync(from, to); fs.rmSync(from, { force: true }); } catch { }
    }
    const fin = fs.existsSync(to) ? to : from;

    // 产出校验：印到「只有侧边栏的网页外壳」时通常仅 1 页且体积偏小，
    // 真正的账单打印文档至少两页。命中则删掉并报失败，交给上层重试。
    const buf = fs.readFileSync(fin);
    const pages = buf.toString('latin1').split('/Type /Page').length - 1;
    if (pages <= 1) {
      fs.rmSync(fin, { force: true });
      throw new Error(`产出疑似废纸（仅 ${pages} 页，${(buf.length / 1024).toFixed(0)}KB），已丢弃`);
    }
    log(`${tag} 完成 → ${path.basename(fin)}  ${(buf.length / 1024).toFixed(0)} KB  ${pages} 页`);
    return { ok: true, file: path.basename(fin) };
  } catch (e: any) {
    log(`${tag} 失败: ${e?.message || e}`);
    if (page) {
      try {
        const snap = path.join(SAVE_DIR, `_fail-${accountId}.png`);
        await page.screenshot({ path: snap });
        log(`${tag} 现场截图 ${snap}`);
      } catch { }
    }
    return { ok: false, error: e?.message || String(e) };
  } finally {
    if (page && !KEEP_OPEN) { try { await page.close(); } catch { } }
  }
}

// ---------------- 主流程 ----------------
log(`账期 ${YEAR}-${mm}   账户 ${accounts.length} 个   输出 ${SAVE_DIR}`);

/**
 * 每个账户开一个全新浏览器实例（独立 --user-data-dir）。
 *
 * 为什么不能复用同一个浏览器：AWS 控制台会话存在 .amazon.com 的 cookie 里，
 * 一个 profile 只持有一份会话。在同一 profile 里顺序打开多个账户的联邦登录链接，
 * 后面的账户会沿用前面账户的会话——实测 8 个账户导出的 PDF 文件名各不相同，
 * 但内容全是第一个账户的数据。这类"看起来成功了"的错误最危险。
 */
async function withFreshBrowser<T>(accountId: string, fn: (b: Browser, tmpDir: string) => Promise<T>): Promise<T> {
  const profileDir = path.join(os.tmpdir(), `aws-bill-profile-${accountId}`);
  // 每账户独立落盘目录：并发打印时互不抢文件名
  const tmpDir = path.join(os.tmpdir(), `aws-bill-out-${accountId}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  seedProfile(profileDir, tmpDir);
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: false,                  // 必须 headed：headless 没有打印子系统
    userDataDir: profileDir,
    args: [
      '--kiosk-printing',             // window.print() 直接落盘，不弹预览
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--window-size=1440,900',
    ],
    defaultViewport: null,
  });
  try {
    return await fn(browser, tmpDir);
  } finally {
    if (!KEEP_OPEN) {
      try { await browser.close(); } catch { }
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
    }
  }
}

const ok: string[] = [];
const fail: { id: string; error?: string }[] = [];
let done = 0;

async function handleAccount(acct: string) {
  // AWS 侧抖动较多（加载失败、限流），最多试 3 次，每次都用干净会话
  let r: { ok: boolean; file?: string; error?: string } = { ok: false };
  for (let t = 1; t <= 3 && !r.ok; t++) {
    if (t > 1) {
      log(`${acct} 第 ${t} 次尝试`);
      await new Promise(res => setTimeout(res, 8000));
    }
    r = await withFreshBrowser(acct, (b, tmp) => printOne(b, acct, tmp));
  }
  done++;
  if (r.ok) ok.push(acct); else fail.push({ id: acct, error: r.error });
  log(`[进度] ${done}/${accounts.length}  成功 ${ok.length} 失败 ${fail.length}`);
}

// 并发池：每个账户是独立浏览器 + 独立落盘目录，因此可以并行。
// 并发过高会同时开多个 Chrome，吃内存也更容易触发 AWS 限流。
const queue = [...accounts];
const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async (_, w) => {
  // 错开启动，避免同一瞬间几个 Chrome 一起抢资源
  await new Promise(res => setTimeout(res, w * 2500));
  while (queue.length) {
    const acct = queue.shift();
    if (!acct) break;
    await handleAccount(acct);
  }
});
await Promise.all(workers);

log(`\n成功 ${ok.length} / 失败 ${fail.length}`);
for (const f of fail) log(`  失败 ${f.id}: ${f.error}`);
log(`PDF 目录: ${SAVE_DIR}`);
process.exit(fail.length && !ok.length ? 1 : 0);
