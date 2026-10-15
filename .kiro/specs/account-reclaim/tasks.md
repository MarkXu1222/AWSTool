# 任务拆分 —— account-reclaim

> 前置：`design.md` 已通过闸门 G1（2026-10-15）。所有任务的唯一依据是同目录 `design.md`；邮箱接口以 `mailbox-api-spec.md`（含顶部「上线差异」）为准。
> P2 回写 design.md（不改设计思路，见其顶部状态行）：邮箱改密不做认证缓存刷新；补 `NOT_FOUND`/`HTTPS_REQUIRED`；新增测试注入点 `accountReclaimDeps`（§5.4）；受限账户矩阵测试归 service 测试（§9）。
> 执行方式（2026-10-15 调整）：T1 由 Claude 在 VSCode 会话直接实现。实现 T2 时 Claude 的输出被安全审查拦截（与此前起草 tasks.md 被拦同类），
> 用户选择 **T2–T7 由用户在 Orca 托管终端派 codex（gpt-6-sol / high）实现**，Claude 只做审核、串行合并到 `integration/account-reclaim` 与后续阶段。
> 派发简报见同目录 `briefs.md`。四道闸门不变。
>
> **实际执行记录**：T1 `0083ed5`（Claude）；T3 `7ac57c7`；T7 `02a1b8a`；T2 `57896d5` + 审核返工 `96afc7f`（codex，Run `run_bd066de5c0e9`）；T4–T6 进行中。
> T1 相对 design 的增补：catalog 账户项增加 `restricted?: boolean`（前端给 admin 显示「受限账户」Tag 用），P5 回写 design.md §5.4。

| # | 任务名 | 独占文件 | 依赖 | design.md 章节 | 验收命令 |
|---|--------|----------|------|----------------|----------|
| T1 | 回收核心 + 权限 + 存储 | `web/server/account-reclaim-core.ts`（新）<br>`web/server/account-reclaim-permissions.ts`（新）<br>`web/server/db.ts`<br>`web/server/auth.ts`<br>`web/tests/account-reclaim-core.test.ts`（新）<br>`web/tests/account-reclaim-permissions.test.ts`（新） | — | §4.1 §4.2（邮箱密码加密 kind 与轮换） §4.3（用户字段） §5.1 §5.2 §5.4（DTO 类型定义） §8.1（Root 状态映射） §8.2（错误翻译） | `cd web && node --import tsx --test tests/account-reclaim-core.test.ts tests/account-reclaim-permissions.test.ts && npm test && npm run typecheck` |
| T2 | 邮箱写接口 client | `web/server/mailbox-admin-api.ts`（新）<br>`web/tests/mailbox-admin-api.test.ts`（新） | — | §4.3（环境变量） §5.3 §8.2（邮箱类错误码） | `cd web && node --import tsx --test tests/mailbox-admin-api.test.ts tests/mail-api.test.ts && npm test && npm run typecheck` |
| T3 | Root MFA / 恢复密码函数加固 | `web/server/aws-service.ts`<br>`web/tests/aws-root-credentials.test.ts`（新） | — | §5.7 第一段 §7 | `cd web && node --import tsx --test tests/aws-root-credentials.test.ts && npm test && npm run typecheck` |
| T4 | Root 模块接入与来源隔离 | `web/server/root-email-core.ts`<br>`web/server/root-email-jobs.ts`<br>`web/server/root-reset-permissions.ts`<br>`web/tests/root-reset-permissions.test.ts`<br>`web/tests/root-email.test.ts`<br>`web/tests/root-email-manual.test.ts` | T1 | §4.2（origin / reclaimJobId） §5.5 | `cd web && node --import tsx --test tests/root-email.test.ts tests/root-email-selection.test.ts tests/root-email-manual.test.ts tests/root-email-execution-slot.test.ts tests/root-email-reconcile.test.ts tests/root-email-network.test.ts tests/root-email-security-frame.test.ts tests/root-reset-permissions.test.ts tests/root-mail-links.test.ts && npm test && npm run typecheck` |
| T5 | 回收编排服务 | `web/server/account-reclaim.ts`（新）<br>`web/tests/account-reclaim-service.test.ts`（新） | T1 T2 T3 T4 | §5.4 §5.6（业务审计与飞书事件） §7（受限账户） §8 | `cd web && node --import tsx --test tests/account-reclaim-service.test.ts && npm test && npm run typecheck` |
| T6 | 后端接线：路由 / 启停 / 审计名 | `web/server/routes/aws.ts`<br>`web/server/index.ts`<br>`web/server/audit-presentation.ts`<br>`web/tests/account-reclaim-routes.test.ts`（新） | T5 | §5.6 §5.7（启动与关停） | `cd web && node --import tsx --test tests/account-reclaim-routes.test.ts tests/audit-middleware.test.ts && npm test && npm run typecheck` |
| T7 | 前端：回收 Tab / 权限 / 验证码复用 | `web/client/src/components/AccountReclaimPanel.tsx`（新）<br>`web/client/src/pages/Cleanup.tsx`<br>`web/client/src/components/MainLayout.tsx`<br>`web/client/src/components/RootManualCaptchaModal.tsx`<br>`web/client/src/pages/Settings.tsx`<br>`web/client/src/api.ts`<br>`web/client/src/styles/global.css`<br>`web/tests/account-reclaim-ui.test.ts`（新） | —（只依赖 §5.4 DTO 与 §6.3 接口契约） | §6 §5.4（DTO） | `cd web && node --import tsx --test tests/account-reclaim-ui.test.ts && npm run typecheck && npx vite build --config client/vite.config.ts`；页面验收在 P6 |

