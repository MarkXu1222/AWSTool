---
name: orca-dev-flow
description: AWSTool 需求从想法到上线的全流程编排。当用户提出新需求、新功能、要新增或改动页面/接口/模块，或说「走流程」「按流程来」「orca 流程」「派给 codex」「开 worktree 做」「orca dev flow」时使用。七阶段：superpowers 头脑风暴 → Claude 写完整实现方案 design.md → 拆任务 tasks.md → orca worktree + codex(gpt-6-sol) 并行实现 → Claude 串行合并与审核 → 发版收尾 → Claude 亲自部署上线。每个需求强制产出 .kiro/specs/<需求名>/ 三份文档。不用于一行修复、纯文案改动或纯排查。
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
- **用户 = 唯一批准人**。四道闸门只有用户能开，Claude 不得自行放行、不得默认同意、不得"用户没反对就当批准"。

## 七阶段 / 四闸门

| 阶段 | 做什么 | 产出 | 出口 |
|------|--------|------|------|
| P0 澄清 | `superpowers:brainstorming` 问清意图、边界、验收标准 | `requirements.md` | brainstorming 自带 HARD-GATE |
| P1 实现方案 | 读 README 定事实，写**完整**实现方案 | `design.md` | **闸门 G1：方案获批** |
| P2 任务拆分 | 按方案切成文件所有权互斥的任务 | `tasks.md` | **闸门 G2：任务表获批** |
| P3 派发与监督 | orca orchestration 建 run，每任务一个 worktree + codex(`gpt-6-sol`) | 代码 | 所有 Dispatch 结算 |
| P4 集成与审核 | 串行合并到集成分支，逐任务审核，全量重跑测试 | 集成分支 | 测试全绿 |
| P5 发版收尾 | 统一改 `APP_VERSION`、README、project-context | 上线清单 | **闸门 G3：上线内容获批** |
| P6 部署与验证 | 推代码、EC2 部署、验证、备好回滚 | 线上 | **闸门 G4：部署动作获批** → 上线确认 |

闸门不可跳过、不可合并、不可事后补。跳了就是流程失败，停下来说明原因。

### 文档产物：每个需求必须有

```
.kiro/specs/<需求名>/
├── requirements.md   P0 产出 —— 需求纪要与验收标准
├── design.md         P1 产出 —— 完整实现方案（workers 的唯一依据）
└── tasks.md          P2 产出 —— 任务拆分表与波次
```

**这三份不是可选的，不是"大需求才写"。** 没有 `design.md` 就不准拆任务，没有 `tasks.md` 就不准派 codex。

`<需求名>` 用 kebab-case 英文短名，例如 `billing-group-export`。

⚠️ `.kiro/specs/` 是本流程新建的目录（项目原本只有 `.kiro/steering/` 和 `.kiro/skills/`）。`docs/` 放的是领域参考文档（Bedrock API、Partner Central API 等），**不要**把需求方案塞进 `docs/`。

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

4. 澄清结束后写 `.kiro/specs/<需求名>/requirements.md`：目标、使用者与角色、范围内做什么、**明确不做什么**、验收标准（可执行的命令或页面操作）、已知约束。

brainstorming 的 HARD-GATE 没过，**不准写任何产品代码、不准建 worktree、不准派 codex**。只读探索允许。

## P1 实现方案

**这一阶段只产出文档，不写产品代码、不拆任务、不派人。**

1. 读 **`README.md`** 的相关章节定实现事实，读涉及模块的源码看现状。
2. 按 **`references/design-doc.md`** 的大纲写 `.kiro/specs/<需求名>/design.md`。这份文档要**完整到 codex 照着就能实现**——它是 worker 的唯一依据，worker 看不到本会话的任何讨论。
3. 方案写完调 `superpowers:writing-plans` 复核一遍结构与粒度（不是可选步骤，它会抓出你漏掉的测试与边界）。
4. 自检：方案里每个函数签名、每个接口路径、每个权限守卫、每条 AWS 链路都写死了吗？还是留了"由实现者决定"？**留一个，就会错一个。**

> 🚦 **闸门 G1**：把 `design.md` 给用户过目，等明确批准。用户改了方案就改文档，重新等批准。
> **方案没批准，不准进 P2。**

## P2 任务拆分

1. 按 **`references/task-split.md`** 的规则，把 `design.md` 切成任务。核心约束：**任意两个任务不得写同一个文件**。
2. 写 `.kiro/specs/<需求名>/tasks.md`：

   | # | 任务名 | 独占文件 | 依赖 | 对应 design.md 章节 | 验收命令 |
   |---|--------|----------|------|---------------------|----------|

   下面再写波次编排（哪些并行、哪些串行）。
3. 过一遍 `references/task-split.md` 的拆分检查清单，逐条打勾。

> 🚦 **闸门 G2**：把 `tasks.md` 和波次给用户，等明确批准。用户改了拆分就重出表，重新等批准。

