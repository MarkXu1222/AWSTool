/**
 * 批量探测「Activate IAM Access」开关 —— 找出联邦控制台打不开 Billing 页的账户
 *
 * 背景：该开关（Billing 首选项 IAM user and role access to Billing information）没有任何
 * 读写 API，API 路径（ce:*、billing:*）不受它管控，唯一可靠的探测方式是真实打开
 * Billing 控制台页面，看 billingconsole 后端是否返回 "IAM user access not activated"。
 *
 * 实现要点（借鉴 billing-exporter.ts 的教训）：
 *   - 不需要打印子系统 → headless 即可，无需 Xvfb
 *   - 会话存在 .amazon.com cookie 里 → 每个账户用独立 BrowserContext（隔离 cookie jar）
 *   - 判定不依赖页面文案语言 → 监听网络响应，检查 4xx 响应体是否含 "not activated"
 *
 * 结果分类：
 *   NOT_ACTIVATED — 开关未激活，需要 root 登录手动开启（这就是要修的账户）
 *   OK            — Billing 控制台可用
 *   LOGIN_FAILED  — 联邦链路失败（角色缺失/受限账户等），无法探测
 *   UNKNOWN       — 超时内未见决定性信号，建议单独复查
 *
 * 用法（在 web/ 目录下执行；本机 AWS_PROFILE 会干扰 SDK，用 env -u 清掉）：
 *   env -u AWS_PROFILE npx tsx scripts/check-billing-iam-access.mts --payer FFCloud
 *   env -u AWS_PROFILE npx tsx scripts/check-billing-iam-access.mts --accounts 953761113844
 *   env -u AWS_PROFILE npx tsx scripts/check-billing-iam-access.mts --payer FFCloud --csv /tmp/ff.csv
 *
 * 只读探测：不改任何 AWS 资源，不写平台 DB。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer, { Browser } from 'puppeteer-core';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { OrganizationsClient, ListAccountsCommand } from '@aws-sdk/client-organizations';
import { getConsoleSigninUrl } from '../server/aws-service';

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const opt = (f: string, d?: string) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const payerName = opt('--payer');
const accountsArg = opt('--accounts');
const csvPath = opt('--csv');
const CONCURRENCY = Math.max(1, Math.min(6, Number(opt('--concurrency', '3'))));
const PER_ACCOUNT_TIMEOUT = 60_000;

if (!payerName && !accountsArg) {
  console.error('用法: --payer <payerName> 或 --accounts <id,id,...> [--csv 输出路径] [--concurrency 1-6]');
  process.exit(1);
}

// ---------------- 配置与凭证 ----------------
// .mts 是 ESM，没有 __dirname，用 import.meta.url 推导
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(SCRIPT_DIR, '../../config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const BASE_CREDS = {
  accessKeyId: config.credentials.accessKeyId,
  secretAccessKey: config.credentials.secretAccessKey,
};

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH || '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
  ];
  for (const c of candidates) {
    if (!c) continue;
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* 继续 */ }
  }
  throw new Error('未找到可执行的 Chrome（可设 CHROME_PATH）');
}

// ---------------- 账户来源 ----------------
interface Target { id: string; name?: string }

async function listPayerAccounts(name: string): Promise<Target[]> {
  const payer = (config.payers || []).find((p: any) => p.name === name);
  if (!payer) throw new Error(`config.json 中没有 payer: ${name}`);
  const sts = new STSClient({ region: 'us-east-1', credentials: BASE_CREDS });
  const r = await sts.send(new AssumeRoleCommand({ RoleArn: payer.roleArn, RoleSessionName: 'billing-access-probe' }));
  const org = new OrganizationsClient({
    region: 'us-east-1',
    credentials: {
      accessKeyId: r.Credentials!.AccessKeyId!,
      secretAccessKey: r.Credentials!.SecretAccessKey!,
      sessionToken: r.Credentials!.SessionToken!,
    },
  });
  const payerAccountId = /arn:aws:iam::(\d+):/.exec(payer.roleArn)![1];
  const out: Target[] = [];
  let token: string | undefined;
  do {
    const page = await org.send(new ListAccountsCommand({ NextToken: token }));
    for (const a of page.Accounts || []) {
      // 管理账户不走 support-quota（角色不存在），单独口径，跳过
      if (a.Id && a.Status === 'ACTIVE' && a.Id !== payerAccountId) out.push({ id: a.Id, name: a.Name });
    }
    token = page.NextToken;
  } while (token);
  return out;
}

// ---------------- 单账户探测 ----------------
type Verdict = 'OK' | 'NOT_ACTIVATED' | 'LOGIN_FAILED' | 'UNKNOWN';
interface ProbeResult { id: string; name?: string; verdict: Verdict; detail?: string }

const BILLS_URL = 'https://us-east-1.console.aws.amazon.com/billing/home?region=us-east-1#/bills';

