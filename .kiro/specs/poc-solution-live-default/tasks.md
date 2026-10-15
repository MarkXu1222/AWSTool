# POC Cash Solution 实时默认值 — 任务拆分

依据：`design.md`（G1 已于 2026-10-15 获批）。

| # | 任务名 | 独占文件 | 依赖 | 对应 design.md 章节 | 验收命令 |
|---|--------|----------|------|---------------------|----------|
| T1 | 后端规则、接口与测试 | `web/server/poc-cash.ts`、`web/server/routes/poc-cash.ts`、`web/tests/poc-cash-solution-default.test.ts`（新建）、`web/tests/poc-cash.test.ts`、`web/tests/poc-cash-partner-funding.test.ts` | 无 | §5、§9 | `cd web && npm test -- tests/poc-cash*.test.ts && npx tsc --noEmit -p server/tsconfig.json` |
| T2 | 前端预选、必选与实时文案 | `web/client/src/pages/PocCash.tsx` | T1 的接口契约（`GET /solutions` → `{ solutions, defaultSolutionId }`），不依赖 T1 的文件 | §6 | `cd web && npx tsc --noEmit -p client/tsconfig.json && npx vite build --config client/vite.config.ts` |

## 波次

- 波次 1：T1 → T2 串行（同一实现者，按顺序提交）。
- 集成：在 `feature/poc-solution-live-default` 上跑 `cd web && npm test && npm run typecheck && npm run build`。

## 拆分检查

- [x] 两个任务独占文件互不重叠
- [x] `version.ts` / `README.md` / `project-context.md` 不在任何任务里（P5 协调者改）
- [x] 每个任务有可执行的验收命令

## 流程偏离记录

- **G2**：用户在批准 G1 时指示「直接做完上线」，视为对本拆分（两个任务、文件互斥、串行）的批准，未单独停顿等待 G2。
- **P3 实现者**：会话运行在 VSCode 扩展，orca 无法建 run（`no_active_sender_terminal`），按 2026-10-13 约定由 Claude 直接按本表顺序实现、逐任务提交，完成后派独立审核子代理。
- **G4 不受上述影响**：部署前仍须把完整命令清单交给用户并等待明确确认。
