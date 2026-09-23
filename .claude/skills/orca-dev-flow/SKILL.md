---
name: orca-dev-flow
description: AWSTool 需求从想法到上线的全流程编排。当用户提出新需求、新功能、要新增或改动页面/接口/模块，或说「走流程」「按流程来」「orca 流程」「派给 codex」「开 worktree 做」「orca dev flow」时使用。串联 superpowers 头脑风暴 → Claude 设计与任务拆分 → orca worktree + codex 并行实现 → Claude 串行合并与审核 → Claude 亲自部署上线。不用于一行修复、纯文案改动或纯排查。
---

# Orca 开发流程（AWSTool）

需求从想法走到 https://markxu.co 上线的唯一路径。

## 何时用

| 用 | 不用 |
|----|------|
| 新页面、新接口、新后端模块 | 一行修复、文案、样式微调 |
| 改动牵扯 ≥ 2 个文件 | 只读排查 / 回答问题 |
| 需要并行推进的多个子任务 | 紧急线上故障（直接修，事后补流程） |

不确定时按"用"处理，代价只是多一次确认。

## 角色与授权

- **Claude（本会话）= 协调者**。全程持有所有权，不做全量 handoff。设计、拆分、审核、合并、部署、汇报都由它做。
- **codex worker（`gpt-6-sol`）= 实现者**。每个任务一个独立 worktree，只在自己的文件所有权范围内改代码，自测绿了才报完成。不做设计决策——设计在 P1 已经定完了，有疑问用 `ask` 回问协调者。
- **用户 = 唯一批准人**。三道闸门只有用户能开，Claude 不得自行放行、不得默认同意、不得"用户没反对就当批准"。

## 六阶段 / 三闸门

| 阶段 | 做什么 | 谁做 | 出口 |
|------|--------|------|------|
| P0 澄清 | `superpowers:brainstorming` 问清意图、边界、验收标准 | Claude + 用户 | 设计获批（brainstorming 自带 HARD-GATE） |
| P1 设计与拆分 | 读 README 定事实，出实现方案，切成文件所有权互斥的任务 | Claude | **闸门 G1：任务表获批** |
| P2 派发与监督 | orca orchestration 建 run，每任务一个 worktree + codex(`gpt-6-sol`) | Claude 派、codex 做 | 所有 Dispatch 结算 |
| P3 集成与审核 | 串行合并到集成分支，逐任务审核，全量重跑测试 | Claude | 集成分支测试全绿 |
| P4 发版收尾 | 统一改 `APP_VERSION`、README、project-context | Claude | **闸门 G2：上线内容获批** |
| P5 部署与验证 | 推代码、EC2 部署、验证、备好回滚 | Claude | **闸门 G3：部署动作获批** → 上线确认 |

闸门不可跳过、不可合并、不可事后补。跳了就是流程失败，停下来说明原因。

---

## P0 澄清

1. 调用 `superpowers:brainstorming`。
2. 同时读 **`README.md`** 的相关章节——它是本项目实现细节的事实来源，`.kiro/steering/project-context.md` 可能滞后，两者冲突以 README 为准。
3. 澄清时必须问到：
   - 这个功能给谁用？哪个角色（admin / partadmin / viewer）看得到？
   - 是可分配页面、独立权限页，还是纯后端？
   - 涉不涉及跨账户 AWS 调用？涉及哪条链路（support-quota / admin-console / OAAR）？
   - 涉不涉及 `data/db.json` 的 schema 变化？涉及就必须先想好向后兼容。
   - 验收标准是什么——用什么命令或什么页面操作能证明它跑通了。

brainstorming 的 HARD-GATE 没过，**不准写任何产品代码、不准建 worktree、不准派 codex**。只读探索允许。

## P1 设计与拆分