async function probeAccount(browser: Browser, t: Target): Promise<ProbeResult> {
  // 联邦链路：只读 support-quota 一级跳（与平台「控制台-只读」入口同链路）
  let loginUrl: string;
  try {
    loginUrl = await getConsoleSigninUrl(t.id, BILLS_URL, 'support');
  } catch (e: any) {
    return { id: t.id, name: t.name, verdict: 'LOGIN_FAILED', detail: e?.message?.slice(0, 120) };
  }

  // 独立 context = 独立 cookie jar，避免会话串号（billing-exporter 的教训）
  const context = await (browser as any).createBrowserContext();
  const page = await context.newPage();
  let notActivated = false;
  let billingOk = false;
  let otherDenied = '';

  const DEBUG = argv.includes('--debug');
  page.on('response', (resp: any) => {
    const url = resp.url();
    if (!/billing/i.test(url)) return;
    const status = resp.status();
    // 决定性信号在 XHR 响应体里，与页面语言无关。
    // 注意：控制台代理可能对错误也返回 HTTP 200（错误包在 body 里），
    // 所以「成功」必须校验 body 是干净 JSON 且不含错误标记，不能只看状态码。
    resp.text().then((body: string) => {
      if (DEBUG) console.log(`  [net] ${status} ${url.split('?')[0].slice(-90)} :: ${body.slice(0, 160).replace(/\n/g, ' ')}`);
      // 实测（2026-09，账户 953761113844）：开关未激活时 billing/rest 端点返回
      // 403 {"type":"AccessDeniedException","errorCode":"IAM_Access_Disabled"}，
      // 页面 widget 的报错文案 "IAM user access not activated" 是前端翻译，网络层看不到。
      if (/IAM_Access_Disabled|not activated/i.test(body)) { notActivated = true; return; }
      // OK 判定：核心账单数据端点（completebill / 账单列表）返回 2xx 且无错误标记
      if (/\/billing\/rest\/v1\.0\/bill\/(completebill|invoice\/list)|getbillsforbillingperiod|billsummaries/i.test(url)) {
        if (status < 400 && !/accessdenied|access denied|"errorCode"/i.test(body)) billingOk = true;
        else if (status >= 400 && !otherDenied) otherDenied = `${status} ${url.split('?')[0].slice(-60)}`;
      } else if (status >= 400 && /accessdenied/i.test(body) && !otherDenied) {
        otherDenied = `${status} ${url.split('?')[0].slice(-60)}`;
      }
    }).catch(() => { /* 响应体不可读则忽略 */ });
  });

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: PER_ACCOUNT_TIMEOUT });
    // 等到出现决定性信号或超时；账单页 XHR 是异步陆续发出的
    const deadline = Date.now() + PER_ACCOUNT_TIMEOUT;
    while (Date.now() < deadline) {
      if (notActivated || billingOk) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    // 网络信号不明确时，用页面文案兜底。
    // 只认「未激活」的明确文案；不做宽松的 OK 兜底 —— Billing 页框架本身就含
    // "账单/Bills" 字样，widget 报错时页面照样有这些词，会造成假 OK（实测踩过）。
    if (!notActivated && !billingOk) {
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/not activated|未激活/i.test(text)) notActivated = true;
    }
  } catch (e: any) {
    await context.close().catch(() => { /* 已关闭 */ });
    return { id: t.id, name: t.name, verdict: 'UNKNOWN', detail: `页面加载失败: ${e?.message?.slice(0, 80)}` };
  }
  await context.close().catch(() => { /* 已关闭 */ });

  if (notActivated) return { id: t.id, name: t.name, verdict: 'NOT_ACTIVATED' };
  if (billingOk) return { id: t.id, name: t.name, verdict: 'OK' };
  return { id: t.id, name: t.name, verdict: 'UNKNOWN', detail: otherDenied || '超时内无决定性信号' };
}

// ---------------- 主流程 ----------------
(async () => {
  const targets: Target[] = accountsArg
    ? accountsArg.split(',').map(s => s.trim()).filter(s => /^\d{12}$/.test(s)).map(id => ({ id }))
    : await listPayerAccounts(payerName!);
  if (!targets.length) { console.error('没有可探测的账户'); process.exit(1); }
  console.log(`共 ${targets.length} 个账户，并发 ${CONCURRENCY}，单账户超时 ${PER_ACCOUNT_TIMEOUT / 1000}s\n`);

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const results: ProbeResult[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const t = targets[cursor++];
      const r = await probeAccount(browser, t);
      results.push(r);
      const mark = { OK: '✅', NOT_ACTIVATED: '❌', LOGIN_FAILED: '⚠️ ', UNKNOWN: '❓' }[r.verdict];
      console.log(`${mark} [${results.length}/${targets.length}] ${r.id} ${r.name || ''} → ${r.verdict}${r.detail ? ` (${r.detail})` : ''}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  await browser.close().catch(() => { /* 已关闭 */ });

  // 汇总
  const by = (v: Verdict) => results.filter(r => r.verdict === v);
  console.log('\n========== 汇总 ==========');
  console.log(`OK(控制台可用):         ${by('OK').length}`);
  console.log(`NOT_ACTIVATED(要修):    ${by('NOT_ACTIVATED').length}`);
  console.log(`LOGIN_FAILED(探测不了): ${by('LOGIN_FAILED').length}`);
  console.log(`UNKNOWN(需复查):        ${by('UNKNOWN').length}`);
  if (by('NOT_ACTIVATED').length) {
    console.log('\n需要 root 开启 Activate IAM Access 的账户:');
    for (const r of by('NOT_ACTIVATED')) console.log(`  ${r.id}  ${r.name || ''}`);
  }

  if (csvPath) {
    const lines = ['account_id,account_name,verdict,detail'];
    for (const r of results) lines.push(`${r.id},"${(r.name || '').replace(/"/g, '""')}",${r.verdict},"${(r.detail || '').replace(/"/g, '""')}"`);
    fs.writeFileSync(csvPath, lines.join('\n'));
    console.log(`\nCSV 已写入: ${csvPath}`);
  }
  // 有待修账户时以退出码 2 结束，方便脚本化判断
  process.exit(by('NOT_ACTIVATED').length ? 2 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
