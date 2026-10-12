# 任务拆分 —— poc-calculator-uniqueness

> 前置：`design.md` 已通过闸门 G1（2026-10-12）。所有任务的唯一依据是同目录 `design.md`，
> 数值与模板以 `templates/`、`reference/` 为准。

| # | 任务名 | 独占文件 | 依赖 | design.md 章节 | 验收命令 |
|---|--------|----------|------|----------------|----------|
| T1 | 计算器生成引擎 | `web/server/calculator-rates.ts`（新）<br>`web/server/calculator-services.ts`（新）<br>`web/server/pricing-calculator.ts`<br>`web/tests/calculator-calibration.test.ts`（新）<br>`web/tests/pricing-calculator-target.test.ts` | — | §2.1 §2.2 §5.1 §5.2 §5.3 §9.1 §9.2 §9.5 第 1 行 | 见下「T1 验收」 |
| T2 | 计算器台账（DB） | `web/server/db.ts`<br>`web/tests/poc-calculator-ledger.test.ts`（新） | — | §2.4 §4 §5.4 §9.3 §9.5 第 2 行 | `cd web && node --import tsx --test tests/poc-calculator-ledger.test.ts && npm test && npm run typecheck` |
| T4 | 结果页展示计算器组成 | `web/client/src/pages/PocCash.tsx`<br>`web/client/src/styles/global.css` | — | §6 | `cd web && npm run typecheck && npx vite build --config client/vite.config.ts` |
| T3 | 接线：创建流程走台账 | `web/server/poc-calculator.ts`（新）<br>`web/server/poc-cash-funding.ts`<br>`web/server/routes/poc-cash.ts`<br>`web/tests/poc-calculator-flow.test.ts`（新） | T1, T2 | §2.3 §3 §5.5 §5.6 §5.7 §8 §9.5 第 3 行 | `cd web && npm test && npm run typecheck && npm run build` |
| T5 | 引擎重算验收脚本 | `web/scripts/verify-calculator-render.ts`（新） | T1 | §7 §9.4 | `cd web && npx tsx scripts/verify-calculator-render.ts --plan-only --mrr 7800 --count 3`（3 份 total 与 signature 两两不同）；联网全量运行由协调者在 P4 执行 |

### T1 验收

```bash
cd web
node --import tsx --test tests/calculator-calibration.test.ts tests/pricing-calculator-target.test.ts
npm test
npx tsc --noEmit -p server/tsconfig.json 2>&1 | grep -E 'error TS' | grep -v '^server/routes/poc-cash.ts' ; test $? -eq 1
npx tsc --noEmit -p client/tsconfig.json
```

⚠️ **已知且预期的过渡错误**：T1 按 §5.3 替换了 `buildPocEstimate` 的签名，`server/routes/poc-cash.ts` 的
`makeCalculator`（:42-54）会报类型错误。**T1 不得修改 `routes/poc-cash.ts`**（该文件归 T3），
上面第三条命令确认「除 routes/poc-cash.ts 外没有任何类型错误」。T3 合入后集成分支全绿。

## 波次

- **波次 1（并行 3 个 worker）**：T1、T2、T4
- 协调者把波次 1 串行合入 `integration/poc-calculator-uniqueness`（顺序 T2 → T1 → T4）
- **波次 2（并行 2 个 worker，基于合入波次 1 后的集成分支）**：T3、T5
- 协调者合入 T3 → T5，集成分支全量 `npm test && npm run typecheck && npm run build`，
  并联网执行 `npx tsx scripts/verify-calculator-render.ts`（全量，需本机 Chrome）

依赖链深度 1（T1/T2 → T3、T1 → T5）。

## 拆分检查清单

- [x] `design.md` 已通过闸门 G1
- [x] 每个任务都能指到 `design.md` 的具体章节（见表）
- [x] `design.md` 每一节都被覆盖：§1 验收由各任务验收命令 + 协调者 P4 合成；§2 现状分给读者对应任务；
      §3 → T3；§4 → T2；§5.1–5.3 → T1；§5.4 → T2；§5.5–5.7 → T3；§6 → T4；§7 → T3/T5；§8 → T3；
      §9.1/9.2 → T1；§9.3 → T2；§9.4 → T5；§9.5 → T1/T2/T3 各一行；§10 §11 是约束，写进每份简报
- [x] 任意两个任务的独占文件集合无交集
- [x] 枢纽文件同波次最多一个任务：`db.ts` 仅 T2（波次 1）；`global.css` 仅 T4（波次 1）；
      `routes/aws.ts` / `aws-service.ts` / `auth.ts` / `index.ts` / `MainLayout.tsx` / `api.ts` / `Settings.tsx` / `main.tsx` 均不涉及
- [x] 协调者独占文件（`version.ts` / `README.md` / `.kiro/steering/**` / `config*.json` / `data/**`）不在任何任务内
- [x] 每个任务有可执行验收命令
- [x] 依赖链深度 ≤ 3（实际 1）
- [x] 每个任务能独立通过 `npm test`：T1/T2/T4 只依赖主干；T3/T5 基于合入波次 1 的集成分支
      （`npm test` 用 tsx 不做类型检查；T1 的类型过渡错误见上，已给出精确判定命令）
- [x] 不涉及 `root-email-*` / `root-mail-*` / `mail-api*`
- [x] README 第九节高危区：仅「任何 CSV 导出不加千分位」相关（T1 的 configSummary、T4 的金额显示不加千分位），写进 T1/T4 简报

## 派发要点（写进各任务简报）

**全部任务**
1. 先读 `.kiro/specs/poc-calculator-uniqueness/design.md` 全文，再读本任务对应章节；数值一律取自 `templates/` 与 `reference/`，**不得自行查价或改数**
2. 禁止改 `version.ts` / `README.md` / `.kiro/steering/**` / `config*.json` / `data/**`；禁止改本任务独占文件以外的任何文件
3. worktree 的 `node_modules` 可能为空，先 `cd web && npm install`
4. 验收命令全绿才能报 `worker_done --outcome succeeded`；遇到方案没写到的决策点用 `ask` 回问，不要自己定

**T1**
- `reference/formula.cjs` 与 `reference/generator-prototype.cjs` 是参考实现，翻译成 TS，**不要 import 它们**
- 模板逐字内嵌（§5.2.4），运行时不得读 `.kiro/`；`numberOfManangedRules` 是模板原拼写，不要改
- configSummary 不加千分位；不含中文
- 不得修改 `routes/poc-cash.ts`（见「T1 验收」）

**T2**
- `reservePocCalculator` 内**不得出现 await**，也不能是 async 函数（§9.5 第 2 行有测试锁）
- 风格参照 `createBillingExportJob()`（db.ts:540）；`ARRAY_FIELDS` 与 `emptyDB()` 都要加

**T3**
- 基于合入 T1+T2 后的集成分支开发
- `createApplicationWithLedger` 抽在 `poc-cash-funding.ts` 并导出（§9.5）
- 路由路径与守卫不变；审计详情追加计算器总额

**T4**
- 只加 §6 的展示块与一条 CSS 类；`Tag` 已在 import 中
- 金额不 `toLocaleString()`；不顺手重构文件里的内联样式与 emoji

**T5**
- Chrome 路径查找复用 `billing-exporter.ts` 的 `findChrome()` 候选列表（复制逻辑到脚本内，不改 billing-exporter）
- `--plan-only` 不得联网
