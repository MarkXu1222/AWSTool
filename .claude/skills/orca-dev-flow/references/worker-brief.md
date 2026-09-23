# codex 任务简报模板

`worker-start --spec` 的内容。**简报是 worker 唯一的上下文来源**——它看不到本会话的头脑风暴、看不到你的设计推导。写得含糊，返工的成本由协调者承担。

## 模板

```
【任务】<一句话，动词开头>

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
<具体到函数签名、接口路径、参数、返回结构。不要写"实现 XX 功能"这种话>

【必读】
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

**具体到可执行。** "加一个导出接口" → "在 `web/server/xxx.ts` 导出 `exportRecords(accountId: string, range: {from: string, to: string}): Promise<Buffer>`，CSV 格式，列依次为 …"。

**边界写死。** worker 不知道别人在干什么，必须显式告诉它哪些文件不属于它。少写这一段，它会"顺手"改掉枢纽文件。

**验收是命令，不是形容词。** "确保功能正常" 是无效验收。`npm test` 加具体测试文件名才是。

**AWS 链路提前定死。** 走哪条 assume 链、用哪个角色、哪些账户要排除，协调者在简报里给结论。worker 猜不出 INVITED 账户没有 OAAR 这种事。

**权限守卫点名。** `requireAdmin` 实际放行 admin + partadmin（名字有误导性），`requireStrictAdmin` 才是只放 admin 且实时查库。简报里直接写用哪个，别让 worker 从名字推。

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
