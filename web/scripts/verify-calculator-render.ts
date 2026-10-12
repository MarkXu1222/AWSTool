/** Local calculator.aws recalculation acceptance check; not part of CI. */
import fs from 'node:fs';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { buildPocEstimate, renderEstimate, saveEstimate,
  type CalculatorPlan, type Estimate } from '../server/pricing-calculator';
import { monthlyCost, shortLabel, type ServiceItem,
  type ServiceKind } from '../server/calculator-services';

interface Options { mrrs: number[]; count: number; planOnly: boolean }
interface Verification { name: string; estimate: Estimate; plan: CalculatorPlan }
const MONEY = /^([\d,]+\.\d\d) USD$/;

function options(argv: string[]): Options {
  const mrrs: number[] = [];
  let count = 2;
  let planOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--plan-only') { planOnly = true; continue; }
    if (arg !== '--mrr' && arg !== '--count') throw new Error(`Unknown argument: ${arg}`);
    const raw = argv[++i];
    if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) throw new Error(`${arg} requires a positive number`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${arg} requires a positive number`);
    if (arg === '--mrr') mrrs.push(value);
    else {
      if (!Number.isSafeInteger(value)) throw new Error('--count requires a positive integer');
      count = value;
    }
  }
  return { mrrs: mrrs.length ? mrrs : [1500, 7800, 25000], count, planOnly };
}

function coverage(): Verification {
  // One representative per ServiceParams declaration, using design 5.3.3 midpoints.
  const items: ServiceItem[] = [
    { kind: 'ec2', role: 'app', params: { instanceType: 'm7i.xlarge', count: 2, storageGbPerInstance: 100 } },
    { kind: 'ebs-volume', params: { volumes: 2, gbPerVolume: 280 } },
    { kind: 's3', params: { gb: 1950, putRequests: 250000, getRequests: 5000000 } },
    { kind: 'alb', params: { count: 2, gbPerHour: 0.8 } },
    { kind: 'cloudwatch', params: { metrics: 80, logGb: 78, dashboards: 5, alarms: 33 } },
    { kind: 'cloudtrail', params: { writeTrails: 2, eventsMillions: 3 } },
    { kind: 'rds-mysql', params: { instanceType: 'db.m6g.large', nodes: 1, deployment: 'Multi-AZ', storageGb: 100, backupGb: 0 } },
    { kind: 'rds-postgresql', params: { instanceType: 'db.m6g.large', nodes: 1, deployment: 'Multi-AZ', storageGb: 100, backupGb: 0 } },
    { kind: 'aurora-mysql', params: { instanceType: 'db.r7g.large', nodes: 2, storageGb: 200 } },
    { kind: 'elasticache', params: { instanceType: 'cache.m7g.large', nodes: 2 } },
    { kind: 'nat-gateway', params: { gateways: 2, gbPerGateway: 330 } },
    { kind: 'waf', params: { webAcls: 2, rulesPerAcl: 9, managedGroupsPerAcl: 3, requestsMillions: 63 } },
    { kind: 'api-gateway-http', params: { requestsMillions: 78 } },
    { kind: 'route53', params: { hostedZones: 5, queriesMillions: 31 } },
    { kind: 'secrets-manager', params: { secrets: 33, apiCalls: 250000 } },
    { kind: 'backup-ebs', params: { gb: 800 } },
    { kind: 'efs', params: { storageGb: 430, readGb: 50, writeGb: 50 } },
    { kind: 'ecr', params: { gb: 310 } },
    { kind: 'kms', params: { keys: 7, requests: 500000 } },
    { kind: 'sqs', params: { requestsMillions: 103 } },
  ];
  const kinds = items.map(item => item.kind);
  if (new Set<ServiceKind>(kinds).size !== kinds.length || kinds.length !== 20)
    throw new Error('Coverage estimate has missing or duplicate service kinds');
  const services = items.map(item => ({ item, monthly: monthlyCost(item), label: shortLabel(item) }));
  const total = Math.round(services.reduce((sum, service) => sum + service.monthly, 0) * 100) / 100;
  const plan: CalculatorPlan = { seed: 'coverage', mrrUsd: 0, target: total, total,
    signature: `coverage:${kinds.join('|')}`, services };
  const name = 'verify coverage';
  return { name, estimate: renderEstimate(name, plan), plan };
}

function plans(opt: Options): Verification[] {
  const output: Verification[] = [];
  const timestamp = Date.now();
  for (const mrrUsd of opt.mrrs) for (let i = 0; i < opt.count; i++) {
    const name = `verify ${mrrUsd} #${i}`;
    const seed = `verify-${timestamp}-${mrrUsd}-${i}#0`;
    output.push({ name, ...buildPocEstimate({ name, mrrUsd, seed }) });
  }
  output.push(coverage());
  return output;
}

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH || '',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    catch { /* continue to the next candidate */ }
  }
  throw new Error('No executable Chrome found');
}

