# POC Cash 创建商机：Solution 默认值改为实时数据 — 实现方案

## 1. 需求与验收

把 POC Cash「创建商机」的 Solution 默认值从硬编码 `defaultSolutionId` 改为基于实时 `ListSolutions`
计算：恰好 1 个 Active 时预选，Webby 的优先项 `S-0070517` 在列表里时预选它，多个时必须手选；
主体有 Active Solution 时字段必选，列表为空或查询失败时允许留空（商机照建 + warning）。
后端在 `CreateOpportunity` 之前用同一份实时数据校验，校验不过直接 400，不建出商机。

验收（全部可执行）：

- [ ] `cd web && npm test -- tests/poc-cash-solution-default.test.ts`（新增）通过
- [ ] `cd web && npm test && npm run typecheck && npm run build` 全绿
- [ ] 页面 `/poccash` 选 Mergebytes：「关联 Solution」自动选中 `S-0100389`，主体提示显示「1 个 Active Solution」
- [ ] 选 Webby：自动选中 `S-0070517`
- [ ] 任一主体清空「关联 Solution」后点「创建」：表单报「请选择要关联的 Solution」，不弹确认框
- [ ] 确认框里出现「Solution：S-xxxx — 名称」一行

## 2. 现状分析

- `web/server/poc-cash.ts`
  - `PartnerProfile.defaultSolutionId: string`（L54-57），Webby `'S-0070517'`（L94），Mergebytes `''`（L129）。
  - `listSolutions(partnerKey)`（L607-622）：分页拉 `ListSolutionsCommand`，过滤 `Status === 'Active'`，
    返回 `{ id, name, category, status }[]`，返回类型目前是推断出的 `any` 映射结果。
  - `createOpportunity`（L995 起）：L1027 `const solutionId = input.solutionId || partner.defaultSolutionId;`，
    随后 `client()` → `CreateOpportunityCommand` → L1085 起：`solutionId` 为空就 push warning 跳过，
    否则 `AssociateOpportunityCommand`，失败 push warning（不回滚商机）。
- `web/server/routes/poc-cash.ts`
  - `GET /meta`（L73-95）把 `defaultSolutionId` 透传给前端（L81）。
  - `GET /solutions`（L97-104）：`{ solutions: await poc.listSolutions(partnerKeyOf(req)) }`，失败 400 `{ error }`。
  - `POST /opportunities`（~L440-470）：`solutionId: b.solutionId ? String(b.solutionId) : undefined`，
    catch 分支已负责失败审计与 400 响应（本方案不改该路由）。
  - 整个 router 已 `use(requireStrictAdmin)`，守卫不变。
- `web/client/src/pages/PocCash.tsx`
  - `Partner` 接口含 `defaultSolutionId`（L26）；`solutions` state（L153）。
  - 主体切换 effect（L213-230）：`setSolutions([])` → `api.pocCashSolutions(activePartner)`，失败静默。
  - `applyTemplate`（L238-262）：`solutionId: t.solutionIds?.[0]`。
  - `resetAll`（L403-409）：`form.resetFields()` 后写回 `partnerKey`。
  - `doSubmit` 的 `Modal.confirm`（L331-）展示标题/客户/MRR。
  - 主体字段 `extra`（L1331-1337）与 Solution 下拉（L1431-1436）是本次要改的两处文案。
- 测试：`tests/poc-cash.test.ts` L77-86 断言 `defaultSolutionId`；`tests/poc-cash-partner-funding.test.ts` L64 夹具含 `defaultSolutionId: ''`。
- `client/src/api.ts` L524 `pocCashSolutions(partnerKey?)` 已存在，**签名不变**。

## 3. 方案总览

```
页面切主体 ──GET /solutions?partnerKey=x──▶ getSolutionChoice(x)
                                              ├─ listSolutions(x)            (实时，Active only)
                                              └─ resolveSolutionDefault(ids, partner.preferredSolutionId)
          ◀── { solutions, defaultSolutionId } ──┘
页面：预选 defaultSolutionId；solutions 非空时字段必选；文案按 solutions 数量/加载状态生成

点创建 ──POST /opportunities { solutionId? }──▶ createOpportunity
                                              ├─ listSolutions(partnerKey)  (try/catch → live)
                                              ├─ decideSolutionForCreate(partner, solutionId, live)
                                              │     不合法 → throw（路由 catch → 400，未建商机）
                                              └─ CreateOpportunity → Associate（逻辑不变）
```

