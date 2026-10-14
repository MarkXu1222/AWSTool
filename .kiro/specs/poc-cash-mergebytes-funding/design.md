# design.md — POC 资金申请支持 Mergebytes 主体

## 1. 需求与验收

把 POC 资金申请链路从「写死 Webby」改为「按 `partnerKey` 分流」：凭证、发票信息、联系人
都取自所选主体；进展与 CSV 按主体分开。Mergebytes 的发票与联系人见 `requirements.md`。

验收：

- [ ] `cd web && npm test -- ` 全部通过，含新增 `tests/poc-cash-partner-funding.test.ts`
- [ ] `cd web && npm run typecheck && npm run build` 通过
- [ ] `getFundingProfile('webby')` 返回值与改动前常量逐字相同（测试锁死）
- [ ] 线上「POC 进展」切 Mergebytes 正常加载；Webby 进展与 CSV 不变
- [ ] Webby CSV 文件名仍为 `poc-cash-<ts>.csv`；Mergebytes 为 `poc-cash-mergebytes-<ts>.csv`
- [ ] 「POC 申请」切 Mergebytes 后，下拉只列 Mergebytes 商机且预览不报「找不到」

## 2. 现状分析

- `web/server/poc-cash.ts`
  - `PARTNERS: PartnerProfile[]`（webby / mergebytes），`getPartner(key)` 未知 key 抛 `未知的 Partner`。
  - `sellingClient(partnerKey = DEFAULT_PARTNER_KEY)`、`benefitsClient(partnerKey = DEFAULT_PARTNER_KEY)`
    已支持按主体 AssumeRole；`DEFAULT_PARTNER_KEY = 'webby'`。
  - `getStageStatus(id, partnerKey = DEFAULT_PARTNER_KEY)`。
- `web/server/poc-cash-funding.ts`
  - 模块常量 `WEBBY_INVOICE`（4 字段）、`CONTACT`（4 字段），写死。
  - `precheckOpportunity(oppId)` → `sellingClient()`（默认 webby）。
  - `buildDetails(...)`（未导出）把 `...WEBBY_INVOICE` 展开进 `CashRequest`。
  - `createPocApplication(input, calcFactory?)` → `benefitsClient()`，`PartnerContacts: [CONTACT]`。
  - `submitExisting(id)`、`listPocApplications(opts)`、`getPocApplication(id)` 全用默认 webby。
  - `createApplicationWithLedger`、`computeAmounts`、`buildCsv` 与主体无关，不动。
- `web/server/poc-calculator.ts`：`CalculatorContext` 传给 `reservePocCalculator` / `recordManualPocCalculator`。
- `web/server/db.ts`：`PocCalculatorLedgerEntry`、`PocCalculatorReserveInput`、`reservePocCalculator`、
  `recordManualPocCalculator`。查重逻辑（总额或签名相同即撞车）遍历全部条目。
- `web/server/routes/poc-cash.ts`：`partnerKeyOf(req)` 从 query 或 body 取 key，空则默认 webby，
  非法则抛（`getPartner`）。商机类端点已用；`/funding*` 端点没用。`savePocCsv(csv)`、
  `listPocCsvFiles()` 为文件内私有函数，固定前缀 `poc-cash-`。
- `web/client/src/api.ts`：`pk(partnerKey)`、`qs(params)` 查询串工具；`pocFunding*` 方法均不带主体。
- `web/client/src/pages/PocCash.tsx`
  - 页面级 `activePartner`；商机列表 `opps` 随 `activePartner` 重拉（`useEffect` 带 stale 守卫）。
  - 「阶段检查」Tab 内联一个主体 `Select`（约 1088–1104 行），`onChange` 里
    `setActivePartner` + `form.setFieldValue('partnerKey', v)` + 清 `checkId` / `stageInfo`。
  - 「创建商机」表单内另有 `partnerKey` 字段的 `Select`（约 1284–1292 行），`onChange` 调 `setActivePartner`。
  - POC 表单的商机下拉用 `opps`（即当前 `activePartner` 的商机）→ 与后端恒用 Webby 不一致（本次修复）。
  - `loadPocRows()` 无参，Tab 切到 progress 且 `pocRows` 为空时自动加载（约 1426 行）；
    「刷新」按钮 `onClick={loadPocRows}`。

## 3. 方案总览

