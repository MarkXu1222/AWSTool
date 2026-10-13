# 实现方案：Bedrock map-migrated 标签防错

> 需求与验收见同目录 `requirements.md`。本文件是实现的唯一依据。

## 1. 需求与验收

让格式错误的 `map-migrated` 值（以 `migmig…` 为代表）既写不进 AWS，也进不了交付 Excel；
创建 / 打 Tag 的结果以 AWS 回查为准，部分失败可见、可只重试未完成项；切换账户不残留旧数据。

验收：

- [ ] `cd web && npm test && npm run typecheck && npm run build` 全绿
- [ ] `cd web && node --import tsx --test tests/bedrock-map-tag-guard.test.ts tests/bedrock-delivery-tag-guard.test.ts` 通过（用例见第 9 节）
- [ ] 已有 `tests/bedrock-delivery-55.test.ts`、`tests/bedrock-delivery-name-match.test.ts`、`tests/bedrock-account-tpd.test.ts`、`tests/tag-extra-tag.test.ts` 仍通过
- [ ] Bedrock 页「批量创建」「批量打 Tag」输入 `migmigEY52ZIK63T` → 输入框下方红字、提交按钮禁用
- [ ] 账户 A 加载 Profiles 后切换到账户 B → Profiles 表格为空、Tag 输入恢复为空、勾选为 0
- [ ] 打 Tag 后弹出「打 Tag 结果」，按状态显示；存在非 `verified` 行时「重试未完成项（n）」可点，且只重发这 n 个
- [ ] 交付 Tab 对含不合规标签的账户点「生成交付表格」→ 报错并列出具体 profile 名

## 2. 现状分析

- `web/server/routes/bedrock.ts`：挂在 `/api/bedrock`（`index.ts:118`，`authMiddleware + auditMiddleware`）。
  - 本地函数 `validateTags(tags)`：只校验非空并 **trim**，被 `/profiles/create`、`/profiles/tag` 使用。
  - 错误码判断用 `e.message?.includes('Tag') ? 400 : 500`。
  - `/delivery`（v1）请求体 `{rows, iamUser, iamPassword}`，**没有 accountId**，直接把前端 rows（含 tags）交给 `buildDeliveryXlsx`。
  - `/delivery-v2` 请求体 `{accountId, rows, iamUser, iamPassword, variant}`，先 `filterAndSortForDelivery` 再查配额，再 `buildDeliveryXlsxV2`，tags 同样来自前端。
- `web/server/bedrock-tools.ts`：
  - `adminCreds(accountId)`（模块私有，50 分钟缓存，底层 `getTempAdminCredentials`）+ `bedrock(creds, region)` 构造 `BedrockClient`。
  - `listProfiles(accountId, regions)` → `{ rows, errors }`，每行含 `region,name,status,scope,backendModels,backendRegions,tags,arn`。
  - `createProfiles(...)` → `Array<{name, ok, arn?, error?}>`；`tagProfiles(...)` → `Array<{arn, ok, error?}>`；均不回查。
  - 已 import `ListTagsForResourceCommand`、`TagResourceCommand`。
- `web/server/bedrock-delivery.ts`：`prepareDelivery(rows)` 校验 ARN 账户唯一、`map-migrated` 存在且全表唯一，**不校验格式**；`buildDeliveryXlsx` / `buildDeliveryXlsxV2` 都调它。
- `web/server/tag-compliance.ts:121` 已有 `export const MAP_TAG_KEY = 'map-migrated'`，但该模块会初始化 S3/STS 配置，Bedrock 侧**不得 import 它**（本需求不改该文件）。
- `web/client/src/pages/Bedrock.tsx`（1059 行）：`TagInputs` 组件 + `validTags()`；`ProfilesTab` / `CreateTab` / `DeliveryTab` 状态都在组件内，`BedrockPage` 的 `<Tabs>` 不随 `selectedAccount` 重建。
- `web/client/src/api.ts:444-469`：`bedrockCreateProfiles`、`bedrockTagProfiles`、`bedrockDeliveryExport`（v1，body 无 accountId）、`bedrockDeliveryExportV2`。
- 测试框架：`node --import tsx --test tests/*.test.ts`，`node:test` + `node:assert/strict`；测试可直接 import `../client/src/...` 的纯 TS 文件（先例：`tests/regions.test.ts`）。

## 3. 方案总览

```
 前端 TagInputs ──checkTagInputs()（client/src/utils/mapTag.ts，与服务端逐字一致）── 不合规：红字+禁用
        │
        ▼
 POST /api/bedrock/profiles/{create,tag}
        │ validateBedrockTags()  ── MapTagRuleError → 400
        │ assertArnsBelong()（仅 tag）
        ▼
 bedrock-tools.createProfiles / tagProfiles
        │ 写入 → readBackTags()（最多 3 次，间隔 1s）→ verified / *_failed / read_failed / mismatch
        ▼
 审计（旧值分布、新值、各状态计数）→ 前端结果表 → 「重试未完成项」
 
 POST /api/bedrock/delivery{,-v2}
        │ normalizeDeliveryRows()：ARN 必须属于 accountId，region 以 ARN 为准
        │ （v2：filterAndSortForDelivery 在此之后、读标签之前）
        │ bt.readProfileTagsByArn()：从 AWS 读真实标签，读失败即拒绝
        ▼
 prepareDelivery()：缺失 / 大小写变体 key / 格式不合规 → 拒绝；再校验全表唯一 → 生成 xlsx
```

## 4. 数据模型变更

**无变更。** 不新增 `db.json` 键，不改 `config.json`，不改 `orgs.json`。审计仍写 `audit_log`（字符串 detail，格式见 5.3）。

## 5. 后端设计

