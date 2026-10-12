# 实现方案：POC 定价计算器去重 + 引擎一致

> 需求见同目录 `requirements.md`。本文档是实现的**唯一依据**。
> 同目录资料（实现时必须使用，不得自行替换数值）：
>
> | 路径 | 内容 |
> |---|---|
> | `templates/*.json` | 19 个服务的 calculator.aws JSON 模板，克隆自人工制作的真实估算，已在引擎实测 |
> | `templates/calibration.json` | 137 个引擎实测用例（服务 + 参数 → 引擎重算月费），测试夹具 |
> | `templates/engine-config-summaries.json` | 引擎自己生成的配置摘要原文（中英混杂，因 headless 浏览器为中文环境），§5.2 的英文摘要以此为准翻译 |
> | `reference/formula.cjs` | 成本公式参考实现（对 137 个用例最大误差 0.01 USD） |
> | `reference/generator-prototype.cjs` | 生成算法参考实现（`node generator-prototype.cjs` 输出唯一率统计） |
>
> `reference/` 是一次性原型，**不是产品代码**，不要 import，按本文档翻译成 TypeScript。

---

## 1. 需求与验收

把 `buildPocEstimate` 从「只按 MRR 播种、固定 8 个服务整体缩放」改为「按台账 ID 播种、服务池随机组合、成本公式与 calculator.aws 引擎一致」，并新增本地台账做撞车查重。

验收（全部可执行）：

- [ ] `cd web && npm test && npm run typecheck && npm run build` 全绿
- [ ] `tests/calculator-calibration.test.ts`：137 个实测用例，本地 `monthlyCost()` 与 `engineMonthlyUsd` 差 ≤ 0.02
- [ ] `tests/pricing-calculator-target.test.ts`：§9 列出的全部断言通过
- [ ] `tests/poc-calculator-ledger.test.ts`：§9 列出的全部断言通过
- [ ] `tests/poc-calculator-flow.test.ts`：§9.5 列出的全部断言通过
- [ ] `cd web && npx tsx scripts/verify-calculator-render.ts` 退出码 0（联网 + 本机 Chrome，由协调者在 P4 执行）
- [ ] `cd web && npx tsx scripts/verify-calculator-render.ts --plan-only --mrr 7800 --count 3` 打印 3 份计划，总额与签名两两不同

---

## 2. 现状分析

### 2.1 计算器生成（`web/server/pricing-calculator.ts`，378 行）

- `buildPocEstimate(name, region, mrrUsd): Promise<Estimate>`（async 但内部无 await）
  - `seed = Math.round(mrrUsd * 7919) % 1000`，目标 `mrr + 100 + seed%51 + (seed%99+1)/100`
  - 固定 8 个服务：EC2 m6i.xlarge（挂 EBS）/ c7i.xlarge / m6i.large、S3、ALB、CloudFront、CloudWatch、CloudTrail
  - 只有 `RATES['ap-southeast-5']` 一个区域的单价
- 块构造函数 `ec2Block` / `s3Block` / `cloudFrontBlock` / `cloudWatchBlock` / `cloudTrailBlock` / `albBlock`（文件内私有）
- `sanitizeEstimateName()`、`saveEstimate()`、`verifyEstimate()`、`shareUrl()`：**保留不动**
- `Estimate` 接口：保留不动

### 2.2 现有实现经不起引擎重算（实测）

calculator.aws 打开分享链接是只读视图，展示写入的 `serviceCost` 与 `configSummary`；点「Update estimate」后引擎按 `calculationComponents` 重算。实测 `b265f874…`：写入 7,946.93 → 重算 27,767.33。

| 现有块 | 问题 |
|---|---|
| `ec2Block` 的 `storageAmount` | 引擎按**每台实例**计（现代码当总量用） |
| `albBlock` | `sizeOfDataProcessedForEC2InstanceAndIPAddressTargets=60 gb|hour` 每台，引擎按 LCU 计费，本地只算了小时费 |
| `cloudFrontBlock` | 引擎重算恒为 0（参数格式无效，且无人工样本可参照）→ **移出服务池** |
| `cloudWatchBlock` / `cloudTrailBlock` | 参数与引擎不符 → 改用 `templates/` 模板 |

`ec2Block` 的其余结构（v0.0.57、on-demand）经实测有效，§5.2 沿用。

### 2.3 调用链

```
routes/poc-cash.ts  POST /api/poc-cash/funding
  → fund.createPocApplication(input, makeCalculator)       poc-cash-funding.ts:218
      → calcFactory(activityName, region, pre.mrrUsd)        :249   ← input.calculatorUrl 有值时跳过
      → CreateBenefitApplicationCommand({ ClientToken: randomUUID(), … AwsCalculatorUrls: [url] })
  routes/poc-cash.ts:44 makeCalculator = buildPocEstimate → saveEstimate → verifyEstimate → shareUrl
```

- `createPocApplication` 的 `calcFactory` 参数签名：`(name: string, region: string, mrr: number) => Promise<string>`
- 前端从不传 `calcRegion`；`GET /funding/meta` 的 `defaults.calcRegion = 'ap-southeast-5'`
- 结果页：`client/src/pages/PocCash.tsx:807-826` 的 `Alert`，显示申请号/金额/计算器链接

### 2.4 DB（`web/server/db.ts`）

- `readDB()` / `writeDB()` 文件内私有；`ARRAY_FIELDS`（:299）列出的键在 `normalizeDB()` 中缺失时补 `[]`；`emptyDB()`（:313）给初始值
- 参考模式：`createBillingExportJob()`（:540）—— 校验与写入之间无 `await`，同一进程内并发安全
- 测试隔离：在 import 前设 `process.env.DB_PATH` 为临时文件（见 `tests/audit-middleware.test.ts:9`）

---

## 3. 方案总览

```
POST /api/poc-cash/funding
  │
  ├─ fund.createPocApplication(input, createUniqueCalculator)
  │     ├─ precheck / 金额 / 风险项（不变）
  │     ├─ calculator = input.calculatorUrl
  │     │     ? recordManualPocCalculator(...)                      ← 台账记一条 manual
  │     │     : await createUniqueCalculator(ctx)                    ← poc-calculator.ts
  │     │           ├─ reservePocCalculator(ctx, seed => buildPocEstimate({seed,…}))   ← db.ts，同步段
  │     │           │     id=uuid；attempt 0..19：seed=`${id}#${attempt}`
  │     │           │     生成 → 与台账比对 total/signature → 不撞则写 reserved，撞则 attempt+1
  │     │           ├─ await saveEstimate(estimate)       失败 → markPocCalculatorFailed
  │     │           ├─ await verifyEstimate(key, total, n) 失败 → markPocCalculatorFailed
  │     │           └─ markPocCalculatorReady(id, key, url)
  │     ├─ CreateBenefitApplication({ ClientToken: calculator.ledgerId, … })
  │     │     失败 → markPocCalculatorFailed(ledgerId) 后抛出
  │     ├─ markPocCalculatorApplication(ledgerId, applicationId)
  │     └─ 关联商机 / 提交 / 回读（不变）
  └─ res.json({ ...result, calculator: { ledgerId, total, items[{label, monthly}] } })