```
PocCash.tsx (activePartner)
   │  partnerKey 放在 query（GET / submit）或 body（preview / create / export）
   ▼
routes/poc-cash.ts  partnerKeyOf(req) ──► pk
   │
   ├─ getFundingProfile(pk)            (poc-cash.ts，未配置 funding 即抛)
   ├─ precheckOpportunity(id, pk)      → sellingClient(pk)
   ├─ createPocApplication({..., partnerKey: pk})
   │     ├─ calculator ctx.partnerKey → 台账条目 partnerKey
   │     ├─ buildDetails({..., invoice: funding.invoice})
   │     └─ benefitsClient(pk) / PartnerContacts: [funding.contact]
   ├─ submitExisting(id, pk) / listPocApplications({partnerKey: pk}) → benefitsClient(pk)
   └─ export: listPocApplications(pk) + getStageStatus(id, pk) → savePocCsv(csv, pk)
```

## 4. 数据模型变更

- `data/db.json` → `poc_calculator_ledger[]` 条目新增**可选**字段 `partnerKey?: string`。
  - 新条目一律写入（来自 `CalculatorContext.partnerKey`）。
  - 老条目无此字段：读出为 `undefined`，语义为 webby；**不迁移**，也不需要回填。
  - 查重**不按主体过滤**，仍对全部条目生效（跨主体全局唯一）。
- `config.json`：无变更（发票信息不是密钥，放代码）。
- `data/poc-cash/`：新增 `poc-cash-mergebytes-<ts>.csv` / `poc-cash-mergebytes-latest.csv`；Webby 文件名不变。

## 5. 后端设计

### 5.1 `web/server/poc-cash.ts`（修改）

新增类型并扩展 `PartnerProfile`：

```ts
/** POC 资金申请（Benefits）用的主体资料。缺省表示该主体不能提 POC。 */
export interface PartnerFundingProfile {
  invoice: {
    InvoiceEntityName: string;
    /** ISO 3166-1 alpha-2，如 MY（不是 MALAYSIA） */
    InvoiceRemitCountry: string;
    InvoiceRemitAddress: string;
    /** Payee Central 收款档案 ID */
    AccountProfileID: string;
  };
  contact: { Email: string; FirstName: string; LastName: string; BusinessTitle: string };
}

export interface PartnerProfile {
  // ...现有字段不变...
  funding?: PartnerFundingProfile;
}
```

`PARTNERS` 两条各加 `funding`：

```ts
// webby —— 值从 poc-cash-funding.ts 的 WEBBY_INVOICE / CONTACT 原样搬来，一个字符都不改
funding: {
  invoice: {
    InvoiceEntityName: 'WEBBY SDN BHD',
    InvoiceRemitCountry: 'MY',
    InvoiceRemitAddress: '2-3, Jalan Merbah 1, Bandar Puchong Jaya, 47170 Puchong, Selangor',
    AccountProfileID: '123749FB67ZJQ',
  },
  contact: {
    Email: 'sy.siow@webbygroup.com', FirstName: 'SY', LastName: 'Siow',
    BusinessTitle: 'Business Strategy Director',
  },
},

// mergebytes —— 用户 2026-10-14 提供
funding: {
  invoice: {
    InvoiceEntityName: 'MERGEBYTES AI SDN. BHD.',
    InvoiceRemitCountry: 'MY',
    InvoiceRemitAddress:
      '3-1, JALAN MERBAH 1, BANDAR PUCHONG JAYA, 47170 PUCHONG SELANGOR MALAYSIA',
    AccountProfileID: '2MGE7NZ9LMR3C',
  },
  contact: {
    Email: 'cloud@mergebytes.ai', FirstName: 'SY', LastName: 'Siow',
    BusinessTitle: 'OpportunityOwner',
  },
},
```

新增函数（放在 `getPartner` 之后）：

```ts
/** 取主体的 POC 资金资料；未配置即抛错，绝不回退到 Webby（发票主体错了很难察觉）。 */
export function getFundingProfile(partnerKey: string): PartnerFundingProfile {
  const p = getPartner(partnerKey);
  if (!p.funding) {
    throw new Error(`${p.label} 未配置 POC 发票信息，不能提 POC 资金申请`);
  }
  return p.funding;
}
```

### 5.2 `web/server/poc-cash-funding.ts`（修改）

- 删除模块常量 `WEBBY_INVOICE`、`CONTACT`。
- import 增加 `DEFAULT_PARTNER_KEY, getFundingProfile, type PartnerFundingProfile`（from `./poc-cash`）。
- 签名变更（第二参数均有默认值，旧调用方不受影响）：

