# design.md — POC Cash 客户主体误填防护

> 本文是实现者的**唯一依据**。承接同目录 `requirements.md`。

---

## 1. 需求与验收

把 POC Cash「创建商机」表单里两处拿真实客户当 placeholder 的地方换成中性示例；并在用户
套用过「参考已有商机」模板后，于「客户公司全称」字段下方给出一条核对提示，提醒复核客户
法人主体。回归测试里钉死的错主体样例改为正确主体。

**纯前端改动。不动后端、不动 AWS 调用、不动权限、不动数据结构。**

### 验收标准（逐条可执行）

- [ ] `cd web && grep -c "Korea Wallpaper" client/src/pages/PocCash.tsx` 输出 `0`
- [ ] `cd web && grep -c "Korea Wallpaper (KL)" tests/poc-cash.test.ts` 输出 `0`
- [ ] `cd web && npm test` 全绿（17 个回归测试）
- [ ] `cd web && npm run typecheck` 无报错
- [ ] `cd web && npx vite build --config client/vite.config.ts` 构建成功
- [ ] 页面行为：进入 POC Cash →「创建商机」，未选「参考已有商机」时，「客户公司全称」
      输入框下方**没有**灰色提示文字
- [ ] 页面行为：在「参考已有商机」下拉里选一条商机后，「客户公司全称」下方出现
      `已从 <商机ID> 带入 —— 请核对客户法人主体，同一集团可能有多个 Sdn Bhd`
- [ ] 页面行为：点击「已套用 … 的信息」提示条上的「知道了」按钮后，上述提示消失
- [ ] 页面行为：套用模板后切换「Partner 主体」下拉 → 核对提示与「已套用 X 的信息」
      Alert 同时消失；客户公司全称 / 行业 / 客户网址 / 邮编 / 业务描述 / 关联 Solution
      被清空；国家回到 `MY`、Use Case 回到 `Migration / Database Migration`、
      Marketing 两项回到 `None` / `No`；弹出一条切换提示
- [ ] 页面行为：**未**套用过模板（`refFrom` 为 null）时切换「Partner 主体」→
      表单里用户手填的内容**原样保留**，不弹提示

---

## 2. 现状分析

### 涉及文件

| 文件 | 现状 |
|---|---|
| `web/client/src/pages/PocCash.tsx` | POC Cash 页面，1248 行，4 个 Tab（创建商机 / 商机阶段检查 / POC 申请 / POC 进展）。本次只改「创建商机」Tab 的表单部分 |
| `web/tests/poc-cash.test.ts` | POC Cash 回归测试，含 `buildTitle` 的断言 |

### 现有的可复用物（**不要新建 state**）

页面里**已经存在**完整的模板套用状态机，直接复用，不要另起炉灶：

- `refFrom` —— `useState<string | null>(null)`，存「参考已有商机」选中的来源商机 ID
  （声明在组件上部，`applyTemplate` 成功时 `setRefFrom(id)`）
- `applyTemplate(id)` —— `PocCash.tsx:186`，读模板并 `form.setFieldsValue({ companyName: t.companyName, ... })`
- `PocCash.tsx:1123-1128` —— 已有的 `<Alert>`，条件是 `{refFrom && (...)}`，
  文案「已套用 {refFrom} 的信息」，带一个「知道了」按钮执行 `setRefFrom(null)`

因此：**`refFrom` 为真 ⟺ 用户套用过模板且尚未关闭提示**。新提示直接挂在这个条件上即可，
无需新增任何 state、useEffect 或 props。

### 切换 Partner 主体时的现状（本次要修的第二个问题）

`PocCash.tsx:1138-1144` 的主体下拉：

```tsx
<Select style={{ maxWidth: 320 }}
  onChange={(v: string) => setActivePartner(v)}
  options={...} />
```

`setActivePartner` 触发 `PocCash.tsx:160-177` 的 useEffect，它只做两件事：
`setSolutions([])` + 重新拉 Solution 列表、`setOpps([])` + 重新拉商机列表。
**完全不碰表单，也不碰 `refFrom`。**