默认值规则只在后端 `resolveSolutionDefault` 一处实现，前端不复制规则。

## 4. 数据模型变更

无变更。不涉及 `data/db.json`、`config.json`。仅代码内 `PartnerProfile` 字段改名（见 5.1）。

## 5. 后端设计

### 5.1 `web/server/poc-cash.ts`（修改）

**(a) `PartnerProfile`**：删除 `defaultSolutionId: string`，新增：

```ts
  /**
   * 优先关联的 Solution。**只是偏好**：仅当它在该主体实时 Active 列表里时才作为默认值；
   * 不在列表里就当没配置。缺省 = 无偏好（恰好 1 个 Active 时自动用它，多个时必须手选）。
   */
  preferredSolutionId?: string;
```

Webby：`preferredSolutionId: 'S-0070517', // Migration services`；Mergebytes：**删除**该行（不写 preferredSolutionId）。

**(b) 类型与 `listSolutions` 返回类型**（放在 `listSolutions` 上方）：

```ts
export interface SolutionSummary { id: string; name: string; category: string; status: string }

/** 创建表单的 Solution 选择信息：列表 + 后端算好的默认值 + 是否必选 */
export interface SolutionChoice {
  solutions: SolutionSummary[];
  /** null = 没有可自动选的（0 个 Active，或多个且无可用优先项） */
  defaultSolutionId: string | null;
}

/** createOpportunity 拿到的实时列表；查询失败也要能表达 */
export type LiveSolutions =
  | { ok: true; activeIds: string[] }
  | { ok: false; error: string };
```

`listSolutions` 签名改为 `export async function listSolutions(partnerKey: string = DEFAULT_PARTNER_KEY): Promise<SolutionSummary[]>`，实现不变。

**(c) 纯函数：默认值规则**

```ts
export function resolveSolutionDefault(activeIds: string[], preferredId?: string): string | null
```

按顺序：
1. `activeIds.length === 0` → `null`
2. `preferredId && activeIds.includes(preferredId)` → `preferredId`
3. `activeIds.length === 1` → `activeIds[0]`
4. 其它 → `null`

**(d) 异步：给 GET /solutions 用**

```ts
export async function getSolutionChoice(partnerKey: string = DEFAULT_PARTNER_KEY): Promise<SolutionChoice>
```

`getPartner(partnerKey)`（未知主体照常抛错）→ `listSolutions(partnerKey)`（失败直接抛，路由返回 400）→
`{ solutions, defaultSolutionId: resolveSolutionDefault(solutions.map(s => s.id), partner.preferredSolutionId) }`。是否必选由前端按 `solutions.length > 0` 判断，不另设字段。

**(e) 纯函数：创建前的决定**

```ts
export function decideSolutionForCreate(
  partner: PartnerProfile,
  requested: string | undefined,
  live: LiveSolutions,
): { solutionId?: string; warnings: string[] }
```

`requested` 先 `trim()`，空串视为未传。规则（throw 的都用 `new Error(<文案>)`，文案逐字如下）：

| live | requested | 结果 |
|---|---|---|
| ok，列表含 requested | 有 | `{ solutionId: requested, warnings: [] }` |
| ok，列表不含 requested（含列表为空） | 有 | throw `Solution ${requested} 不是 ${partner.label} 的 Active Solution，请刷新页面后重新选择` |
| ok，`resolveSolutionDefault` 非 null | 无 | `{ solutionId: <默认值>, warnings: [] }` |
| ok，列表为空 | 无 | `{ warnings: [\`${partner.label} 没有 Active 的 Solution，已跳过关联。在 Partner Central 发布 Solution 后会自动关联。\`] }` |
| ok，多个且无默认 | 无 | throw `${partner.label} 有 ${n} 个 Active Solution，请选择要关联的 Solution` |
| 失败 | 有 | `{ solutionId: requested, warnings: [] }`（关联失败由既有逻辑记 warning） |
| 失败，有 `preferredSolutionId` | 无 | `{ solutionId: preferredSolutionId, warnings: [\`查询 Solution 列表失败（${live.error}），按优先项 ${preferredSolutionId} 关联。\`] }` |
| 失败，无 `preferredSolutionId` | 无 | `{ warnings: [\`查询 Solution 列表失败（${live.error}），已跳过关联。\`] }` |

**(f) `createOpportunity` 改动**：把 L1027 那一行替换为下面这段，位置不变（在 `client()` 和 `CreateOpportunityCommand` **之前**，保证校验失败时不建商机）：