```ts
export async function precheckOpportunity(
  oppId: string, partnerKey: string = DEFAULT_PARTNER_KEY,
): Promise<OppPrecheck>                      // sellingClient(partnerKey)

export function buildDetails(i: {           // 由私有改为导出（测试用），字段新增 invoice
  activityName: string; awsAccountId: string; description: string;
  start: Date; end: Date; budgetYear: number; amounts: PocAmounts;
  calculatorUrl: string; considering: string;
  invoice: PartnerFundingProfile['invoice'];
}): Record<string, unknown>                  // CashRequest 里 ...WEBBY_INVOICE 改为 ...i.invoice，其余字段与顺序不变

export interface CreatePocInput { /* 现有字段 */ partnerKey?: string }

export interface CreatePocResult { /* 现有字段 */ partnerKey: string }

export async function submitExisting(
  applicationId: string, partnerKey: string = DEFAULT_PARTNER_KEY,
): Promise<{ applicationId: string; status: string; stage: string }>

export async function listPocApplications(
  opts: { includeMigrated?: boolean; partnerKey?: string } = {},
): Promise<PocRow[]>                         // benefitsClient(opts.partnerKey ?? DEFAULT_PARTNER_KEY)

export async function getPocApplication(
  applicationId: string, partnerKey: string = DEFAULT_PARTNER_KEY,
): Promise<PocRow>
```

`createPocApplication` 内部改动（顺序重要）：

1. 第一行：`const partnerKey = input.partnerKey ?? DEFAULT_PARTNER_KEY;`
   `const funding = getFundingProfile(partnerKey);` —— **必须在任何 AWS 调用之前**，未配置主体零副作用。
2. `precheckOpportunity(input.opportunityId, partnerKey)`。
3. `ctx` 增加 `partnerKey`。
4. `buildDetails({ ..., invoice: funding.invoice })`。
5. `benefitsClient(partnerKey)`；`PartnerContacts: [funding.contact]`。
6. `result.partnerKey = partnerKey`。

`submitExisting` 首行调用 `getFundingProfile(partnerKey)`（未配置主体拒绝写操作），再 `benefitsClient(partnerKey)`。
`listPocApplications` / `getPocApplication` 是只读，**不**调用 `getFundingProfile`。

新增 CSV 文件名工具（纯函数，供路由与测试使用）：

```ts
/** Webby 沿用历史前缀 poc-cash，其余主体为 poc-cash-<key>，避免旧快照被归到别的主体 */
export function pocCsvFilePrefix(partnerKey: string): string {
  return partnerKey === DEFAULT_PARTNER_KEY ? 'poc-cash' : `poc-cash-${partnerKey}`;
}

/** 是否为该主体的带时间戳快照（排除 latest 与其他主体的文件） */
export function isPocCsvSnapshotOf(file: string, partnerKey: string): boolean {
  const prefix = pocCsvFilePrefix(partnerKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.csv$`).test(file);
}
```

`savePocCsv` 生成的时间戳格式为 `new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)`
（如 `2026-10-14T08-30-12`），上面的正则与之匹配。

### 5.3 `web/server/poc-calculator.ts`（修改）

- `CalculatorContext` 新增 `partnerKey: string`（必填）。
- `createUniqueCalculator` / `recordManualCalculator` 把 `partnerKey: ctx.partnerKey` 传给
  `reservePocCalculator` / `recordManualPocCalculator` 的 input。

### 5.4 `web/server/db.ts`（修改）

- `PocCalculatorLedgerEntry` 新增 `partnerKey?: string;`（放在 `opportunityId` 之前）。
- `PocCalculatorReserveInput` 新增 `partnerKey?: string;`（可选，保证现有测试的 input 不改也能编译）。
- `reservePocCalculator` 与 `recordManualPocCalculator` 构造 entry 时：
  `...(input.partnerKey ? { partnerKey: input.partnerKey } : {})`。
- 查重条件**不变**，不得加主体过滤。

### 5.5 `web/server/routes/poc-cash.ts`（修改）

守卫：沿用 router 级 `pocCashRouter.use(requireStrictAdmin)`，不新增守卫。
所有 `partnerKeyOf(req)` 调用都必须位于 `try` 内，非法 key → 400。

| 方法 | 路径 | 主体来源 | 改动 |
|------|------|----------|------|
| GET | `/meta` | — | 每个 partner 增加 `fundingEnabled: !!p.funding`、`fundingInvoiceEntity: p.funding?.invoice.InvoiceEntityName ?? null` |
| GET | `/funding/meta` | — | 不变 |
| GET | `/funding/account/:id` | — | 不变（账户 → payer，与主体无关） |
| POST | `/funding/preview` | body.partnerKey | `precheckOpportunity(oppId, pk)`；响应增加 `partnerKey` |
| POST | `/funding` | body.partnerKey | `createPocApplication({ ..., partnerKey: pk }, createUniqueCalculator)`；审计改为 `` `[${pk}] ${原文}` `` |
| POST | `/funding/:id/submit` | query.partnerKey | `submitExisting(id, pk)`；审计 `` `[${pk}] ${id} | ...` `` |
| GET | `/funding` | query.partnerKey | `listPocApplications({ includeMigrated, partnerKey: pk })` |
| POST | `/funding/export` | body.partnerKey | `listPocApplications({ partnerKey: pk })`；`getStageStatus(id, pk)`；`savePocCsv(csv, pk)`；审计 `` `[${pk}] 导出 ...` ``；响应增加 `partnerKey` |
| GET | `/funding/exports` | query.partnerKey | `listPocCsvFiles(pk)`；包进 try/catch，非法 key 400 |

路由注册顺序不变（`/funding/meta`、`/funding/account/:id`、`/funding/export`、`/funding/exports`
都不与 `/funding/:id/submit` 冲突，现有顺序已正确）。

文件内私有函数改为：

```ts
function savePocCsv(csv: string, partnerKey: string): { file: string; savedAt: string }
// file = `${fund.pocCsvFilePrefix(partnerKey)}-${ts}.csv`
// latest = `${fund.pocCsvFilePrefix(partnerKey)}-latest.csv`

