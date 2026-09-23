# 任务拆分规则

并行开发唯一的失败模式是**撞车**。这份文档的目的是让拆分阶段就把撞车消灭掉，而不是等到合并时解冲突。

**前置条件：`.kiro/specs/<需求名>/design.md` 已写完并通过闸门 G1。** 没有方案就拆任务，拆出来的是猜测。

拆分产出 `.kiro/specs/<需求名>/tasks.md`：

```markdown
# 任务拆分 —— <需求名>

| # | 任务名 | 独占文件 | 依赖 | design.md 章节 | 验收命令 |
|---|--------|----------|------|----------------|----------|
| T1 | 后端导出模块 | web/server/billing-group-export.ts<br>web/tests/billing-group-export.test.ts | — | §5.1 | `npm test -- tests/billing-group-export.test.ts` |
| T2 | 前端分组 UI | web/client/src/pages/Billing.tsx | — | §6 | 页面操作：… |
| T3 | 接线 | web/server/routes/aws.ts<br>web/client/src/api.ts | T1,T2 | §5.2 §6 | `npm run build` |

## 波次
- 波次 1（并行）：T1、T2
- 波次 2：T3
```

「design.md 章节」这一列不是装饰——worker 的简报靠它定位。**每个任务都必须能指到方案里的具体一节**；指不过去，说明方案漏写了那部分，回 P1 补。

## 第一原则：按文件所有权拆，不按功能拆

错误示范（按功能拆）：

- 任务 A：实现"批量导出"功能
- 任务 B：实现"导出记录审计"功能

两个都要改 `routes/aws.ts`、`api.ts`、`MainLayout.tsx` —— 必冲突。

正确示范（按文件所有权拆）：

- 任务 A：后端导出模块 —— 独占 `web/server/xxx-export.ts` + `web/tests/xxx-export.test.ts`，**不碰路由**
- 任务 B：前端页面 —— 独占 `web/client/src/pages/Xxx.tsx`，用 mock 数据先跑通
- 任务 C（依赖 A、B）：接线 —— 独占 `routes/aws.ts` 的路由注册、`api.ts` 的方法、`MainLayout.tsx` 的三处登记

枢纽文件的改动集中到**一个**收尾任务里，这是让并行成立的关键。

## 冲突热点清单（本项目）

这些文件被多个功能共享，是撞车高发区。**同一波次里最多允许一个任务持有其中任意一个**。

### 后端枢纽

| 文件 | 行数量级 | 为什么是热点 |
|------|----------|--------------|
| `web/server/routes/aws.ts` | ~1800 | 主业务 50+ 端点全在这里 |
| `web/server/aws-service.ts` | ~1960 | 所有跨账户调用的公共入口 |
| `web/server/db.ts` | ~1070 | 所有存储读写 |
| `web/server/auth.ts` | ~360 | 权限模型、`ALL_PAGE_KEYS`、守卫定义 |
| `web/server/index.ts` | — | 中间件、限速、路由挂载、CORS |

### 前端枢纽

| 文件 | 为什么是热点 |
|------|--------------|
| `web/client/src/components/MainLayout.tsx` | `navItems` / `PAGE_META` / `pageComponent()` / 权限 gating 全在这里 |
| `web/client/src/api.ts` | 所有前端请求方法 |
| `web/client/src/pages/Settings.tsx` | 用户权限勾选与列表列 |
| `web/client/src/styles/global.css` | 全局样式与 CSS 变量 |
| `web/client/src/main.tsx` | AntD ConfigProvider 主题 token |

### 协调者独占（worker 一律不准碰）

- `web/client/src/version.ts`
- `README.md`
- `.kiro/steering/**`
- `config.json`、`config.example.json`
- `data/**`

## 拆分检查清单

出任务表前逐条过：

- [ ] `design.md` 已通过闸门 G1
- [ ] 每个任务都能指到 `design.md` 的具体章节；指不过去说明方案有洞，回 P1 补
- [ ] `design.md` 里的每一节都被至少一个任务覆盖；有遗漏说明拆漏了
- [ ] 任意两个任务的"独占文件"集合**无交集**
- [ ] 每个枢纽文件在同一波次里最多被一个任务持有
- [ ] 协调者独占文件没有出现在任何任务里
- [ ] 每个任务有**可观测的验收命令**（能跑的命令或能点的页面操作），不是"实现完就行"
- [ ] 依赖链深度 ≤ 3。更深说明拆错了，应该合并成一个任务
- [ ] 每个任务能独立通过 `npm test`（不依赖别的任务先合进来）
- [ ] 涉及 `web/server/root-email-*` / `root-mail-*` / `mail-api*` 的任务，简报里写明"先读 `web/ROOT_EMAIL.md`"
- [ ] 涉及 README 第九节高危区的任务，简报里点名具体那一条约束

## 波次编排

把任务排成波次，**同一波次内全部并行起，波次之间串行**：

```
波次 1（无依赖，全并行）：后端模块 A、后端模块 B、前端页面 C
波次 2（依赖波次 1）：接线任务 D（独占 routes/aws.ts + api.ts + MainLayout.tsx）
波次 3（依赖波次 2）：端到端验证任务 E（可选，通常协调者自己做）
```

并行度建议 **2–4 个 worker**。再多的话协调者的审核和合并会成为瓶颈，而且 EC2 单实例、单 `db.json` 的本地开发环境也容易互相干扰。

## 本项目的常见拆分模板

### 新增一个可分配页面

- T1：后端业务模块（独占新建的 `web/server/<feature>.ts` + 对应测试）
- T2：前端页面（独占 `web/client/src/pages/<Feature>.tsx`）
- T3（依赖 T1+T2）：接线 —— `routes/aws.ts` 加路由与守卫、`api.ts` 加方法、`MainLayout.tsx` 加 `navItems`/`PAGE_META`/`pageComponent()`、`auth.ts` 加 `ALL_PAGE_KEYS`

注意 `routes/aws.ts` 的**路由注册顺序**：具体路径必须早于通配。已知易踩两处见 `.kiro/steering/project-context.md` 第八节。

### 新增一个独立权限字段

这个**不要拆**。它天然要同时动 `auth.ts`、`db.ts`、`routes/aws.ts`、`MainLayout.tsx`、`Settings.tsx`、`api.ts` 六个文件，拆开必撞。**一个任务做完**，串行。

### 纯后端增强（不动前端）

可以按模块自由并行，只要接线集中在一个收尾任务里。

### 涉及 AWS 跨账户新链路

先由协调者确认走哪条链路（`support-quota` 一级跳 / payer 自身 / `admin-console` / OAAR 二级跳），把结论写进简报。**不要让 worker 自己猜**——INVITED 账户没有 OAAR，猜错会得到一个在测试环境能过、在生产必炸的实现。
