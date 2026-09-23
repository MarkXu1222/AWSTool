# 任务拆分 —— poc-cash-company-name-guard

| # | 任务名 | 独占文件 | 依赖 | design.md 章节 | 验收命令 |
|---|--------|----------|------|----------------|----------|
| T1 | POC Cash 客户主体误填防护 | `web/client/src/pages/PocCash.tsx`<br>`web/tests/poc-cash.test.ts` | — | §6 改动 1–4、§8、§9 | `cd web && npm install && npm test && npm run typecheck && npx vite build --config client/vite.config.ts`，外加 §1 的 5 条页面行为核对 |

## 波次

- **波次 1**：T1（单任务，无并行）

## 为什么只有一个任务

拆分的唯一目的是消灭撞车。本需求的 4 处改动落在 2 个文件上：

- 改动 1（客户公司全称 placeholder + `extra` 核对提示）→ `PocCash.tsx:1149-1151`
- 改动 2（商机名称 placeholder）→ `PocCash.tsx:1193`
- 改动 3（切换 Partner 主体清残留）→ `PocCash.tsx:1138-1144`
- 改动 4（测试样例 `(KL)` → `(HQ)`）→ `poc-cash.test.ts:46-47`

**改动 1/2/3 同处一个文件，按「任意两个任务的独占文件集合无交集」的硬规则，物理上不可拆。**
剩下改动 4 只有 2 行，单独立一个任务、开一个 worktree、派一个 worker、再走一轮审核合并，
开销远大于改动本身，且会人为制造一次合并操作。

依赖链深度 0，无枢纽文件争用，无并行收益。**单任务串行是这个规模的正确形状。**

## 拆分检查清单

- [x] `design.md` 已通过闸门 G1（2026-09-23，第 2 版）
- [x] 每个任务都能指到 `design.md` 的具体章节 —— T1 → §6 改动 1–4、§8、§9
- [x] `design.md` 每一节都被覆盖 —— §4 §5 §7 明确写「无变更 / 不涉及」，无需任务承接；
      §10 §11 是约束不是交付物，写进任务简报
- [x] 任意两个任务的独占文件集合无交集 —— 只有一个任务，平凡满足
- [x] 每个枢纽文件在同一波次里最多被一个任务持有 —— **本次不碰任何枢纽文件**：
      `routes/aws.ts` / `aws-service.ts` / `db.ts` / `auth.ts` / `index.ts` /
      `MainLayout.tsx` / `api.ts` / `Settings.tsx` / `global.css` / `main.tsx` 全部不动
- [x] 协调者独占文件未出现在任务里 —— `version.ts` / `README.md` / `.kiro/steering/**` /
      `config.json` / `data/**` 均不在 T1 的独占文件内，且 `design.md` §11 第 4、5 条
      明文禁止 worker 触碰
- [x] 验收命令可观测 —— 4 条可执行命令 + 5 条页面操作（§1）
- [x] 依赖链深度 ≤ 3 —— 深度为 0
- [x] T1 能独立通过 `npm test` —— 不依赖任何其它任务
- [x] 不涉及 `root-email-*` / `root-mail-*` / `mail-api*`，无需附加 `ROOT_EMAIL.md` 阅读要求
- [x] 不涉及 README 第九节任何高危区（`design.md` §10 已逐条核对）

## 派发要点（写进 T1 的简报）

1. **唯一高风险点**：改动 3 的 `if (refFrom)` 条件。漏写或写反 → 切换主体会抹掉用户
   手填的客户信息且无法撤销。简报必须点名 `design.md` §10 的对应段落。
2. **禁止用 `resetAll()` 实现改动 3**（闭包旧值坑，§6 改动 3 + §11 第 11 条）。
3. **禁止碰 `version.ts` / `README.md` / `project-context.md`**（§11 第 4、5 条）。
4. **禁止重构 `PocCash.tsx` 其余部分**（1248 行、有 inline style 技术债，§11 第 7 条）。
5. worktree 里 `node_modules` 可能为空，**先 `npm install`**，否则 `vite build` 会报
   `Rollup failed to resolve import "recharts"` —— 那是环境缺依赖，不是改动问题。
6. 自测四条命令全绿才能报 `worker_done --outcome succeeded`。