1. 产出实现方案：改哪些文件、每个文件负责什么、接口签名、权限守卫选哪个、要不要加测试。
2. 任务数 ≥ 4 或跨前后端时，额外调用 `superpowers:writing-plans` 生成正式计划。
3. 按 **`references/task-split.md`** 的规则切任务。核心约束：**任意两个任务不得写同一个文件**。
4. 输出任务表给用户，格式：

   | # | 任务名 | 独占文件 | 依赖 | 验收命令 |
   |---|--------|----------|------|----------|

5. **闸门 G1**：把任务表和并行波次给用户，等用户明确批准。用户改了拆分就重出表，重新等批准。

## P2 派发与监督

这是**监督式编排**，不是 handoff——不要用 `orca worktree create --agent codex --prompt` 甩手不管。

### 实现模型固定为 gpt-6-sol

`~/.codex/config.toml` 的全局默认已设为 `model = "gpt-6-sol"` / `model_reasoning_effort = "high"`。
**即便如此，派发时仍然必须显式传 `--model`**：全局配置随时可能被改动，而 orca 的 `--agent codex` 走的是它自己配置的 launcher，是否继承 `config.toml` 并无保证。显式传才可审计、才不会某天静默换模型。

```
orca status --json
orca orchestration run-create --objective "<需求一句话>" --json

# 每个任务一次；任务都有 worktree，所以用 new-child / new-top-level
orca orchestration worker-start \
  --spec "<任务简报>" \
  --worktree new-child --name <任务名> --setup run \
  --agent codex --model gpt-6-sol --effort high \
  --json

orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

- `--effort` 必须和 `--model` 一起给；两者都**不能**和 `--terminal` 同用（复用已有终端时传不了模型）。
- **派发后必须核对回执的 `launch.effective`**，确认真的是 `gpt-6-sol`。orca 明确要求：不得仅凭 `launch.requested` 就宣称模型生效——连接的 worker server 没有 advertise 该能力时，模型字段会被静默丢弃，worker 会退回它自己的默认。effective 对不上就停下来告诉用户，不要默默继续。
- `--worktree new-child`：任务 worktree 挂在协调者之下，UI 分组和血缘清晰，适合同一需求的并行子任务。`new-top-level` 用于与当前工作完全独立的任务。Git base 由 orca 按仓库策略决定，派发后用 `orca orchestration worker-show --dispatch <id> --json` 核对分支落在哪。
- `gpt-6-sol` 支持 `low` / `medium` / `high` / `xhigh`（默认 medium）。本流程固定 `high`——方案由 Claude 设计完整、worker 只做实现，`high` 够用且比 `xhigh` 快。高危区任务（README 第九节）可单独提到 `xhigh`。
- 任务简报用 **`references/worker-brief.md`** 的模板，必须自包含五要素：目标文件 / 要做的改动 / 约束 / 所有权边界 / 可观测验收。
- 无依赖的任务**一次性全部起完再等**，不要起一个等一个。
- 收到 `question` 用 `orca orchestration reply --id <message_id> --body "<答复>" --json` 回答，不要让 worker 干等。
- 收到 `worker_done` 先核对 Dispatch ID 是否是当前授权的那一个，再 ack。
- `worker-start` 非零退出**不要重起**，读回执的 `failedStage` / `residualResources`，加载 `references/recovery-and-cleanup.md`。
- 连续三次空等之后，改用 `orca orchestration worker-list --run <run_id> --include-remote --json` 逐行看 `projection.attention`，按 `projection.nextAction` 给的字面 argv 行动。**必须带 `--run`**——不带会列出本 runtime 记录过的所有 Dispatch，你要等的 worker 会淹在历史里。**没有正面的退出证据，不准 stop / abandon / retry / release。**
- 每个任务结算后立刻做且只做一件：复用该终端接下一个任务、`worker-retain`、或 `worker-release`。
- 协调者退出本阶段前，`orca orchestration worker-list --run <run_id> --terminal-state reclaimable --json` 必须返回空。

## P3 集成与审核

完整步骤见 **`references/integrate-and-deploy.md`**。要点：

1. 建集成分支 `integration/<需求名>`，从当前主干开。
2. **串行**合入，一次一个任务分支，顺序按依赖。
3. 每合入一个就地审核（对照 `README.md` 第九节高危区 + `.kiro/steering/coding-standards.md`），必要时调 `superpowers:requesting-code-review`。
4. 冲突由 Claude 解。**同一对文件连续冲突两次 = 拆分失败**，退回 P1 重拆，不要硬解。
5. 全部合完后在集成分支重跑全量：
   ```
   cd web && npm test && npm run typecheck && npm run build
   ```
   三个全绿才算通过。有红就修到绿，修不动就退回对应 worker。
6. 收尾用 `superpowers:verification-before-completion` 自查。

## P4 发版收尾

这三类文件**只有协调者能改，worker 一律禁止**（否则每次并行都冲突）：

- `web/client/src/version.ts` —— 递增 `APP_VERSION`（小改 patch / 大改 minor）
- `README.md` —— 同步功能模块表、目录结构、接口清单、关键实现、已知待办
- `.kiro/steering/project-context.md` —— 补齐索引与架构决策（第十节）

**闸门 G2**：向用户汇报——本次上线包含哪些任务、改了哪些文件、版本号从多少到多少、测试结果、有没有 schema 变更。等用户批准上线内容。

## P5 部署与验证

**部署由 Claude 亲自执行，不交给 codex。**

**闸门 G3**：执行任何部署动作前，把完整命令清单打给用户，等用户回一个明确的确认词。**用户没回，一条都不准跑。**

完整 runbook 与回滚预案见 **`references/integrate-and-deploy.md`**。

---

## 不可违反的硬规则

数据安全红线来自 `.kiro/steering/deployment.md`，优先级高于本流程的一切效率考量。

1. **禁止 `git add -A` / `git add .`** —— 只 add 具体代码文件。提交前 `git status` 确认没有 `data/`、`config.json` 被 staged。
2. **EC2 上禁止** `git stash`、`git checkout -- data/`、`git reset --hard`，以及任何会动 `data/` 或 `config.json` 的 git 操作。
3. **禁止让 worker 改** `version.ts`、`README.md`、`project-context.md`、`config.json`、`data/**`。
4. **worker 未自测通过不得报 `worker_done --outcome succeeded`**。Claude 审的是已经绿的代码，不是拿人肉当 CI。
5. **任务间文件所有权必须互斥**。做不到就别并行，改串行。
6. **闸门不可由 Claude 自行放行**。
7. 碰 `web/ROOT_EMAIL.md` 覆盖的批量 Root 改密模块，派发前必须先让 worker 读那份文档；`password_unknown` 绝不自动重试。
8. **实现一律用 `gpt-6-sol`**，派发时显式传 `--model gpt-6-sol --effort high`，并核对回执 `launch.effective`。不许依赖全局配置兜底。
9. 本技能给出的 orca 参数只限文中出现过的；需要文中没有的 flag 时，先 `orca <command> --help` 或加载对应 reference，**不要猜**。

## 心跳汇报

按 `.kiro/steering/heartbeat.md` 的格式，在这些时刻各输出一次：阶段切换、每次派发、每次收到 `worker_done`、每道闸门前后、遇到阻塞时。并行阶段由**协调者统一汇报**，worker 的进度汇总进协调者的心跳，不要让用户去看多个终端。

## 失败处理

| 情况 | 动作 |
|------|------|
| worker 报 `failed` | 读它的执行摘要，判断是任务简报没写清还是实现难点。前者重写简报重派，后者拆细或 Claude 接手 |
| worker 失联 / `unverifiable` | 绝不当成死亡。继续等或 `worker-show` 查，按 `references/recovery-and-cleanup.md` 处理 |
| 合并冲突 ≥ 2 次同文件 | 判定拆分失败，退回 P1 重拆 |
| 集成分支测试红 | 定位到具体任务，退回该 worker 或 Claude 直接修，不准带红上线 |
| 部署后验证失败 | 立刻按回滚预案退版，再排查。**不在生产上调试** |
