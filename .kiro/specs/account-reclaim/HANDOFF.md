# 账户回收 —— 进度交接（供新会话续作）

> 最后更新：2026-10-15。本需求走 **orca-dev-flow 七阶段四闸门**。
> G1 已批（2026-10-15）；`tasks.md` 已起草，目前处于 **P2 待 G2 审阅**。
> 五步编号已统一；具体接口与状态设计以当前 `design.md` 为准。

## 需求一句话

交付时客户拿到根邮箱及其密码、AWS Root 密码，并可能通过转发收邮件；回收时要切断这些旧的登录/找回入口，
避免客户再次通过“忘记密码”继续使用账户、产生费用。**本功能把工具箱与邮箱平台已有操作组合成一个回收流程**，
新增统一入口、顺序编排、进度与失败原因；不重写底层已有功能。账户和邮箱保留，新密码归平台控制。

现有「资源清理」页新增「账户回收」Tab：选 1–20 个成员账户、TOTP 确认后，后台按账户依次执行五步，
逐账户 × 逐步骤在页面显示进展与**失败原因**，完成后可查看、复制新的 AWS 密码与邮箱密码。

五步顺序（2026-10-14 P1 再次调整，已与用户确认，以此为准）：
1. 删除邮箱转发 → 2. 改邮箱密码（踢会话） → 3. 删除 Root MFA → 4. 允许恢复密码 → 5. 改 AWS Root 密码

> 调整理由：原顺序下第 4 步 AWS 重置邮件到达时客户仍持有旧邮箱密码 / 已登录的 IMAP 客户端，可抢先点链接。

关键规则（用户已拍板）：
- **每一步失败/未知都必须在页面写清楚：哪一步、什么原因、建议怎么办**，不能只显示「失败」。
- 第 1–4 步任一失败：该账户停止，后续步骤标「因第 N 步失败未执行」，可 TOTP 后从失败步重试。
- 第 5 步失败或 password_unknown：账户「部分完成」。明确未提交密码的失败可 TOTP 重试；
  password_unknown 绝不自动重试、不给重试按钮，建议用已收回的根邮箱手工走「忘记密码」。
- 第 5 步进入手工验证码时，回收页提供输入入口（复用 `RootManualCaptchaModal`，加可注入的取图/提交函数 props）。
- 回收产生的 root-email 任务（`origin:'account-reclaim'`）对 `/rootreset` 隐藏且不可操作。
- 预检：Root 邮箱不在 EwoMail 的账户、payer 自身，一律置灰不可选，并写明原因；受限账户（敏感权限客户）仅 admin 可回收，非 admin 置灰。
- 支持批量（每批 ≤ 20），页面逐账户逐步骤进度。
- 新 AWS 密码 + 新邮箱密码永久加密保存，可反复查看、复制，每次查看写审计。
- 新增独立权限字段 `account_reclaim_access`（none/operate），admin 恒 operate。
- 邮箱侧删除转发、改密及踢会话已有能力；邮箱平台由用户维护，AWSTool 只做调用适配。现有源码与生产 API 连通性分开核验。

## 已完成

- [x] P0 澄清：已问清所有关键点（上面"关键规则"即结论）。
- [x] `.kiro/specs/account-reclaim/requirements.md` —— 已落盘，完整。
- [x] `.kiro/specs/account-reclaim/mailbox-api-spec.md` —— 已落盘，作为既有邮箱能力的调用/联调契约。
- [x] `.kiro/specs/account-reclaim/design.md` —— 11 节草案已落盘；已纳入受限账户仅 admin 可回收及本轮“整合已有功能”的业务说明。
- [x] 代码对接点调研（结论见下方"对接点速查"）。

## 待做（按顺序）

- [x] 闸门 **G1**：2026-10-15 用户已批准 design.md（受限账户已统一为「仅 admin 可回收」）。
- [ ] P2 拆 `tasks.md`（文件所有权互斥）→ 闸门 G2。**2026-10-15 已落盘 7 个任务 / 4 波次，待用户批准 G2**；同时回写 design.md（对齐上线邮箱接口、补 `accountReclaimDeps` 测试注入点）。
      拆分规则见 `.claude/skills/orca-dev-flow/references/task-split.md`，可参照 `.kiro/specs/admin-console-on-demand/tasks.md`。
      提醒：`root-email-jobs.ts` / `root-email-core.ts` / `root-reset-permissions.ts` 三个文件须归同一任务（来源隔离、互斥、验证码注入互相牵连），
      该任务简报写明「先读 `web/ROOT_EMAIL.md`」；`db.ts`、`auth.ts`、`routes/aws.ts`、`index.ts`、`MainLayout.tsx`、`api.ts`、`Settings.tsx` 为枢纽文件，同一波次各只能归一个任务。
