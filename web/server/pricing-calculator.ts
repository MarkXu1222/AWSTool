/**
 * AWS Pricing Calculator —— 纯 REST 生成估算链接。
 *
 * calculator.aws 自己的 config.js 暴露了后端端点，POST 一份估算 JSON
 * 即返回 savedKey，无需登录、无需浏览器：
 *   saveAs  https://dnd5zrqcec4or.cloudfront.net/Prod/v2/saveAs
 *   get     https://d3knqfixx3sbls.cloudfront.net/{key}
 *
 * ⚠️ 这是未公开的内部端点，AWS 可能随时改动。缓解手段是每次都
 * verifyEstimate() 独立读回核对 —— 端点变了会立刻暴露，
 * 而不是静默生成一个空估算发给客户。
 *
 * ⚠️ metaData 三个字段缺一不可：实测缺 createdOn、或把 source 写成
 * "calculator.aws"（正确值 "calculator-platform"），都会返回 400。
 */
import { CALC_REGION, UNIT, type Ec2Type, type RdsType, type AuroraType,
  type CacheType } from './calculator-rates';
import { buildServiceBlock, monthlyCost, shortLabel, type ServiceItem,
  type Ec2Role } from './calculator-services';

const SAVE_API = 'https://dnd5zrqcec4or.cloudfront.net/Prod/v2/saveAs';
const GET_API = 'https://d3knqfixx3sbls.cloudfront.net/';
const SHARE = 'https://calculator.aws/#/estimate?id=';


/**
 * 估算名里的 `<` `>` `&` 会被 calculator.aws 拒绝：
 *   Group Name cannot contain ">", "<" and "&"
 *
 * 商机标题里出现 `&` 很自然（如 "Network Configuration & Security Hardening"），
 * 而标题是直接拿来当估算名的，于是整个 POC 创建失败。
 *
 * 替换而不是删除：`&` 承载语义，删掉会变成 "Configuration  Security"
 * 这种读不通的名字。用 "and" 替换保留原意；`<` `>` 极少出现在标题里，
 * 按连字符处理即可。
 *
 * ⚠️ 只清洗发给计算器的名字，不回头改商机标题 —— 商机一旦 Approved
 * 标题就不可改，且 `&` 在 Partner Central 侧完全合法。
 */
export function sanitizeEstimateName(name: string): string {
  return String(name || '')
    .replace(/&/g, 'and')
    .replace(/[<>]/g, '-')
    .replace(/\s{2,}/g, ' ')
    .trim();
}


export interface Estimate {
  name: string;
  services: Record<string, any>;
  groups: Record<string, any>;
  groupSubtotal: { monthly: number; upfront: number };
  totalCost: { monthly: number; upfront: number };
  support: Record<string, any>;
  metaData: Record<string, any>;
}

export const MIN_MRR_USD = 600;
export const MAX_SEED_ATTEMPTS = 20;

export interface PlannedService { item: ServiceItem; monthly: number; label: string }
export interface CalculatorPlan {
  seed: string; mrrUsd: number; target: number; total: number; signature: string;
  services: PlannedService[];
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s, 'utf8')) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const ROLE_TYPES: Record<Exclude<Ec2Role, 'db'>, Ec2Type[]> = {
  web: ['m6i.large','m7i.large','m7g.large','c7i.large','t3.large','t3.xlarge','m6i.xlarge','m7i.xlarge','m7g.xlarge'],
  app: ['m6i.xlarge','m7i.xlarge','m7g.xlarge','m6i.2xlarge','m7i.2xlarge','m7g.2xlarge','r6i.xlarge','r7g.xlarge'],
  worker: ['c6i.xlarge','c6i.2xlarge','c7i.xlarge','c7i.2xlarge','c7g.xlarge'],
  batch: ['c7i.2xlarge','c6i.2xlarge','m7i.2xlarge','r7i.xlarge','r6i.xlarge'],
  api: ['m7g.large','m7g.xlarge','c7g.xlarge','c7i.large','m6i.large'],
};
const RDS_TYPES: RdsType[] = ['db.t4g.large','db.m6g.large','db.m6g.xlarge','db.m7g.large','db.m7g.xlarge','db.r6g.large','db.r6g.xlarge','db.r7g.large'];
const AURORA_TYPES: AuroraType[] = ['db.r6g.large','db.r6g.xlarge','db.r7g.large','db.r7g.xlarge'];
const CACHE_TYPES: CacheType[] = ['cache.m6g.large','cache.m6g.xlarge','cache.m7g.large','cache.m7g.xlarge'];
const SELF_DB_TYPES: Ec2Type[] = ['r6i.large','r6i.xlarge','r7i.large','r7i.xlarge','m7i.xlarge','r7g.large','r7g.xlarge'];
const DB_OPTIONS = ['rds-mysql','rds-postgresql','aurora-mysql','ec2-self-hosted'] as const;
const AUX_KINDS = ['elasticache','nat-gateway','waf','cloudtrail','api-gateway-http','route53',
  'secrets-manager','backup-ebs','efs','ecr','kms','sqs','ebs-volume'] as const;
