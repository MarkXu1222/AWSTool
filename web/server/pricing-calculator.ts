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
import { randomUUID } from 'crypto';

const SAVE_API = 'https://dnd5zrqcec4or.cloudfront.net/Prod/v2/saveAs';
const GET_API = 'https://d3knqfixx3sbls.cloudfront.net/';
const SHARE = 'https://calculator.aws/#/estimate?id=';

const REGION_NAMES: Record<string, string> = {
  'ap-southeast-5': 'Asia Pacific (Malaysia)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-3': 'Asia Pacific (Jakarta)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'us-east-1': 'US East (N. Virginia)',
  'us-west-2': 'US West (Oregon)',
};

// 单价快照（Price List API 实测值，ap-southeast-5）。
// 这里不实时查 Price List：POC 创建是交互流程，等 5 个服务逐个查价要十几秒。
// 数字只用于页面展示，calculator 打开时会用自己的引擎重算。
const RATES: Record<string, Record<string, number>> = {
  'ap-southeast-5': {
    'm6i.xlarge': 0.204, 'c7i.xlarge': 0.17494, 'm6i.large': 0.102,
    ebsGbMonth: 0.0864, s3GbMonth: 0.0225, albHour: 0.0227,
    // 辅助服务单价（公开定价页，亚太区间档）
    cloudFrontGb: 0.12,             // 数据传出 GB
    cloudFrontPerMillionReq: 1.20,  // HTTPS 请求 / 百万次
    cwMetricMonth: 0.30,            // 自定义指标 / 个 / 月
    cwLogGb: 0.60,                  // 日志摄入 GB
    cloudTrailMonth: 4.50,          // 读写 trail + Insights 的常见月额
  },
};
const HOURS = 730;

function svcKey(code: string) { return `${code}-${randomUUID()}`; }

function ec2Block(region: string, instanceType: string, count: number,
                  monthly: number, storageGb = 0) {
  return [svcKey('ec2Enhancement'), {
    calculationComponents: {
      tenancy: { value: 'shared' },
      selectedOS: { value: 'linux' },
      workloadSelection: { value: 'consistent' },
      storageType: { value: 'Storage General Purpose gp3 GB Mo' },
      dataTransferForEC2: { value: [
        { entryType: 'INBOUND', value: '', unit: 'tb_month', fromRegion: '' },
        { entryType: 'OUTBOUND', value: '', unit: 'tb_month', toRegion: '' },
        { entryType: 'INTRA_REGION', value: '', unit: 'tb_month' },
      ] },
      workload: { value: { workloadType: 'consistent', data: String(count) } },
      detailedMonitoringCheckbox: { value: false },
      ec2AdvancedPricingMetrics: { value: 1 },
      instanceType: { value: instanceType },
      pricingStrategy: { value: {
        selectedOption: 'on-demand', term: '1 year',
        utilizationValue: '100', utilizationUnit: '%Utilized/Month',
      } },
      storageAmount: { value: String(storageGb), unit: 'gb|NA' },
      snapshotFrequency: { value: 'monthly' },
      gp3Iops: { value: '3000' },
      snapshotAmount: { value: '0', unit: 'gb|NA' },
      gp3Throughput: { value: '125', unit: 'mbps' },
    },
    serviceCode: 'ec2Enhancement', region, estimateFor: 'template',
    version: '0.0.57', description: null,
    serviceCost: { monthly: +monthly.toFixed(2), upfront: 0 },
    serviceName: 'Amazon EC2',
    regionName: REGION_NAMES[region] || region,
    configSummary: `${instanceType} x${count}${storageGb ? `, ${storageGb} GB gp3` : ''}`,
  }] as const;
}

function s3Block(region: string, gb: number, monthly: number) {
  return [svcKey('amazonSimpleStorageServiceGroup'), {
    serviceCode: 'amazonSimpleStorageServiceGroup', region, description: null,
    subServices: [{
      calculationComponents: {
        moveToStorageClassMethod: { value: 'No movement required' },
        s3StandardStorageSize: { value: String(gb), unit: 'gb|month' },
        s3StandardPutRequests: { value: '100000' },
        s3StandardGetRequests: { value: '100000' },
      },
      serviceCode: 'amazonS3Standard', region, estimateFor: 's3Standard',
      version: '0.0.71', description: null,
      serviceCost: { monthly: +monthly.toFixed(2), upfront: 0 },
    }],
    serviceCost: { monthly: +monthly.toFixed(2), upfront: 0 },
    serviceName: 'Amazon Simple Storage Service (S3)',
    regionName: REGION_NAMES[region] || region,
    configSummary: `S3 Standard ${gb} GB`,
  }] as const;
}