### 5.1 新建 `web/server/map-tag-rules.ts`（纯函数，不 import 任何 AWS / db 模块）

```ts
export const MAP_TAG_KEY = 'map-migrated';
export const MAP_TAG_VALUE_RE = /^mig[A-Z0-9]{10}$/;
export const MAX_TAGS_PER_REQUEST = 50;

export interface BedrockTag { key: string; value: string }

export class MapTagRuleError extends Error {
  readonly code = 'MAP_TAG_RULE';
  constructor(message: string) { super(message); this.name = 'MapTagRuleError'; }
}

/** 返回 null 表示合规；否则返回给用户看的完整错误信息。 */
export function checkMapTagValue(value: unknown): string | null;

/** 校验并返回规范化后的 tags（map-migrated 排第一，其余保持原顺序）。不合规抛 MapTagRuleError。 */
export function validateBedrockTags(tags: unknown): BedrockTag[];

/** 取 key 严格等于 map-migrated 的值；没有返回 null。 */
export function findMapTagValue(tags: BedrockTag[] | undefined | null): string | null;

/** 返回不分大小写等于 map-migrated 但不是精确 map-migrated 的 key（如 Map-Migrated）；没有返回 null。 */
export function findMapTagKeyVariant(tags: BedrockTag[] | undefined | null): string | null;

/** 返回所有不分大小写等于 map-migrated 但不是精确 map-migrated 的 key（打 Tag 前需移除的变体，按出现顺序去重）。 */
export function variantKeysToRemove(tags: BedrockTag[] | undefined | null): string[];

/** 解析 application inference profile ARN；不匹配返回 null。 */
export function parseProfileArn(arn: unknown): { region: string; accountId: string } | null;

/** 所有 ARN 必须能解析、属于 accountId，且（给了 region 时）区域相同；否则抛 MapTagRuleError。 */
export function assertArnsBelong(arns: string[], accountId: string, region?: string): void;

/** 期望 tags 与 AWS 实际 tags 的差异描述；空数组 = 一致。 */
export function diffTags(expected: BedrockTag[], actual: BedrockTag[]): string[];

export type ReadBackStatus = 'verified' | 'read_failed' | 'mismatch';
export async function readBackTags(
  read: () => Promise<BedrockTag[]>,
  expected: BedrockTag[],
  opts?: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<{ status: ReadBackStatus; actual: BedrockTag[] | null; error?: string }>;
```

**`checkMapTagValue` 规则**：按顺序检查，命中第一条即返回。`P` = `` `map-migrated 值「${value}」不合规：` ``

| # | 条件 | 返回 |
|---|---|---|
| 1 | `typeof value !== 'string' \|\| value === ''` | `'map-migrated 的值不能为空'` |
| 2 | `value !== value.trim()` | `P + '首尾不能有空格'` |
| 3 | `value.startsWith('migmig')`（**区分大小写**） | `P + '出现重复的 mig 前缀（migmig…），只能以一个 mig 开头'` |
| 4 | `!value.startsWith('mig')` | `P + '必须以小写 mig 开头'` |
| 5 | `value.length !== 13` | `` P + `长度应为 13（mig + 10 位大写字母或数字），当前 ${value.length}` `` |
| 6 | `!MAP_TAG_VALUE_RE.test(value)` | `P + 'mig 之后只能是大写字母 A-Z 或数字 0-9'` |
| — | 以上都不命中 | `null` |

规则 3 必须区分大小写：合法值 `migMIGAB12345`（10 位恰好以 MIG 开头）必须通过。

**`validateBedrockTags` 规则**（顺序固定，`i` 为 1 起的序号，信息逐字如下）：

1. 不是数组或长度为 0 → `'必须提供至少一个 Tag（key/value 均必填，平台不提供默认 Tag）'`
2. 长度 > `MAX_TAGS_PER_REQUEST` → `'一次最多 50 个 Tag（AWS 上限）'`
3. 逐项（按数组顺序）：
   1. `key` 或 `value` 不是 string → `` `第 ${i} 个 Tag 的 key 和 value 都必须是字符串` ``
   2. `key === ''` 或 `value === ''` → `` `第 ${i} 个 Tag 的 key 和 value 都不能为空` ``
   3. `key !== key.trim()` → `` `第 ${i} 个 Tag 的 key「${key}」首尾不能有空格` ``
   4. `key.toLowerCase().startsWith('aws:')` → `` `第 ${i} 个 Tag 的 key 不能以 aws: 开头（AWS 保留前缀）` ``
   5. `key.toLowerCase() === 'map-migrated' && key !== 'map-migrated'` → `` `第 ${i} 个 Tag 的 key「${key}」与 map-migrated 仅大小写不同，会造成混淆，请删除` ``
   6. 小写后与前面某项相同 → `` `第 ${i} 个 Tag 的 key「${key}」重复` ``
   7. `key !== 'map-migrated' && value !== value.trim()` → `` `第 ${i} 个 Tag 的 value 首尾不能有空格` ``
4. 没有 key 为 `map-migrated` 的项 → `'缺少 map-migrated 标签'`
5. `checkMapTagValue(该项 value)` 非 null → 该信息
6. 返回 `[mapTag, ...其余按原顺序]`，每项为新对象 `{ key, value }`（不带多余字段）

全部以 `throw new MapTagRuleError(msg)` 抛出。**不 trim、不改写任何值。**

**`parseProfileArn`**：正则 `/^arn:aws:bedrock:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):application-inference-profile\/[A-Za-z0-9]+$/`，返回 `{ region: m[1], accountId: m[2] }`。

**`assertArnsBelong`**：收集所有 `parseProfileArn` 为 null、或 `accountId` 不等、或（传了 `region` 时）region 不等的 ARN；非空时抛
`` `以下 ARN 不属于账户 ${accountId}${region ? ` / 区域 ${region}` : ''}：${bad.slice(0, 5).join('、')}${bad.length > 5 ? ` 等 ${bad.length} 个` : ''}` ``。