```

---

## 4. 数据模型变更

### 4.1 `data/db.json` 新顶层键 `poc_calculator_ledger`

类型 `PocCalculatorLedgerEntry[]`，定义在 `db.ts`：

```ts
export type PocCalculatorStatus = 'reserved' | 'calculator_ready' | 'application_created' | 'failed';

export interface PocCalculatorLedgerEntry {
  id: string;                    // randomUUID()；同时作为 CreateBenefitApplication 的 ClientToken
  source: 'generated' | 'manual';
  status: PocCalculatorStatus;
  attempt: number;               // generated: 0..19；manual: 0
  seed: string | null;           // generated: `${id}#${attempt}`；manual: null
  opportunityId: string;
  awsAccountId: string;
  activityName: string;
  region: string;
  mrrUsd: number;
  target: number | null;         // manual: null
  total: number | null;          // 月总额 USD，两位小数；manual: null
  signature: string | null;      // §5.3.6；manual: null
  calculatorKey: string | null;  // calculator.aws savedKey；manual: null
  calculatorUrl: string | null;
  applicationId: string | null;  // benappl-…，创建成功后回填
  createdBy: string;             // 用户名
  createdAt: string;             // ISO
  updatedAt: string;
  error: string | null;          // 截断到 500 字
}
```

状态迁移：`reserved → calculator_ready → application_created`；任一步失败 → `failed`。manual 直接以 `calculator_ready` 创建。

### 4.2 向后兼容

- `ARRAY_FIELDS` 追加 `'poc_calculator_ledger'`，`emptyDB()` 追加 `poc_calculator_ledger: []`，`DBSchema` 加字段 `poc_calculator_ledger: PocCalculatorLedgerEntry[]`
- 旧库无此键 → `normalizeDB()` 补 `[]`，无需迁移
- 不裁剪、不过期（量级为每月几十条）
- `config.json`：**无变更**

---

## 5. 后端设计

### 5.1 新建 `web/server/calculator-rates.ts`

只放常量，全部来自 `reference/formula.cjs`（引擎实测，不是 Price List）。文件头注释写明「2026-10-12 calculator.aws Update estimate 实测；AWS 调价后重跑 `scripts/verify-calculator-render.ts` 并更新」。

```ts
export const CALC_REGION = 'ap-southeast-5' as const;
export const CALC_REGION_NAME = 'Asia Pacific (Malaysia)';
export const HOURS_PER_MONTH = 730;

export const EC2_HOURLY = { 'm6i.large': 0.102, 'm6i.xlarge': 0.204, 'm6i.2xlarge': 0.408,
  'm7i.large': 0.1071, 'm7i.xlarge': 0.2142, 'm7i.2xlarge': 0.4284,
  'c6i.xlarge': 0.1666, 'c6i.2xlarge': 0.3332,
  'c7i.large': 0.08747, 'c7i.xlarge': 0.17494, 'c7i.2xlarge': 0.34988,
  'r6i.large': 0.1292, 'r6i.xlarge': 0.2584, 'r7i.large': 0.13566, 'r7i.xlarge': 0.27132,
  'm7g.large': 0.0867, 'm7g.xlarge': 0.1734, 'm7g.2xlarge': 0.3468, 'c7g.xlarge': 0.1416,
  'r7g.large': 0.1098, 'r7g.xlarge': 0.2196, 't3.large': 0.095, 't3.xlarge': 0.1901 } as const;
export type Ec2Type = keyof typeof EC2_HOURLY;

// RDS MySQL 与 PostgreSQL 单价相同（实测）；Single-AZ 单价，Multi-AZ ×2
export const RDS_HOURLY = { 'db.t4g.large': 0.183, 'db.m6g.large': 0.188, 'db.m6g.xlarge': 0.376,
  'db.m7g.large': 0.199, 'db.m7g.xlarge': 0.398, 'db.r6g.large': 0.23, 'db.r6g.xlarge': 0.46,
  'db.r7g.large': 0.244 } as const;
export type RdsType = keyof typeof RDS_HOURLY;
export const AURORA_HOURLY = { 'db.r6g.large': 0.266, 'db.r6g.xlarge': 0.532,
  'db.r7g.large': 0.283, 'db.r7g.xlarge': 0.566 } as const;
export type AuroraType = keyof typeof AURORA_HOURLY;
export const ELASTICACHE_HOURLY = { 'cache.m6g.large': 0.157, 'cache.m6g.xlarge': 0.314,
  'cache.m7g.large': 0.1664, 'cache.m7g.xlarge': 0.3328 } as const;
export type CacheType = keyof typeof ELASTICACHE_HOURLY;

export const UNIT = {
  ec2EbsGp3GbMonth: 0.0864,        // EC2 内挂 gp3，按每台实例
  ebsGp2GbMonth: 0.108,            // 独立 EBS 卷（gp2）
  s3GbMonth: 0.0225, s3PutPer1k: 0.0045, s3GetPer1k: 0.00036,
  albHour: 0.0227, albLcuHour: 0.008,           // LCU 只由 gbPerHour 驱动
  cwMetric: 0.30, cwLogGb: 0.5045, cwDashboard: 3, cwFreeDashboards: 3, cwAlarm: 0.10,
  cloudTrailPerMillionExtraTrail: 20,           // 首条写 trail 免费
  rdsStorageGbMonth: 0.124,                     // ×2 when Multi-AZ，且按节点数计
  rdsBackupGbMonth: 0.086,
  auroraStorageGbMonth: 0.099,
  natHour: 0.05015, natGb: 0.05015,
  wafAcl: 5, wafRule: 1, wafManagedGroup: 1, wafPerMillion: 0.6,
  apiGwHttpPerMillion: 1.125,
  r53Zone: 0.5, r53PerMillion: 0.4,
  secret: 0.4, secretPer10k: 0.05,
  backupEbsGbMonth: 0.07089,
  efsGbMonth: 0.324, efsReadGb: 0.036, efsWriteGb: 0.063,
  ecrGbMonth: 0.10,
  kmsKey: 1, kmsPer10k: 0.03,
  sqsPerMillion: 0.34,
} as const;
```

### 5.2 新建 `web/server/calculator-services.ts`

#### 5.2.1 类型

```ts
import type { Ec2Type, RdsType, AuroraType, CacheType } from './calculator-rates';

export type Ec2Role = 'web' | 'app' | 'worker' | 'batch' | 'api' | 'db';
export type RdsDeployment = 'Single-AZ' | 'Multi-AZ';