```ts
  // Solution 以实时 Active 列表为准：不合法直接抛错（此时还没建商机）
  let live: LiveSolutions;
  try {
    live = { ok: true, activeIds: (await listSolutions(input.partnerKey)).map(s => s.id) };
  } catch (e: any) {
    live = { ok: false, error: e?.message || String(e) };
  }
  const decision = decideSolutionForCreate(partner, input.solutionId, live);
  warnings.push(...decision.warnings);
  const solutionId = decision.solutionId;
```

L1082-1089 的「`!solutionId` → push warning 跳过」分支：**删除其中的 `warnings.push(...)`**（跳过原因已由
`decideSolutionForCreate` 写入 warnings，避免重复），保留「为空就不调用 Associate」的判断；同时把上方的注释改成
「没有可关联的 Solution 时不调用 Associate —— 传空 RelatedEntityIdentifier 会被 AWS 拒」。

### 5.2 `web/server/routes/poc-cash.ts`（修改）

| 方法 | 路径 | 守卫 | 请求 | 响应 |
|---|---|---|---|---|
| GET | `/api/poc-cash/solutions?partnerKey=` | router 级 `requireStrictAdmin`（不变） | — | 成功 `SolutionChoice` = `{ solutions, defaultSolutionId }`；失败 400 `{ error }` |

- `/solutions` 处理函数体改为 `res.json(await poc.getSolutionChoice(partnerKeyOf(req)));`，catch 不变。注释改为「可关联的 Solutions（仅 Active）+ 后端算好的默认值」。
- `/meta`：删除 `defaultSolutionId: p.defaultSolutionId,` 这一行，**不**新增 preferredSolutionId（前端不需要）。
- `POST /opportunities` 不改。

## 6. 前端设计

文件：`web/client/src/pages/PocCash.tsx`（修改）。不新增组件，`api.ts` 不改。页面档位不变（独立权限页 `poccash`，仅 admin）。

1. `Partner` 接口（L26）删除 `defaultSolutionId`。
2. 新增 state（放在 `solutions` state 旁）：
   ```ts
   const [solutionsState, setSolutionsState] = useState<'loading' | 'ok' | 'error'>('loading');
   const [solutionDefault, setSolutionDefault] = useState<string | null>(null);
   ```
3. 主体切换 effect 中 Solutions 部分改为：
   ```ts
   setSolutions([]); setSolutionDefault(null); setSolutionsState('loading');
   api.pocCashSolutions(activePartner)
     .then((r: any) => {
       if (stale) return;
       // request() 对非 2xx 不抛错，{ error } 会被 resolve 回来
       if (r?.error || !Array.isArray(r?.solutions)) { setSolutionsState('error'); return; }
       const list: Solution[] = r.solutions;
       const def: string | null = r.defaultSolutionId ?? null;
       setSolutions(list); setSolutionDefault(def); setSolutionsState('ok');
       // 已选的（例如套用模板带来的）仍在列表里就保留，否则换成默认值
       const cur = form.getFieldValue('solutionId');
       if (!cur || !list.some(s => s.id === cur)) form.setFieldValue('solutionId', def ?? undefined);
     })
     .catch(() => { if (!stale) setSolutionsState('error'); });
   ```
   另外在该 effect 开头的 `if (!meta?.configured || !activePartner) return;` **之前**加一行
   `if (meta && !meta.configured) setSolutionsState('error');` —— 凭证未配置时不会发请求，否则会一直停在「加载中」。
   （P3 实现时补充）
4. `applyTemplate`：`solutionId` 改为
   ```ts
   solutionId: solutionsState === 'ok'
     ? (t.solutionIds?.find((id: string) => solutions.some(s => s.id === id)) ?? solutionDefault ?? undefined)
     : t.solutionIds?.[0],
   ```
5. `resetAll`：在写回 `partnerKey` 之后加 `form.setFieldValue('solutionId', solutionDefault ?? undefined);`
6. 主体字段 `extra`（L1331-1337）改为：
   ```ts
   extra={activeP
     ? `APN 账户 ${activeP.apnAccountId}｜` + (
         solutionsState === 'loading' ? '正在查询 Solution…'
         : solutionsState === 'error' ? '查询 Solution 失败，留空将跳过关联'
         : solutions.length ? `${solutions.length} 个 Active Solution`
         : '暂无 Active Solution，创建时跳过关联')
     : '切换主体会同时切换 Solution 与商机列表（各主体数据互相隔离）'}
   ```