## 各任务的边界与点名约束

### T1 回收核心 + 权限 + 存储
- core / permissions **不读写 db、不调外部服务**；core 只 `import type` `RootEmailJob`。
- `translateAccountReclaimError()` 识别邮箱错误靠鸭子类型（读 `.code` / `.statusCode` / `.uncertain` / `.retryAfterMs`），**不 import `mailbox-admin-api.ts`**，保证 T1 与 T2 独立。
- `db.ts`：`DBSchema` / `ARRAY_FIELDS` / `emptyDB()` 加 `account_reclaim_jobs`；`listAccountReclaimJobs` / `insertAccountReclaimJobs`（单次 `writeDB`）/ `updateAccountReclaimJob`（不可变字段 + revision CAS，失败抛 409）；`EncryptedFieldKind` 加 `'mailbox-password'`，`validateDecryptedField()` 按 §5.1 规则校验，`migrateEncryptMFASecrets()` 纳入重加密与迁移审计；`getAllUsers()` 暴露标准化 `account_reclaim_access`。**不得**按条数/时间裁剪回收记录。
- `auth.ts`：`/me` 返回 `accountReclaimAccess`；create/update 接受 camelCase、存 snake_case，非法值 400；admin 恒 operate。**不改** `ALL_PAGE_KEYS` / `DEFAULT_PAGE_KEYS`。
- 测试 DB 隔离沿用现有做法：`DB_PATH` 指向临时目录、`ALLOW_DB_INITIALIZATION=true`、测试专用 `ENCRYPTION_KEY`（参照 `tests/temp-admin.test.ts`），不读真实 `data/`。
- 受限账户矩阵不在本任务测试（需读 `restricted_accounts`，归 T5）。

### T2 邮箱写接口 client
- 先读 `web/ROOT_EMAIL.md` 的邮件索引章节和 `server/mail-api.ts` 的签名实现作参照；**不修改** `mail-api.ts`、`mail-api-config.ts`，只调用 `readMailApiSsmConfig()`。
- 以 `mailbox-api-spec.md` 顶部「上线差异」为准：成功改密 = 写入 + 踢会话；500 `msg` 前缀 `doveadm who failed:` / `doveadm kick failed:` 要作为可识别的子动作透出（供 T1 的翻译表用固定码映射，不透传原文）。
- 写请求（`forwards/delete`、`password`）**绝不透明自动重试**；429 只记录下次可调用时间。
- 环境变量 `MAIL_ADMIN_API_SSM_PARAMETER` 未设置时 `mailboxAdminApiConfigured()===false`，不回退旧 `/toolbox/mail-api`。
- 测试不连真实邮箱、不读真实 SSM：通过构造函数注入 `config` 与 `transport`。