export interface ServiceParams {
  'ec2': { instanceType: Ec2Type; count: number; storageGbPerInstance: number };
  'ebs-volume': { volumes: number; gbPerVolume: number };
  's3': { gb: number; putRequests: number; getRequests: number };
  'alb': { count: number; gbPerHour: number };
  'cloudwatch': { metrics: number; logGb: number; dashboards: number; alarms: number };
  'cloudtrail': { writeTrails: number; eventsMillions: number };
  'rds-mysql': { instanceType: RdsType; nodes: number; deployment: RdsDeployment; storageGb: number; backupGb: number };
  'rds-postgresql': { instanceType: RdsType; nodes: number; deployment: RdsDeployment; storageGb: number; backupGb: number };
  'aurora-mysql': { instanceType: AuroraType; nodes: number; storageGb: number };
  'elasticache': { instanceType: CacheType; nodes: number };
  'nat-gateway': { gateways: number; gbPerGateway: number };
  'waf': { webAcls: number; rulesPerAcl: number; managedGroupsPerAcl: number; requestsMillions: number };
  'api-gateway-http': { requestsMillions: number };
  'route53': { hostedZones: number; queriesMillions: number };
  'secrets-manager': { secrets: number; apiCalls: number };
  'backup-ebs': { gb: number };
  'efs': { storageGb: number; readGb: number; writeGb: number };
  'ecr': { gb: number };
  'kms': { keys: number; requests: number };
  'sqs': { requestsMillions: number };
}
export type ServiceKind = keyof ServiceParams;
export type ServiceItem = { [K in ServiceKind]: { kind: K; params: ServiceParams[K]; role?: Ec2Role } }[ServiceKind];
export type CalculatorServiceBlock = Record<string, unknown>;
```

`calibration.json` 的 `service` / `params` 字段与 `ServiceKind` / `ServiceParams` 一一对应，测试直接构造 `{ kind: c.service, params: c.params }`。

#### 5.2.2 导出函数

```ts
/** 引擎一致的月费，四舍五入到分：Math.round(v * 100) / 100 */
export function monthlyCost(item: ServiceItem): number;
/** calculator.aws 的服务块：[`${serviceCode}-${randomUUID()}`, block] */
export function buildServiceBlock(item: ServiceItem): [string, CalculatorServiceBlock];
/** 写入 block.configSummary 的英文摘要（§5.2.5） */
export function configSummary(item: ServiceItem): string;
/** 结果页短标签（§5.2.6） */
export function shortLabel(item: ServiceItem): string;
```

#### 5.2.3 成本公式（与 `reference/formula.cjs` 完全一致，H = 730）

| kind | 公式 |
|---|---|
| ec2 | `count × (EC2_HOURLY[t] × H + storageGbPerInstance × 0.0864)` |
| ebs-volume | `volumes × gbPerVolume × 0.108` |
| s3 | `gb × 0.0225 + putRequests / 1000 × 0.0045 + getRequests / 1000 × 0.00036` |
| alb | `count × H × (0.0227 + gbPerHour × 0.008)` |
| cloudwatch | `metrics × 0.30 + logGb × 0.5045 + max(0, dashboards − 3) × 3 + alarms × 0.10` |
| cloudtrail | `(writeTrails − 1) × eventsMillions × 20` |
| rds-mysql / rds-postgresql | `m = deployment==='Multi-AZ' ? 2 : 1`；`nodes × (RDS_HOURLY[t] × m × H + storageGb × 0.124 × m) + backupGb × 0.086` |
| aurora-mysql | `nodes × AURORA_HOURLY[t] × H + storageGb × 0.099` |
| elasticache | `nodes × ELASTICACHE_HOURLY[t] × H` |
| nat-gateway | `gateways × (H × 0.05015 + gbPerGateway × 0.05015)` |
| waf | `webAcls × (5 + rulesPerAcl + managedGroupsPerAcl) + requestsMillions × 0.6` |
| api-gateway-http | `requestsMillions × 1.125` |
| route53 | `hostedZones × 0.5 + queriesMillions × 0.4` |
| secrets-manager | `secrets × 0.4 + apiCalls / 10000 × 0.05` |
| backup-ebs | `gb × 0.07089` |
| efs | `storageGb × 0.324 + readGb × 0.036 + writeGb × 0.063` |
| ecr | `gb × 0.10` |
| kms | `keys × 1 + requests / 10000 × 0.03` |
| sqs | `requestsMillions × 0.34` |

常量一律引用 `calculator-rates.ts` 的 `UNIT` / `*_HOURLY`，不得在本文件写字面量单价。

#### 5.2.4 服务块构造

模板以 TS 常量内嵌在本文件（`const TEMPLATES = { 's3': {...}, … } as const`），**内容逐字复制** `templates/<kind>.json`（ec2 除外）。运行时不得读取 `.kiro/` 目录。

构造步骤（每个 kind 相同）：

1. `structuredClone(TEMPLATES[kind])`
2. 按下表写入旋钮字段，**一律写字符串**（`String(n)`）
3. `cost = monthlyCost(item)`；`block.serviceCost.monthly = cost`；若有 `subServices`：`subServices[0].serviceCost.monthly = cost`，其余子服务 `serviceCost.monthly = 0`
4. `block.description = null`；`block.configSummary = configSummary(item)`；`block.regionName = CALC_REGION_NAME`
5. 返回 `[`${block.serviceCode}-${randomUUID()}`, block]`

旋钮字段（`cc` = `calculationComponents`；`sub0` = `subServices[0].calculationComponents`）：

| kind | 字段 |
|---|---|
| ebs-volume | `cc.numberOfInstances.value`=volumes，`cc.storageAmount.value`=gbPerVolume |
| s3 | `sub0.s3StandardStorageSize.value`=gb，`sub0.s3StandardPutRequests.value`=putRequests，`sub0.s3StandardGetRequests.value`=getRequests |
| alb | `sub0.numberOfApplicationLoadBalancers.value`=count，`sub0.sizeOfDataProcessedForEC2InstanceAndIPAddressTargets.value`=gbPerHour |
| cloudwatch | `cc.totalNumberOfMetrics`=metrics，`cc.sizeOfStandardLogsDataIngested`=logGb，`cc.numberOfDashboards`=dashboards，`cc.numberOfStandardAlarms`=alarms（均 `.value`） |
| cloudtrail | `cc.numberOfWriteTrails.value`=writeTrails，`cc.numberOfWriteEvents.value`=eventsMillions |
| rds-mysql / rds-postgresql | `cc.columnFormIPM.value[0]['Instance Type'].value`=instanceType，`['Number of Nodes'].value`=nodes，`['Deployment Option'].value`=deployment；`cc.storageAmount.value`=storageGb；`cc.additionalBackupStorage.value`=backupGb |
| aurora-mysql | `cc.columnFormIPM.value[0]['Instance Type'].value`、`['Number of Nodes'].value`；`cc.storageAmount.value` |
| elasticache | `cc.columnFormIPM.value[0]['Instance Type'].value`、`['Number of Nodes'].value` |
| nat-gateway | `sub0.numberOfGateways.value`=gateways，`sub0.dataProcessedPerNATGateway.value`=gbPerGateway |
| waf | `cc.numberOfWebAcls`、`cc.numberOfRulesPerWebAcl`、`cc.numberOfManangedRules`（模板原拼写，**不要改正**）、`cc.numberOfWebRequests`（均 `.value`） |
| api-gateway-http | `cc.numberOfAPIRequests.value` |
| route53 | `cc.numberOfHostedZones.value`、`cc.numberOfStandardQueries.value` |
| secrets-manager | `cc.NumberOfSecrets.value`、`cc.numberOfAPIs.value` |
| backup-ebs | `sub0.dataSize.value` |
| efs | `cc.standardStorageSize.value`、`cc.elasticThroughputReadDataInputSS.value`、`cc.elasticThroughputWriteDataInputSS.value` |
| ecr | `cc.amountofdatastored.value` |
| kms | `cc.numberOfCmk.value`、`cc.numberOfSymmetricRequests.value` |
| sqs | `cc.standardQueueRequests.value` |

**ec2**：沿用现 `ec2Block` 的 JSON 结构原样（v0.0.57、`pricingStrategy.selectedOption='on-demand'`），`workload.value.data=String(count)`，`instanceType.value=t`，`storageAmount.value=String(storageGbPerInstance)`；`serviceCost = { monthly: cost, upfront: 0 }`。

#### 5.2.5 configSummary（英文，逐字照此格式）

| kind | 格式 |
|---|---|
| ec2 | `Tenancy (Shared Instances), Operating system (Linux), Workload (Consistent, Number of instances: {count}), Advance EC2 instance ({t}), Pricing strategy (On-Demand Utilization: 100 %Utilized/Month), Enable monitoring (disabled), EBS Storage amount ({gb} GB), DT Inbound: Not selected (0 TB per month), DT Outbound: Not selected (0 TB per month), DT Intra-Region: (0 TB per month)` |
| ebs-volume | `Number of volumes ({v}), Average duration of volume (730 hours per month), Storage amount per volume ({gb} GB), Snapshot Frequency (No snapshot storage)` |
| s3 | `S3 Standard storage ({gb} GB per month), PUT, COPY, POST, LIST requests to S3 Standard ({put}), GET, SELECT, and all other requests from S3 Standard ({get}), DT Inbound: Not selected (0 TB per month), DT Outbound: Not selected (0 TB per month)` |
| alb | `Number of Application Load Balancers ({count}), Processed bytes (EC2 Instances and IP addresses as targets) ({gbPerHour} GB per hour)` |
| cloudwatch | `Number of Metrics (includes detailed and custom metrics) ({m}), Standard Logs: Data Ingested ({l} GB), Number of Dashboards ({d}), Number of Standard Resolution Alarm Metrics ({a})` |
| cloudtrail | `Management event trails ({w}), Number of management events ({ev} million per month)` |
| rds-mysql | `Storage amount ({gb} GB), Storage for each RDS instance (General Purpose SSD (gp2)), Nodes ({n}), Instance type ({t}), Utilization (On-Demand only) (100 %Utilized/Month), Deployment option ({dep}), Pricing strategy (OnDemand), Additional backup storage ({bk} GB)` |
| rds-postgresql | `Storage amount ({gb} GB), Storage volume (General Purpose SSD (gp3)), Nodes ({n}), Instance Type ({t}), Utilization (On-Demand only) (100 %Utilized/Month), Deployment Option ({dep}), Pricing Model (OnDemand), Additional backup storage ({bk} GB)` |
| aurora-mysql | `Aurora MySQL Cluster Configuration Option (Aurora Standard), Instance Type ({t}), Nodes ({n}), Utilization (100 %Utilized/Month), Pricing Model (OnDemand), Storage amount ({gb} GB)` |
| elasticache | `Engine (Redis OSS), Instance type ({t}), Nodes ({n}), Utilization (On-Demand only) (100 %Utilized/Month), Cache Node Type (Standard), Pricing strategy (OnDemand)` |
| nat-gateway | `Number of NAT Gateways ({g}), Data Processed per NAT Gateway ({gb} GB per month)` |
| waf | `Number of Web Access Control Lists (Web ACLs) utilized ({a} per month), Number of Rules added per Web ACL ({r} per month), Number of Managed Rule Groups per Web ACL ({m} per month), Number of web requests received across all web ACLs ({q} million per month)` |
| api-gateway-http | `HTTP API requests ({q} million per month), Average size of each request (50 KB)` |
| route53 | `Hosted Zones ({z}), Standard queries ({q} million per month)` |
| secrets-manager | `Number of secrets ({n}), Average duration of each secret (30 days), Number of API calls ({api} per month)` |
| backup-ebs | `Amount of primary data to be backed up ({gb} GB), Daily backups warm retention period (30 Days)` |
| efs | `Desired Storage Capacity ({gb} GB per month), Read Data Transferred ({r} GB per month), Write Data Transferred ({w} GB per month)` |
| ecr | `Amount of data stored ({gb} GB per month)` |
| kms | `Number of customer managed Customer Master Keys (CMK) ({k}), Number of symmetric requests ({r})` |
| sqs | `Standard queue requests ({q} million per month)` |

数字直接 `String(n)`，**不加千分位**。

#### 5.2.6 shortLabel（结果页用）

`EC2 {role} · {t} ×{count}`、`EBS gp2 ×{v} · {gb} GB`、`S3 · {gb} GB`、`ALB ×{count}`、`CloudWatch`、`CloudTrail`、`RDS MySQL · {t} ×{n} {dep}`、`RDS PostgreSQL · {t} ×{n} {dep}`、`Aurora MySQL · {t} ×{n}`、`ElastiCache · {t} ×{n}`、`NAT Gateway ×{g}`、`WAF`、`API Gateway`、`Route 53`、`Secrets Manager`、`AWS Backup · {gb} GB`、`EFS · {gb} GB`、`ECR · {gb} GB`、`KMS`、`SQS`。ec2 无 role 时 role 显示 `app`。

### 5.3 修改 `web/server/pricing-calculator.ts`

删除：`RATES`、`HOURS`、`svcKey`、`ec2Block`、`s3Block`、`cloudFrontBlock`、`cloudWatchBlock`、`cloudTrailBlock`、`albBlock`、旧 `buildPocEstimate`。保留：`sanitizeEstimateName`、`Estimate`、`saveEstimate`、`verifyEstimate`、`shareUrl`、文件头注释。

#### 5.3.1 新导出

```ts
export const MIN_MRR_USD = 600;
export const MAX_SEED_ATTEMPTS = 20;