**`diffTags`**：
- 对 `expected` 每项：`actual` 中找 `key` 精确相等的项；无 → `` `${e.key}：期望 ${e.value}，实际缺失` ``；值不同 → `` `${e.key}：期望 ${e.value}，实际 ${a.value}` ``
- 另：`findMapTagKeyVariant(actual)` 非 null → 追加 `` `存在与 map-migrated 仅大小写不同的 key「${variant}」` ``
- 不比较 `actual` 中多出的其它 key。

**`readBackTags`**：默认 `attempts = 3`、`delayMs = 1000`、`sleep = ms => new Promise(r => setTimeout(r, ms))`。

```
let lastActual = null, lastDiff = [], lastErr = ''
for i in 0..attempts-1:
  if i > 0: await sleep(delayMs)
  try:
    actual = await read(); lastActual = actual
    diff = diffTags(expected, actual)
    if diff 为空: return { status: 'verified', actual }
    lastDiff = diff
  catch e: lastErr = e?.message || String(e)
if lastActual === null: return { status: 'read_failed', actual: null, error: lastErr }
return { status: 'mismatch', actual: lastActual, error: lastDiff.join('；') }
```

### 5.2 修改 `web/server/bedrock-tools.ts`

新增 import：`import { readBackTags, findMapTagValue, parseProfileArn, type BedrockTag } from './map-tag-rules';`

新增私有函数：

```ts
async function listTags(c: BedrockClient, arn: string): Promise<BedrockTag[]> {
  const resp = await c.send(new ListTagsForResourceCommand({ resourceARN: arn }));
  return (resp.tags || []).map(t => ({ key: String(t.key ?? ''), value: String(t.value ?? '') }));
}
```

**`createProfiles` 改签名与行为**：

```ts
export type CreateProfileStatus = 'verified' | 'create_failed' | 'read_failed' | 'mismatch';
export interface CreateProfileResult {
  name: string;
  modelId: string;
  ok: boolean;                 // === (status === 'verified')
  status: CreateProfileStatus;
  arn?: string;
  actualMapValue: string | null;
  error?: string;
}
export async function createProfiles(
  accountId: string, region: string,
  items: Array<{ modelId: string; name: string }>,
  tags: BedrockTag[],
): Promise<CreateProfileResult[]>;
```

逐个串行：`CreateInferenceProfileCommand`（不变）。异常 → `{status:'create_failed', ok:false, actualMapValue:null, error}`。
成功 → `readBackTags(() => listTags(c, arn), tags)`，按其 status 填入，`actualMapValue = findMapTagValue(actual)`（actual 为 null 时为 null）。

**`tagProfiles` 改签名与行为**：

```ts
export type TagWriteStatus = 'verified' | 'write_failed' | 'read_failed' | 'mismatch';
export interface TagWriteResult {
  arn: string;
  ok: boolean;                 // === (status === 'verified')
  status: TagWriteStatus;
  oldMapValue: string | null;  // 写入前的 map-migrated；没有或读失败为 null
  oldReadFailed: boolean;      // 写入前读取失败（不阻断写入）
  removedVariantKeys: string[]; // 写入前移除的 map-migrated 大小写变体 key（如 Map-Migrated）
  actualMapValue: string | null;
  error?: string;
}
export async function tagProfiles(
  accountId: string, region: string, arns: string[], tags: BedrockTag[],
): Promise<TagWriteResult[]>;
```

逐个 ARN 串行：
1. `listTags` 读旧值；异常 → `oldReadFailed = true`、`oldMapValue = null`、`removedVariantKeys = []`，继续
2. 旧值读取成功且 `variantKeysToRemove(oldTags)` 非空 → `UntagResourceCommand({ resourceARN: arn, tagKeys: variants })`；异常 → `status:'write_failed'`，`error: '移除大小写变体 key 失败：' + 信息`，跳到下一个；成功 → `removedVariantKeys = variants`
3. `TagResourceCommand`；异常 → `status:'write_failed'`，`actualMapValue:null`，跳到下一个
4. `readBackTags(() => listTags(c, arn), tags)` → 填 status / actualMapValue / error

`TagResource` 对已存在的同名 key 是覆盖写，所以重打 Tag 就能修正错值，不需要先 untag。
第 2 步存在的理由：旧版 `validateTags` 允许额外 Tag 写 `Map-Migrated`，这类变体已在 AWS 上时，
回查和交付都会把它判为不合规，而 Bedrock 页没有解 Tag 的入口，不自动移除用户就修不掉。
只移除「不分大小写等于 map-migrated 但不精确」的 key，其它 key 一律不动。

**新增 `readProfileTagsByArn`**（交付用）：

```ts
export async function readProfileTagsByArn(
  accountId: string, arns: string[],
): Promise<{ tags: Map<string, BedrockTag[]>; failures: Array<{ arn: string; error: string }> }>;
```

按 `parseProfileArn(arn).region` 分组（解析失败直接进 failures，`error: '无法解析 ARN'`）；各区域并发、区域内串行；每个 ARN 调一次 `listTags`，异常进 failures。每个区域 client 用完 `destroy()`。

`untagProfiles` / `deleteProfiles` / `listProfiles` 不改。

### 5.3 修改 `web/server/routes/bedrock.ts`

- 删除本地 `validateTags`，改 import `validateBedrockTags, assertArnsBelong, MapTagRuleError, findMapTagValue, type BedrockTag` from `'../map-tag-rules'`；import `normalizeDeliveryRows` from `'../bedrock-delivery'`。
- 文件头注释的「Tag 纪律」补一句：value 必须符合 `^mig[A-Z0-9]{10}$`，规则见 `map-tag-rules.ts`。
- 错误码：`/profiles/create`、`/profiles/tag` 的 catch 改为 `res.status(e instanceof MapTagRuleError ? 400 : 500)`。