type AuxKind = typeof AUX_KINDS[number];
type Role = Exclude<Ec2Role, 'db'>;

/** Deterministic, synchronous service mix for a ledger ID and attempt seed. */
export function planPocEstimate(input: { mrrUsd: number; seed: string }): CalculatorPlan {
  const { mrrUsd, seed } = input;
  if (!Number.isFinite(mrrUsd) || mrrUsd < MIN_MRR_USD)
    throw new Error('MRR 低于 600 USD，无法生成计算器');
  const r = mulberry32(fnv1a32(seed));
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(r() * arr.length)];
  const uni = (a: number, b: number) => a + r() * (b - a);
  const sample = <T>(arr: readonly T[], k: number): T[] => {
    const copy = [...arr];
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(r() * (copy.length - i));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, k);
  };
  const cost = monthlyCost;
  const ec2 = (t: Ec2Type, count: number, gb: number, role?: Ec2Role):
    Extract<ServiceItem, { kind: 'ec2' }> =>
    ({ kind: 'ec2', params: { instanceType: t, count, storageGbPerInstance: gb }, role });

  const target = mrrUsd + 101 + int(0, 48) + int(1, 99) / 100;
  const alb: ServiceItem = { kind: 'alb', params: { count: int(1, 3), gbPerHour: pick([0.2,0.3,0.5,0.8,1,1.5]) } };
  const cloudwatch: ServiceItem = { kind: 'cloudwatch', params: {
    metrics: int(10, 150), logGb: int(5, 150), dashboards: int(1, 8), alarms: int(5, 60),
  } };
  const s3: Extract<ServiceItem, { kind: 's3' }> = { kind: 's3', params: {
    gb: Math.max(100, Math.round(mrrUsd * uni(0.1, 0.4) / 10) * 10),
    putRequests: int(1, 50) * 10000, getRequests: int(1, 100) * 100000,
  } };

  const makeAux = (kind: AuxKind): ServiceItem => {
    switch (kind) {
      case 'elasticache': return { kind, params: { instanceType: pick(CACHE_TYPES), nodes: int(1, 3) } };
      case 'nat-gateway': return { kind, params: { gateways: int(1, 3), gbPerGateway: int(5, 60) * 10 } };
      case 'waf': return { kind, params: { webAcls: int(1, 2), rulesPerAcl: int(3, 15),
        managedGroupsPerAcl: int(1, 4), requestsMillions: int(5, 120) } };
      case 'cloudtrail': return { kind, params: { writeTrails: 2, eventsMillions: int(1, 5) } };
      case 'api-gateway-http': return { kind, params: { requestsMillions: int(5, 150) } };
      case 'route53': return { kind, params: { hostedZones: int(1, 8), queriesMillions: int(1, 60) } };
      case 'secrets-manager': return { kind, params: { secrets: int(5, 60), apiCalls: int(1, 50) * 10000 } };
      case 'backup-ebs': return { kind, params: { gb: int(10, 150) * 10 } };
      case 'efs': return { kind, params: { storageGb: int(5, 80) * 10, readGb: int(0, 20) * 5,
        writeGb: int(0, 20) * 5 } };
      case 'ecr': return { kind, params: { gb: int(2, 60) * 10 } };
      case 'kms': return { kind, params: { keys: int(1, 12), requests: int(1, 100) * 10000 } };
      case 'sqs': return { kind, params: { requestsMillions: int(5, 200) } };
      case 'ebs-volume': return { kind, params: { volumes: int(1, 4), gbPerVolume: int(5, 50) * 10 } };
    }
  };
  const aux = sample(AUX_KINDS, int(3, 6)).map(makeAux);

  const dbOption = pick(DB_OPTIONS);
  const dbBudget = target * uni(0.12, 0.30);
  let db: Extract<ServiceItem, { kind: 'ec2' | 'rds-mysql' | 'rds-postgresql' | 'aurora-mysql' }>;
  if (dbOption === 'rds-mysql' || dbOption === 'rds-postgresql') {
    const storageGb = int(5, 100) * 10, backupGb = int(0, 50) * 10;
    let best: typeof db | undefined, error = Infinity;
    for (const instanceType of RDS_TYPES) for (const nodes of [1, 2])
      for (const deployment of ['Single-AZ', 'Multi-AZ'] as const) {
        const candidate: Extract<ServiceItem, { kind: 'rds-mysql' | 'rds-postgresql' }> =
          { kind: dbOption, params: { instanceType, nodes, deployment, storageGb, backupGb } };
        const delta = Math.abs(cost(candidate) - dbBudget);
        if (delta < error) { best = candidate; error = delta; }
      }
    db = best!;
  } else if (dbOption === 'aurora-mysql') {
    const storageGb = int(5, 100) * 10;
    let best: typeof db | undefined, error = Infinity;
    for (const instanceType of AURORA_TYPES) for (const nodes of [1, 2, 3]) {
      const candidate: Extract<ServiceItem, { kind: 'aurora-mysql' }> =
        { kind: 'aurora-mysql', params: { instanceType, nodes, storageGb } };
      const delta = Math.abs(cost(candidate) - dbBudget);
      if (delta < error) { best = candidate; error = delta; }
    }
    db = best!;
  } else {
    const t = pick(SELF_DB_TYPES), gb = int(10, 50) * 10;
    db = ec2(t, Math.max(1, Math.round(dbBudget / cost(ec2(t, 1, gb)))), gb, 'db');
  }

  const roles = sample(Object.keys(ROLE_TYPES) as Role[], int(1, 3)).map(role => ({
    role, t: pick(ROLE_TYPES[role]), gb: int(3, 25) * 10, w: uni(1, 3),
  }));
  const fixedSum = () => [alb, cloudwatch, s3, db, ...aux].reduce((sum, item) => sum + cost(item), 0);
  const perOf = (role: typeof roles[number]) => cost(ec2(role.t, 1, role.gb));
  const fits = () => fixedSum() + roles.reduce((sum, role) => sum + perOf(role), 0) <= target - 1;
  while (!fits() && aux.length) {
    const highest = [...aux].sort((a, b) => cost(b) - cost(a))[0];
    aux.splice(aux.indexOf(highest), 1);
  }
  if (!fits() && roles.length > 1) roles.splice(1);
  if (!fits()) db = { kind: 'rds-mysql', params: {
    instanceType: 'db.t4g.large', nodes: 1, deployment: 'Single-AZ', storageGb: 20, backupGb: 0,
  } };
  if (!fits()) throw new Error('MRR 过低，放不下最小配置');

  const remaining = target - fixedSum();
  const spare = remaining - roles.reduce((sum, role) => sum + perOf(role), 0);
  const weights = roles.reduce((sum, role) => sum + role.w, 0);
  const roleItems = roles.map(role => ec2(role.t,
    1 + Math.floor(spare * role.w / weights / perOf(role)), role.gb, role.role)) as
    Extract<ServiceItem, { kind: 'ec2' }>[];
  const one = (item: Extract<ServiceItem, { kind: 'ec2' }>) =>
    cost(ec2(item.params.instanceType, 1, item.params.storageGbPerInstance));
  let rest = target - fixedSum() - roleItems.reduce((sum, item) => sum + cost(item), 0);
  const cheap = [...roleItems].sort((a, b) => one(a) - one(b))[0];
  while (rest >= one(cheap)) { cheap.params.count++; rest -= one(cheap); }
  const most = [...roleItems].sort((a, b) => b.params.count - a.params.count)[0];
  const step = most.params.count * 10 * UNIT.ec2EbsGp3GbMonth;
  while (rest >= step + 2) { most.params.storageGbPerInstance += 10; rest -= step; }

  const items = () => [...roleItems, db, alb, cloudwatch, s3, ...aux];
  const total = () => Math.round(items().reduce((sum, item) => sum + cost(item), 0) * 100) / 100;
  let converged = false;
  for (let guard = 0; guard < 50; guard++) {
    const t = total();
    const decrease = () => {
      const big = roleItems.filter(item => item.params.count > 1)
        .sort((a, b) => one(b) - one(a))[0];
      if (big) big.params.count--;
      return Boolean(big);
    };
    if (t > mrrUsd + 150.99 && decrease()) continue;
    const dg = Math.floor((target - t) / UNIT.s3GbMonth);
    if (s3.params.gb + dg < 100) {
      if (decrease()) continue;
      throw new Error('计算器收敛失败');
    }
    s3.params.gb += dg;
    converged = true;
    break;
  }
  if (!converged) throw new Error('计算器收敛失败');
  if (Math.round(total() * 100) % 100 === 0) s3.params.gb += 1;
  const finalTotal = total();
  if (finalTotal < mrrUsd + 100 || finalTotal >= mrrUsd + 151)
    throw new Error('计算器总额越界');

  const dbSignature = db.kind === 'ec2'
    ? `db:ec2-self-hosted:${db.params.instanceType}x${db.params.count}`
    : db.kind === 'aurora-mysql'
      ? `db:aurora-mysql:${db.params.instanceType}x${db.params.nodes}`
      : `db:${db.kind}:${db.params.instanceType}x${db.params.nodes}:${db.params.deployment}`;
  const auxSignature = (item: ServiceItem): string => {
    if (item.kind === 'elasticache') return `elasticache:${item.params.instanceType}x${item.params.nodes}`;
    if (item.kind === 'nat-gateway') return `nat:x${item.params.gateways}`;
    if (item.kind === 'ebs-volume') return `ebs-volume:x${item.params.volumes}`;
    return item.kind;
  };
  const signature = [
    ...roleItems.map(item => `ec2:${item.role}:${item.params.instanceType}x${item.params.count}`).sort(),
    dbSignature, `alb:x${alb.params.count}`, ...aux.map(auxSignature).sort(),
  ].join('|');
  return { seed, mrrUsd, target, total: finalTotal, signature,
    services: items().map(item => ({ item, monthly: cost(item), label: shortLabel(item) })) };
}