后果：切换主体后 `refFrom` 与 `applyTemplate` 写进表单的全部客户字段都残留下来。
其中 `solutionId` 残留得最糟 —— 它是旧主体目录里的 Solution ID，新主体的
`solutions` 列表里没有这一项，下拉会显示一个不在选项中的值。

对照组：`resetAll()`（`PocCash.tsx:326-332`）是页面里已有的完整清理范式，
它做 `form.resetFields()` + `setRefFrom(null)` + 把 `partnerKey` 写回去。
**本次不复用 `resetAll()`** —— 它读闭包里的 `activePartner`，在 `setActivePartner(v)`
之后立刻调用会拿到**旧值**，把 `partnerKey` 写回成切换前的主体。

### 创建商机表单的 initialValues（清理时要回到这些值，不是 `undefined`）

`PocCash.tsx:1082-1088`：

```
countryCode: 'MY'
submit: true
marketingSource: 'None'
marketingAwsFundingUsed: 'No'
customerUseCase: 'Migration / Database Migration'
```

### 当前的两处 placeholder

```
PocCash.tsx:1150   placeholder="Korea Wallpaper (KL) Sdn Bhd"
PocCash.tsx:1193   placeholder="Webby - Korea Wallpaper Application Service Migration #ADPL"
```

### 当前的测试样例

```
tests/poc-cash.test.ts:46-47
  buildTitle(webby, 'Korea Wallpaper (KL) Sdn Bhd', 'Application Service Migration')
  === 'Webby - Korea Wallpaper (KL) Application Service Migration #ADPL'
```

这条断言测的是 `buildTitle()`（`web/server/poc-cash.ts:280`）**剥掉 `Sdn Bhd` 后缀、
保留括号内容**的行为。括号部分是有效覆盖，不能删，只换括号里的字。

---

## 3. 方案总览

```
用户操作                        状态                      UI 表现
──────────────────────────────────────────────────────────────────────
进入「创建商机」            refFrom = null        companyName 字段无 extra 提示
                                                 placeholder 显示中性示例

选「参考已有商机」= O28604112
  → applyTemplate('O28604112')
      form.setFieldsValue({companyName: ...})
      setRefFrom('O28604112')  ──────────►  refFrom = 'O28604112'
                                                 ① 已有 Alert：「已套用 O28604112 的信息」
                                                 ② 新增 extra：「已从 O28604112 带入 ——
                                                    请核对客户法人主体…」

点 Alert 上的「知道了」
  → setRefFrom(null)          ──────────►  refFrom = null
                                                 ① Alert 消失（已有行为）
                                                 ② extra 提示消失（新增，同一条件）

切换「Partner 主体」下拉（refFrom 非空时）
  → setActivePartner(v)
    setRefFrom(null)
    form.setFieldsValue({客户字段清回默认})  ──►  refFrom = null
                                                 ① Alert 消失
                                                 ② extra 提示消失
                                                 ③ 客户字段清空/回默认（新增）
                                                 ④ message.info 告知已清空（新增）

切换「Partner 主体」（refFrom 为 null 时）
  → setActivePartner(v) 而已   ──────────►  表单原样不动（用户手填的不能抹）
```

数据流没有后端变化，全部是前端展示层与表单状态的增量。

---

## 4. 数据模型变更

**无变更。** 不新增 / 不修改 `data/db.json` 的任何顶层键，不动 `config.json` 的任何字段，
不涉及向后兼容问题。

---

## 5. 后端设计

**无后端改动。** 不新增路由、不改现有路由、不动守卫、不动 `web/server/**` 的任何文件。

> 注：`web/server/poc-cash.ts` 的 `buildTitle()` 逻辑**不改**，只改测试里喂给它的样例值。

---

## 6. 前端设计

文件：`web/client/src/pages/PocCash.tsx`（修改，不新建文件）

页面归属不变：`poccash` 是**独立权限页**，仅 `role === 'admin'` 可见，
不在 `PAGE_META` / `ALL_PAGE_KEYS` 里。**本次不碰任何导航或权限代码。**

`api.ts` 无改动。无新增组件。

### 改动 1 —— 客户公司全称：换 placeholder + 加核对提示

位置：`PocCash.tsx:1149-1151`

现状：