**新增本地 helper**：

```ts
/** 统计各状态数量，如「verified 3，mismatch 1」，只列出现过的状态 */
function statusSummary(results: Array<{ status: string }>): string;
```

**`POST /profiles/create`**（守卫 `requireAdmin` 不变）：`tags = validateBedrockTags(req.body.tags)`，其余校验不变。审计 detail：

```
账户 ${accountId} | ${region} | 创建 ${created}/${total}，核验通过 ${verified}（${statusSummary(results)}） | tags: k=v;k=v
```
其中 `created` = status 不为 `create_failed` 的个数。

**`POST /profiles/tag`**（守卫 `requireAdmin` 不变）：
- `arns` 必须是数组且每项为 string，否则 400 `'arns 必须是字符串数组'`；去掉旧的 `startsWith('arn:')` 过滤
- 空 → 400 `'请至少选择一个 Profile'`；> 100 → 400 `'一次最多 100 个 Profile'`
- `tags = validateBedrockTags(req.body.tags)`；`assertArnsBelong(arns, accountId, region)`
- 审计 detail：

```
账户 ${accountId} | ${region} | 打 Tag 核验通过 ${verified}/${total}（${statusSummary(results)}） | 旧 map-migrated: ${oldDist} | 新 tags: k=v;k=v
```
`oldDist` 形如 `migAAAA×3, 无×2, 读取失败×1`（无 = `oldMapValue === null && !oldReadFailed`）。
若任一结果 `removedVariantKeys` 非空，detail 末尾追加 `` ` | 移除变体 key：${arn 末段 id}(${keys.join('/')})，…` ``。

**新增本地 helper `attachAwsTags`**：

```ts
async function attachAwsTags<T extends { arn: string; name: string }>(
  accountId: string, rows: T[],
): Promise<Array<T & { tags: BedrockTag[] }>>;
```
调 `bt.readProfileTagsByArn(accountId, rows.map(r => r.arn))`；`failures` 非空时抛
`` new MapTagRuleError(`无法从 AWS 读取以下 Profile 的标签，已拒绝生成：${列表前 5 项 name（error）}${超过 5 个时 ` 等 ${n} 个`}`) ``；否则返回 `rows.map(r => ({ ...r, tags: tags.get(r.arn)! }))`。

**`POST /delivery`（v1）**：
- 请求体改为 `{ accountId, rows, iamUser, iamPassword }`；`accountId` 不符合 `ACCOUNT_RE` → 400 `'无效的账户 ID'`
- 顺序：`const base = normalizeDeliveryRows(accountId, rows)` → `const authoritative = await attachAwsTags(accountId, base)` → `buildDeliveryXlsx(authoritative, iamUser, iamPassword)`
- 前端传来的 `tags` **一律忽略**
- catch 仍是 400（不变）

**`POST /delivery-v2`**：
- 现有 `rows.map(... name/region String 化)` 替换为 `normalizeDeliveryRows(accountId, rows)`
- 然后 `filterAndSortForDelivery(base, variant)`（**必须在读标签之前**，见 README「筛选必须在 prepareDelivery 之前」）
- `kept` 为空的报错不变
- 然后 `const keptWithTags = await attachAwsTags(accountId, kept)`，后续 `rowsV2` 的 `tags` 取 `keptWithTags` 的 AWS 标签（删除 `Array.isArray(r.tags) ? r.tags : []`）
- 其余（配额匹配、响应头、审计）不变

### 5.4 修改 `web/server/bedrock-delivery.ts`

新增 import：`import { checkMapTagValue, findMapTagKeyVariant, parseProfileArn, MapTagRuleError } from './map-tag-rules';`

**新增 `normalizeDeliveryRows`**：

```ts
export interface DeliveryInputRow { name: string; arn: string; region: string; backendModels?: string; scope?: string }
export function normalizeDeliveryRows(accountId: string, raw: unknown): DeliveryInputRow[];
```
- `raw` 不是数组或为空 → 抛 `MapTagRuleError('没有 Profile 数据')`
- 每项：`arn = String(r?.arn ?? '')`，`name = String(r?.name ?? '')`；`parseProfileArn(arn)` 为 null 或 accountId 不等 → 收集
- 有收集项 → 抛 `` MapTagRuleError(`以下 Profile 不属于账户 ${accountId}，已拒绝生成：${前 5 个 name || arn}${>5 时 ` 等 ${n} 个`}`) ``
- **region 一律取 ARN 解析值**（忽略前端传的 region）；`backendModels` / `scope` 是 string 时保留，否则不带
- 返回新数组（不带 tags）

**修改 `prepareDelivery` 的 tag 校验段**（替换原 `for (const r of rows) { const mig = ... }` 循环，ARN 账户唯一校验和后续分组不变）：

```ts
const bad: string[] = [];
const tagValues = new Set<string>();
for (const r of rows) {
  const variant = findMapTagKeyVariant(r.tags);
  if (variant) { bad.push(`${r.name}：存在与 map-migrated 仅大小写不同的 key「${variant}」`); continue; }
  const mig = (r.tags || []).find(t => t.key === 'map-migrated');
  if (!mig || !mig.value) { bad.push(`${r.name}：缺少 map-migrated`); continue; }
  const err = checkMapTagValue(mig.value);
  if (err) { bad.push(`${r.name}：${err}`); continue; }
  tagValues.add(mig.value);
}
if (bad.length) {
  throw new Error(`以下 ${bad.length} 个 Profile 的 map-migrated 标签不合规，不能交付：${bad.slice(0, 10).join('；')}${bad.length > 10 ? ' 等' : ''}。请在「Profiles 管理」重新打 Tag 后再生成`);
}
if (tagValues.size !== 1) throw new Error(`map-migrated tag 不唯一：${[...tagValues].join(', ')}，请先统一`);
```

