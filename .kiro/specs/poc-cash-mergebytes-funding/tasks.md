# 任务拆分 —— poc-cash-mergebytes-funding

> 前置：`design.md` 已通过闸门 G1（2026-10-14）。所有任务的唯一依据是同目录 `design.md`。
>
> **实际执行（2026-10-14）**：orca runtime 未运行（`orca status` → `not_running`），按约定由 Claude 直接实现，
> 串行 T1（`728a388`）→ T2（`9884e5d`），分支 `feature/poc-cash-mergebytes-funding`。实现与 design.md 一致，无偏离。

| # | 任务名 | 独占文件 | 依赖 | design.md 章节 | 验收命令 |
|---|--------|----------|------|----------------|----------|
| T1 | 后端：主体资金资料 + funding 分流 + 台账 + 路由 | `web/server/poc-cash.ts`<br>`web/server/poc-cash-funding.ts`<br>`web/server/poc-calculator.ts`<br>`web/server/db.ts`<br>`web/server/routes/poc-cash.ts`<br>`web/tests/poc-cash-partner-funding.test.ts`（新） | — | §2 §4 §5.1 §5.2 §5.3 §5.4 §5.5 §7 §8 §9 §10 §11 | 见下「T1 验收」 |
| T2 | 前端：主体选择器 + funding 调用带主体 | `web/client/src/api.ts`<br>`web/client/src/pages/PocCash.tsx` | — | §2 §6.1 §6.2 §8 §8.1 §11 | 见下「T2 验收」 |

### 为什么后端不再细拆

`CalculatorContext.partnerKey`（poc-calculator.ts）→ `PocCalculatorReserveInput.partnerKey`（db.ts）→
`createPocApplication`（poc-cash-funding.ts）→ `getFundingProfile`（poc-cash.ts）→ 路由（routes/poc-cash.ts）
是一条签名链，拆开会在中间状态互相类型报错；总改动量约 150 行，单任务即可。`db.ts` 是枢纽文件，本波次只有 T1 持有。

### T1 验收

```bash
cd web
node --import tsx --test tests/poc-cash-partner-funding.test.ts
npm test
npx tsc --noEmit -p server/tsconfig.json
```

三条全过。现有 `tests/poc-cash*.test.ts`、`tests/poc-calculator-*.test.ts`、`tests/calculator-calibration.test.ts`、
`tests/pricing-calculator-target.test.ts` **不得修改**。

### T2 验收

```bash
cd web
npx tsc --noEmit -p client/tsconfig.json
npx vite build --config client/vite.config.ts
```

T2 只依赖 design.md §5.5 定义的接口契约（`/meta` 新字段、`partnerKey` 走 query/body），不需要 T1 先合入即可编译。
§8.1 的 5 条手验由协调者在 P4 集成后执行。

## 波次

- **波次 1（并行 2 个 worker）**：T1、T2
- 协调者串行合入 `integration/poc-cash-mergebytes-funding`（顺序 T1 → T2），集成分支全量
  `cd web && npm test && npm run typecheck && npm run build`，再本地起服务按 §8.1 手验

依赖链深度 0。

## 拆分检查清单

- [x] `design.md` 已通过闸门 G1
- [x] 每个任务都能指到 `design.md` 的具体章节
- [x] `design.md` 每一节都被覆盖：§1 验收由 P4 协调者执行；§2–§5、§7–§11 → T1；§6、§8.1 → T2
- [x] 两个任务的独占文件无交集
- [x] 枢纽文件：`db.ts` 仅 T1；`api.ts` 仅 T2
- [x] 协调者独占文件（`version.ts`、`README.md`、`.kiro/steering/**`、`config*.json`、`data/**`）未出现在任何任务中
- [x] 每个任务有可执行的验收命令
- [x] 依赖链深度 0（≤ 3）
- [x] 每个任务能独立通过各自验收命令
- [x] 不涉及 root-email 模块
- [x] 高危区点名：T1 简报写明「POC 定价计算器：只透传 partnerKey，不碰 calculator-rates / calculator-services / pricing-calculator，calculator-calibration 测试必须通过」「POC Cash IAM 不改」「CSV 列与裸数字规则不变」