- [ ] P3 派 codex（`gpt-6-sol`，`--effort high`，核对 `launch.effective`）。
- [ ] P4 集成分支串行合并 + 审核 + `npm test && npm run typecheck && npm run build` 全绿。
- [ ] P5 发版（改 `web/client/src/version.ts` 的 `APP_VERSION`、README、project-context）→ 闸门 G3。
- [ ] P6 Claude 亲自部署 EC2 → 闸门 G4。邮箱侧接口上线后用授权测试账户联调五步。

## 当前设计摘要（实现细节见 design.md）

### 架构：方案 A —— 组合现有操作，第 5 步委托现有 Root 改密执行器
- 新建 `server/account-reclaim.ts`（服务 + 2 秒 tick 的 runner），`server/account-reclaim-core.ts`（纯函数/类型），
  `server/account-reclaim-permissions.ts`，`server/mailbox-admin-api.ts`（EwoMail 写接口 client）。
- 第 1/2/3/4 步同步调用现有能力；第 5 步向现有执行器投一个 `origin: 'account-reclaim'` 的单账户批次，然后按 root-email 任务终态推进。
- 同一时刻只执行一个回收同步步骤；第 5 步等待期间别的账户的 1/2/3/4 继续。

### 数据模型
- `data/db.json` 新增顶层键 `account_reclaim_jobs: AccountReclaimJob[]`（按需创建，旧库读出为 `[]`，无需迁移）。
  改 `db.ts` 的 `DBSchema` / `ARRAY_FIELDS` / `emptyDB`，加三个 db 方法（list/insert/update）。
- 每账户一条 job：id、batchId(=requestId)、accountId、accountName、email、payer、createdBy/UserId、
  status(queued/running/completed/partial/failed/cancelled)、steps(5 个，每个含 state/message/errorCode/时间)、
  rootEmailJobId、加密后的邮箱密码、retryCount。
- 邮箱密码加密复用 `db.ts` 的字段加密，新增 kind `'mailbox-password'`（在 `validateDecryptedField` 加分支、
  在 `migrateEncryptMFASecrets()` 加重加密循环，使密钥轮换时一并迁移）。
- AWS 新密码**不另存**，查看时从 root-email 任务用现有解密函数取（仅 password_set 的任务可取）。
- `RootEmailJob` 加两个可选字段 `origin?: 'account-reclaim'`、`reclaimJobId?`（`RootEmailInput` 同步放宽）。

### 权限
- 新字段 `account_reclaim_access`：仿 `root_reset_access` 的所有落点改一遍
  （`auth.ts` 的 /me、create、update + 校验；`db.ts` 的 `getAllUsers`；`Settings.tsx` 表单+列表列；`api.ts` 参数）。
- 守卫 `createAccountReclaimGuard`：仿 `createRootResetGuard`，实时查库，只放 operate（无 view 档），GET 也拦。
- **不**加进 `ALL_PAGE_KEYS` / `DEFAULT_PAGE_KEYS`。
- 执行器内第 5 步的实时权限复验：`authorize()` 按 `job.origin` 分流 —— 回收任务认 `account_reclaim_access`，
  原批量改密任务仍认 `root_reset_access`。

### 接口（前缀 `/api/aws/account-reclaim`，挂 `createAccountReclaimGuard`）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/catalog` | 可选账户 + 预检（邮箱托管/存在/启用、payer 自身、是否已有任务） |
| POST | `/batches` | `{accountIds, requestId, confirmAccountCount, totpCode}`，≤20，路由层校 TOTP |
| GET | `/batches`、`/batches/:id` | 列表、逐账户×5步状态（不含密码） |
| POST | `/jobs/:id/retry` | `{totpCode}`，从失败步继续 |
| POST | `/batches/:id/cancel` | 停未开始的账户 |
| POST | `/jobs/:id/credentials` | 返回明文 AWS 密码 + 邮箱密码，no-store，写审计 |

TOTP 用 `step-up-mfa.ts` 的 `verifyStepUpTotp`；失败走 root-email 同款审计模式。

### 前端
- `Cleanup.tsx` 改成两个 Tab：「账户回收」(新组件 `AccountReclaimPanel.tsx`) +「资源清理」(原内容抽成子组件)。
  Tab 是否显示按各自权限（原 cleanup 页权限 / account_reclaim_access）。
