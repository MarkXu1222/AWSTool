# 实现方案文档（design.md）大纲

`.kiro/specs/<需求名>/design.md` 的写法。

## 这份文档的唯一标准

**codex worker 看不到本会话的任何讨论。** 它拿到的只有任务简报 + 这份文档。

判据只有一条：**把这份文档交给一个没参与过讨论、但熟悉 TypeScript 的工程师，他能不能照着写出来，且写出来的和你想的一样？**

凡是写成"由实现者决定"、"视情况而定"、"合理处理"的地方，都不是方案，是把决策成本转嫁给了 worker——而 worker 会用它自己的判断填空，填出来的通常不是你要的。

---

## 大纲

### 1. 需求与验收

承接 `requirements.md`，一段话说清做什么。然后列验收标准，**每条都必须可执行**：

```
- [ ] 登录为 partadmin，账单页出现「按 payer 分组导出」按钮
- [ ] 点击后下载 CSV，列依次为 payer / 账户数 / 总额 / 币种
- [ ] cd web && npm test -- tests/billing-group-export.test.ts 通过
```

不要写"功能正常""体验良好"。

### 2. 现状分析

读完 README 和源码之后，**当前是怎么做的**：

- 相关模块现在的职责边界
- 现有的数据结构长什么样
- 现有的接口有哪些、返回什么
- 哪些现成的东西可以复用（明确点名函数/文件，不要说"复用已有逻辑"）

这一节是为了避免 worker 重造轮子，也避免你的方案和现状打架。

### 3. 方案总览

一段话 + 一张数据流图（ASCII 即可）。说清楚：请求从哪进来，经过哪几个模块，数据怎么变，结果怎么出去。

### 4. 数据模型变更

**没有变更也要写"无变更"**，不要留空。

有变更时必须写：

- `data/db.json` 新增/修改哪个顶层键，结构是什么
- **向后兼容怎么处理**——老数据没有这个字段时读出来是什么，要不要迁移
- `config.json` 新增哪个字段，是否必填，缺失时的降级行为

⚠️ `db.json` 的键是**按需创建**的。判断 schema 以 `web/server/db.ts` 的代码为准，不要拿本地 `db.json` 当权威（本地库通常只有前几个键）。

### 5. 后端设计

逐个模块写，每个模块包含：

**文件路径**（新建还是修改）

**导出的函数签名**——写全，带类型：

```ts
export async function exportByPayer(
  payerId: string,
  range: { from: string; to: string },
): Promise<{ csv: Buffer; rowCount: number }>
```

**路由**（如果有）：

| 方法 | 路径 | 守卫 | 请求体 | 响应 |
|------|------|------|--------|------|
| POST | `/api/aws/billing/export-by-payer` | `requireBillingAccess` | `{payerId, from, to}` | `{jobId}` |

⚠️ **守卫要点名，不要靠名字推**：
- `requireAdmin` 实际放行 **admin + partadmin**（只拦 viewer），名字有误导性
- `requireStrictAdmin` 才是只放 admin，且**从数据库实时读取**，不信任 JWT 里的 role
- MAP 标签的全部写端点用的是 `requireStrictAdmin`

⚠️ **路由注册顺序**：具体路径必须写在通配之前。写进方案里，别让 worker 自己发现。

### 6. 前端设计

- 页面文件路径，是新建页面还是改现有页面
- 组件结构（哪些是新组件，放哪）
- `api.ts` 要加的方法签名
- 页面属于哪一档：**可分配页面** / **独立权限页** / 纯后端无页面
  - 可分配页面：要在 `MainLayout.tsx` 的 `navItems`、`PAGE_META`、`pageComponent()` 各加一项（同一 key），再在 `auth.ts` 的 `ALL_PAGE_KEYS` 加同名 key
  - 独立权限页：**不要**加进 `PAGE_META` / `ALL_PAGE_KEYS`；要导出 `XXX_PAGE_KEY` 常量，补 `navItems`、`VALID_PAGE_KEYS`、`isPageAllowed()` 分支、`pageComponent()` 分支，**以及按 URL 直达时的 `independentAccess` 判断**——漏掉最后一条，有权限的用户直链进不去
- 样式约束：颜色只用 `var(--color-*)`，z-index 只用 `var(--z-*)`，字重 表头 500 / 卡片标题 600 / 页面标题 700，图标用 AntD 不用 emoji

### 7. AWS 链路（涉及跨账户时必写）

**不要让 worker 猜。** 明确写：

- 走哪条链路：一级跳 `support-quota` / payer 自身 `role/tool` / 一级跳 `admin-console` / 二级跳 OAAR
- 为什么是这条（例如：需要覆盖 INVITED 账户 → 必须走 `admin-console`，因为 INVITED 账户没有 OAAR）
- 需要哪些 IAM action
- 要不要排除 `restricted_accounts`
- 调用量级，会不会触发限流

⚠️ POC Cash 相关的 IAM action 前缀是 `partnercentral:`，**不是** `partnercentral-selling:`——写错整个策略静默失效。

### 8. 错误处理与边界

- 每个外部调用失败时怎么办（重试？降级？直接报错？）
- 超时设多少
- 并发/重入怎么处理
- 空数据、单条数据、超大数据量分别是什么行为

### 9. 测试计划

列出要新增或修改的测试文件，每个测试覆盖什么。`web/tests/` 下已有 17 个回归测试，**不要破坏它们**。

如果改动触及下列区域，对应测试必须跑通：

| 改动区域 | 守着它的测试 |
|---|---|
| Bedrock Profile 名匹配 | `tests/bedrock-delivery-name-match.test.ts` |
| Bedrock 账户 TPD | `tests/bedrock-account-tpd.test.ts` |
| 批量 Root 改密 | `tests/root-email*.test.ts`（8 个） |
| MAP 标签 | `tests/tag-compliance-policy.test.ts`、`tests/tag-extra-tag.test.ts` |
| POC Cash | `tests/poc-cash*.test.ts` |

### 10. 影响面与风险

- 这次改动会碰到 `README.md` 第九节哪些高危区？逐条点名，并写明怎么规避
- 有没有破坏性变更？老用户/老数据受影响吗
- 出问题的话，回滚需不需要额外处理数据（只回滚代码够不够）

### 11. 明确不做什么

把讨论中砍掉的、以后再说的、容易被 worker "顺手做了"的事写清楚。

这一节的作用是**防止 scope 蔓延**——worker 看到相邻的烂代码会想顺手重构，写在这里它就不会动。

---

## 写完后的自检

- [ ] 每个函数都有完整签名和类型，没有 `any`、没有"参数待定"
- [ ] 每个接口都有路径、方法、守卫、请求体、响应
- [ ] 每个权限判断都点名了具体守卫，没有靠名字推断
- [ ] AWS 链路写死了，没留给 worker 选
- [ ] 数据模型变更写了向后兼容，或明确写了"无变更"
- [ ] 验收标准全部可执行
- [ ] 高危区逐条点名并写了规避方式
- [ ] 有「不做什么」一节
- [ ] 通篇搜一遍"由实现者决定""视情况""酌情""合理"——**一处都不该有**

自检完调 `superpowers:writing-plans` 复核结构与任务粒度，再进闸门 G1。
