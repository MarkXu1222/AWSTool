# 派发简报 —— account-reclaim（T2–T7）

> 用法：在 Orca 托管终端里，每个任务一次 `worker-start --spec "<下方对应简报全文>"`，
> 显式带 `--agent codex --model gpt-6-sol --effort high`，派发后核对回执 `launch.effective` 确为 `gpt-6-sol`。
> T1 已由协调者完成（`0083ed5`），所有 worker 的 git base 必须是本地分支 `integration/account-reclaim`（含 T1）。
> 派发后用 `orca orchestration worker-show --dispatch <id> --json` 核对分支落点；落在 `main` 上就停下，不要继续。
>
> 波次：**波次 1** 并行 T2、T3、T7 → **波次 2** T4 → **波次 3** T5 → **波次 4** T6。
> 后一波必须在前一波由协调者合入 `integration/account-reclaim` 之后再派，base 用合入后的最新提交。

以下各简报共用的部分（每份简报末尾都已包含，派发时整段复制即可）：

```
【公共约束】
- 先读完 .kiro/specs/account-reclaim/design.md（至少 §1 §2 §3 和你负责的章节）与 tasks.md 中你这个任务的「边界与点名约束」。
  方案里写死的签名、路径、守卫、链路一律照做；觉得方案有问题用 ask 问协调者，不要自己改方案。
- 已存在、可直接 import 的 T1 产物：web/server/account-reclaim-core.ts、web/server/account-reclaim-permissions.ts，
  以及 db.ts 的 listAccountReclaimJobs / insertAccountReclaimJobs / updateAccountReclaimJob、'mailbox-password' 字段加密。不要修改它们。
- 禁止触碰：web/client/src/version.ts、README.md、web/ROOT_EMAIL.md、.kiro/**、config*.json、data/**、web/package*.json，以及不在你独占清单里的任何文件。
  需要改它们才能完成时：不要改，用 ask 问协调者。
- 不新增 npm 依赖。测试一律用替身，不连真实邮箱、AWS、生产库，不读取真实 config.json 中的密钥，不创建含真实凭证的 fixture。
- 只 git add 你独占清单里的文件；禁止 git add -A / git add .。提交信息用 conventional commits（feat: / fix: / test:）。
- 后端 tsx 直跑不编译。
- 完成：你的验收命令 + `cd web && npm test && npm run typecheck` 全绿后 worker_done --outcome succeeded，附三句执行摘要与 --files-modified；
  任何一项没绿就 --outcome failed 并写清卡在哪。
```

---

## T2 邮箱写接口 client

```
【任务】新建邮箱写接口 HTTP 适配层 web/server/mailbox-admin-api.ts 及其测试。

【先读这个】design.md §5.3（全部）、§4.3（环境变量）、§8.2（邮箱类错误码行）；mailbox-api-spec.md 全文，顶部「上线差异」优先于正文。
参照（只读，不修改）：web/server/mail-api.ts（签名、串行队列、429、响应上限的既有写法）、web/server/mail-api-config.ts（readMailApiSsmConfig）、web/ROOT_EMAIL.md 的邮件索引配置章节。

【你独占的文件】
- web/server/mailbox-admin-api.ts（新）
- web/tests/mailbox-admin-api.test.ts（新）

【要做的改动】按 design.md §5.3 的导出签名实现 lookup / deleteForwards / setPassword、MailboxAdminApiError、mailboxAdminApiConfigured、单例 mailboxAdmin。
§5.3 末尾「P2 补充」的两点（INTERNAL_ERROR 的两句固定文案、可选 timeoutMs）必须照做——T1 的错误翻译依赖这两句文案。
配置只读 MAIL_ADMIN_API_SSM_PARAMETER，不回退 MAIL_API_SECRET / MAIL_API_SSM_PARAMETER；写请求绝不透明自动重试。

【验收】cd web && node --import tsx --test tests/mailbox-admin-api.test.ts tests/mail-api.test.ts
测试至少覆盖 design.md §9 的 mailbox-admin-api 行。

<公共约束>
```

## T3 Root MFA / 恢复密码函数加固

```
【任务】加固 web/server/aws-service.ts 中 deleteRootMFA 与 recoverRootPassword 两个函数，并新增测试。

【先读这个】design.md §5.7 第一段、§7；README「跨账户访问模型」章节。

【你独占的文件】
- web/server/aws-service.ts（只改这两个函数，其余不动）
- web/tests/aws-root-credentials.test.ts（新）

【要做的改动】见 tasks.md「T3」小节：无设备时错误补 code='ROOT_MFA_NOT_ENABLED'（保留原 message）；部分失败返回值与全部失败 throw 的语义不变；
两个函数的 IAM 请求改用文件内已有的 withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, ...)，deleteRootMFA 补 finally 释放 client。链路与 task policy 不改。
现有调用方（routes/aws.ts）行为保持不变，不要改路由。

【验收】cd web && node --import tsx --test tests/aws-root-credentials.test.ts
测试用 t.mock.method(STSClient.prototype / IAMClient.prototype, 'send') 替身覆盖：无设备 code、部分失败、全部失败、已存在恢复条件 code、client 被释放。

<公共约束>
```

## T7 前端

