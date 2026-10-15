# MAP 标签部署最小权限化 — 任务拆分

依据：`design.md`（G1 已于 2026-10-15 获批，用户附加要求：严格遵循最小权限原则）。

| # | 任务名 | 独占文件 | 依赖 | 对应 design.md 章节 | 验收命令 |
|---|--------|----------|------|---------------------|----------|
| T1 | 最小权限模板、纯函数、provisionOrg、区域发现 | `web/server/tag-compliance.ts`、`web/tests/tag-compliance-policy.test.ts`、`web/tests/tag-least-privilege.test.ts`（新建） | 无 | §5、§10 | `cd web && node --import tsx --test tests/tag-*.test.ts && npx tsc --noEmit -p server/tsconfig.json` |
| T2 | 接入任务传参与不可达账户记录 | `web/server/tag-onboarding.ts`、`web/server/db.ts` | T1（`provisionOrg` 新签名、`normalizeAllowedTagKeys`、`getMemberEnabledRegions` 新返回值） | §4、§6 | `cd web && node --import tsx --test tests/tag-*.test.ts && npx tsc --noEmit -p server/tsconfig.json` |
| T1b | 方案增补 §13：受限账户索引 payer 侧核验、跳过不可达账户 | `web/server/tag-compliance.ts`、`web/server/tag-onboarding.ts`、`web/tests/tag-least-privilege.test.ts` | T1、T2 | §13 | 同 T1 |
| T3 | TagKeys 金丝雀运维脚本 | `web/scripts/tag-keys-canary.ts`（新建） | T1（`AUTO_TAGGER_INLINE_POLICY` 新签名） | §7 | `cd web && npx tsx scripts/tag-keys-canary.ts`（无参数打印用法、退出码 2）+ `npx tsc --noEmit -p server/tsconfig.json` |

## 波次

- 串行：T1 → T2 → T3（同一实现者，逐个提交）。
- 集成：`cd web && npm test && npm run typecheck && npm run build`，随后派独立审核子代理，**审核重点为最小权限**：
  逐条核对新模板/内联策略/信任策略中每个 Action 与 Resource 是否都有中央代码的实际调用支撑。

## 拆分检查

- [x] 三个任务独占文件互不重叠
- [x] `version.ts` / `README.md` / `project-context.md` 不在任何任务里（P5 协调者改）
- [x] 每个任务有可执行的验收命令

## 流程说明

- **P3 实现者**：VSCode 会话无法建 orca run，按 2026-10-13 约定由 Claude 按本表顺序实现、逐任务提交，完成后派独立审核子代理。
- 本需求在 `feature/map-tag-least-privilege` 分支（从 `origin/main` 开 worktree）实现。