### T3 Root MFA / 恢复密码函数加固
- 高危区（AWS 跨账户）：链路固定 payer → `AssumeRoot`，**不改链路、不改 task policy**。
- `deleteRootMFA()` 无设备时 throw 的错误补 `code:'ROOT_MFA_NOT_ENABLED'`，保留原 message；部分失败仍 return `{accountId,removed,failed}`；全部失败仍 throw。
- 两个函数的 IAM 请求改为 `withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, ...)`，`deleteRootMFA` 补 `finally { iamRoot.destroy() }`；`recoverRootPassword` 的 `ROOT_PASSWORD_ALREADY_EXISTS` 语义不变。
- 现有调用方（`routes/aws.ts` 的单账户删 MFA / 恢复密码接口）行为不变，因此本任务不碰路由。
- 测试用 `t.mock.method(STSClient.prototype, 'send')` / `IAMClient.prototype.send` 替身；若 `assumeRoot` 需要 payer 配置，用临时配置隔离，**不读取真实 `config.json` 里的密钥**。

### T4 Root 模块接入与来源隔离
- **先读 `web/ROOT_EMAIL.md` 全文**。高危区「批量 Root 改密」：`password_unknown` 绝不自动重试；提交边界、单浏览器执行槽、自动重试上限、永久凭证策略一律不改。
- `root-email-jobs.ts` 只依赖 T1 的类型/权限函数与 `db`，**不得 import `account-reclaim.ts`**（避免循环依赖）。
- 内容：`RootEmailJob`/`RootEmailInput` 加 `origin?` / `reclaimJobId?`，加载、入队幂等比较、`createRetry()` 保留并校验来源；五个 bridge 导出（§5.5）；`authorize()` 按 origin 分流；普通 `submitRootEmail` / `submitRootEmailBatch` / `retryRootEmailJob` 对未结束回收账户拒绝（双向互斥）；`root-reset-permissions.ts` 三个 can* 遇回收来源恒 false（含 admin）；`prepareRootCredentialCsv()` 在 claim/解密前拒绝回收来源；`authorizedManualInput()` 与两个人工验证码导出加可选 `check` 参数，默认原 `canManageRootEmailJob`，旧路由实参不变。
- 两份 JSON 的中断恢复协议（§5.5 1–5 条）由 bridge 侧实现「按 attempt.requestId/origin/reclaimJobId 先查后建」，不生成新 UUID。

### T5 回收编排服务
- 按 design §5.4「测试注入点」导出 `accountReclaimDeps`，服务内所有外部调用经它发出；测试用 `t.mock.method(accountReclaimDeps, ...)` 替换，不连真实邮箱/AWS/浏览器。
- 业务审计（创建、重试、取消、终态、查看凭证）由服务用 `db.addAuditLog` 写入；TOTP 失败审计（`ACCOUNT_RECLAIM_MFA_FAILED`）由 T6 路由写。飞书只用现有 `sendNotification(title, content)`，内容仅脱敏元数据，**不改 `notify.ts`**。
- 受限账户：任意状态的 `restricted_accounts` 记录都算受限；创建、重试、每步外部动作前实时读库判断「未受限或创建者当前为 admin」，否则 `ACCOUNT_RESTRICTED`。
- 第 4 步 unknown **不得**继续第 5 步；第 2 步失败/未知阻断 3–5，重试复用同一已加密密码。
- 测试必须覆盖 design §9 中 service 行、持久化/竞态组、临时 DB 组，以及受限账户矩阵。

### T6 后端接线
- `awsRouter.use('/account-reclaim', createAccountReclaimGuard(...))` 挂在所有回收具体路由之前，且整组注册在任何账户通配路由（如 `/accounts/:id/detail`、`/quotas/:accountId/:serviceCode`）之前。
- 创建/重试路由：先 `findAccountReclaimBatchReplay()`，无记录才 `verifyStepUpTotp()`；显式审计成功后 `res.locals.audited = true`。
- credentials 响应 `Cache-Control: no-store`；审计失败不发明文。
- `index.ts`：启动顺序 billing 单实例锁 → `startRootEmailRunner()` → `startAccountReclaimRunner()`；shutdown 的 `Promise.all` 加 `stopAccountReclaimRunner()`。CORS 回调不动。
- `audit-presentation.ts` 的 `explicitActions` 登记 §5.6 的 8 个动作中文名。