```
【任务】在 /cleanup 页新增「账户回收」Tab，补用户权限设置，并让 RootManualCaptchaModal 支持注入取图/提交函数。

【先读这个】design.md §6 全部、§5.4（DTO）、§5.6（接口表）；.kiro/steering/coding-standards.md 的 Frontend Style Rules。
T1 已在 web/server/account-reclaim-core.ts 定义了 DTO（含 catalog 账户项的 restricted?: boolean，用于给 admin 显示「受限账户」Tag），api.ts 里按它镜像类型。

【你独占的文件】
- web/client/src/components/AccountReclaimPanel.tsx（新）
- web/client/src/pages/Cleanup.tsx
- web/client/src/components/MainLayout.tsx
- web/client/src/components/RootManualCaptchaModal.tsx
- web/client/src/pages/Settings.tsx
- web/client/src/api.ts
- web/client/src/styles/global.css
- web/tests/account-reclaim-ui.test.ts（新）

【要做的改动】见 tasks.md「T7」小节，逐条照做。重点：MainLayout 的 isPageAllowed('cleanup') 与 /me 初始化的 independentAccess 两处都要加回收权限分支；
canCleanup 与 canReclaim 分开计算；BulkRootReset.tsx、RootEmailPanel.tsx 不改（类型收窄迫使改动时停下来 ask）；回收侧传给验证码弹窗的 id 是 reclaim job ID。
后端接口此时尚未接线，页面与测试一律用替身 API 函数。

【验收】cd web && node --import tsx --test tests/account-reclaim-ui.test.ts && npm run typecheck && npx vite build --config client/vite.config.ts
UI 测试用已有依赖 jsdom + react-dom/client，覆盖 design.md §9 的 account-reclaim-ui 行。

<公共约束>
```

## T4 Root 模块接入与来源隔离（波次 2，T1 已合入即可派）

```
【任务】让现有 Root 改密执行器支持 origin='account-reclaim' 的任务：内部 bridge、来源隔离、双向互斥、人工验证码权限注入。

【先读这个】web/ROOT_EMAIL.md 全文（必须）；design.md §4.2（origin / reclaimJobId）与 §5.5 全部；README「批量 Root 改密」章节与第九节对应高危区条目。
高危约束：password_unknown 绝不自动重试；提交边界、单浏览器执行槽、自动重试上限、永久凭证策略一律不改；root-email-jobs.ts 不得 import account-reclaim.ts。

【你独占的文件】
- web/server/root-email-core.ts
- web/server/root-email-jobs.ts
- web/server/root-reset-permissions.ts
- web/tests/root-reset-permissions.test.ts
- web/tests/root-email.test.ts
- web/tests/root-email-manual.test.ts

【要做的改动】见 tasks.md「T4」小节，逐条照做；§5.5 的五个 bridge 导出签名、authorizedManualInput 的可选 check 参数签名照抄 design.md。
回收权限判断使用 T1 的 canManageAccountReclaimRootJob；关联核对只查 db（db.listAccountReclaimJobs），不反向依赖编排服务。

【验收】cd web && node --import tsx --test tests/root-email.test.ts tests/root-email-selection.test.ts tests/root-email-manual.test.ts tests/root-email-execution-slot.test.ts tests/root-email-reconcile.test.ts tests/root-email-network.test.ts tests/root-email-security-frame.test.ts tests/root-reset-permissions.test.ts tests/root-mail-links.test.ts
测试覆盖 design.md §9 中 root-reset-permissions / root-email / root-email-manual 三行。

<公共约束>
```

## T5 回收编排服务（波次 3，T1–T4 合入后派）

```
【任务】新建账户回收编排服务 web/server/account-reclaim.ts（catalog、创建、重试、取消、凭证查看、人工验证码包装、2 秒 tick runner）及其测试。

【先读这个】design.md §5.4 全部（含「测试注入点」accountReclaimDeps）、§5.6 审计与飞书段落、§7 受限账户段落、§8 全部；tasks.md「T5」小节。
依赖（已合入，只调用不修改）：T1 core/permissions/db 方法、T2 mailboxAdmin、T3 deleteRootMFA/recoverRootPassword、T4 root-email-jobs 的 bridge 导出与 rootEmailAvailability。

【你独占的文件】
- web/server/account-reclaim.ts（新）
- web/tests/account-reclaim-service.test.ts（新）

【要做的改动】按 §5.4 导出签名逐个实现；所有外部调用经 accountReclaimDeps 发出。业务审计用 db.addAuditLog，飞书用现有 sendNotification，不改 notify.ts。
TOTP 校验不在服务里（路由层做）。受限账户判断读 db.getRestrictedAccounts()，任意状态记录都算受限。

【验收】cd web && node --import tsx --test tests/account-reclaim-service.test.ts
测试覆盖 design.md §9 中 service 行、持久化/竞态组、临时 DB 组，以及受限账户矩阵（见 tasks.md T5）。DB 隔离参照 tests/account-reclaim-core.test.ts 的 DB_PATH 临时目录写法。

<公共约束>
```

## T6 后端接线（波次 4，T5 合入后派）

```
【任务】把账户回收接入路由、服务启停与审计中文名，并新增路由测试。

【先读这个】design.md §5.6 全部、§5.7 启动与关停段落；tasks.md「T6」小节；README 第九节 CORS 与路由注册顺序相关条目。

【你独占的文件】
- web/server/routes/aws.ts
- web/server/index.ts
- web/server/audit-presentation.ts
- web/tests/account-reclaim-routes.test.ts（新）

【要做的改动】见 tasks.md「T6」小节逐条照做：守卫挂载位置与注册顺序、创建/重试先查重放再校 TOTP、TOTP 失败审计、res.locals.audited、credentials no-store、
index.ts 启动顺序与 shutdown 的 Promise.all、audit-presentation 的 8 个动作中文名。CORS 回调不动。

【验收】cd web && node --import tsx --test tests/account-reclaim-routes.test.ts tests/audit-middleware.test.ts && npm run build
测试覆盖 design.md §9 的 account-reclaim-routes 行。

<公共约束>
```