function amount(text: string): number | undefined {
  const match = MONEY.exec(text);
  return match ? Number(match[1].replace(/,/g, '')) : undefined;
}

function collect(text: string, costs: Map<number, number>): number | undefined {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  let total: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'Monthly cost') total = amount(lines[i + 1] || '') ?? total;
    const match = /^VERIFY-(\d+)$/.exec(lines[i]);
    if (!match) continue;
    for (let back = 1; back <= 4 && back <= i; back++) {
      const monthly = amount(lines[i - back]);
      if (monthly !== undefined) { costs.set(Number(match[1]), monthly); break; }
    }
  }
  return total;
}

async function readRecalculation(page: Page): Promise<{ costs: Map<number, number>; total?: number }> {
  const costs = new Map<number, number>();
  let total: number | undefined;
  for (let index = 0; index < 15; index++) {
    const text = await page.evaluate(() => document.body.innerText);
    total = collect(text, costs) ?? total;
    const next = await page.$('button[aria-label="Next page"]');
    if (!next || await next.evaluate(button => (button as HTMLButtonElement).disabled
      || button.getAttribute('aria-disabled') === 'true')) break;
    await next.click();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return { costs, total };
}

async function check(browser: Browser, verification: Verification): Promise<boolean> {
  const { estimate, plan, name } = verification;
  Object.values(estimate.services).forEach((block, index) => { block.description = `VERIFY-${index + 1}`; });
  const key = await saveEstimate(estimate);
  const page = await browser.newPage();
  try {
    await page.goto(`https://calculator.aws/#/estimate?id=${encodeURIComponent(key)}`,
      { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 6000));
    await page.waitForFunction(() => [...document.querySelectorAll('button')]
      .some(button => button.textContent?.trim() === 'Update estimate'), { timeout: 30000 });
    const clicked = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')]
        .find(candidate => candidate.textContent?.trim() === 'Update estimate');
      button?.click();
      return Boolean(button);
    });
    if (!clicked) throw new Error('Update estimate button not found');
    await new Promise(resolve => setTimeout(resolve, 20000));
    const engine = await readRecalculation(page);
    let ok = true;
    console.log(`\n${name} key=${key} expected=${plan.total} engine=${engine.total ?? 'MISSING'}`);
    console.log('Service | Expected USD | Engine USD | Delta USD');
    plan.services.forEach((service, index) => {
      const actual = engine.costs.get(index + 1);
      const delta = actual === undefined ? undefined : Math.abs(actual - service.monthly);
      if (delta === undefined || delta > 0.02) ok = false;
      console.log(`VERIFY-${index + 1} ${service.label} | ${service.monthly.toFixed(2)} | ${actual?.toFixed(2) ?? 'MISSING'} | ${delta?.toFixed(2) ?? 'MISSING'}`);
    });
    if (engine.total === undefined || Math.abs(engine.total - plan.total) > 0.10) ok = false;
    console.log(`Total | ${plan.total.toFixed(2)} | ${engine.total?.toFixed(2) ?? 'MISSING'} | ${engine.total === undefined ? 'MISSING' : Math.abs(engine.total - plan.total).toFixed(2)}`);
    return ok;
  } finally {
    await page.close();
  }
}

async function main(): Promise<boolean> {
  const opt = options(process.argv.slice(2));
  const verifications = plans(opt);
  if (opt.planOnly) {
    for (const { name, plan } of verifications) {
      console.log(`${name}: total=${plan.total} signature=${plan.signature}`);
      console.log(`  ${plan.services.map(service => service.label).join(' | ')}`);
    }
    return true;
  }

  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--lang=en-US'] });
  try {
    let allOk = true;
    for (const verification of verifications) {
      try { if (!await check(browser, verification)) allOk = false; }
      catch (error) { allOk = false; console.error(`${verification.name}: ${error}`); }
    }
    return allOk;
  } finally {
    await browser.close();
  }
}

main().then(ok => process.exit(ok ? 0 : 1), error => {
  console.error(error);
  process.exit(1);
});