函数头注释改为：账户唯一；`map-migrated` 必须存在、格式合规、无大小写变体 key、全表唯一。
**不得改动** `normalizeProfileName`、`filterAndSortForDelivery`、`deliveryOrderFor`、xlsx 版式与须知文案（README 第九节高危区）。

## 6. 前端设计

页面：现有 `web/client/src/pages/Bedrock.tsx`（可分配页 `bedrock`），**不改** `MainLayout.tsx` / `auth.ts`。

### 6.1 新建 `web/client/src/utils/mapTag.ts`

```ts
export const MAP_TAG_KEY = 'map-migrated';
export const MAP_TAG_VALUE_RE = /^mig[A-Z0-9]{10}$/;
export function checkMapTagValue(value: unknown): string | null;
/** 与 server validateBedrockTags 规则与信息逐字一致；合规返回 null，否则返回第一条错误信息。 */
export function checkTagInputs(tags: Array<{ key: string; value: string }>): string | null;
```
逻辑与 5.1 的 `checkMapTagValue` / `validateBedrockTags` **逐字一致**（含 50 上限与全部信息文案）。文件头注释：`与 server/map-tag-rules.ts 保持逐字一致，tests/bedrock-map-tag-guard.test.ts 锁死`。

### 6.2 新建 `web/client/src/components/BedrockTagResults.tsx`

```ts
export type TagResultStatus = 'verified' | 'create_failed' | 'write_failed' | 'read_failed' | 'mismatch';
export interface TagResultRow {
  key: string;               // 行唯一键：打 Tag 用 arn；创建用 `${region}|${modelId}`
  region: string;
  name?: string;
  arn?: string;
  modelId?: string;
  status: TagResultStatus;
  oldMapValue?: string | null;
  actualMapValue?: string | null;
  error?: string;
}
export const TAG_STATUS_LABEL: Record<TagResultStatus, string>;
// verified 已核验 / create_failed 创建失败 / write_failed 写入失败 / read_failed 回查失败 / mismatch 值不一致
const BedrockTagResults: React.FC<{ rows: TagResultRow[]; retrying: boolean; onRetry: () => void }>;
export default BedrockTagResults;
```
- 顶部一行汇总：每个出现过的状态一个 AntD `<Tag>`，`verified` 用 `color="success"`，`mismatch` 用 `color="warning"`，其余用 `color="error"`，文字 `${label} ${count}`
- 右侧按钮「重试未完成项（n）」，n = 非 verified 行数；`n === 0 || retrying` 时禁用；`loading={retrying}`
- `size="small"` 表格，`rowKey="key"`，不分页超过 20 行时分页 20；列：状态（同色 Tag）、Region、名称（`name || '-'`）、ARN（等宽 12px、`wordBreak: 'break-all'`）、旧值（仅当任一行 `oldMapValue !== undefined` 时显示该列，null 显示 `无`）、AWS 实际值（null 显示 `-`）、说明（`error || '-'`）
- 只用 AntD 组件与 `var(--color-*)`，不写 hex、不用 emoji

### 6.3 修改 `web/client/src/pages/Bedrock.tsx`

1. 删除 `validTags`；import `checkMapTagValue, checkTagInputs, MAP_TAG_KEY` from `'../utils/mapTag'` 与 `BedrockTagResults, { type TagResultRow }` from `'../components/BedrockTagResults'`。`FIXED_TAG_KEY` 改为 `= MAP_TAG_KEY`。
2. 新增 `const trimTags = (tags) => tags.map(t => ({ key: t.key.trim(), value: t.value.trim() }));`（提交前去首尾空格，这是现有行为；**不改大小写、不补删 mig**）。
3. `TagInputs` 增加可选 prop `error?: string | null`，非空时在「+ 添加额外 Tag」按钮下方渲染 `<Typography.Text type="danger" style={{ fontSize: 12 }}>{error}</Typography.Text>`；第一行 value 占位符改为 `'Tag Value（mig + 10 位大写字母或数字）'`。
4. **ProfilesTab**：
   - `const tagError = checkTagInputs(trimTags(tagInputs));`，打 Tag Modal 的 `okButtonProps={{ disabled: !!tagError }}`，`<TagInputs ... error={tagError} />`
   - 新 state：`tagResults: TagResultRow[]`、`resultOpen: boolean`、`lastTags: {key,value}[]`、`retrying: boolean`
   - 新函数 `runTag(targets: Map<string, string[]>, tags): Promise<TagResultRow[]>`：逐区域调 `api.bedrockTagProfiles`；`res.success` 时把 `res.data` 每项映射为 `{ key: arn, region, arn, name: rows 中同 arn 的 name, status, oldMapValue, actualMapValue, error }`，其中 `removedVariantKeys` 非空时 `error` 前缀 `` `已移除变体 key ${keys.join('/')}；` ``（`error` 为空时只留这句，去掉末尾分号）；`!res.success` 时该区域每个 arn 生成 `{ status: 'write_failed', error: res.error || '请求失败' }`；请求抛异常同样处理
   - `doTag`：`tags = trimTags(tagInputs)`，`setLastTags(tags)`，`runTag(byRegion(selectedRows), tags)` → `setTagResults`，关闭打 Tag Modal，打开结果 Modal，`message` 按是否全部 verified 给 success / warning（文案「打 Tag 完成：核验通过 x / y」，无感叹号），然后 `load()`
   - `retryTag`：取 `tagResults` 中非 verified 行，按 region 分组 → `runTag(..., lastTags)` → 按 `key` 合并回 `tagResults`（替换同 key 行）→ `load()`
   - 结果 Modal：标题「打 Tag 结果」，`width={960}`，内容 `<BedrockTagResults rows={tagResults} retrying={retrying} onRetry={retryTag} />`，footer 仅「关闭」
   - `setTagInputs([{ key: FIXED_TAG_KEY, value: '' }])` 的重置逻辑保留
   - Tags 列 render：对每个 tag，若 `t.key === 'map-migrated'` 且 `checkMapTagValue(t.value)` 非 null，或 `t.key.toLowerCase() === 'map-migrated' && t.key !== 'map-migrated'`，渲染 `<Tooltip title={原因}><Tag color="error">{t.key}={t.value}</Tag></Tooltip>`（大小写变体原因：`与 map-migrated 仅大小写不同`）；其余保持原样
   - `ProfilesTabView` 的 props 透传新增项（`tagError, tagResults, resultOpen, setResultOpen, retryTag, retrying`）