```tsx
<Form.Item name="companyName" label="客户公司全称" rules={[{ required: true }]}>
  <Input style={{ width: 360 }} placeholder="Korea Wallpaper (KL) Sdn Bhd" />
</Form.Item>
```

改为：

```tsx
<Form.Item name="companyName" label="客户公司全称" rules={[{ required: true }]}
  // 套用模板会把来源商机的客户名直接写进来；来源本身填错过（真实事故），
  // 而商机一旦提交给 AWS，客户名就锁死改不回来，所以在这里提醒复核。
  extra={refFrom
    ? `已从 ${refFrom} 带入 —— 请核对客户法人主体，同一集团可能有多个 Sdn Bhd`
    : undefined}>
  <Input style={{ width: 360 }} placeholder="ABC Technologies Sdn Bhd" />
</Form.Item>
```

要点：
- `extra` 用 AntD `Form.Item` 自带的 prop，**渲染成默认的次要灰色文字，不要自己写颜色**。
  这样自动符合 `coding-standards.md`「颜色只用 `var(--color-*)` 令牌」的约束。
- 未套用模板时传 `undefined`（不是空字符串），避免 AntD 渲染出一个空的 `.ant-form-item-extra`
  占位撑高行。
- 该 `Form.Item` 位于 `<Space align="start" wrap size="large">` 内（`PocCash.tsx:1148`）。
  `align="start"` 已保证多出一行 extra 时同排其它字段仍顶部对齐，**无需改 Space 的属性**。
- 文案末尾**不加感叹号**（`coding-standards.md` 的文案规范）。
- **不要**用 emoji 或 AntD 图标，就是纯文字。

### 改动 2 —— 商机名称 placeholder 去掉真实客户

位置：`PocCash.tsx:1193`

```
placeholder="Webby - Korea Wallpaper Application Service Migration #ADPL"
```
改为：
```
placeholder="Webby - ABC Technologies Application Service Migration #ADPL"
```

只换客户名部分，**保留 `Webby - ` 前缀、`#ADPL` 后缀和整体两段式格式** —— 这个
placeholder 的作用是示范标题格式惯例，格式不能动。

### 改动 3 —— 切换 Partner 主体时清掉模板残留

位置：`PocCash.tsx:1138-1144`

现状：

```tsx
<Select style={{ maxWidth: 320 }}
  onChange={(v: string) => setActivePartner(v)}
  options={(meta?.partners || []).map(p => ({
    value: p.key,
    label: p.configured === false ? `${p.label}（未配置 role）` : p.label,
    disabled: p.configured === false,
  }))} />
```

改为（`options` 原样不动，只改 `onChange`）：

```tsx
<Select style={{ maxWidth: 320 }}
  onChange={(v: string) => {
    setActivePartner(v);
    // 切主体等于换一个 APN 目录：之前套用的商机不在新主体名下，带入的客户信息
    // 与 solutionId 都失效（solutionId 尤其坏 —— 新主体的下拉里没有这一项）。
    // 只在确实套用过模板时清理，否则会抹掉用户自己手填的内容。
    if (refFrom) {
      setRefFrom(null);
      form.setFieldsValue({
        companyName: undefined,
        industry: undefined,
        websiteUrl: undefined,
        postalCode: undefined,
        customerBusinessProblem: undefined,
        solutionId: undefined,
        // 以下回到表单 initialValues，不是 undefined
        countryCode: 'MY',
        customerUseCase: 'Migration / Database Migration',
        marketingSource: 'None',
        marketingAwsFundingUsed: 'No',
      });
      message.info('已切换 Partner 主体，之前套用的商机信息已清空');
    }
  }}
  options={(meta?.partners || []).map(p => ({
    value: p.key,
    label: p.configured === false ? `${p.label}（未配置 role）` : p.label,
    disabled: p.configured === false,
  }))} />
```

要点：
- **`if (refFrom)` 这个条件是必须的**，不能无条件清。用户没套用过模板时，表单里
  全是他自己敲的，切换主体把它抹掉是数据丢失。
- 清理列表就是 `applyTemplate()`（`PocCash.tsx:189-202`）写过的那 10 个字段，一一对应，
  不多不少。`projectName` 不在其中（`applyTemplate` 本来就刻意不填它）。