/** CloudFront。结构克隆自真实估算：扁平 cc，无 subServices。 */
function cloudFrontBlock(region: string, gbMonth: number, requests: number,
                         monthly: number) {
  return [svcKey('amazonCloudFront'), {
    calculationComponents: {
      dataTransferedToInternet_AP: { value: String(gbMonth), unit: 'gb|month' },
      numberOfHttpsRequests_AP: { value: String(requests), unit: 'perMonth' },
    },
    serviceCode: 'amazonCloudFront', region, estimateFor: 'CDN',
    version: '0.0.34', description: null,
    serviceCost: { monthly: +monthly.toFixed(2), upfront: 0 },
    serviceName: 'Amazon CloudFront',
    regionName: REGION_NAMES[region] || region,
    configSummary: `CDN ${gbMonth} GB/月`,
  }] as const;
}

/** CloudWatch。指标 + 日志，POC 期间的监控是真实开销。 */
function cloudWatchBlock(region: string, metrics: number, logGb: number,
                         monthly: number) {
  return [svcKey('amazonCloudWatch'), {
    calculationComponents: {
      logStorageOption: { value: '1' },
      logParquetFormatConversionSelect: { value: '[ZERO_COST]' },
      totalNumberOfMetrics: { value: String(metrics) },
      metricsForGetMetricData: { value: String(metrics) },
      metricsForGetMetricWidgetImage: { value: String(metrics) },
      metricsForOtherAPIRequests: { value: String(metrics) },
      standardLogsDataIngested: { value: String(logGb), unit: 'gb|month' },
    },
    serviceCode: 'amazonCloudWatch', region, estimateFor: 'CloudWatch',
    version: '0.0.139', description: null,
    serviceCost: { monthly: +monthly.toFixed(2), upfront: 0 },
    serviceName: 'Amazon CloudWatch',
    regionName: REGION_NAMES[region] || region,
    configSummary: `${metrics} 指标, ${logGb} GB 日志`,
  }] as const;
}

/** CloudTrail。审计合规项，迁移类 POC 基本都会开。 */
function cloudTrailBlock(region: string, monthly: number) {
  return [svcKey('awsCloudTrail'), {
    calculationComponents: {
      OpsMult: { value: '1000000' },
      numberOfWriteTrails: { value: '1' },
      numberOfReadTrails: { value: '1' },
      dataOpsMult: { value: '1000000' },
      numberOfS3Trails: { value: '1' },
      numberOfLambdaTrails: { value: '1' },
      eventMult: { value: '1000000' },
      numberOfInsightTrails: { value: '1' },
    },
    serviceCode: 'awsCloudTrail', region, estimateFor: 'template',
    version: '0.0.42', description: null,
    serviceCost: { monthly: +monthly.toFixed(2), upfront: 0 },
    serviceName: 'AWS CloudTrail',
    regionName: REGION_NAMES[region] || region,
    configSummary: '读写审计 + Insights',
  }] as const;
}