5. **CreateTab**：
   - `const tagError = checkTagInputs(trimTags(tagInputs));` 创建按钮 `disabled` 条件中的 `!validTags(tagInputs)` 换成 `!!tagError`；按钮旁提示改为 `{tagError && <Typography.Text type="danger" style={{ fontSize: 12 }}>{tagError}</Typography.Text>}`（替换原 `#cf1322` 硬编码）；`<TagInputs ... error={tagError} />`
   - Alert 文案改为：`Tag Key 固定为 map-migrated，Value 每次必须手动输入，格式为 mig + 10 位大写字母或数字（如 migAB12CD34EF）。平台不记忆、不提供默认值——请核对与该账户所属 MAP 协议一致后再创建。`
   - 新 state：`createResults: TagResultRow[]`、`lastTags`、`retrying`
   - `doCreate`：`tags = trimTags(tagInputs)`、`setLastTags(tags)`；逐区域调 `api.bedrockCreateProfiles`，结果映射为 `{ key: `${rgn}|${r.modelId}`, region: rgn, name: r.name, modelId: r.modelId, arn: r.arn, status: r.status, actualMapValue: r.actualMapValue, error: r.error }`；整区域请求失败时该区域每个选中模型生成 `status: 'create_failed'`；`log` 行仍追加（`[OK]` 只用于 verified，其余用 `[ERR] [rgn] name: 状态标签 error`）；完成后 `setCreateResults`
   - `retryCreate`：非 verified 行中
     - `create_failed` → 按 region 分组，`items = [{ modelId, name }]`，调 `api.bedrockCreateProfiles({ accountId, region, items, tags: lastTags })`
     - `read_failed` / `mismatch`（有 arn）→ 按 region 分组，调 `api.bedrockTagProfiles({ accountId, region, arns, tags: lastTags })`，返回的 status 直接写回该行
     - 结果按 `key` 合并回 `createResults`
   - 在 `log` `<pre>` 下方：`createResults.length > 0` 时渲染 `<BedrockTagResults rows={createResults} retrying={retrying} onRetry={retryCreate} />`
   - 重试用的是 `lastTags`（发起创建时的值），不是输入框里当前的值；在结果区上方加一行 `Typography.Text type="secondary"`：`重试使用本次创建时的 Tag：${lastTags.map(k=v).join('; ')}`
6. **DeliveryTab**：
   - `doExport` v1 改为 `api.bedrockDeliveryExport({ accountId, rows: rows.map(r => ({ name: r.name, arn: r.arn, region: r.region })), iamUser: iamUser.trim(), iamPassword })`；v2 的 rows 去掉 `tags` 字段，其余不变
   - Alert 文案改为：`生成客户交付 Excel：账户信息 + ARN List（按区域分组）+ 使用须知。服务端会按 ARN 从 AWS 重新读取标签：所有 Profile 必须属于当前账户、带同一个 map-migrated 值，且格式为 mig + 10 位大写字母或数字，否则拒绝生成。`
   - map-migrated 列：缺失 → `<Tag color="red">缺失</Tag>`（不变）；`checkMapTagValue` 非 null → `<Tooltip title={err}><Tag color="error">{t.value}</Tag></Tooltip>`；合规 → `<Tag color="green">`（不变）
7. **BedrockPage**：`<Tabs key={selectedAccount || 'none'} ...>`，上方加注释：`切换账户必须整体重建各 Tab：rows / 勾选 / 已填 Tag / 结果都是组件内 state，不重建就会把上一个账户的数据带到新账户（曾出现把 A 账户的 Profile 选中后在 B 账户操作）`。`activeTab` state 在 BedrockPage，重建后仍停留在当前 Tab。

### 6.4 修改 `web/client/src/api.ts`

- `bedrockDeliveryExport` 的 body 类型改为 `{ accountId: string; rows: { name: string; arn: string; region: string }[]; iamUser: string; iamPassword: string }`
- `bedrockDeliveryExportV2` 的 `rows` 类型保持 `any[]`
- 其它不变（`bedrockCreateProfiles` / `bedrockTagProfiles` 走通用 `request`，返回结构变化由页面消费）

## 7. AWS 链路

- 与现有 Bedrock 工具完全一致：`bedrock-tools.ts` 的 `adminCreds(accountId)` → `getTempAdminCredentials`（Admin 链路：payer 自身 / 一级跳 `admin-console` / 二级跳 OAAR）。不新增链路，不改 `restricted_accounts` 处理。
- 新增调用：`bedrock:ListTagsForResource`（创建 / 打 Tag 时每个 ARN 读旧值 1 次 + 回查 1–3 次；交付时每个 ARN 1 次）；`bedrock:UntagResource`（仅当资源上存在 map-migrated 大小写变体 key 时）。Admin 角色均已具备，`listProfiles` / `untagProfiles` 已在用。
- 量级：单次请求 ≤ 100 个 ARN，区域内串行，SDK `maxAttempts: 2`；不会触发限流。