7. Solution 下拉（L1431-1436）改为：
   ```tsx
   <Form.Item name="solutionId" label="关联 Solution"
     rules={[{ required: solutionsState === 'ok' && solutions.length > 0, message: '请选择要关联的 Solution' }]}
     extra={solutionsState === 'ok' && solutions.length > 1 && !solutionDefault
       ? '该主体有多个 Active Solution，请选择' : undefined}>
     <Select style={{ width: 400 }} allowClear showSearch optionFilterProp="label"
       loading={solutionsState === 'loading'}
       disabled={solutionsState === 'ok' && solutions.length === 0}
       placeholder={solutionsState === 'loading' ? '加载中…'
         : solutionsState === 'error' ? '查询失败，留空将跳过关联'
         : solutions.length ? '请选择 Solution'
         : '该主体暂无 Active Solution，将跳过关联'}
       options={solutions.map(s => ({ value: s.id, label: `${s.id} — ${s.name}` }))} />
   </Form.Item>
   ```
8. 确认框（`doSubmit` 的 `Modal.confirm` content）在「客户：」那行之后加：
   ```tsx
   <div>Solution：{values.solutionId
     ? `${values.solutionId}${(() => { const s = solutions.find(x => x.id === values.solutionId); return s ? ` — ${s.name}` : ''; })()}`
     : '不关联'}</div>
   ```
   （`values` 是 `doSubmit = async (values: any)` 的参数，即提交时的表单值。）

样式：只用既有 AntD 组件与已有 class，不加颜色、不加 inline 样式。

## 7. AWS 链路

不变。仍走 `partner-central-tool` role（每主体一套，`assumeCredentials`），只多一次 `partnercentral:ListSolutions`
（创建时一次，已在 role 的只读权限内）。不涉及成员账户链路、不涉及 `restricted_accounts`。量级：每次创建 +1 次分页调用。

## 8. 错误处理与边界

- `ListSolutions` 失败：GET /solutions → 400，前端进入 `error` 态，字段不必选；创建时按 5.1(e) 表回落。
- 并发切主体：沿用 effect 里的 `stale` 标记丢弃过期响应（第 3 步已包含）。
- 0 / 1 / 多个 Active 的行为见 5.1(c)(e) 表。
- 前端预选与后端校验之间 Solution 被下线：后端 throw「不是 Active Solution，请刷新页面后重新选择」，商机未建。

## 9. 测试计划

- **新增** `web/tests/poc-cash-solution-default.test.ts`（node:test + assert/strict，仿照 `tests/poc-cash.test.ts` 的 import 风格）：
  - `resolveSolutionDefault`：空 → null；优先项在列表 → 优先项（列表 5 个时）；优先项不在列表且仅 1 个 → 那 1 个；多个无优先 → null；优先项不在列表且多个 → null。
  - `decideSolutionForCreate`：逐行覆盖 5.1(e) 表的 8 种情况，throw 的用 `assert.throws(..., /正则/)` 校验文案关键字，warnings 校验内容。夹具用 `getPartner('webby')` / `getPartner('mergebytes')`。
- **修改** `web/tests/poc-cash.test.ts` L77-86：断言 `webby.preferredSolutionId === 'S-0070517'`、`mb.preferredSolutionId === undefined`，注释改为说明「默认值来自实时列表，这里只有偏好」。
- **修改** `web/tests/poc-cash-partner-funding.test.ts` L64：删除夹具里的 `defaultSolutionId: '',`。
- 全量：`cd web && npm test && npm run typecheck && npm run build`。

## 10. 影响面与风险

- README 第九节高危区：「POC 资金发票主体」——本方案不碰 `funding` 字段与 `poc-cash-funding.ts`，`tests/poc-cash-partner-funding.test.ts` 只删夹具里的一个字段，必须仍全绿。其余高危区不涉及。
- 行为变化：有 Active Solution 时不再允许无 Solution 建商机；Webby 默认值不变（仍 `S-0070517`）。
- 回滚：纯代码回滚即可，无数据处理。

## 11. 明确不做

- 不在平台创建/发布 Solution，不改 IAM、`config.json`、`db.json`。
- 不展示非 Active Solution，不给已建商机补关联。
- 不改「商机阶段检查」Tab、POC 申请 Tab、`poc-cash-funding.ts`。
- 不重构 PocCash.tsx 其它部分（inline 样式债等），不改 `api.ts`。
- `version.ts`、`README.md`、`project-context.md` 由协调者在 P5 统一改，实现任务不碰。