### T7 前端
- 颜色只用 `var(--color-*)`，z-index 只用 `var(--z-*)`，字重 500/600/700，AntD 图标，无 emoji、无 hex，成功提示无感叹号；重复 3 次以上的样式进 `global.css`。
- `Cleanup.tsx`：原默认组件同文件改名 `ResourceCleanupPanel`，原扫描/删除逻辑不改；新默认导出 `CleanupPage({canCleanup, canReclaim})`。
- `MainLayout.tsx`：`isPageAllowed('cleanup')` 与 `/me` 初始化的 `independentAccess` **两处都要**加回收权限分支，否则仅回收权限的用户直链进不去；`canCleanup` 与 `canReclaim` 分开计算。
- `RootManualCaptchaModal.tsx`：只加可选 `fetchCaptcha` / `submitCaptcha` props，默认旧 Root API；`BulkRootReset.tsx`、`RootEmailPanel.tsx` **不改**（若类型收窄迫使它们改动，停下来回报协调者）。回收侧传入的 id 必须是 reclaim job ID。
- 密码明文只在弹窗组件状态里，关闭/切批次/权限失效即清空；不写 storage、URL、console。
- UI 测试：项目目前没有前端渲染测试先例；在测试文件内用已有依赖 `jsdom` 建全局 DOM、`react-dom/client` 渲染，**不新增 npm 依赖**。API 用替身函数，不发真实请求。

## 全局约束（所有任务）

- 不改 `web/client/src/version.ts`、`README.md`、`web/ROOT_EMAIL.md`、`.kiro/steering/**`、`config*.json`、`data/**`（P5 由协调者统一改）。
- 不新增 npm 依赖，不动当前未提交的 `web/package-lock.json` 改动。
- 只 `git add` 本任务独占文件；禁止 `git add -A` / `git add .`；提交前 `git status` 确认无 `data/`、`config.json`。
- 测试一律用替身，不连真实邮箱、AWS、生产库，不创建含真实凭证的 fixture。

## 波次

- **波次 1**（互不依赖）：T1（持 `db.ts`、`auth.ts`，已完成）、T2、T3（持 `aws-service.ts`）、T7（持 `api.ts`、`MainLayout.tsx`、`Settings.tsx`、`global.css`）
- **波次 2**：T4（依赖 T1）
- **波次 3**：T5（依赖 T1–T4）
- **波次 4**：T6（持 `routes/aws.ts`、`index.ts`；依赖 T5）
- 实际执行：T1 已由 Claude 提交；T2/T3/T7 由 codex 并行，协调者逐个审核后串行合入 `integration/account-reclaim`，再按波次派 T4 → T5 → T6（base 均为合入后的最新提交）；全部合完后在集成分支全量 `npm test && npm run typecheck && npm run build`，再派独立审核子代理。

依赖链：T1 → T4 → T5 → T6，深度 3（上限）。

## 拆分检查清单

- [x] `design.md` 已通过闸门 G1
- [x] 每个任务都能指到 `design.md` 的具体章节
- [x] `design.md` 每一节都被覆盖：§4.1→T1；§4.2→T1（邮箱密码）/T4（origin）；§4.3→T1（用户字段）/T2（环境变量）；§5.1/§5.2→T1；§5.3→T2；§5.4→T5（DTO 类型在 T1，前端镜像在 T7）；§5.5→T4；§5.6→T6（路由/审计名）/T5（业务审计与通知）；§5.7→T3（AWS 函数）/T6（启停）；§6→T7；§7→T3/T5；§8→T1（映射与翻译）/T5（编排边界）；§9 按测试文件分摊到各任务；§1–3、§10–11 说明性
- [x] 任意两个任务的独占文件无交集
- [x] 枢纽文件：`db.ts`、`auth.ts`→T1；`aws-service.ts`→T3；`routes/aws.ts`、`index.ts`→T6；`api.ts`、`MainLayout.tsx`、`Settings.tsx`、`global.css`→T7；同一波次内每个枢纽文件只有一个持有者
- [x] 协调者独占文件不在任何任务里
- [x] 每个任务有可执行的验收命令
- [x] 依赖链深度 3（≤ 3）
- [x] 每个任务基于集成分支（含其依赖）可独立通过 `npm test`
- [x] 涉及 `mail-api*` / `root-email-*` 的 T2、T4 已写明先读 `web/ROOT_EMAIL.md`
- [x] 涉及高危区的 T3（跨账户 AssumeRoot）、T4（批量 Root 改密）、T6（路由注册顺序、CORS 不动）、T7（前端样式规范）已点名具体约束