## 8. 错误处理与边界

| 场景 | 行为 |
|---|---|
| tags 不合规 | 400，`MapTagRuleError` 的信息原样返回；不调用 AWS |
| 打 Tag 的 ARN 不属于账户 / 区域 | 400，整单拒绝，不做任何写入 |
| 写入前读旧值失败 | 不阻断，`oldReadFailed: true`；此时无法得知是否有变体 key，不移除（回查若发现变体会判 mismatch，重试时会再读一次旧值并移除） |
| 资源上已有 `Map-Migrated` 等变体 key | 写入前 `UntagResource` 移除，记入 `removedVariantKeys` 与审计；移除失败 → `write_failed` |
| `TagResource` / `CreateInferenceProfile` 失败 | 该项 `write_failed` / `create_failed`，其它项继续 |
| 回查 3 次都读失败 | `read_failed`（标签可能已写入，重试会再写一次，覆盖写幂等） |
| 回查读到但不一致 | `mismatch`，`error` 写差异 |
| 交付：ARN 不属于账户 | 400，列出 profile |
| 交付：任一 ARN 读标签失败 | 400，拒绝生成（不允许用前端值兜底） |
| 交付：标签缺失 / 大小写变体 / 格式错 / 不唯一 | 400，列出 profile |
| 交付 v1 缺 accountId | 400 `无效的账户 ID`（旧前端缓存会遇到，刷新页面即可） |
| 切换账户时有请求在途 | Tab 已重建，旧组件 setState 为 no-op；旧请求的 toast 仍会弹出（描述的是真实发生的操作） |

## 9. 测试计划

新增两个测试文件（`node:test` + `node:assert/strict`），按文件所有权拆开：

- `web/tests/bedrock-map-tag-guard.test.ts`：用例 1、2、3、4、4b、7。import `../server/map-tag-rules`、`../client/src/utils/mapTag`、`../server/tag-compliance`（只取 `MAP_TAG_KEY`，`tests/tag-extra-tag.test.ts` 已这样 import）
- `web/tests/bedrock-delivery-tag-guard.test.ts`：用例 5、6。import `../server/bedrock-delivery`（`prepareDelivery`、`normalizeDeliveryRows`）

用例：

1. `checkMapTagValue`：`migEY52ZIK63T`、`migMIGAB12345` → null；`migmigEY52ZIK63T`（含「重复的 mig 前缀」）、`migey52zik63t`（含「大写字母 A-Z」）、` migEY52ZIK63T`（含「首尾不能有空格」）、`migEY52ZIK63`（含「长度应为 13」）、`MIGEY52ZIK63T`（含「小写 mig 开头」）、`''` / `undefined`（`map-migrated 的值不能为空`）
2. `validateBedrockTags`：
   - 合法 `[{key:'Project',value:'x'},{key:'map-migrated',value:'migEY52ZIK63T'}]` → 返回 map-migrated 在第一位
   - 额外项 key `Map-Migrated` / `MAP-MIGRATED` → 抛「仅大小写不同」
   - 两个 `map-migrated` → 抛「重复」
   - `Project` 与 `project` → 抛「重复」
   - 没有 map-migrated → `缺少 map-migrated 标签`
   - map-migrated 值 `migmigEY52ZIK63T` → 抛「重复的 mig 前缀」
   - 空数组、51 个、`aws:x` key、value 为 `' x'` 的额外项 → 各自抛对应信息
   - 所有抛出的都是 `MapTagRuleError`
3. `assertArnsBelong`：同账户同区域通过；另一账户 ARN、另一区域 ARN、`foundation-model` ARN → 抛，信息含该 ARN
4. `readBackTags`（注入 `sleep: async () => {}`）：
   - 第一次读回一致 → verified，read 调用 1 次
   - 第一次值不同、第二次一致 → verified，调用 2 次
   - 三次都是 `migmigX…` → mismatch，error 含「期望」「实际」
   - 三次都抛错 → read_failed，error 为最后一次信息
   - 读回含 `Map-Migrated` 变体 → mismatch
   - map-migrated 一致但额外 Tag `Project` 值不同 → mismatch，error 含 `Project`
   - 读回比期望多出无关 key（如 `Owner=x`）→ verified
4b. `variantKeysToRemove`：`[map-migrated, Map-Migrated, MAP-MIGRATED, Project]` → `['Map-Migrated', 'MAP-MIGRATED']`；只有精确 `map-migrated` → `[]`；`null` → `[]`
5. `prepareDelivery`：
   - 3 行全部 `map-migrated=migmigEY52ZIK63T`（全部一致但格式错）→ 抛「不合规，不能交付」
   - 1 行缺失 + 1 行合规 → 抛，信息含缺失行 name
   - 含 `Map-Migrated` 变体 → 抛
   - 全部 `migEY52ZIK63T` → 返回 `tagValue === 'migEY52ZIK63T'`
6. `normalizeDeliveryRows`：另一账户 ARN → 抛；前端 region 写错时以 ARN 为准；空数组 → 抛；输入行带 `tags` 时返回对象**没有** `tags` 键
7. 前后端一致：对用例 1 的全部输入，`server.checkMapTagValue(x) === client.checkMapTagValue(x)`；对用例 2 的全部输入，`try { server.validateBedrockTags(x); null } catch (e) { e.message }` 等于 `client.checkTagInputs(x)`（client 入参为数组，非数组用例跳过）；`server.MAP_TAG_VALUE_RE.source === client.MAP_TAG_VALUE_RE.source`；`server.MAP_TAG_KEY === tagCompliance.MAP_TAG_KEY === client.MAP_TAG_KEY`

