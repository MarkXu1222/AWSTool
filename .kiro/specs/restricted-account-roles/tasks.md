# 任务拆分：restricted-account-roles

> 实现者：Claude 直接实现（用户指定不派 codex），因此不建 worktree、不并行，单分支串行。
> 依据：`design.md`（G1 已批准）。

| # | 任务名 | 独占文件 | 依赖 | 对应 design.md 章节 | 验收命令 |
|---|--------|----------|------|---------------------|----------|
| T1 | 收窄策略与标记流程 | `web/server/restricted-accounts.ts` | — | 2、3.1 | `cd web && npx tsc --noEmit -p server/tsconfig.json` |
| T2 | 凭证链路守卫 | `web/server/aws-service.ts` | T1（`isSupportOnlyRestricted` 导出） | 3.2 | 同上 |
| T3 | 自愈逻辑（保留 Codex 改动，仅复核） | `web/server/account-roles.ts` | T1 | 3.3 | 同上 |
| T4 | 标记弹窗文案与 INVITED 警示 | `web/client/src/pages/Accounts.tsx` | — | 3.4 | `cd web && npx tsc --noEmit -p client/tsconfig.json` |
| T5 | 回归测试 | `web/tests/restricted-admin-access.test.ts` | T1–T3 | 4 | `cd web && node --import tsx --test tests/restricted-admin-access.test.ts` |
| T6 | 发版收尾（协调者） | `web/client/src/version.ts`、`README.md`、`.kiro/steering/project-context.md` | T1–T5 | 5 | `cd web && npm test && npm run typecheck && npm run build` |

## 波次

1. **波次 1**：T1 → T2 → T3（同一调用链，串行）；T4 可穿插。
2. **波次 2**：T5，跑单测到绿。
3. **波次 3**：T6，全量 `npm test && npm run typecheck && npm run build` 全绿 → 闸门 G3。
4. 部署与生产账户重新收窄（design.md 第 6 节）→ 闸门 G4，单独批准。

## 拆分检查清单
- [x] 任意两个任务不写同一文件
- [x] 每个任务都能对应到 design.md 章节
- [x] 每个任务都有可执行的验收命令
- [x] version.ts / README / project-context 只在 T6 由协调者修改
- [x] 不涉及 `data/**`、`config.json`；`db.json` 中 `restricted_accounts` 记录结构不变（沿用 Codex 已加的可选字段 `support_policy_backup`，向后兼容）
- [x] 提交时排除 `web/package-lock.json`（无关的未提交改动）