## P3 派发与监督

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
- 任务简报用 **`references/worker-brief.md`** 的模板。简报**不重述方案**——它负责把 worker 指到 `design.md` 的对应章节、划清文件边界、给出验收命令。方案本身由 worker 自己读 `.kiro/specs/<需求名>/design.md`。
- 无依赖的任务**一次性全部起完再等**，不要起一个等一个。
- 收到 `question` 用 `orca orchestration reply --id <message_id> --body "<答复>" --json` 回答，不要让 worker 干等。
- 收到 `worker_done` 先核对 Dispatch ID 是否是当前授权的那一个，再 ack。
- `worker-start` 非零退出**不要重起**，读回执的 `failedStage` / `residualResources`，加载 `references/recovery-and-cleanup.md`。
- 连续三次空等之后，改用 `orca orchestration worker-list --run <run_id> --include-remote --json` 逐行看 `projection.attention`，按 `projection.nextAction` 给的字面 argv 行动。**必须带 `--run`**——不带会列出本 runtime 记录过的所有 Dispatch，你要等的 worker 会淹在历史里。**没有正面的退出证据，不准 stop / abandon / retry / release。**
- 每个任务结算后立刻做且只做一件：复用该终端接下一个任务、`worker-retain`、或 `worker-release`。
- 协调者退出本阶段前，`orca orchestration worker-list --run <run_id> --terminal-state reclaimable --json` 必须返回空。

## P4 集成与审核

完整步骤见 **`references/integrate-and-deploy.md`**。要点：

1. 建集成分支 `integration/<需求名>`，从当前主干开。
2. **串行**合入，一次一个任务分支，顺序按依赖。
3. 每合入一个就地审核（对照 `README.md` 第九节高危区 + `.kiro/steering/coding-standards.md`），必要时调 `superpowers:requesting-code-review`。
4. 冲突由 Claude 解。**同一对文件连续冲突两次 = 拆分失败**，退回 P2 重拆并更新 `tasks.md`，不要硬解。
5. 全部合完后在集成分支重跑全量：
   ```
   cd web && npm test && npm run typecheck && npm run build
   ```
   三个全绿才算通过。有红就修到绿，修不动就退回对应 worker。
6. 收尾用 `superpowers:verification-before-completion` 自查。

## P5 发版收尾

这三类文件**只有协调者能改，worker 一律禁止**（否则每次并行都冲突）：

- `web/client/src/version.ts` —— 递增 `APP_VERSION`（小改 patch / 大改 minor）
- `README.md` —— 同步功能模块表、目录结构、接口清单、关键实现、已知待办
- `.kiro/steering/project-context.md` —— 补齐索引与架构决策（第十节）

同时把 `.kiro/specs/<需求名>/` 三份文档补成最终状态——实现过程中方案有调整的，回写进 `design.md`，别让文档和代码对不上。

> 🚦 **闸门 G3**：向用户汇报——本次上线包含哪些任务、改了哪些文件、版本号从多少到多少、测试结果、有没有 schema 变更。等用户批准上线内容。

## P6 部署与验证

**部署由 Claude 亲自执行，不交给 codex。**

> 🚦 **闸门 G4**：执行任何部署动作前，把完整命令清单打给用户，等用户回一个明确的确认词。**用户没回，一条都不准跑。**

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
7. **没有 `design.md` 不准拆任务，没有 `tasks.md` 不准派 codex。** 文档是流程的前置条件，不是事后补的交付物。方案里凡是写"由实现者决定"的地方，都等于埋了一个 bug。
8. 碰 `web/ROOT_EMAIL.md` 覆盖的批量 Root 改密模块，派发前必须先让 worker 读那份文档；`password_unknown` 绝不自动重试。
9. **实现一律用 `gpt-6-sol`**，派发时显式传 `--model gpt-6-sol --effort high`，并核对回执 `launch.effective`。不许依赖全局配置兜底。
10. 本技能给出的 orca 参数只限文中出现过的；需要文中没有的 flag 时，先 `orca <command> --help` 或加载对应 reference，**不要猜**。

## 心跳汇报

按 `.kiro/steering/heartbeat.md` 的格式，在这些时刻各输出一次：阶段切换、每次派发、每次收到 `worker_done`、每道闸门前后、遇到阻塞时。并行阶段由**协调者统一汇报**，worker 的进度汇总进协调者的心跳，不要让用户去看多个终端。

## 失败处理

| 情况 | 动作 |
|------|------|
| worker 报 `failed` | 读它的执行摘要，判断是任务简报没写清还是实现难点。前者重写简报重派，后者拆细或 Claude 接手 |
| worker 失联 / `unverifiable` | 绝不当成死亡。继续等或 `worker-show` 查，按 `references/recovery-and-cleanup.md` 处理 |
| 合并冲突 ≥ 2 次同文件 | 判定拆分失败，退回 P2 重拆并更新 `tasks.md` |
| 集成分支测试红 | 定位到具体任务，退回该 worker 或 Claude 直接修，不准带红上线 |
| 部署后验证失败 | 立刻按回滚预案退版，再排查。**不在生产上调试** |