function listPocCsvFiles(partnerKey: string): { file: string; size: number; savedAt: string }[]
// filter 改为 f => fund.isPocCsvSnapshotOf(f, partnerKey)，其余（排序、最多 50、stat）不变
```

## 6. 前端设计

页面档位不变（独立权限页 `poccash`，admin only），不动 `MainLayout.tsx` / `auth.ts`。

### 6.1 `web/client/src/api.ts`（修改）

```ts
pocFundingPreview: (body: Record<string, unknown> & { partnerKey: string }) =>   // body 原样 POST
pocFundingCreate:  (body: Record<string, unknown> & { partnerKey: string }) =>
pocFundingSubmit:  (id: string, partnerKey: string) =>
  request(`/poc-cash/funding/${encodeURIComponent(id)}/submit${pk(partnerKey)}`, { method: 'POST' }),
pocFundingList:    (partnerKey: string) => request(`/poc-cash/funding${pk(partnerKey)}`),
pocFundingExport:  (partnerKey: string, owner?: string) =>
  request('/poc-cash/funding/export', { method: 'POST', body: JSON.stringify({ partnerKey, owner }) }),
```

`pocFundingMeta`、`pocFundingAccount` 不变。

### 6.2 `web/client/src/pages/PocCash.tsx`（修改）

1. `interface Meta['partners'][number]` 增加 `fundingEnabled?: boolean; fundingInvoiceEntity?: string | null;`。
2. **主体选择器抽成一个渲染函数** `renderPartnerPicker()`，内容即现「阶段检查」Tab 的那段
   `<Space>…<Select>…APN 账户…</Space>`，`onChange={switchPartner}`。「阶段检查」「POC 申请」
   「POC 进展」三处都调用它（阶段检查原内联代码删除，改为调用）。
3. 新增 `const switchPartner = (v: string) => { setActivePartner(v); form.setFieldValue('partnerKey', v); };`
   「创建商机」表单里的 `partnerKey` Select 保持现状（它已调 `setActivePartner`）。
4. **主体切换的清理统一放进一个 `useEffect([activePartner])`**（无论从哪个入口切换都生效）：
   ```ts
   useEffect(() => {
     activePartnerRef.current = activePartner;
     setCheckId(''); setStageInfo(null);                 // 原阶段检查 onChange 里的清理移到这里
     pocForm.setFieldsValue({ opportunityId: undefined });
     setPocPreview(null); setPocResult(null); setPocRows([]);
     if (activePartner && tab === 'progress') loadPocRows();
   }, [activePartner]);
   ```
   `activePartnerRef = useRef('')`。
5. `loadPocRows` 无参（`onClick={loadPocRows}` 保持可用），内部：
   ```ts
   const requested = activePartnerRef.current;
   if (!requested) return;
   ... const r = await api.pocFundingList(requested);
   if (activePartnerRef.current !== requested) return;   // 丢弃过期响应
   setPocRows(r.applications || []);
   ```
   注意 `request()` 对非 2xx 不抛错：`if (r?.error) { message.error(r.error); return; }`。
6. `doPocPreview`：body 加 `partnerKey: activePartner`。
7. `doPocCreate`：`api.pocFundingCreate({ ...values, partnerKey: activePartner })`；确认框首行增加
   `<div>主体 {activeP?.label}<Text type="secondary">（发票 {activeP?.fundingInvoiceEntity}）</Text></div>`。
8. `doPocSubmit`：`api.pocFundingSubmit(row.applicationId, activePartner)`。
9. `doExport`：`api.pocFundingExport(activePartner)`；同样判 `r?.error`。
10. `renderPocForm`：在现有 info Alert 之前放 `renderPartnerPicker()`；当 `activeP?.fundingEnabled === false`
    时再放 `<Alert type="warning" showIcon message={`${activeP.label} 未配置 POC 发票信息，暂不能提 POC 资金申请`} />`，
    并给 `<Form>` 加 `disabled={activeP?.fundingEnabled === false}`（AntD Form 原生 `disabled`）。
11. `renderProgressTab`：在「刷新 / 导出」按钮行之前放 `renderPartnerPicker()`。
12. 样式：只用现有 AntD 组件与 `type="secondary"`，不新增 hex 颜色、不新增 CSS 类。

## 7. AWS 链路

- 只走 Partner Central：平台身份 `user/mark` → AssumeRole 各主体 `partner-central-tool`（`config.json`
  `partnerCentral.<key>.roleArn` + ExternalId），由现有 `sellingClient(pk)` / `benefitsClient(pk)` 完成。
  不涉及 support-quota / admin-console / OAAR，不涉及 `restricted_accounts`。
- IAM：`partnercentral:GetOpportunity`、`CreateBenefitApplication`、`AssociateBenefitApplicationResource`、
  `SubmitBenefitApplication`、`GetBenefitApplication`、`ListBenefitApplications`、`ListBenefitAllocations`
  —— 两主体的 role 均已具备（`scripts/setup_partner_central_role.py` 同一策略；Mergebytes 已实测 List 通过）。
  **不改 IAM**。前缀是 `partnercentral:`。
- Benefit ID `ben-un8hh6qdrxqx50` / `ben-8j7y5dohajcl16` 两主体相同（实测），常量不变。
- 调用量级与现状相同（列表 Get 并发 6）。

## 8. 错误处理与边界

- 非法 `partnerKey` → `getPartner` 抛 → 路由 400，`{ error: '未知的 Partner: x（可选：webby / mergebytes）' }`。
- 主体无 `funding` → 创建 / 提交 400 `「<label> 未配置 POC 发票信息，不能提 POC 资金申请」`，且在任何 AWS 调用前抛出。
- 用户在 A 主体选商机后切到 B：effect 清空 `opportunityId`，不会拿 B 的凭证提交 A 的商机。
- 进展加载期间切主体：`activePartnerRef` 比对丢弃过期响应。
- Mergebytes 当前 0 条申请：进展表显示空表，CSV 只有表头（与 Webby 空表行为一致）。
- 其余失败语义（关联失败不回滚、提交失败写 warnings、台账 failed 标记）不变。
- `pocForm` 在「POC 申请」Tab 首次渲染前未挂载，effect 里 `setFieldsValue` 只会在开发模式打一条
  「not connected」警告，生产无影响；**不要**为此加 `forceRender` 或改 Tabs 配置。

### 8.1 Review Focus（测试覆盖不到、最可能出问题的场景，集成审核与线上验收时逐条手验）

1. 在「创建商机」表单里切主体（不是三个 Tab 共用的选择器）→ 切到「POC 申请」，商机下拉必须是新主体的、已选商机已清空。
2. 「POC 进展」加载中快速切主体 → 最终列表属于最后选中的主体，不出现另一主体的申请。
3. 旧前端包（缓存）不带 `partnerKey` 调 `/funding*` → 服务端按 webby 处理，行为与改动前一致。
4. 切到 Mergebytes 导出 CSV → 只有表头一行（当前 0 条），文件名 `poc-cash-mergebytes-<ts>.csv`，
   Webby 的 `poc-cash-latest.csv` 未被覆盖。
5. 创建确认框显示的发票主体与当前主体一致（Mergebytes → `MERGEBYTES AI SDN. BHD.`）。

## 9. 测试计划

新增 `web/tests/poc-cash-partner-funding.test.ts`（DB 隔离照抄 `tests/poc-calculator-flow.test.ts`：
先设 `process.env.DB_PATH` 到临时目录再 `require('../server/db')`）：

1. `getFundingProfile('webby')` 深等于改动前常量（第 5.1 节 webby 的 8 个值逐字列出）。
2. `getFundingProfile('mergebytes')` 深等于第 5.1 节 mergebytes 的值；`InvoiceRemitCountry === 'MY'`。
3. `getFundingProfile('nope')` 抛 `/未知的 Partner/`；临时 push 一个无 `funding` 的假主体进 `PARTNERS`，
   断言抛 `/未配置 POC 发票信息/`，`finally` 中移除。
4. `buildDetails` 传 mergebytes 的 invoice：`CashRequest` 含四个发票字段与 `Currency: 'MYR'`，
   `ExecutedCountry: 'MY'`，且 `JSON.stringify(details)` 不含 `WEBBY`。
5. `buildDetails` 传 webby 的 invoice：对固定输入（start `2026-11-01`、end `2026-11-04`、budgetYear 2027、
   `computeAmounts(2400, 2, 3)`、calculatorUrl `https://calculator.aws/#/estimate?id=k`、considering `Other`）
   断言完整对象深等于期望字面量（迁移回归锁）。