### Review Focus（规格隐含、最容易出事、上面未必显式覆盖的 5 类输入）

1. **资源上已存在 `Map-Migrated` 变体 key** → 打 Tag 应移除变体并 verified，而不是永远 mismatch。测试：用例 4b + 4「读回含变体 → mismatch」（证明不移除就过不了）
2. **10 位恰好以 `MIG` 开头的合法值**（`migMIGAB12345`）→ 必须通过，不能被 migmig 规则误伤。测试：用例 1
3. **前端传来合规 tags、AWS 实际是错值** → 交付必须按 AWS 拒绝。`attachAwsTags` 依赖 AWS 无法单测；由 `normalizeDeliveryRows` 不返回 tags 字段（用例 6 断言返回对象无 `tags` 键）+ `prepareDelivery` 用例 5 共同锁住
4. **额外 Tag 回查不一致而 map-migrated 一致** → 必须判 mismatch，不能只看主标签。测试：用例 4 新增两条
5. **前端请求里的 region 与 ARN 不符**（打 Tag 选错区域分组 / 交付行 region 被篡改）→ 打 Tag 整单 400，交付以 ARN 为准。测试：用例 3、用例 6

必须仍然通过：`tests/bedrock-delivery-55.test.ts`、`tests/bedrock-delivery-name-match.test.ts`、`tests/bedrock-account-tpd.test.ts`、`tests/tag-extra-tag.test.ts`。

## 10. 存量排查脚本（一次性，只读）

新建 `web/scripts/audit-bedrock-map-tags.ts`，运行：`cd web && npx tsx scripts/audit-bedrock-map-tags.ts [--payer <payer名>] [--out <目录>] [--plan-only]`

- `--plan-only`：只解析审计日志，写出 history CSV，并在 stdout 打印「将查询的账户 → 区域列表」，**不 import / 不调用任何 AWS 相关模块**（`bedrock-tools` 用动态 `await import('../server/bedrock-tools')`，仅在非 plan-only 时加载）

- 读 `process.env.DB_PATH || path.join(__dirname, '../../data/db.json')`，`fs.readFileSync` + `JSON.parse`，**不经 db.ts、不写任何文件到 data/**
- 从 `audit_log` 取 `action ∈ {BEDROCK_PROFILE_CREATE, BEDROCK_PROFILE_TAG, BEDROCK_DELIVERY_EXPORT}`：
  - accountId：`/账户 (\d{12})/`
  - region：`/\| ([a-z]{2}(?:-[a-z]+)+-\d) \|/`（交付记录没有，忽略）
  - 历史值：`/map-migrated=([^;|\s]+)/g` 与 `/tag=([^\s，）)]+)/`
- payer：`accounts_cache` 中 `Id === accountId` 的 `_payer`，找不到写 `unknown`；`--payer` 给定时只处理该 payer
- 每个账户区域集合 = `us-east-1`、`us-west-2` ∪ 审计中出现的区域，每 12 个一批调 `listProfiles(accountId, regions)`（from `../server/bedrock-tools`）；账户之间串行；单账户失败记一行 `status=查询失败`，继续
- 每个 profile 判定：`findMapTagKeyVariant` 非 null → `大小写变体`；无 map-migrated → `缺失`；`checkMapTagValue` 非 null → `格式错误`；否则 `OK`
- 输出两个 CSV（UTF-8 BOM，所有字段双引号包裹、内部双引号转义，**数字不加千分位**）到 `--out`（默认 `process.cwd()`）：
  - `bedrock-map-tag-current-YYYYMMDD.csv`：`payer,accountId,region,profileName,arn,mapValue,status,reason`
  - `bedrock-map-tag-history-YYYYMMDD.csv`：`createdAt,action,payer,accountId,value,valid,reason`
- stdout 打印汇总：账户数、profile 数、各状态计数、格式错误所在账户列表
- 脚本头注释写明：只读；会通过 Admin 链路读取各账户 Bedrock 标签；修正方式是在页面「Profiles 管理」重打 Tag 并重新生成交付表

## 11. 影响面与风险

- README 第九节高危区：
  - `bedrock-delivery.ts` `normalizeProfileName()`：**不改**；`tests/bedrock-delivery-name-match.test.ts` 守着
  - Bedrock TPD `inherited` 标记：不涉及；`buildDeliveryXlsxV2` 版式与须知不改
  - CSV 导出：排查脚本数字不加千分位
- 行为变化（破坏性）：
  - 已有格式不合规标签的账户将**无法生成交付表**，直到重打 Tag。这是本需求的目的
  - `/delivery` v1 新增必填 `accountId`；前后端同批发布，旧页面缓存刷新即可
  - 打 Tag / 创建响应项新增字段，`ok` 语义从「写入成功」收紧为「回查通过」
  - 打 Tag 会自动移除资源上的 `Map-Migrated` 等大小写变体 key（唯一的自动删除行为，审计可查）
- 回滚：只回滚代码即可，无数据变更

## 12. 明确不做

- 不存储 payer 标准值，不和 `orgs.json` 比对，不检测「格式合法但属于别家 payer」
- 交付时不要求二次输入预期值
- 不做定期巡检，不加 scheduler 任务
- 不改 `tag-compliance.ts`、`TagCompliance.tsx`、`orgs.json`
- 不改 `/profiles/untag`、`/profiles/delete`、`listProfiles`
- 不自动修正存量标签（脚本只读）
- 不重构 `Bedrock.tsx` 的其它 Tab、不清理其中既有的 inline style 债务
- 不改 `version.ts`、`README.md`、`project-context.md`（协调者在 P5 统一改）