/** Render a plan as calculator.aws estimate JSON; only the service keys and timestamp vary. */
export function renderEstimate(name: string, plan: CalculatorPlan): Estimate {
  return {
    name: sanitizeEstimateName(name),
    services: Object.fromEntries(plan.services.map(s => buildServiceBlock(s.item))),
    groups: {}, groupSubtotal: { monthly: plan.total, upfront: 0 },
    totalCost: { monthly: plan.total, upfront: 0 }, support: {},
    metaData: { locale: 'en_US', currency: 'USD',
      createdOn: new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z'),
      source: 'calculator-platform' },
  };
}

/** Validate the supported region and combine a deterministic plan with its estimate. */
export function buildPocEstimate(input: { name: string; mrrUsd: number; seed: string; region?: string }):
  { estimate: Estimate; plan: CalculatorPlan } {
  if ((input.region || CALC_REGION) !== CALC_REGION)
    throw new Error('定价计算器只支持 ap-southeast-5');
  const plan = planPocEstimate(input);
  return { estimate: renderEstimate(input.name, plan), plan };
}

export async function saveEstimate(est: Estimate): Promise<string> {
  const resp = await fetch(SAVE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://calculator.aws',
      Referer: 'https://calculator.aws/',
    },
    body: JSON.stringify(est),
    signal: AbortSignal.timeout(40000),
  });
  if (!resp.ok) {
    // 截断到 200 字会把关键信息切掉：曾经因此看到
    // "name has value: Webby-koreawallpaper- Network Config" 就以为名字是干净的，
    // 实际真名是 "...Network Configuration & Security Hardening"，罪魁 & 在 200 字之外。
    throw new Error(`计算器保存失败 HTTP ${resp.status}: `
      + (await resp.text()).slice(0, 800));
  }
  const data: any = await resp.json();
  if (![200, 201].includes(data?.statusCode)) {
    throw new Error(`计算器保存失败：statusCode=${data?.statusCode}`);
  }
  const inner = typeof data.body === 'string' ? JSON.parse(data.body) : data.body;
  const key = inner?.savedKey;
  if (!key) throw new Error('计算器响应里没有 savedKey');
  return key;
}

/** 独立读回核对。端点是未公开接口，这一步是它被改动时的唯一预警。 */
export async function verifyEstimate(
  key: string, expectTotal?: number, expectServices?: number,
) {
  let last: any;
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await fetch(GET_API + key, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const got: any = await resp.json();
      const svcs = got.services || {};
      const total = got.totalCost?.monthly;
      const problems: string[] = [];
      if (!Object.keys(svcs).length) problems.push('读回的估算没有任何服务');
      if (expectServices != null && Object.keys(svcs).length !== expectServices) {
        problems.push(`服务条数 ${Object.keys(svcs).length}，期望 ${expectServices}`);
      }
      if (expectTotal != null && Math.abs((total || 0) - expectTotal) > 0.02) {
        problems.push(`总额 ${total}，期望 ${expectTotal}`);
      }
      return { ok: !problems.length, problems, total, name: got.name };
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return { ok: false, problems: [`读回失败：${last}`], total: null, name: null };
}

export function shareUrl(key: string) { return SHARE + key; }