6. `createPocApplication({ partnerKey: <无 funding 的假主体>, ... })` rejects `/未配置 POC 发票信息/`
   （此时不会触网：校验在首行）。
7. `pocCsvFilePrefix('webby') === 'poc-cash'`，`pocCsvFilePrefix('mergebytes') === 'poc-cash-mergebytes'`；
   `isPocCsvSnapshotOf`：`poc-cash-2026-10-14T08-30-12.csv` 对 webby true、对 mergebytes false；
   `poc-cash-mergebytes-2026-10-14T08-30-12.csv` 对 mergebytes true、对 webby false；两个 latest 文件均 false。
8. 台账：
   - `reservePocCalculator({ ...input, partnerKey: 'mergebytes' }, seed => ({ target: 1020, total: 1000.05, signature: `mb-${seed}` }))`
     写入的条目 `partnerKey === 'mergebytes'`；不带 `partnerKey` 的 input 写入的条目 **没有** `partnerKey` 属性
     （`'partnerKey' in entry === false`）。
   - 跨主体查重：先用不带 `partnerKey` 的 input 预留一条 `total: 1000.01, signature: 'legacy'`；再以
     `partnerKey: 'mergebytes'` 预留，生成器为
     `seed => seed.endsWith('#0') ? { target: 1020, total: 1000.01, signature: 'mb-0' } : { target: 1020, total: 1000.02, signature: `mb-${seed}` }`
     → 断言返回 `entry.attempt === 1`、`entry.total === 1000.02`（attempt 0 被老条目判重）。