- 有 initialValues 的 4 个字段回默认值，其余回 `undefined`。
- **不要调用 `resetAll()`** —— 它读闭包里的 `activePartner`（切换前的旧值），会把
  `partnerKey` 写回成旧主体，产生比现在更糟的不一致。
- `message` 已在文件顶部从 antd import，无需新增 import。
- 文案不加感叹号。

### 改动 4 —— 测试样例改为正确主体

文件：`web/tests/poc-cash.test.ts:46-47`

```ts
buildTitle(webby, 'Korea Wallpaper (KL) Sdn Bhd', 'Application Service Migration'),
'Webby - Korea Wallpaper (KL) Application Service Migration #ADPL');
```
改为：
```ts
buildTitle(webby, 'Korea Wallpaper (HQ) Sdn Bhd', 'Application Service Migration'),
'Webby - Korea Wallpaper (HQ) Application Service Migration #ADPL');
```

**只把 `(KL)` 换成 `(HQ)`，其余一个字符都不动。** 这条断言覆盖的是「`Sdn Bhd` 后缀被剥掉、
括号内容被保留」，换成 `(HQ)` 覆盖范围完全相同，只是不再把错主体固化在测试里。
同文件第二条断言（`FF CLOUD PG NETWORK TECHNOLOGY SDN. BHD.`）**不要动**。

---

## 7. AWS 链路

**不涉及。** 本次改动不产生任何 AWS API 调用，不碰 `assumeToAccount()`，不碰
`partner-central-tool` role，不需要任何 IAM action 变更。

---

## 8. 错误处理与边界

- **无外部调用**，因此没有重试、超时、降级需要设计。
- `refFrom` 为 `null` / `undefined` / 空字符串时，`extra` 一律传 `undefined`，不渲染提示。
  用上面给出的三元表达式即可覆盖（空字符串是 falsy）。
- 用户套用模板后手动改写了客户公司名：提示**仍然显示**。这是有意的 —— 它是核对提醒，
  不是「你填错了」的错误态，常驻更安全。**不要**加「用户编辑后自动隐藏」的逻辑。
- 连续套用多条商机：`applyTemplate` 每次都 `setRefFrom(id)` 覆盖，提示里的 ID 随之更新。
  已有行为，无需额外处理。
- `applyTemplate` 抛错时（`catch` 分支只 `message.error`），`setRefFrom(id)` 不会执行，
  `refFrom` 保持旧值，与表单里实际残留的旧数据一致。已有行为，不改。
- **切换 Partner 主体**（改动 3）：只在 `refFrom` 非空时清理。`refFrom` 为空 ⟹ 用户
  没套用过模板 ⟹ 表单内容全是他自己填的 ⟹ **一个字段都不能动**。这条搞反就是数据丢失。
- 切换主体时若 `applyTemplate` 正在飞行中：L162 的 `stale` 标志只保护 `solutions` /
  `opps` 两个列表，不保护 `applyTemplate` 的 `form.setFieldsValue`。极端情况下
  「点模板 → 立刻切主体」可能让模板数据在清理之后才落到表单上。
  **本次不处理** —— 需要给 `applyTemplate` 加取消令牌，属独立改动；且该竞态在改动 3
  之前就存在（旧数据本来就会留在表单里），本次没有让它变严重。
- 不做表单校验、不阻断提交、不弹确认框。

---

## 9. 测试计划

**不新增测试文件。**

理由：本次改动是 placeholder 字符串与一处条件渲染的展示层增量，项目现有测试是
node:test 的纯逻辑回归测试，`web/` 下**没有** React 组件测试的运行环境
（无 jsdom / testing-library / vitest 配置）。为一条 `extra` 文案引入整套组件测试
基础设施，成本远大于收益。条件渲染由验收标准里的手动页面核对覆盖。

**worker 自测命令（三条全绿才算完成）：**

```
cd web
npm install            # 新建 worktree 里 node_modules 为空时必须先装，否则 build 会报
                       # Rollup failed to resolve import "recharts"（属环境缺依赖，不是你的改动）
npm test               # 17 个回归测试全绿
npm run typecheck      # tsc --noEmit，客户端 + 服务端
npx vite build --config client/vite.config.ts
```