export interface PlannedService { item: ServiceItem; monthly: number; label: string }
export interface CalculatorPlan {
  seed: string; mrrUsd: number; target: number; total: number; signature: string;
  services: PlannedService[];   // 顺序见 §5.3.5
}
/** 纯函数、同步、确定性：同 seed + 同 mrrUsd → 完全相同的 plan */
export function planPocEstimate(input: { mrrUsd: number; seed: string }): CalculatorPlan;
/** 纯函数：plan → calculator.aws 估算 JSON（服务 key 含随机 UUID，其余确定） */
export function renderEstimate(name: string, plan: CalculatorPlan): Estimate;
/** 便捷组合：plan + render */
export function buildPocEstimate(input: { name: string; mrrUsd: number; seed: string; region?: string }):
  { estimate: Estimate; plan: CalculatorPlan };
```

`buildPocEstimate`：`region` 缺省为 `CALC_REGION`；传其他值抛 `Error('定价计算器只支持 ap-southeast-5')`。`mrrUsd < MIN_MRR_USD` 或非有限数抛 `Error('MRR 低于 600 USD，无法生成计算器')`。

`renderEstimate`：`services = Object.fromEntries(plan.services.map(s => buildServiceBlock(s.item)))`；`name = sanitizeEstimateName(name)`；`groups = {}`；`support = {}`；`groupSubtotal = totalCost = { monthly: plan.total, upfront: 0 }`；`metaData` 同现实现（`locale:'en_US'`、`currency:'USD'`、`createdOn` 毫秒三位、`source:'calculator-platform'`）。

#### 5.3.2 PRNG（逐字实现）

```ts
function fnv1a32(s: string): number {           // 按 UTF-8 字节
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
```

由 `mulberry32(fnv1a32(seed))` 得 `r()`，派生：`int(a,b) = a + floor(r()*(b-a+1))`；`pick(arr) = arr[floor(r()*arr.length)]`；`uni(a,b) = a + r()*(b-a)`；`sample(arr,k)` = 部分 Fisher–Yates（对副本 `i=0..k-1`：`j = i + floor(r()*(len-i))`，交换，取前 k）。

#### 5.3.3 池

```ts
const ROLE_TYPES: Record<'web'|'app'|'worker'|'batch'|'api', Ec2Type[]> = {
  web:    ['m6i.large','m7i.large','m7g.large','c7i.large','t3.large','t3.xlarge','m6i.xlarge','m7i.xlarge','m7g.xlarge'],
  app:    ['m6i.xlarge','m7i.xlarge','m7g.xlarge','m6i.2xlarge','m7i.2xlarge','m7g.2xlarge','r6i.xlarge','r7g.xlarge'],
  worker: ['c6i.xlarge','c6i.2xlarge','c7i.xlarge','c7i.2xlarge','c7g.xlarge'],
  batch:  ['c7i.2xlarge','c6i.2xlarge','m7i.2xlarge','r7i.xlarge','r6i.xlarge'],
  api:    ['m7g.large','m7g.xlarge','c7g.xlarge','c7i.large','m6i.large'],
};
const RDS_TYPES: RdsType[] = ['db.t4g.large','db.m6g.large','db.m6g.xlarge','db.m7g.large','db.m7g.xlarge','db.r6g.large','db.r6g.xlarge','db.r7g.large'];
const AURORA_TYPES: AuroraType[] = ['db.r6g.large','db.r6g.xlarge','db.r7g.large','db.r7g.xlarge'];
const CACHE_TYPES: CacheType[] = ['cache.m6g.large','cache.m6g.xlarge','cache.m7g.large','cache.m7g.xlarge'];
const SELF_DB_TYPES: Ec2Type[] = ['r6i.large','r6i.xlarge','r7i.large','r7i.xlarge','m7i.xlarge','r7g.large','r7g.xlarge'];
const DB_OPTIONS = ['rds-mysql','rds-postgresql','aurora-mysql','ec2-self-hosted'] as const;
// 辅助池顺序固定（影响 sample 结果）
const AUX_KINDS = ['elasticache','nat-gateway','waf','cloudtrail','api-gateway-http','route53',
  'secrets-manager','backup-ebs','efs','ecr','kms','sqs','ebs-volume'] as const;
```

辅助服务参数（按下列顺序调用 PRNG）：

| kind | 参数 |
|---|---|
| elasticache | `instanceType=pick(CACHE_TYPES)`, `nodes=int(1,3)` |
| nat-gateway | `gateways=int(1,3)`, `gbPerGateway=int(5,60)*10` |
| waf | `webAcls=int(1,2)`, `rulesPerAcl=int(3,15)`, `managedGroupsPerAcl=int(1,4)`, `requestsMillions=int(5,120)` |
| cloudtrail | `writeTrails=2`, `eventsMillions=int(1,5)` |
| api-gateway-http | `requestsMillions=int(5,150)` |
| route53 | `hostedZones=int(1,8)`, `queriesMillions=int(1,60)` |
| secrets-manager | `secrets=int(5,60)`, `apiCalls=int(1,50)*10000` |
| backup-ebs | `gb=int(10,150)*10` |
| efs | `storageGb=int(5,80)*10`, `readGb=int(0,20)*5`, `writeGb=int(0,20)*5` |
| ecr | `gb=int(2,60)*10` |
| kms | `keys=int(1,12)`, `requests=int(1,100)*10000` |
| sqs | `requestsMillions=int(5,200)` |
| ebs-volume | `volumes=int(1,4)`, `gbPerVolume=int(5,50)*10` |

#### 5.3.4 算法（与 `reference/generator-prototype.cjs` 的 `build()` 一致）

记 `cost(item) = monthlyCost(item)`（已到分），`lo = mrr + 100`，`hiOut = mrr + 151`。

1. `target = mrr + 101 + int(0,48) + int(1,99)/100`
2. 骨架：
   - `alb = { count: int(1,3), gbPerHour: pick([0.2,0.3,0.5,0.8,1,1.5]) }`
   - `cloudwatch = { metrics: int(10,150), logGb: int(5,150), dashboards: int(1,8), alarms: int(5,60) }`
   - `s3 = { gb: max(100, round(mrr*uni(0.1,0.4)/10)*10), putRequests: int(1,50)*10000, getRequests: int(1,100)*100000 }`
3. 辅助：`k = int(3,6)`；`aux = sample(AUX_KINDS, k)` 依次按 §5.3.3 生成参数
4. 数据库：`opt = pick(DB_OPTIONS)`；`dbBudget = target * uni(0.12, 0.30)`
   - rds-mysql / rds-postgresql：`storageGb=int(5,100)*10`，`backupGb=int(0,50)*10`；枚举 `RDS_TYPES × nodes∈[1,2] × deployment∈['Single-AZ','Multi-AZ']`（按此嵌套顺序），取 `|cost−dbBudget|` 最小者（相等取先出现者）
   - aurora-mysql：`storageGb=int(5,100)*10`；枚举 `AURORA_TYPES × nodes∈[1,2,3]`，同上取最近
   - ec2-self-hosted：`t=pick(SELF_DB_TYPES)`，`gb=int(10,50)*10`，`per = cost(ec2{t,1,gb})`，`count=max(1, round(dbBudget/per))`，`role='db'`
5. 角色：`roleN=int(1,3)`；`roles = sample(['web','app','worker','batch','api'], roleN)`，每个依次取 `t = pick(ROLE_TYPES[role])`、`gb = int(3,25)*10`、`w = uni(1,3)`
6. 预算收缩（`fixedSum` = alb+cloudwatch+s3+db+aux 的 cost 之和；`minRoles` = 各角色 1 台的 cost 之和；`fits = fixedSum + minRoles <= target − 1`）：
   1. `while (!fits && aux.length)`：按 cost 降序排序 aux，移除第一个
   2. 仍 `!fits` 且 `roles.length > 1`：只保留 `roles[0]`
   3. 仍 `!fits`：db 换成 `rds-mysql { db.t4g.large, nodes 1, Single-AZ, storageGb 20, backupGb 0 }`
   4. 仍 `!fits`：抛 `Error('MRR 过低，放不下最小配置')`
7. 台数：`R0 = target − fixedSum`；`perOf(r) = cost(ec2{r.t,1,r.gb})`；`spare = R0 − Σ perOf`；`W = Σ w`；每角色 `count = 1 + floor(spare × w / W / perOf)`
8. 补齐：`rest = target − fixedSum − Σ cost(ec2 角色)`；`cheap` = perOf 最小的角色（`[...].sort` 升序取首）：`while (rest >= perOf(cheap)) { cheap.count++; rest -= perOf(cheap) }`；`most` = count 最大的角色（降序取首），`step = most.count × 10 × 0.0864`：`while (rest >= step + 2) { most.gb += 10; rest -= step }`
9. 收敛（最多 50 轮）：`t = total()`；
   - 若 `t > mrr + 150.99`：取 `count > 1` 中单台成本最高的角色 `count--`，continue（无可减者则落入下一步）
   - `dg = floor((target − t) / 0.0225)`；若 `s3.gb + dg < 100`：同上减一台后 continue，无可减者抛 `Error('计算器收敛失败')`；否则 `s3.gb += dg`，break
10. 若 `round(total × 100) % 100 === 0`：`s3.gb += 1`
11. 校验 `lo <= total < hiOut`，否则抛 `Error('计算器总额越界')`

`total()` = 所有服务 `cost` 之和再 `Math.round(x*100)/100`。

#### 5.3.5 services 输出顺序

EC2 角色（生成顺序）→ db（若为 ec2-self-hosted，作为 `kind:'ec2', role:'db'`）→ alb → cloudwatch → s3 → aux（收缩后剩余，按生成顺序）。

#### 5.3.6 signature

各段：
- EC2 角色：`ec2:{role}:{t}x{count}`，**按字典序排序**
- db：rds `db:{kind}:{t}x{nodes}:{deployment}`；aurora `db:aurora-mysql:{t}x{nodes}`；自建 `db:ec2-self-hosted:{t}x{count}`
- `alb:x{count}`
- aux：elasticache `elasticache:{t}x{nodes}`，nat-gateway `nat:x{gateways}`，ebs-volume `ebs-volume:x{volumes}`，其余为 kind 本身；**按字典序排序**

拼接顺序：EC2 段们 → db → alb → aux 段们，以 `|` 连接。不含任何 GB / 请求量。

### 5.4 修改 `web/server/db.ts`

新增（放在 billing export 函数之后，风格同 `createBillingExportJob`）：

```ts
export interface PocCalculatorReserveInput {
  opportunityId: string; awsAccountId: string; activityName: string;
  region: string; mrrUsd: number; createdBy: string;
}
export interface PocCalculatorCandidate { target: number; total: number; signature: string }

/**
 * 生成 + 查重 + 预留，全程同步（中间不得出现 await）。
 * attempt 0..maxAttempts-1：seed = `${id}#${attempt}`，result = generate(seed)；
 * 与台账中所有 total/signature 非 null 的记录比较（不分状态，failed 也算）：
 *   Math.round(total*100) 相等 或 signature 相等 → 撞车，attempt+1
 * 不撞 → push { status:'reserved', source:'generated', … } 并 writeDB，返回。
 * generate 抛错 → 原样抛出，不写台账。
 * 用尽 → 抛 Error(`连续 ${maxAttempts} 次生成的计算器都与已有记录重复，请重试`)，不写台账。
 */
export function reservePocCalculator<T extends PocCalculatorCandidate>(
  input: PocCalculatorReserveInput,
  generate: (seed: string) => T,
  maxAttempts?: number,          // 默认 20
): { entry: PocCalculatorLedgerEntry; result: T };

export function markPocCalculatorReady(id: string, r: { calculatorKey: string; calculatorUrl: string }): PocCalculatorLedgerEntry;
export function markPocCalculatorApplication(id: string, applicationId: string): PocCalculatorLedgerEntry;
export function markPocCalculatorFailed(id: string, error: string): PocCalculatorLedgerEntry;
export function recordManualPocCalculator(input: PocCalculatorReserveInput & { calculatorUrl: string }): PocCalculatorLedgerEntry;
export function listPocCalculatorEntries(): PocCalculatorLedgerEntry[];
```

- `mark*`：按 id 查找，找不到抛 `Error('计算器台账记录不存在')`；更新对应字段与 `updatedAt`；`markPocCalculatorFailed` 的 error 截断到 500 字；`markPocCalculatorApplication` 置 `status='application_created'`；`markPocCalculatorReady` 置 `status='calculator_ready'`
- 返回值一律是副本（`{ ...entry }`）
- `recordManualPocCalculator`：`source:'manual'`、`status:'calculator_ready'`、`attempt:0`，seed/target/total/signature/calculatorKey 为 null

### 5.5 新建 `web/server/poc-calculator.ts`

```ts
export interface CalculatorContext {
  name: string;                  // 估算名（activityName）
  region: string;
  mrrUsd: number;
  opportunityId: string;
  awsAccountId: string;
  createdBy: string;
}
export interface CalculatorOutcome {
  ledgerId: string;
  url: string;
  total: number | null;          // manual 为 null
  items: { label: string; monthly: number }[];   // manual 为 []
}
export async function createUniqueCalculator(ctx: CalculatorContext): Promise<CalculatorOutcome>;
export function recordManualCalculator(ctx: CalculatorContext, url: string): CalculatorOutcome;
```

`createUniqueCalculator`：

1. `const { entry, result } = reservePocCalculator({ opportunityId: ctx.opportunityId, awsAccountId: ctx.awsAccountId, activityName: ctx.name, region: ctx.region, mrrUsd: ctx.mrrUsd, createdBy: ctx.createdBy }, seed => {`（逐字段传，不要展开 ctx —— 多余的 `name` 会触发多余属性检查） const b = buildPocEstimate({ name: ctx.name, mrrUsd: ctx.mrrUsd, seed, region: ctx.region }); return { target: b.plan.target, total: b.plan.total, signature: b.plan.signature, built: b }; })`
2. `try { key = await saveEstimate(result.built.estimate); v = await verifyEstimate(key, result.built.plan.total, Object.keys(result.built.estimate.services).length); if (!v.ok) throw new Error(`计算器读回校验失败：${v.problems.join('；')}`) } catch (e) { markPocCalculatorFailed(entry.id, msg); throw e }`
3. `markPocCalculatorReady(entry.id, { calculatorKey: key, calculatorUrl: shareUrl(key) })`
4. 返回 `{ ledgerId: entry.id, url, total: plan.total, items: plan.services.map(s => ({ label: s.label, monthly: s.monthly })) }`

`recordManualCalculator`：调 `recordManualPocCalculator`，返回 `{ ledgerId, url, total: null, items: [] }`。

### 5.6 修改 `web/server/poc-cash-funding.ts`

- `createPocApplication(input, calcFactory?)` 第二参数类型改为
  `(ctx: CalculatorContext) => Promise<CalculatorOutcome>`
- `CreatePocInput` 新增 `createdBy?: string`（缺省 `'unknown'`）
- 原 `calculatorUrl` 计算段改为：
  ```ts
  const ctx: CalculatorContext = { name: activityName, region: input.calcRegion || CALC_REGION,
    mrrUsd: pre.mrrUsd, opportunityId: input.opportunityId, awsAccountId: input.awsAccountId,
    createdBy: input.createdBy || 'unknown' };
  const calculator = input.calculatorUrl
    ? recordManualCalculator(ctx, input.calculatorUrl)
    : calcFactory ? await calcFactory(ctx) : null;
  if (!calculator) throw new Error('缺少定价计算器链接');
  const calculatorUrl = calculator.url;
  ```
- `CreateBenefitApplicationCommand` 的 `ClientToken` 由 `randomUUID()` 改为 `calculator.ledgerId`
- 原 `const created = await ben.send(new CreateBenefitApplicationCommand(…)); const applicationId = created.Id` 改为
  `const applicationId = await createApplicationWithLedger(calculator.ledgerId, () => ben.send(new CreateBenefitApplicationCommand(…)))`，
  失败标记、空 Id、回填台账全部由该函数负责（定义见 §9.5）
- `CreatePocResult` 新增 `calculator: { ledgerId: string; total: number | null; items: { label: string; monthly: number }[] }`
- 其余（金额、风险项、关联、提交、回读）不动

### 5.7 修改 `web/server/routes/poc-cash.ts`

- 删除 `makeCalculator`（:42-54）
- `import { createUniqueCalculator } from '../poc-calculator'`
- `POST /funding` 调用改为 `fund.createPocApplication({ …原字段, createdBy: user?.username || 'unknown' }, createUniqueCalculator)`，`user` 从 `(req as any).user` 取（与本文件其他处相同），需在调用前取出
- 审计详情追加 ` | 计算器 ${result.calculator.total ?? '手填'} USD`
- 路由路径、守卫（router 级 `requireStrictAdmin`）**不变**；无新路由

---

## 6. 前端设计

- 页面：现有 `client/src/pages/PocCash.tsx`（独立权限页 `poccash`，admin 专属），**无导航/权限变动**
- `api.ts`：无变化（`pocFundingCreate` 已透传响应）
- 结果 `Alert`（:819-822 计算器链接那段）之后追加：

```tsx
{pocResult.calculator?.total != null && (
  <div>计算器总额 {pocResult.calculator.total} USD · {pocResult.calculator.items.length} 项服务
    <div className="poc-calc-items">
      {pocResult.calculator.items.map((it: { label: string; monthly: number }, i: number) =>
        <Tag key={i}>{it.label} · {it.monthly} USD</Tag>)}
    </div>
  </div>
)}
```

- `client/src/styles/global.css` 追加 `.poc-calc-items { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }`（不加颜色）
- `Tag` 已在 `PocCash.tsx:11-15` 的 antd import 中，无需新增 import
- 金额直接显示数字，不 `toLocaleString()`（与 CSV 规则一致，避免千分位）

---

## 7. AWS 链路

- **无新增跨账户调用**。Partner Central 调用沿用 `benefitsClient()`（webby 的 `partner-central-tool` role），IAM 不变
- `ClientToken` 改用台账 ID：仍是 UUID 格式，且每条申请唯一，满足幂等要求
- calculator.aws：沿用 `saveEstimate` / `verifyEstimate` 的未公开端点，每次创建调用量不变（1 次保存 + ≤3 次读回）
- 验收脚本另访问 `https://calculator.aws/#/estimate?id=…`（浏览器），仅本地手动执行

---

## 8. 错误处理与边界

| 场景 | 行为 |
|---|---|
| `mrrUsd < 600` | `buildPocEstimate` 抛错 → `reservePocCalculator` 原样抛 → 400，不写台账 |
| region ≠ ap-southeast-5 | 同上 |
| 20 次全撞 | 抛错，不写台账 |
| saveEstimate / verifyEstimate 失败 | 台账 `failed`（保留 total/signature 继续参与查重），400 |
| CreateBenefitApplication 失败 | 台账 `failed`，400 |
| 写台账回填 applicationId 失败 | `console.error`，返回成功（申请已在 AWS 建好） |
| 并发两次创建 | `reservePocCalculator` 同步段内完成生成、比对、写入；Node 单线程保证串行 |
| 手填计算器链接 | 不生成、不查重；台账记 manual |

超时沿用现值（save 40s、读回 30s × 3）。

---

## 9. 测试计划

`web/tests/` 现有测试不得破坏。

### 9.1 改写 `tests/pricing-calculator-target.test.ts`

保留 `sanitizeEstimateName` 的 3 个测试；删除依赖旧签名的测试，新增：

1. 窗口与零头：`mrr ∈ [600, 750, 1000, 2000, 3333.33, 7800, 12297.6, 53221.2, 100002]` × 每个 300 个 seed（`t${i}#0`），`planPocEstimate` 的 `total − mrr ∈ [100, 151)` 且 `round(total*100) % 100 !== 0`
2. 可复现：同 seed 两次 `planPocEstimate` 深相等
3. 签名唯一率：1000 个 seed（`ledger-${i}#0`）—— mrr 1000 唯一 ≥ 990；mrr 2400 / 7800 / 60000 唯一 ≥ 995
4. 结构约束（mrr 2400/7800/60000 各 300 seed）：ALB count ∈ [1,3]；数据库项恰好 1 个（rds-*/aurora-mysql 或 role='db' 的 ec2）；非 db 的 ec2 角色 1~3 个；辅助服务数 ∈ [3,6]
5. 小 MRR 收缩：mrr 600 的 1000 个 seed 全部不抛错
6. `planPocEstimate` 中每个 service 的 `monthly === monthlyCost(item)`，且 `total === round(Σ monthly)`
7. `buildPocEstimate` 输出 `estimate.name` 不含 `<>&`；`estimate.totalCost.monthly === plan.total`；服务数 === `plan.services.length`
8. `mrr 599` 抛错；`region 'us-east-1'` 抛错
9. 台账模拟（纯内存，不碰 db）：mrr 1000 与 7800 各连续 300 份，按 §5.4 规则查重换 attempt，全部成功且 attempt ≤ 19

### 9.2 新建 `tests/calculator-calibration.test.ts`

读取 `../../.kiro/specs/poc-calculator-uniqueness/templates/calibration.json`（相对 `web/tests/`），对每个 case：`Math.abs(monthlyCost({kind: c.service, params: c.params}) − c.engineMonthlyUsd) <= 0.02`。另断言 case 数 === 137。

再对每个 kind 各构造一个 item，断言 `buildServiceBlock` 的 block：`serviceCode` 与模板一致、`region === 'ap-southeast-5'`、`serviceCost.monthly === monthlyCost(item)`、`configSummary` 不含中文字符（`/[一-鿿]/`）、不含 `,` 千分位（数字段用正则 `/\d,\d{3}/` 不匹配）。

### 9.3 新建 `tests/poc-calculator-ledger.test.ts`

import 前设 `process.env.DB_PATH` 为 `os.tmpdir()` 下唯一文件，测试结束删除。

1. 首次 reserve：写入 `reserved`、`seed === `${id}#0``、`attempt === 0`
2. 撞车：先手动 reserve 一条 total=1000.01，再用 generate 前两次返回 total 1000.01、第三次 1000.02 → `attempt === 2`
3. signature 撞车同理
4. failed 记录参与查重
5. 20 次全撞 → 抛错，台账条数不变
6. generate 抛错 → 原样抛出，台账条数不变
7. `markPocCalculatorReady` / `Application` / `Failed` 状态迁移正确；error 截断到 500
8. id 不存在 → 抛错
9. 旧库（文件中无 `poc_calculator_ledger` 键）→ `listPocCalculatorEntries()` 返回 `[]`
10. `recordManualPocCalculator` → source manual、status calculator_ready、total null

### 9.4 新建 `web/scripts/verify-calculator-render.ts`（验收脚本，非 CI）

参数：`--mrr <n>`（可多次，默认 `1500 7800 25000`）、`--count <n>`（每个 mrr 生成份数，默认 2）、`--plan-only`（只打印计划不联网）。

1. 对每个 mrr × count：`seed = verify-${Date.now()}-${mrr}-${i}#0`，`buildPocEstimate({ name: `verify ${mrr} #${i}`, … })`
2. 再追加一份「全覆盖」估算：每个 kind 各一个代表 item（参数取 §5.3.3 区间中点），确保所有服务都被引擎验过
3. `--plan-only`：打印每份 `total`、`signature`、服务标签，结束
4. 否则对每份：给每个 service block 的 `description` 设为 `VERIFY-<序号>`（仅验收副本），`saveEstimate` → 用 puppeteer-core 启动 Chrome（路径查找同 `billing-exporter.ts` 的 `findChrome()` 候选列表；`headless: true`；`args: ['--lang=en-US']`），打开 `https://calculator.aws/#/estimate?id=<key>`，`networkidle2`，等待 6s，点击文本恰为 `Update estimate` 的 `<button>`，等待 20s，循环读 `document.body.innerText` 并点击 `button[aria-label="Next page"]`（禁用即停，最多 15 页）
5. 解析：对每个 `VERIFY-n` 行，向上最多 4 行找 `/^([\d,]+\.\d\d) USD$/` 为引擎月费；`Monthly cost` 下一行为总额
6. 判定：每个服务 `|engine − monthly| ≤ 0.02`，总额 `|engine − plan.total| ≤ 0.10`；任一不满足打印明细并 `process.exit(1)`
7. 全部通过打印每份的 key 与对比表，`process.exit(0)`

### 9.5 Review Focus（上面没覆盖、最可能出事的点，各补一个测试）

| 风险 | 期望行为 | 补到 |
|---|---|---|
| `TEMPLATES` 手抄时漏字段/改了字段名（引擎会静默按默认值重算，正是这次 bug 的形态） | 内嵌模板与 `templates/<kind>.json` 除旋钮字段、`serviceCost`、`configSummary`、`description`、`regionName` 外逐字相同 | §9.2：每个 kind 用模板自身的旋钮值构造 item，`buildServiceBlock` 结果删去上述字段后与模板 JSON（同样删去）`deepStrictEqual` |
| 有人在 `reservePocCalculator` 里加了 `await`（并发查重失效） | 返回值不是 Promise | §9.3：`assert.ok(!(r instanceof Promise))`，且 `reservePocCalculator.constructor.name !== 'AsyncFunction'` |
| 创建 AWS 申请失败后台账卡在 `calculator_ready` | 变为 `failed` 且 error 有值 | 新增 `tests/poc-calculator-flow.test.ts`：`createPocApplication` 走注入的 fake calcFactory，`benefitsClient` 不可注入时改为直接测 §5.6 抽出的 `createApplicationWithLedger(ledgerId, send)` 辅助函数（见下） |

为让第三条可测，§5.6 中 `CreateBenefitApplicationCommand` 的 send 与台账回写抽成同文件导出函数：

```ts
export async function createApplicationWithLedger(
  ledgerId: string,
  send: () => Promise<{ Id?: string }>,
): Promise<string>   // 返回 applicationId；send 抛错 → markPocCalculatorFailed(ledgerId, msg) 后重抛；
                     // Id 为空 → 同样标 failed 并抛 Error('AWS 未返回申请 ID')；
                     // 成功 → markPocCalculatorApplication（失败只 console.error）
```

`tests/poc-calculator-flow.test.ts`（DB_PATH 指向临时文件）：先 `reservePocCalculator` 一条 → `createApplicationWithLedger(id, async () => { throw new Error('boom') })` 抛 boom 且台账 `failed`/`error==='boom'`；另一条 send 返回 `{ Id: 'benappl-x' }` → 台账 `application_created`、`applicationId==='benappl-x'`；send 返回 `{}` → 抛错且 `failed`。

---

## 10. 影响面与风险

| 项 | 说明 / 规避 |
|---|---|
| README 第九节高危区 | 不涉及 billing-exporter、CORS、restricted-accounts、Root 改密、Bedrock；POC IAM 前缀不变 |
| CSV 千分位 | 不改 CSV；新增的摘要与前端金额均不加千分位（§5.2.5、§6） |
| `createPocApplication` 签名变化 | 唯一调用方是 `routes/poc-cash.ts`，同任务内同步修改 |
| 旧计算器 | 已生成的 13 份不变（不在范围内） |
| calculator.aws 引擎调价 | 公式会与引擎偏离；验收脚本可检测，`calculator-rates.ts` 头注释写明维护方式 |
| 回滚 | 只回滚代码即可；`poc_calculator_ledger` 键对旧代码无影响（旧代码不读它） |
| DB schema | 新增键，按需创建，向后兼容 |

---

## 11. 明确不做

- 不改 `saveEstimate` / `verifyEstimate` / `sanitizeEstimateName` 的实现
- 不改金额推导（`computeAmounts`）、风险项（`warningsFor`）、商机创建流程
- 不加页面级台账展示、不加台账查询接口
- 不补录历史计算器、不改审核中的申请
- 不支持 ap-southeast-5 以外的区域
- 不引入新依赖（puppeteer-core 已在依赖中）
- 不改 `README.md`、`version.ts`、`project-context.md`（协调者在 P5 统一改）
- 不顺手重构 `PocCash.tsx` 的既有内联样式与 emoji

---

## 附录：实现期修订记录

| 日期 | 修订 | 原因 |
|---|---|---|
| 2026-10-12 | EFS 读写单价 0.033/0.066 → **0.036/0.063**；标定用例 112 → **137** | T5 联网验收发现 EFS 读 50/写 35 GB 时本地 198.36 vs 引擎 198.40。前 3 轮标定的 EFS 样本读写量恒相等，只能测出两者之和 0.099，拆分是假设。第 4 轮补测 25 个用例，把所有曾同比例变化的参数拆开独立测量：EFS 读/写、S3 PUT/GET、RDS 备份与按节点存储、WAF 规则/托管组；除 EFS 外全部与原公式逐分吻合 |
| 2026-10-12 | §9.4 全覆盖估算：seed=`coverage`、名 `verify coverage`、target=total、signature=`coverage:`+各 kind 按 §5.2.1 声明顺序 `|` 连接 | 方案未定义，T5 提问后由协调者确定 |
| 2026-10-12 | T4 由协调者接手实现 | worker 遇上游模型 502 中断，dispatch 卡在 stop_unknown |