现有测试不得修改且必须通过：`tests/poc-cash*.test.ts`、`tests/poc-calculator-*.test.ts`、
`tests/calculator-calibration.test.ts`、`tests/pricing-calculator-target.test.ts`。

## 10. 影响面与风险

- README 第九节高危区：**POC 定价计算器** —— 本次只给台账加可选字段并透传 `partnerKey`，
  不碰 `calculator-rates.ts` / `calculator-services.ts` / `pricing-calculator.ts`，无需联网验收；
  `tests/calculator-calibration.test.ts` 必须保持通过。**POC Cash IAM** —— 不改策略。
  **CSV 导出** —— 列不变、数字裸值规则不变。
- 破坏性变更：无。所有新参数有默认 webby；老台账条目无需迁移；Webby CSV 文件名不变。
- 回滚：只回滚代码即可。新写入台账条目多出的 `partnerKey` 字段对旧代码无害；
  `data/poc-cash/poc-cash-mergebytes-*.csv` 留着无害。

## 11. 明确不做

- 不改 Mergebytes 的 `requiredTags`（已是 `['#ADPL']`）。
- 不把发票 / 联系人挪进 `config.json`；不新增主体。
- 不改金额公式（`computeAmounts` / `deriveAmounts` 的重复不在本次合并）。
- 不改计算器生成、单价、模板；不改 CSV 列。
- 不做 Cash Claim 创建、附件上传。
- 不重构 `PocCash.tsx` 其他部分（含既有 inline style 债务）、不改 `request()` 的非 2xx 语义。
- worker 不改 `version.ts`、`README.md`、`project-context.md`、`config.json`、`data/**`。