- `MainLayout.tsx`：`isPageAllowed('cleanup')` 和 `me()` 的 `independentAccess` 两处都要加
  「有 account_reclaim_access 也能进 cleanup」的分支（否则只授回收权限、无 cleanup 页权限的用户直链进不去）。
- 进度表每行一个账户、5 个步骤图标，悬浮显示 message，失败行内展开红色说明；完成行有「查看密码」弹窗（逐项复制）。
- 轮询仿 `BulkRootReset.tsx`：5 秒一次。样式遵守 coding-standards（`var(--color-*)`、AntD 图标不用 emoji 等）。

### 测试（新增，别破坏现有 37 个）
`tests/account-reclaim-core.test.ts`（状态机/密码生成/错误翻译）、`account-reclaim-service.test.ts`（五步编排全 mock，
覆盖：全成功 completed / 第2步失败 failed 且后续 not_run / 第4步 unknown 停止且第5步 not_run / 第5步安全失败重试成功 /
取消 / 重启恢复）、`mailbox-admin-api.test.ts`（签名、错误码映射、幂等）、`account-reclaim-permissions.test.ts`（权限矩阵）。

## 2026-10-14 第二会话新增结论（写 design.md 时纳入）

- 步骤 key 建议：`forward` / `mailbox_password` / `root_mfa` / `root_recovery` / `aws_password`。
- 第 1–4 步重启后重新执行即可（删转发幂等、MFA 无设备视为跳过、恢复已开启视为跳过、邮箱密码用同一密码幂等）。
- 第 5 步对 `/rootreset` 隐藏：在 `root-reset-permissions.ts` 的 `canViewRootEmailJob` / `canManageRootEmailJob` /
  `canRetrieveRootEmailManualLink` 对 `origin==='account-reclaim'` 返回 false；`prepareRootCredentialCsv` 另加来源拒绝
  （它不走 canView）。手工验证码的 `authorizedManualInput` 需改为接收权限判断函数，回收侧传回收权限。
- 第 5 步重试门槛直接用 `canRetryFailedRootEmailJob(rootJob)`；创建前若该账户已有 pending root-email 任务 → 拒绝并说明。
- 审计动作中文名要登记到 `server/audit-presentation.ts` 的 `explicitActions`。
- 关停：`index.ts:202` 的 `Promise.all` 里加回收 runner 的 stop；启动放在 `startRootEmailRunner()` 之后。
- `Cleanup.tsx` 建议最小改动：原组件在同文件内改名为 `ResourceCleanupPanel`，新默认导出按权限渲染两个 Tab。
- **2026-10-15 用户最终确认**：受限账户（敏感权限客户）仅 admin 可回收；非 admin 预检置灰，后端创建/重试/每步执行前同样校验「未受限或创建者当前为 admin」。取代同日早先「禁止回收」的写法。

## 对接点速查（已核实，file:line 以当时为准，续作前可再 grep 确认）

- 删 MFA：`web/server/aws-service.ts` `deleteRootMFA(accountId)` —— 无设备 throw（建议给它补 `code:'ROOT_MFA_NOT_ENABLED'`）；
  部分失败 return `{accountId,removed,failed}`；全失败 throw。
- 允许恢复密码：同文件 `recoverRootPassword(accountId)` —— 成功 return `{ok:true}`；已存在 throw 带 `code:'ROOT_PASSWORD_ALREADY_EXISTS'`。
- Root 自动改密：`web/server/root-email-jobs.ts` + `root-email-core.ts`。入队 `store.createBatchGroup(inputs,{batchId,autoSetPassword:true,payerAccountId,payerName})`；
  执行中 `authorize(job)`（root-email-jobs.ts:52）实时复验创建者权限；运行条件 `rootEmailAvailability()`；
  查看明文密码复用现有解密（仅 `status==='password_set' && credentialRetentionPolicy==='permanent'` 可取，见 `credentialAvailable`）。
  启动在 `index.ts:177` `startRootEmailRunner()`，runner 也做密钥轮换重加密。
- 目标账户校验：`root-email-core.ts` `selectRootEmailBatchTargets(accounts,payers,ids,payerAccountId='',max=20)` →
  `{accountId,email,payerAccountId,payerName}[]`。**注意：payer 自身能通过它的校验，回收要额外排除。**
- payer 列表：`aws-service.ts` `listConfiguredPayers()`。
- TOTP：`step-up-mfa.ts` `verifyStepUpTotp(identity,value,ip)`，失败 throw `StepUpMfaError`（有 statusCode）。
- 字段加密：`db.ts` `encryptField/decryptField/encryptedFieldUsesCurrentKey`，`EncryptedFieldKind='mfa'|'external-id'`（加 `'mailbox-password'`）；
  轮换迁移 `migrateEncryptMFASecrets()`。