`tests/poc-cash.test.ts` 直接相关（改动 4 修改了它），必须绿。其余 16 个回归测试
不得被破坏。

> ⚠️ 后端是 tsx 直跑不编译，类型错误不会在运行时暴露；前端改动**必须**靠 `typecheck`
> 和 `vite build` 验证，不能只跑 `npm test` 就报完成。

> 注：仓库根的 `npm run build` 还会跑 `tsc -p server/tsconfig.json` 与
> `copy-runtime-assets.cjs`，本次纯前端改动用上面的 `vite build` 单步即可。

---

## 10. 影响面与风险

### README 第九节高危区

逐条核对，**本次改动一条都不触及**：

| 高危区 | 是否触及 | 说明 |
|---|---|---|
| `bedrock-delivery.ts` 名匹配 | 否 | 不碰 Bedrock |
| Bedrock TPD `inherited` 标记 | 否 | 同上 |
| `billing-exporter.ts` | 否 | 不碰账单导出 |
| `case-doc-submitter.ts` | 否 | 不碰提额文档 |
| `index.ts` 的 CORS | 否 | 不碰后端 |
| CSV 导出数字千分位 | 否 | 不碰任何 CSV 生成 |
| `restricted-accounts.ts` | 否 | 不碰 |
| POC Cash IAM 策略前缀 | 否 | 不改任何 IAM 策略 |
| 批量 Root 改密 | 否 | 不碰 |

### 破坏性变更

无。没有接口变更、没有数据结构变更、没有权限变更，老用户与老数据零影响。

### 回滚

只需回滚代码（`git revert` + 重新 `vite build` + `pm2 restart`），**无需处理任何数据**。

### 其它风险

- `extra` 会让「客户公司全称」这一项比同排的「行业」「客户网址」高出约一行。外层
  `<Space align="start">` 已做顶部对齐，视觉上可接受。实现后请在构建产物里目视确认。
- **改动 3 是本次唯一会清除用户输入的改动，也是唯一有数据丢失风险的地方。**
  风险全部集中在 `if (refFrom)` 这一个条件上：漏写或写反，切换主体就会抹掉用户手填的
  客户信息且无法撤销（表单没有 undo）。审核时**必须**逐字核对这个条件，并按 §1 的
  两条「切换 Partner 主体」验收标准实际点一遍页面，正反两种情形都要试。

---

## 11. 明确不做什么

以下都在讨论中评估并否决 / 推迟，**实现者不得顺手做**：

1. **不改 `applyTemplate()` 本身**（`PocCash.tsx:186-211`）。带出客户信息是刻意设计，
   函数上方的注释已说明取舍。改动 3 改的是**主体下拉的 `onChange`**，不是这个函数；
   只读它写下的 `refFrom`，不动它的逻辑、不删它带入的任何字段。
2. **不加客户名黑名单 / 关键词硬校验**。把具体客户写进代码后续要维护，已否决。
3. **不加强制校验、不阻断提交、不弹二次确认框。** 提示是软提醒。
4. **不改 `web/client/src/version.ts`。** 版本号由协调者在 P5 统一递增，worker 改会冲突。
5. **不改 `README.md` 和 `.kiro/steering/project-context.md`。** 同上，协调者负责。
6. **不动 `web/server/**` 任何文件**，包括 `poc-cash.ts` 的 `buildTitle()` 本体。
7. **不重构 `PocCash.tsx` 的其它部分。** 这个文件 1248 行、有 inline style 技术债，
   看着难受也不要顺手整理 —— 那是独立议题，不在本次范围。
8. **不修复历史数据。** 4 条商机与 1 条资金申请已被 AWS 锁死（详见 `requirements.md`
   的背景段），需走 AWS 侧人工处理，与本次代码改动无关。
9. **不改动 `tests/poc-cash.test.ts` 里除第 46-47 行以外的任何内容。**
10. **不给 `applyTemplate` 加取消令牌 / 竞态保护**（见 §8 末条）。属独立改动。
11. **不调用 `resetAll()` 实现改动 3** —— 它有闭包旧值的坑，§6 改动 3 已说明。
