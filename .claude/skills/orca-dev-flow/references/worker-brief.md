# codex 任务简报模板

`worker-start --spec` 的内容。

**简报不重述方案。** 完整实现方案已经写在 `.kiro/specs/<需求名>/design.md` 里了，简报的职责是：把 worker 定位到方案的**哪一节**，划清它的**文件边界**，给出它的**验收命令**。

worker 看不到本会话的头脑风暴和设计推导，但它能读到 `design.md`——所以简报必须让它先读那份文档。简报里含糊或与 `design.md` 冲突的地方，返工成本由协调者承担。

## 模板

```
【任务】<一句话，动词开头>

【先读这个】
完整实现方案：.kiro/specs/<需求名>/design.md
你负责的是其中的「<章节名>」一节。开工前先把整份 design.md 读完，
至少读完第 1（验收）、2（现状）、3（总览）节和你负责的那节。

方案里已经写死的东西（函数签名、接口路径、权限守卫、AWS 链路）一律照做，
不要自行改进。觉得方案有问题就用 ask 问协调者，不要自己改方案。

【背景】
本次需求：<一句话>
你负责其中的：<这个任务在整体里的位置>
其他 worker 正在并行做：<简要列出，让它知道边界在哪>

【你独占的文件】
- <path/to/file.ts>          ← 只有你能改
- <path/to/file.test.ts>

【禁止触碰】
- web/client/src/version.ts、README.md、.kiro/steering/**、config.json、data/**
- <其他 worker 的独占文件>
需要改上面任何一个文件才能完成时：不要改，用 ask 问协调者。

【要做的改动】
见 design.md 第 <N> 节。这里只列该节里**属于你**的部分：
<逐条列出，每条对应 design.md 里的一个函数/接口/组件。不要重抄签名，指过去即可>

【必读】
- .kiro/specs/<需求名>/design.md —— 本次实现的唯一依据
- README.md 的「<章节名>」章节 —— 本项目的事实来源
- .kiro/steering/coding-standards.md —— 编码与前端样式规范
- <涉及 root-email 模块时>web/ROOT_EMAIL.md
- <涉及高危区时>README.md 第九节的「<具体哪一条>」

【约束】
- 后端用 tsx 直跑不编译，改 .ts 即生效，不要加编译步骤
- 前端颜色只用 var(--color-*) token，z-index 只用 var(--z-*)，不要写裸 hex 和魔法数字
- 成功提示不加感叹号
- CSV 导出的数字不加千分位（toLocaleString 的逗号会让下游 split(',') 串位）
- <本任务特有的约束>

【验收（必须自己跑通再报完成）】
cd web && npm test && npm run typecheck && npm run build
另外：<本任务特有的验收，例如某个测试文件、某个 curl、某个页面操作>

【完成时】
全绿后 worker_done --outcome succeeded，附三句执行摘要和 --files-modified。
任何一项没绿就 --outcome failed，在摘要里写清楚卡在哪。不要把失败只写在正文里。
```

## 写简报的要点

**指向方案，不重抄方案。** 简报和 `design.md` 重复内容越多，两边越容易漂移。具体的函数签名、接口定义、AWS 链路、权限守卫都写在 `design.md` 里了，简报指过去即可。

**边界写死。** worker 不知道别人在干什么，必须显式告诉它哪些文件不属于它。少写这一段，它会"顺手"改掉枢纽文件。

**验收是命令，不是形容词。** "确保功能正常" 是无效验收。`npm test` 加具体测试文件名才是。

**禁止 worker 改方案。** 方案在闸门 G1 已经由用户批准了。worker 觉得方案有问题，只能 `ask` 回问协调者，由协调者判断要不要改 `design.md`、要不要重新过闸门。worker 自己"优化"方案 = 交付了用户没批准的东西。

## worker 契约（简报之外，orchestration 自带的注入前言会说，这里是协调者的核对清单）

worker 应当：

1. 只做当前任务，有阻塞问题用注入前言里的 `ask` 命令问协调者，**不要开本地交互式 TUI**——协调者答不了。
2. 按前言的节奏发心跳。心跳只证明活着，不证明完成。
3. 在自然检查点（开新文件前、跑完测试后）和 `worker_done` 之前，各执行一次
   `orca orchestration check --terminal <自己的 handle> --json` 读协调者的追加指令。
4. `worker_done` 只发一次，从被派发的那个终端发，带三句执行摘要、两个生命周期 ID、显式的 `--outcome`。
5. 报完成后结束回合并空闲，不要自己找活干。

## 协调者收到 worker_done 后的核对

- [ ] Dispatch ID 是当前授权的那一个（不是旧的、不是复制错的）
- [ ] `--outcome` 是显式的，不是从正文里猜的
- [ ] `--files-modified` 列出的文件**全部在该任务的独占清单内**。越界了就打回，不要"既然改都改了"
- [ ] 它声称跑绿的命令，协调者在 P3 集成时会重跑一遍——不信任单方面声明

核对通过后，立刻做且只做一件：复用该终端派下一个任务、`worker-retain`、或 `worker-release`。