- 每日备份：`db.ts` `backupJsonStores(DB_PATH)` 备份 db.json + root-email-jobs.json，保留 7 天。
  （account_reclaim_jobs 在 db.json 里，自动被备份；邮箱密码密文随 db.json 走。）
- 权限样板：全局 grep `root_reset_access` / `rootResetAccess` 看所有落点，照抄给 `account_reclaim_access`。
  关键文件：`auth.ts`、`db.ts:1073-1074`(getAllUsers)、`routes/aws.ts:358`(guard 挂载)、
  `components/MainLayout.tsx`(navItems/isPageAllowed/independentAccess)、`pages/Settings.tsx`、`api.ts:858-860`。
- 页面：`client/src/pages/Cleanup.tsx`(默认导出 CleanupPage，无 Tabs)；`BulkRootReset.tsx`(5 秒轮询样板，TOTP 确认框)。
- 邮箱 client 现状：`server/mail-api.ts`（只读 list/detail，单例 `mailbox`，签名空 body）——**不要改它**，另建 `mailbox-admin-api.ts`。
- 邮箱 SSM 读取复用：`server/mail-api-config.ts` `readMailApiSsmConfig(parameter)`。
- 测试脚本：`web/package.json` → `test`=`node --import tsx --test tests/*.test.ts`，
  `typecheck`=`tsc --noEmit`(client+server)，`build`=vite build + tsc + copy assets。

## 邮箱侧（复用已有能力，用户维护）
本轮已读取本地邮箱仓库 `api/Mailbox.class.php`，存在 `status/deleteForwards/setPassword/revokeSessions`。
按 `mailbox-api-spec.md` 对接 `/Api/Mailbox/lookup`、`/forwards/delete`、`/password`；
复核带 `scopes` 的 token `toolbox-reclaim` 与白名单 `54.255.131.45`，并确认调用配置已写入
SSM SecureString `/toolbox/mail-api-reclaim`（509399618054, us-east-1）。
AWSTool 侧新增环境变量 `MAIL_ADMIN_API_SSM_PARAMETER=/toolbox/mail-api-reclaim`。

**2026-10-15 邮箱侧已上线并完成线上验证（spec §7，29/29 通过；邮箱会话核实）：**
- 生产已部署（ewomail-admin `131d49e`），Base URL `https://admin.yottahub.ai`；Apache 层 `/Api/Mailbox` 只放行 `54.255.131.45`。
- SSM `/toolbox/mail-api-reclaim` 已写入（值 `{"keyId":"toolbox-reclaim","secret":"..."}`）。`toolbox-reclaim` 只有
  `mailbox:read`/`mailbox:write`，读不了邮件；只读邮件仍用原 `/toolbox/mail-api`（旧 `toolbox` key 调 `/Api/Mailbox/*` 得 403 `SCOPE_DENIED`）。
- **与 spec 的差异**：改密后不做 auth cache flush（邮箱服务器未开 Dovecot 认证缓存，改密即时生效；邮箱侧巡检每日确认），只踢会话。
  改密 500 的 `msg` 为 `doveadm who failed: ...` / `doveadm kick failed: ...`（不会出现 auth cache flush），密码已写入，同一密码重试幂等。
- 错误码与 spec §3 一致，另有 404 `NOT_FOUND`（路径写错）、403 `HTTPS_REQUIRED`。邮箱侧文档：ewomail-admin `docs/账户回收接口.md`。

## 硬规则提醒（来自 deployment.md / orca-dev-flow）
- 禁止 `git add -A`/`git add .`；只 add 具体代码文件；提交前 `git status` 确认没 staged `data/`、`config.json`。
- EC2 禁止 `git stash`/`git checkout -- data/`/`git reset --hard`。
- worker 不准改 `version.ts`/`README.md`/`project-context.md`/`config.json`/`data/**`。
- 碰 root-email 模块前先读 `web/ROOT_EMAIL.md`；password_unknown 绝不自动重试。
- 实现一律 `gpt-6-sol --effort high`，核对回执 `launch.effective`。

## 新会话怎么起
先读本文件、requirements.md、design.md、mailbox-api-spec.md。设计草案已经完成，保留“组合已有功能、收回交付入口”
的业务定位，按用户评审意见修订并完成 G1；用户明确批准后才进入 P2，不重新从零起草或重写现有邮箱/Root 能力。