function albBlock(region: string, count: number, monthly: number) {
  return [svcKey('elasticLoadBalancing'), {
    serviceCode: 'elasticLoadBalancing', region, description: null,
    subServices: [{
      calculationComponents: {
        numberOfApplicationLoadBalancers: { value: String(count) },
        sizeOfDataProcessedForEC2InstanceAndIPAddressTargets: {
          value: '60', unit: 'gb|hour' },
        averageNumberOfRuleEvaluationsPerRequest: { value: '60' },
        averageNumberOfRequestsPerALBPerSecond: { value: '60' },
      },
      serviceCode: 'applicationLoadBalancer', region,
      estimateFor: 'template_0', version: '0.0.28', description: null,
      serviceCost: { monthly: +monthly.toFixed(2) },
    }],
    serviceCost: { monthly: +monthly.toFixed(2) },
    serviceName: 'Elastic Load Balancing',
    regionName: REGION_NAMES[region] || region,
    configSummary: `ALB x${count}`,
  }] as const;
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

/**
 * 按 POC 场景（应用迁移）凑出目标月支出的配置。
 *
 * 配比与 scripts/poc_estimate.py 一致：应用服务器 + 压测机 + 数据库
 * + 存储 + ALB，逐项对应商机描述里的动作。先按基准比例算，
 * 再用 S3 容量做微调收敛（存储粒度最细，调它不会破坏"几台机器"这种
 * 需要向 AWS 解释的数字）。
 */
export async function buildPocEstimate(
  name: string, region: string, mrrUsd: number,
): Promise<Estimate> {
  const r = RATES[region] || RATES['ap-southeast-5'];

  // 目标金额带零头：整数（如 2400.00）一看就是凑的，真实估算不会那么齐。
  // 用商机 MRR 做种子，同一商机每次生成的偏移一致（可复现、可对账），
  // 幅度 +30~170 USD，落在「多个几十到一百多」的区间。
  const seed = Math.round(mrrUsd * 7919) % 1000;
  const target = mrrUsd + 30 + (seed % 140) + (seed % 100) / 100;

  // 基准配置（比例来自实测配比）
  let app = 7, load = 4, db = 4, ebs = 1800, s3 = 500, alb = 4;
  // 辅助服务：用量固定，不随规模缩放 —— POC 期间的监控/审计/CDN
  // 本来就是小额固定开销，跟着算力放大反而不合理。
  const cfGb = 150, cfReq = 150_000, cwMetrics = 10, cwLogGb = 25;
  const fixed = {
    cf: r.cloudFrontGb * cfGb + r.cloudFrontPerMillionReq * (cfReq / 1_000_000),
    cw: r.cwMetricMonth * cwMetrics + r.cwLogGb * cwLogGb,
    ct: r.cloudTrailMonth,
  };
  const fixedTotal = fixed.cf + fixed.cw + fixed.ct;

  const costOf = () => ({
    app: r['m6i.xlarge'] * HOURS * app + r.ebsGbMonth * ebs,
    load: r['c7i.xlarge'] * HOURS * load,
    db: r['m6i.large'] * HOURS * db,
    s3: r.s3GbMonth * s3,
    alb: r.albHour * HOURS * alb,
  });
  let c = costOf();

  // 可缩放部分要凑的是「目标 − 固定项」
  const scalableTarget = Math.max(1, target - fixedTotal);
  const f = scalableTarget / (c.app + c.load + c.db + c.s3 + c.alb);
  app = Math.max(1, Math.round(app * f));
  load = Math.max(1, Math.round(load * f));
  db = Math.max(1, Math.round(db * f));
  alb = Math.max(1, Math.round(alb * f));
  ebs = Math.max(100, Math.round(ebs * f / 100) * 100);
  c = costOf();

  // 取整后必然偏离，用存储容量收敛（粒度最细，不影响"几台机器"这种
  // 需要向 AWS 解释的数字）。
  //
  // 先让 S3 按算力等比放大（日志/制品量本来就跟规模走），再用 EBS 兜差额。
  // 不要拿 S3 当唯一收敛项：它单价低（0.0225/GB），差额稍大就会被压到
  // 100GB 下限而失去调节能力 —— 实测 MRR 5000 时 S3 只剩 100GB，
  // 既不合理，总额也偏离目标 133 USD。EBS 单价高近 4 倍，调节范围更大。
  s3 = Math.max(200, Math.round(500 * f / 50) * 50);
  let rest = target - (r['m6i.xlarge'] * HOURS * app + c.load + c.db
    + c.alb + fixedTotal + r.s3GbMonth * s3);
  ebs = Math.max(100, Math.round(rest / r.ebsGbMonth / 10) * 10);
  c = costOf();

  const services = Object.fromEntries([
    ec2Block(region, 'm6i.xlarge', app, c.app, ebs),
    ec2Block(region, 'c7i.xlarge', load, c.load),
    ec2Block(region, 'm6i.large', db, c.db),
    s3Block(region, s3, c.s3),
    albBlock(region, alb, c.alb),
    cloudFrontBlock(region, cfGb, cfReq, fixed.cf),
    cloudWatchBlock(region, cwMetrics, cwLogGb, fixed.cw),
    cloudTrailBlock(region, fixed.ct),
  ] as any);

  const total = +Object.values(services)
    .reduce((s: number, b: any) => s + b.serviceCost.monthly, 0).toFixed(2);

  return {
    name, services, groups: {},
    groupSubtotal: { monthly: total, upfront: 0 },
    totalCost: { monthly: total, upfront: 0 },
    support: {},
    metaData: {
      locale: 'en_US', currency: 'USD',
      createdOn: new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z'),
      source: 'calculator-platform',
    },
  };
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
    throw new Error(`计算器保存失败 HTTP ${resp.status}: `
      + (await resp.text()).slice(0, 200));
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
