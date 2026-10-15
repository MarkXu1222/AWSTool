# 实现方案：账户回收

> 状态：**G1–G4 已批准，P3/P4 完成，0.56.0 已于 2026-10-15 部署，生产只读检查通过**。最终运行代码 `main` / `b9db13b`；真实账户五步与真实角色权限矩阵待验收。见 DEPLOYMENT-RESULT.md / RELEASE-CHECKLIST.md。
> 2026-10-15 P2 回写（对齐已上线邮箱接口 + 拆分补充，不改设计思路）：① 邮箱改密不做认证缓存刷新（邮箱服务器未开 Dovecot 认证缓存，改密即时生效），成功只代表密码写入 + 踢会话；② 补 404 `NOT_FOUND`、403 `HTTPS_REQUIRED` 映射；③ §5.4 新增测试注入点 `accountReclaimDeps`；④ 受限账户矩阵测试归 service 测试（§9）。
> 起草日期：2026-10-15（Asia/Kuala_Lumpur）。依据：同目录 `HANDOFF.md`、`requirements.md`、`mailbox-api-spec.md`，并复核当前源码、`web/ROOT_EMAIL.md` 与项目 steering。
> 本次用户补充确认（2026-10-15 最终版）：**受限账户（敏感权限客户）仅 admin 可回收**。非 admin 预检置灰；admin 可勾选，确认框单独提示。回收由批次创建者身份执行，因此「创建者当前为 admin」是受限账户每一步的前置条件。该结论取代此前「禁止回收」与「只提醒」两种写法。
> 统一步骤编号：**1 删转发 → 2 改邮箱密码并踢会话 → 3 删 Root MFA → 4 允许恢复密码 → 5 改 AWS Root 密码**。requirements.md 与 HANDOFF.md 的执行器编号和测试例子已同步。
> 本草案补充的工程约束：共享根邮箱拒绝回收、双向任务互斥、跨文件入队补关联。它们用于避免影响其他账户或重复执行，在 G1 一并审阅。
> 2026-10-15 业务定位补充：本功能将工具箱与邮箱平台已有操作组合成统一账户回收流程；新增代码负责入口、编排、状态与调用适配，底层业务能力继续复用。

## 1. 需求与验收

交付账户时，客户取得 AWS Root 密码、根邮箱及邮箱密码，并可能配置收取该邮箱邮件的转发。回收时必须同时处理这些入口：
客户若仍能登录根邮箱或收到转发邮件，就可能再次通过 AWS“忘记密码”恢复访问并继续使用账户、产生费用。
因此，本功能的业务目标是收回交付给客户的登录与找回入口的控制权，将原本分散的现有操作一次执行完整。

“清除”指删除客户转发、使旧邮箱和 AWS 密码失效、移除客户 Root MFA；账户与邮箱保留并归我们控制。
新密码由平台保存，恢复邮件后续仍送达我们控制的根邮箱。

业务流程固定为：选择账户并预检 → 核对清单/数量及 TOTP → 执行下列五步 → 核验结果并展示新密码。

| 顺序 | 操作 | 对回收的作用 | 复用能力 |
|---|---|---|---|
| 1 | 删除邮箱转发 | 切断客户通过转发接收恢复邮件的入口，保留本邮箱收信。 | 邮箱平台现有删除转发。 |
| 2 | 改邮箱密码并踢旧会话 | 使旧邮箱密码失效，停止旧 IMAP/POP3 会话，先收回根邮箱。 | 邮箱平台现有改密及会话吊销（未开认证缓存，改密即时生效）。 |
| 3 | 删除 Root MFA | 移除客户绑定的 Root MFA。 | 工具箱现有 deleteRootMFA。 |
| 4 | 允许恢复密码 | 满足平台重置 Root 密码的条件；此时恢复邮件的接收入口已收回。 | 工具箱现有 recoverRootPassword。 |
| 5 | 改 AWS Root 密码 | 使客户旧 AWS 密码失效，建立并保存新的 Root 登录密码。 | 工具箱现有批量 Root 自动改密执行器。 |

先完成邮箱转发及邮箱密码回收，再启动 AWS 密码恢复。五步全部满足才算回收完成；每一步的失败/未知均须明确展示。
邮箱侧联调须覆盖已登录的旧 webmail 和 IMAP/POP3 客户端，确认旧会话不能读取新恢复邮件；优先验证、复用现有认证失效机制，不能只用“旧密码不能重新登录”替代此检查。

在现有 `/cleanup` 页面新增「账户回收」Tab。有独立操作权限的用户选择 1–20 个成员账户，经数量确认及 TOTP 后，由后台依顺序完成五步。页面逐账户、逐步骤展示进展，失败或未知必须显示步骤、原因和处理建议；允许按规则重试。已确认的新 AWS Root 密码与邮箱密码永久加密保留，操作者可反复查看、复制，查看行为写审计。

“按账户串行”的具体调度为：全局同一时刻只执行一个回收同步步骤；某账户第 5 步进入 Root 队列等待时，其他账户可以继续第 1–4 步。Root 浏览器仍使用现有全局单执行槽，不能另起回收专用浏览器 runner。

- [ ] 以无 `account_reclaim_access` 的 partadmin 调用 `/api/aws/account-reclaim/*`，GET 与 POST 均返回 403，页面不显示回收 Tab。
- [ ] 仅有 `account_reclaim_access=operate`、无 cleanup 页权限的用户，从导航及直链 `/cleanup` 均能进入，只显示回收 Tab；仅有 cleanup 页权限的用户只显示资源清理 Tab。
- [ ] payer 自身、非 ACTIVE/非组织成员、根邮箱未托管/不存在/禁用均不可勾选，逐行显示具体原因；admin 同样不能绕过这些校验。
- [ ] 受限账户：非 admin 置灰并显示「受限账户（敏感权限客户）仅 Admin 可回收」，直调创建接口返回 403；admin 可勾选并成功创建，确认框列出其中的受限账户。
- [ ] 创建前全部预检通过才原子写入整批；0 个、21 个、重复 ID、确认数量不匹配、目标变化及冲突均拒绝，不能留半批记录。
- [ ] 同一 `requestId` 与创建者、目标集合的网络重放返回原批次；不同内容复用该 ID 返回 409。
- [ ] 五步全部满足时为 `completed`；第 1–4 步任一失败/未知时停止该账户，后续为 `not_run`，明确注明阻断步骤；其他账户继续。
- [ ] 第 2 步网络超时后显示结果未知，经新的 TOTP 用原来已保存的同一密码重试；未确认旧会话踢出成功前，不执行第 3–5 步。
- [ ] 第 5 步失败/未知时为 `partial`；`password_unknown` 没有重试按钮，直调重试接口也被拒绝。明确安全的失败按现有 `canRetryFailedRootEmailJob()` 判定并经 TOTP 重试。
- [ ] 第 5 步人工验证码可以在回收页取图、刷新、提交；旧图片、重复提交、越权、过期均拒绝，人工期限不延长。
- [ ] 回收来源的 Root 任务不出现在 `/rootreset` 和账户详情 Root 历史；通过旧 Root 接口按已知 ID 查询、取消、重试、取链接、操作验证码及下载 CSV 均不可访问，包括 admin。
- [ ] 服务重启后第 1–4 步从未完成的步骤续跑；第 5 步重新绑定原 Root 任务，不重复发邮件或重放密码提交。
- [ ] `completed` 及具备已确认凭证的失败/部分完成记录可按权限反复查看；普通列表、日志、审计和飞书均没有密码、邮件正文、验证码或 reset URL。
- [ ] 实现阶段执行 `cd web && npm test && npm run typecheck && npm run build` 全绿；新增测试和现有 Root 回归见 §9。
- [ ] 邮箱接口由用户上线并通过其自检后，在 EC2 用授权测试账户跑通五步：新 AWS 密码、新邮箱密码可登录；原邮箱密码失效，旧 IMAP/POP3 会话断开，原转发地址不再收信。

## 2. 现状分析

| 文件/函数 | 当前职责与复用方式 |
|---|---|
| `web/server/aws-service.ts`：`deleteRootMFA(accountId)` | 经 payer → AssumeRoot，在目标 root 会话枚举、停用 MFA。无设备目前抛普通错误；部分失败返回 `failed` 数组，不能仅因 Promise resolve 就算成功。 |
| 同文件：`recoverRootPassword(accountId)` | 经 `IAMCreateRootUserPassword` 调 `CreateLoginProfile({})`，只启用恢复条件；已有密码抛 `code=ROOT_PASSWORD_ALREADY_EXISTS`，不是修改实际密码。 |
| `web/server/root-email-core.ts`：`RootEmailStore` | 独立持久化 Root 任务；`createBatchGroup()` 原子入队、请求 ID 幂等；`createRetry()` 保存重试血缘；全局 500 待处理、单账户互斥及 60 秒创建间隔。 |
| 同文件：`selectRootEmailBatchTargets()` | 从当前账户缓存及 payer 配置解析邮箱与归属。该函数可放行 payer 自身，回收必须另行排除。 |
| 同文件：`canRetryFailedRootEmailJob()`、`hasNewerRootEmailJob()`、`isPendingEmailJob()` | 第 5 步安全重试、新任务冲突与等待状态的权威判定；不复制其判断条件。 |
| `web/server/root-email-jobs.ts` | 管理 Root runner、浏览器执行槽、邮件查询、实时授权和人工验证码。store 私有，回收通过新增窄接口接入，不能实例化第二个 store。 |
| 同文件：`rootEmailAvailability()` | 检查 runner、浏览器/OCR、只读邮箱配置及 Root 凭证加密就绪状态；仅检查环境变量存在不等于邮箱写接口可用。 |
| `web/server/root-password-secrets.ts` | 复用现有 Root 密码加密、解密及加密就绪校验。Root 成功密码保留在原任务，回收不另存一份。 |
| `web/server/mail-api.ts`、`mail-api-config.ts` | 前者是只读邮件索引 client，后者 `readMailApiSsmConfig(parameter)` 可复用读取 SecureString；本期不修改只读 client。 |
| 邮箱维护仓库 `api/Mailbox.class.php` | 本轮已读到现有 `status()`、`deleteForwards()`、`setPassword()`、`revokeSessions()`；工具箱按 mailbox-api-spec 调用其 HTTP 接口，复用业务实现。源码存在不等于生产连通性已验收。 |
| `web/server/db.ts` | JSON schema、按需数组兼容、原子持久化、字段加密、用户实时读取、备份及密钥轮换；新增回收数组与邮箱密码用途。 |
| `root-reset-permissions.ts`、`step-up-mfa.ts` | 分别提供独立权限守卫范式及 `verifyStepUpTotp(identity, value, ip)`。TOTP 会消耗本次验证码，重试必须使用新验证码。 |
| `auth.ts`、`Settings.tsx`、`api.ts`、`MainLayout.tsx` | 现有 `root_reset_access` 完整落点可对照；导航及 `/me` 直链判断必须同时改。 |
| `Cleanup.tsx`、`BulkRootReset.tsx`、`RootManualCaptchaModal.tsx` | 原资源清理没有 Tabs；批量 Root 页提供 5 秒轮询范式；人工弹窗目前硬编码 Root API，需增加可注入函数。 |
| `index.ts`、`audit-presentation.ts`、`notify.ts` | runner 生命周期、中文审计动作与飞书通知接入点。billing runner 的 OS 单实例锁已约束服务单进程运行。 |

`README.md` 部分 Root 章节保留旧的 payer 确认描述；本方案以当前代码、`web/ROOT_EMAIL.md` 及已确认需求为准。现有测试数量持续变化，不以 HANDOFF 的历史“37 个”作为固定基数。

## 3. 方案总览

采用 HANDOFF 的方案 A，为既有操作增加一个轻量回收编排层：前四步直接调用现有邮箱写 API 与 AWS 函数，第五步投递带 `origin: 'account-reclaim'` 的单账户 Root 自动改密任务。新增模块负责顺序、权限、任务状态及失败恢复，不另写邮箱改密、转发删除或 AWS 改密业务。所有外部副作用前先持久化步骤状态，结果到达后再持久化结果。

```text
/cleanup → AccountReclaimPanel
    │ catalog / TOTP 创建、重试 / 查看状态、密码 / 人工验证码
    ▼
/api/aws/account-reclaim → createAccountReclaimGuard → account-reclaim.ts
    │                             │
    │                             └─ account-reclaim-core.ts（纯状态/类型/错误说明）
    ├─ db.account_reclaim_jobs（整批原子创建；每步与 Root 尝试关联持久化）
    ├─ 1 删转发、2 改邮箱密码 ── mailbox-admin-api.ts ── EwoMail 现有功能/API
    ├─ 3 删 Root MFA、4 允许恢复 ── aws-service.ts（payer → AssumeRoot）
    └─ 5 改 AWS 密码 ── root-email-jobs.ts 窄接口
                             ├─ 原 Root store / 浏览器 / 邮件查询 / 人工验证码
                             └─ 原永久 Root 密码库
    ▲
    └─ 2 秒 tick 归并 Root 状态；前端 5 秒轮询；终态审计与飞书
```

模块依赖方向：`account-reclaim.ts` 可依赖 db、AWS、邮箱与 Root bridge；`root-email-jobs.ts` 只依赖回收纯类型/权限函数及 db，**不反向 import 回收编排服务**，避免循环依赖。core 和 permissions 不直接读写 db、启动 runner 或调用外部服务。

## 4. 数据模型变更

### 4.1 回收任务

`data/db.json` 新增 `account_reclaim_jobs: AccountReclaimJob[]`。在 `DBSchema`、`ARRAY_FIELDS`、`emptyDB()` 登记；旧库没有此键读为 `[]`，不需要一次性迁移脚本。每账户一条 job，同批共用 `batchId=requestId`，不另建批次表。

核心类型放在 `web/server/account-reclaim-core.ts`：

```ts
export type AccountReclaimAccess = 'none' | 'operate';
export type AccountReclaimStepKey =
  'forward' | 'mailbox_password' | 'root_mfa' | 'root_recovery' | 'aws_password';
export type AccountReclaimStepState =
  'pending' | 'running' | 'succeeded' | 'skipped' | 'failed' | 'unknown' | 'not_run';
export type AccountReclaimStatus =
  'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export interface AccountReclaimActor {
  id: number | string;
  username: string;
  role: string;
  account_reclaim_access?: unknown;
}
export interface AccountReclaimStep {
  key: AccountReclaimStepKey;
  state: AccountReclaimStepState;
  message: string;
  errorCode?: string;
  recommendation?: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
}
export interface AccountReclaimRootAttempt {
  requestId: string;           // 此次单账户 Root 子批次 UUID，先持久化
  rootEmailJobId?: string;
  retryOfJobId?: string;
  createdAt: string;
}
export interface AccountReclaimJob {
  id: string;
  batchId: string;
  accountId: string;
  accountName: string;
  email: string;               // 服务端解析、去首尾空白、转小写
  payer: string;               // payer 配置名
  payerAccountId: string;
  createdBy: string;
  createdByUserId: string;
  createdFromIp?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  status: AccountReclaimStatus;
  steps: AccountReclaimStep[]; // 恰好五项，固定 key 与顺序
  encryptedMailboxPassword?: string;
  rootEmailJobId?: string;     // 当前一次 Root 尝试的指针
  rootAttempts: AccountReclaimRootAttempt[];
  retryCount: number;
  revision: number;           // 更新 CAS，防重复重试与旧回调覆盖
  outcomeRevision: number;    // 初始 0，每次进入 completed/failed/partial 时递增
  outcomeAuditRevision?: number;
  outcomeNotifiedRevision?: number;
}
export interface AccountReclaimProblem {
  errorCode: string;
  message: string;
  recommendation: string;
  uncertain: boolean;
}
```

`id`、batch/账户/邮箱/payer/创建者/创建时间不可由 update 改动。`rootAttempts` 只追加、补关联，不能覆盖旧尝试。新重试保留原创建者，实际执行重试的 admin/owner 单独写审计，不能通过重试转移凭证所有权。

db 新增三个方法；批量 insert 必须一次 `writeDB`，不能循环逐条写：

```ts
listAccountReclaimJobs(): AccountReclaimJob[];
insertAccountReclaimJobs(jobs: AccountReclaimJob[]): void;
updateAccountReclaimJob(
  id: string,
  expectedRevision: number,
  updates: Partial<AccountReclaimJob>,
): AccountReclaimJob;
```

list 返回深拷贝。insert 校验重复 ID/requestId/活动账户冲突；新 job 的 retryCount/revision/outcomeRevision 均为 0。update 检查不可变字段和 revision，成功递增 revision，不匹配抛 409。回收记录及其永久凭证**不按条数或时间自动裁剪**。批次摘要从按权限过滤后的 jobs 聚合：有未结束账户时为 queued/running；全部完成为 completed；全部未开始即取消为 cancelled；全部失败为 failed；其余终态组合为 partial。

### 4.2 凭证、来源与兼容

- 邮箱密码调用 `db.ts` 的现有字段加密/解密函数，新增 `EncryptedFieldKind='mailbox-password'`。`validateDecryptedField()` 校验 §5.1 的生成规则；`migrateEncryptMFASecrets()` 将邮箱密码加入同次认证、原子重加密及迁移审计。启动在专用加密配置未就绪时拒绝回收创建/执行。
- 邮箱新密码只生成一次，**加密写入成功后**才调用改密接口；所有该 job 的第 2 步重试均复用它。即使调用未知，也保留密文用于幂等恢复；页面只有在邮箱步骤确认成功后才将其作为“已确认的新邮箱密码”返回。
- AWS 密码继续由 `root-password-secrets.ts` 与原 Root 执行器保存；只有 `password_set`、`credentialRetentionPolicy='permanent'` 且存在密文时调用现有解密函数。未知状态不返回候选密码，不另建回收 AWS 密码字段。
- `RootEmailJob` 与 `RootEmailInput` 增加可选 `origin?: 'account-reclaim'`、`reclaimJobId?: string`。旧记录缺失 origin 仍按原 Root 逻辑；回收来源必须具备合法关联。加载、入队幂等比较与 `createRetry()` 均保留/校验来源，不允许普通任务变为回收任务或反向变化。
- `rootAttempts[].requestId` 与用户回收 `batchId` 分离：20 个账户各自有一个单账户 Root 子批次；不能把同一个回收 batchId 用作 20 次不同内容的 Root 入队 ID。
- 每日备份仍复用 `backupJsonStores(DB_PATH)`：回收记录随 db.json 备份，AWS 密码随 Root store 备份；联合恢复还需要匹配的独立 keyring。

### 4.3 用户与配置

- users 新增 `account_reclaim_access`；admin 解析为 operate，partadmin/viewer 缺失或非法历史值解析为 none。创建/更新 API 对非法传入值直接返回 400，不能静默授予。
- `config.json` **无新增字段**，不读取本地运行库或复制密钥作为设计素材。
- 新增环境变量 `MAIL_ADMIN_API_SSM_PARAMETER`，生产预期值 `/toolbox/mail-api-reclaim`；复用 `readMailApiSsmConfig()` 及现有 `MAIL_API_SSM_REGION=us-east-1`。写 API 不回退使用旧只读 token。
- 未配置时 catalog 可返回账户及全局未就绪原因，所有账户不可创建；SSM 读取失败、接口不可达、Root runtime 不就绪时均拒绝创建新批次，不进行任何写操作。已完成历史的查看仍按权限及现有解密能力处理。

## 5. 后端设计

### 5.1 纯核心：新建 `web/server/account-reclaim-core.ts`

```ts
export const ACCOUNT_RECLAIM_MAX_BATCH = 20;
export const ACCOUNT_RECLAIM_STEP_KEYS: readonly AccountReclaimStepKey[];
export function createAccountReclaimSteps(): AccountReclaimStep[];
export function generateMailboxPassword(): string;
export function translateAccountReclaimError(
  step: AccountReclaimStepKey, error: unknown,
): AccountReclaimProblem;
export function classifyAccountReclaimRootResult(
  root: RootEmailJob,
): 'pending' | 'succeeded' | 'failed' | 'unknown';
export function isAccountReclaimPending(job: AccountReclaimJob): boolean;
```

`RootEmailJob` 仅 type import。邮箱密码固定 16 位，字符集为 `A-Z a-z 0-9` 与 `!@#%^*-_=+`；至少各含一位大写、小写、数字、符号，用 Node `crypto.randomInt` 选字符并打乱，不使用 Math.random。仅定义函数契约，不实现新的加密算法。

初始五步为 pending、attempts=0，message 为“待执行”。失败/未知时 errorCode、message、recommendation 必填。`not_run` 使用“因第 N 步〔步骤名称〕失败/结果未知未执行”；`skipped` 只表示目标条件已满足，不能表示失败被忽略。

### 5.2 权限：新建 `web/server/account-reclaim-permissions.ts`

```ts
export function isAccountReclaimAccess(value: unknown): value is AccountReclaimAccess;
export function resolveAccountReclaimAccess(user?: AccountReclaimActor | null): AccountReclaimAccess;
export function canViewAccountReclaimJob(user: AccountReclaimActor, job: AccountReclaimJob): boolean;
export function canManageAccountReclaimJob(user: AccountReclaimActor, job: AccountReclaimJob): boolean;
export function canManageAccountReclaimRootJob(user: AccountReclaimActor, job: RootEmailJob): boolean;
export function createAccountReclaimGuard(
  readUser: (username: string) => AccountReclaimActor | undefined | null,
): RequestHandler;
```

守卫每请求实时读取用户，校验 JWT 的 username/userId 与当前记录一致；身份变化 401，权限非 operate 403，GET/HEAD 也拦。设置 `Cache-Control: no-store`，把当前用户放 `res.locals.accountReclaimUser`。

所有 read/manage/credentials 均要求 operate，再要求 admin 或 `String(user.id)===createdByUserId`。非本人记录返回 404，避免泄露是否存在。`canManageAccountReclaimRootJob()` 还要求 origin 为 account-reclaim、关联合法且 ownership 一致；关联 db 校验由 bridge 完成，不能仅凭 origin 放行。

`auth.ts` 的 `/me` 新增 `accountReclaimAccess`，用户 create/update 接受同名 camelCase 参数并保存 snake_case；`db.getAllUsers()` 返回标准化字段。权限授予不隐含 cleanup、root_access、root_reset_access。**不新增 ALL_PAGE_KEYS / DEFAULT_PAGE_KEYS 项**。

创建者权限撤销、身份改变时 runner 停止其尚未执行的动作，并写明原因；admin 重试他人批次仍保留原创建者，不能绕过原创建者的运行时失权检查。

### 5.3 邮箱写 client：新建 `web/server/mailbox-admin-api.ts`

此模块是调用已有邮箱能力的 HTTP 适配层，仅负责配置、签名、请求、响应校验与错误转换；不在工具箱实现邮箱数据库修改或 Dovecot 会话管理。邮箱侧已有业务能力，API 的生产部署、鉴权与连通性以联调结果为准。

```ts
export interface MailboxAdminLookupItem {
  email: string; domainHosted: boolean; exists: boolean; active: boolean; forwards: string[];
}
export interface MailboxAdminDeleteResult { deleted: number; removed: string[] }
export interface MailboxAdminPasswordResult { updated: true; sessionsKicked: number }
export class MailboxAdminApiError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode: number,
    readonly uncertain: boolean, readonly retryAfterMs: number = 0);
}
export function mailboxAdminApiConfigured(): boolean;
export class MailboxAdminApiClient {
  constructor(config?: () => Promise<MailApiConfig>, transport?: typeof fetch, intervalMs?: number, timeoutMs?: number);
  lookup(emails: string[], signal?: AbortSignal): Promise<MailboxAdminLookupItem[]>;
  deleteForwards(email: string, signal?: AbortSignal): Promise<MailboxAdminDeleteResult>;
  setPassword(email: string, password: string, signal?: AbortSignal): Promise<MailboxAdminPasswordResult>;
}
export const mailboxAdmin: MailboxAdminApiClient;
```

严格实现 `mailbox-api-spec.md` 的三个 POST 接口。签名对实际发送的同一 JSON 字节串计算；每次调用使用新的 timestamp/nonce，禁止记录 body、签名或配置内容。HTTPS 固定主机 `admin.yottahub.ai`、固定 `/Api/Mailbox/*` 路径，拒绝重定向。

SSM 配置内存缓存 10 分钟，读取失败清缓存并返回固定脱敏说明。所有回收 lookup/写调用共用一个 client 队列，启动间隔至少 1250ms，与旧只读 client 的不同 key 队列独立。HTTP 请求含响应读取总上限 15 秒，响应上限 1 MiB；body 按规格 ≤16 KiB，lookup 每次 ≤100 个去重邮箱。

响应从 unknown 做运行时校验：lookup 返回每个请求邮箱恰好一项，无缺失/重复/非请求邮箱；flags 必须为 boolean；删除数量非负整数且 removed 合法；改密必须 `updated===true`、sessionsKicked 为非负整数。只按已验证的结构推进步骤。

429 记录 Retry-After（数字秒或 HTTP 日期），夹在 1 秒–10 分钟并更新 client 下一可调用时间；**不透明自动重试写请求**。超时、连接中断、无效响应属于写结果未知，由回收页提示 TOTP 后幂等重试。其他业务错误码按 §8 映射（P2 补充：改密 500 且 `msg` 以 `doveadm who failed` / `doveadm kick failed` 开头时，抛 `code='INTERNAL_ERROR'`、`message` 分别为固定文案「查询在线会话失败」「踢出旧会话失败」，其他 INTERNAL_ERROR 的 message 为「邮箱服务内部错误」——T1 的 `translateAccountReclaimError` 只认这两句；`timeoutMs` 默认 15000，仅供测试缩短）；不能把原始 body/msg 不加筛选地写进持久化日志。邮箱实现或权限未就绪时不降级到网页管理、SSH 或旧 token。

### 5.4 编排服务：新建 `web/server/account-reclaim.ts`

下列 DTO 均在 core 导出，供服务使用，前端在 `api.ts` 定义对应响应类型。JobView 显式按白名单构造，不 spread 持久化对象：

```ts
export type AccountReclaimJobView = Pick<AccountReclaimJob,
  'id' | 'batchId' | 'accountId' | 'accountName' | 'email' | 'payer' | 'payerAccountId'
  | 'createdBy' | 'createdAt' | 'updatedAt' | 'startedAt' | 'finishedAt'
  | 'status' | 'steps' | 'retryCount'> & {
  canRetry: boolean;
  retryAvailableAt?: string;
  manualCaptchaAvailable: boolean;
  manualCaptchaExpiresAt?: string;
  credentialsAvailable: { aws: boolean; mailbox: boolean };
};
export interface AccountReclaimBatchView {
  id: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  status: AccountReclaimStatus;
  total: number;
  queued: number;
  running: number;
  completed: number;
  partial: number;
  failed: number;
  cancelled: number;
  canCancel: boolean;
  jobs: AccountReclaimJobView[];
}
export interface AccountReclaimCatalogQuery {
  q?: string; payer?: string; page?: number; pageSize?: 20 | 50 | 100;
}
export interface AccountReclaimCatalog {
  accounts: Array<{
    accountId: string; accountName: string; email: string; payer: string;
    payerAccountId: string; eligible: boolean; reasonCode?: string; reason?: string; restricted?: boolean;
  }>;
  total: number;
  page: number;
  pageSize: 20 | 50 | 100;
  cachedAt: string;
  maxBatchSize: 20;
  readiness: { ready: boolean; message: string };
}
export interface AccountReclaimCredentials {
  accountId: string; email: string;
  awsPassword: string | null; mailboxPassword: string | null;
  awsMessage: string; mailboxMessage: string;
}
```

凭证为 null 时原因明确说明，不以空字符串表示成功。下面签名中的 RootEmailJob、RootManualCaptchaView、MailApiConfig、RequestHandler 分别从现有 root-email-core、root-email-manual、mail-api、express 仅按类型引用。

```ts
export class AccountReclaimError extends Error {
  constructor(message: string, readonly code: string,
    readonly statusCode: 400 | 401 | 403 | 404 | 409 | 429 | 503);
}
export function getAccountReclaimCatalog(
  query: AccountReclaimCatalogQuery, actor: AccountReclaimActor,
): Promise<AccountReclaimCatalog>;
export function findAccountReclaimBatchReplay(
  values: { accountIds: unknown; requestId: unknown; confirmAccountCount: unknown },
  actor: AccountReclaimActor,
): AccountReclaimBatchView | null;
export function createAccountReclaimBatch(
  values: { accountIds: unknown; requestId: unknown; confirmAccountCount: unknown },
  actor: AccountReclaimActor, ip?: string,
): Promise<{ batch: AccountReclaimBatchView; reused: boolean }>;
export function listAccountReclaimBatches(actor: AccountReclaimActor): AccountReclaimBatchView[];
export function getAccountReclaimBatch(id: string, actor: AccountReclaimActor): AccountReclaimBatchView;
export function retryAccountReclaimJob(
  id: string, actor: AccountReclaimActor, ip?: string,
): Promise<AccountReclaimJobView>;
export function cancelAccountReclaimBatch(
  id: string, actor: AccountReclaimActor, ip?: string,
): { cancelled: number; remaining: number };
export function getAccountReclaimCredentials(
  id: string, actor: AccountReclaimActor, ip?: string,
): AccountReclaimCredentials;
export function getAccountReclaimManualCaptcha(id: string, actor: AccountReclaimActor): RootManualCaptchaView;
export function answerAccountReclaimManualCaptcha(
  id: string, actor: AccountReclaimActor,
  values: { challengeId?: unknown; action?: unknown; captchaAnswer?: unknown }, ip?: string,
): { accepted: true };
export function startAccountReclaimRunner(): void;
export function stopAccountReclaimRunner(): Promise<void>;
```

**测试注入点**（P2 补充）：同文件导出一个可变依赖对象，服务内部所有外部调用一律经它发出，测试用 `t.mock.method(accountReclaimDeps, '<name>', ...)` 替换，不 mock 模块命名空间：

```ts
export const accountReclaimDeps = {
  mailbox: mailboxAdmin,                       // lookup / deleteForwards / setPassword
  deleteRootMFA, recoverRootPassword,          // aws-service
  ensureAccountReclaimRootJob, getAccountReclaimRootJob, hasPendingRootEmailForAccount,
  assertAccountReclaimRootAdmission, getAccountReclaimRootPassword,   // root-email-jobs bridge
  rootEmailAvailability,                       // root-email-jobs 运行条件
  sendNotification,                            // notify.ts
  now: () => Date.now(),
};
```

TOTP 只在路由层用 `verifyStepUpTotp` 校验，不进该对象。`ensureAccountReclaimRootJob` 等五个 bridge 函数由 `root-email-jobs.ts` 导出（§5.5）。

**catalog**：默认 page=1/pageSize=50，非法分页返回 400；q 匹配账户 ID/名称/邮箱，payer 为配置名。先按当前账户缓存做结构校验，再对本页最多 100 个邮箱批量 lookup；可缓存 lookup 60 秒用于列表显示，创建/重试不依赖该缓存。账户缓存为空时返回空列表与“请先同步账户”。lookup 不可用时本页显示“邮箱状态暂无法确认”，不能把未知当作托管成功。

**创建批次**：

1. 路由校验当前权限、requestId 为 v4 UUID、accountIds 为 1–20 个互不重复的 12 位字符串、confirmAccountCount 为匹配整数。email/payer/origin/密码均不接受客户端覆盖。
2. 路由先调用同步 `findAccountReclaimBatchReplay()` 查同 requestId：相同创建者及目标集合经当前 read 权限检查后返回原批次，不重新执行 TOTP 或副作用；内容/创建者不一致 409。该函数对无记录返回 null，对非法参数抛 400。仅这个“返回已存在结果”的分支不消耗 TOTP；无记录时路由调用 `verifyStepUpTotp()` 后再调用 create。create 在最终 insert 前再次检查 requestId，抵御并发请求。
3. 用 `selectRootEmailBatchTargets(..., '', 20)` 解析当前 targets；额外排除所有配置 payer 的账户 ID、`_isPayer`、非 ACTIVE、无归属；目标命中**任何状态的 restricted_accounts 记录**且当前操作者（实时读库）不是 admin 时整批拒绝 403 `ACCOUNT_RESTRICTED`。检查同账户已有 queued/running 回收或 pending Root 任务，以及 Root 60 秒间隔和当前队列余量。
4. 检查 mailbox admin 配置并实际读 SSM/lookup；确认域名托管、邮箱存在且 active。检查 `rootEmailAvailability()` 的 passwordAutomationReady 及加密状态。若两个目标共用同一根邮箱，整批拒绝 `MAILBOX_SHARED`；若其他 ACTIVE 账户或未结束回收使用相同邮箱，也拒绝，避免改一个共享邮箱影响另一账户。
5. 等待外部检查后重新读取当前用户、账户邮箱/payer/受限标记及冲突，比较与已确认 targets 一致；从最后复验到整批 insert 之间不得 await。任一变化 409，全批不写入。
6. 一次写入所有 queued jobs，然后写创建审计并唤醒 tick。密码在各账户第 2 步临执行前生成、加密落盘；创建批次不调用邮箱写 API 或 AWS 改动 API。

**runner**：单进程 2 秒 tick；用模块级 inFlight promise 保证重入时直接退出，每次先归并正在等待的 Root 状态，再选 createdAt/id 顺序的可执行账户，优先让已开始账户完成连续的第 1–4 步。一次只执行一个同步外部步骤，结果持久化后再取下一步；第 5 步入队后让出编排槽。每次外部动作前复验创建者身份/operate、账户 ACTIVE、邮箱/payer 未变，且「账户未受限或创建者当前为 admin」，不使用旧 JWT。条件失效时停在该步骤并明确建议，无自动权限提升。

| 步骤 | 执行与成功条件 | 非成功处理 |
|---|---|---|
| 1 forward | `mailboxAdmin.deleteForwards(email)`；deleted>0 → succeeded；deleted=0 → skipped（本来无转发）。 | 失败/未知即 failed/unknown，整体 failed，2–5 not_run。 |
| 2 mailbox_password | 生成一次并持久化密文，再 `setPassword()`；严格成功响应表示密码已写入且旧 IMAP/POP3 会话已踢出（邮箱侧不做认证缓存刷新）。 | 失败/未知均阻断 3–5，不能因为密码可能写入就前进；重试使用同一密码。 |
| 3 root_mfa | `deleteRootMFA()`：全部目标设备停用成功 → succeeded；机器码 `ROOT_MFA_NOT_ENABLED` → skipped。 | 返回 failed 非空也算失败，列出脱敏原因；4–5 not_run。禁止以“部分 removed”当成功。 |
| 4 root_recovery | `recoverRootPassword()` 成功 → succeeded；`ROOT_PASSWORD_ALREADY_EXISTS` → skipped（已满足恢复条件）。 | 其余错误/未知阻断 5，整体 failed；不能捕获所有 AccessDenied 当“已存在”。 |
| 5 aws_password | 先持久化 Root attempt，再通过 bridge 入队并归并原任务；只有 password_set → succeeded。 | 明确失败 → failed，未知 → unknown，整体 partial；有安全证据才允许人工 TOTP 重试。 |

第 1–4 步重试仅重置失败/未知步骤及其后 not_run 为 pending，保留已成功/跳过步骤、同一邮箱密码和步骤尝试次数，清除本轮步骤/账户 finishedAt，retryCount+1，CAS 更新为 queued。重试前全部前置条件重新检查。第 5 步入队前的明确未执行错误可以 TOTP 重试；已有 Root 任务时严格使用其安全重试函数及 60 秒间隔，并校验无更新任务。

**取消**仅取消 `status=queued && startedAt` 为空的账户，五步标 not_run（“批次停止，账户尚未开始”）。已经开始或在等待 Root 的账户继续执行，不调用原 Root cancel；接口及按钮文案为“停止未开始账户”，返回实际取消/剩余数量。取消不需要新的 TOTP，仍需当前 operate 与所有权。

### 5.5 Root 最小接入与来源隔离

修改 `web/server/root-email-jobs.ts`，新增内部 bridge 导出，不挂独立公网路由：

```ts
export function ensureAccountReclaimRootJob(job: AccountReclaimJob): Promise<RootEmailJob>;
export function getAccountReclaimRootJob(job: AccountReclaimJob): RootEmailJob | null;
export function hasPendingRootEmailForAccount(accountId: string): boolean;
export function assertAccountReclaimRootAdmission(accountIds: readonly string[]): void;
export function getAccountReclaimRootPassword(job: AccountReclaimJob): string | null;
```

bridge 使用现有私有 store，校验 origin、reclaimJobId、账户、邮箱、payer、创建者及当前 attempt 全部匹配；回收 service 不接触 store 文件路径。初次创建通过 `store.createBatchGroup([input], {batchId:attempt.requestId,autoSetPassword:true})`；重试通过 `store.createRetry()`，输入仍带回收 origin/reclaimJobId，保留原安全模式选择：可重新查邮箱的失败优先 `mailbox`，其他安全失败才 `resend`。

`assertAccountReclaimRootAdmission()` 在批次创建最终写入前同步检查当前 pending Root 冲突、60 秒账户间隔及 `pendingCount + accountIds.length <= 500`，失败沿用 Root 错误语义。该检查不预留 Root 槽位；实际第 5 步由原 store 再检容量，队列后续变满按 §8 处理。查回已经入队的同一 attempt 不再走“新入队”检查。

**两份 JSON 的中断恢复协议**：

1. db 先追加 Root attempt（UUID、可选 retryOfJobId），并将第 5 步写为 running；此时尚无外部发信。
2. bridge 先按 attempt.requestId/origin/reclaimJobId 找已存在 Root 任务。有且参数全匹配则复用；未找到且从未记录 rootEmailJobId 时才执行首次入队/安全重试。
3. Root store 写入后回填 db 的 attempt.rootEmailJobId 与当前 rootEmailJobId。崩溃发生在两次写入之间，下次先查到既有 Root 任务并补关联，不能新生成 UUID。
4. 重试时若 source 已存在 retriedByJobId，只有 child 与已持久化 attempt 完全匹配才重新绑定；否则报冲突。不能因 createRetry 返回“已重试”就再建任务。
5. db 已记录 rootEmailJobId 却在健康 Root store 找不到，或同一关联找到多条不一致记录：第 5 步 unknown、整体 partial，显示 `ROOT_JOB_LINK_INVALID`，人工核查；禁止以空任务自动补发。

Root `authorize()` 按来源分流：旧任务仍使用 root_reset_access；回收任务使用当前 account_reclaim_access，并核对其关联回收 job 正在第 5 步、目标/创建者一致、账户未受限或创建者当前为 admin。不要求回收用户额外拥有 root_access/root_reset_access。未知 origin 或关联损坏失败关闭。

**双向互斥**：创建回收时拒绝 pending Root 任务；在普通 `submitRootEmail()`、`submitRootEmailBatch()`、`retryRootEmailJob()` 最后同步入队前，检查目标账户是否有未结束回收并拒绝。仅匹配该回收 job/attempt 的内部 bridge 可放行。校验函数留在 root-email-jobs 内、只查 db，不能 import account-reclaim.ts。这样回收第 1 步到 Root 入队之前也不会出现普通 Root 任务插队。

`root-reset-permissions.ts` 的 `canViewRootEmailJob()`、`canManageRootEmailJob()`、`canRetrieveRootEmailManualLink()` 遇回收来源均返回 false（包括 admin）。`prepareRootCredentialCsv()` 在任何 claim/解密前单独拒绝含回收来源的批次；已有列表/批次详情/relatedBatches、单账户历史、取消、重试、链接与人工验证码路径全部检查来源隔离。

人工验证码保留 `RootEmailManualInput` 的 challenge/TTL/单执行槽语义。将 `authorizedManualInput()` 增加服务端可选权限判断函数，原接口默认旧 canManage；回收包装函数传入 `canManageAccountReclaimRootJob`，先验证 db 关联且不得从 HTTP 参数选择权限函数。取图/提交后的 `auditAs()` 仍记录当前实际操作者。

具体扩展签名如下；`RootEmailUser` 在原类型上增加可选 account_reclaim_access，默认 check 为原 `canManageRootEmailJob`，旧路由保持原有实参：

```ts
type RootManualPermissionCheck = (user: RootEmailUser, job: RootEmailJob) => boolean;
function authorizedManualInput(id: string, user: RootEmailUser, check?: RootManualPermissionCheck): {
  job: RootEmailJob; input: RootEmailManualInput; current: RootEmailUser;
};
export function getRootEmailManualCaptcha(
  id: string, user: RootEmailUser, check?: RootManualPermissionCheck,
): RootManualCaptchaView;
export function answerRootEmailManualCaptcha(
  id: string, user: RootEmailUser,
  values: { challengeId?: unknown; action?: unknown; captchaAnswer?: unknown },
  clientIp?: string, check?: RootManualPermissionCheck,
): { accepted: true };
```

### 5.6 路由与审计

P4 补充：Root retry child 尚未回填回收指针时，仅允许该指针等于当前 attempt 的 retryOfJobId，其他关联字段仍逐一匹配；这保证立即执行与跨文件重启恢复使用同一 child。普通 Root 任务保留 admin 重试他人任务的原行为，创建者不可改变仅约束回收来源。

在 `web/server/routes/aws.ts` 加 `awsRouter.use('/account-reclaim', createAccountReclaimGuard(...))`，挂在回收具体路由之前，所有新路径置于任何通配/泛化账户路由之前。沿用 `{success:true,data:...}` 成功 envelope；错误 `{error,code}`，保留 StepUpMfaError 的 statusCode。

下表路径均带前缀 `/api/aws/account-reclaim`，守卫均为 `createAccountReclaimGuard`；按 ID 操作另做所有权校验：

| 方法 | 路径 | 请求 | 响应 data / 条件 |
|---|---|---|---|
| GET | `/catalog` | query：q/payer/page/pageSize | AccountReclaimCatalog |
| POST | `/batches` | `{accountIds,requestId,confirmAccountCount,totpCode}` | `{batch,reused}`；新建校验 TOTP，幂等返回见 §5.4。 |
| GET | `/batches` | 无 | AccountReclaimBatchView[]，最近 20 批。 |
| GET | `/batches/:id` | 无 | AccountReclaimBatchView；历史按已知 ID 可回读，不因列表限制删数据。 |
| POST | `/jobs/:id/retry` | `{totpCode}` | AccountReclaimJobView；校验新 TOTP 与 CAS。 |
| POST | `/batches/:id/cancel` | `{}` | `{cancelled,remaining}`，仅停未开始账户。 |
| POST | `/jobs/:id/credentials` | `{}` | AccountReclaimCredentials；实时权限、no-store、成功审计后才发明文；无需额外 TOTP。 |
| POST | `/jobs/:id/manual-captcha` | `{}` | RootManualCaptchaView，图片仅此敏感响应返回。 |
| POST | `/jobs/:id/manual-captcha/answer` | `{challengeId,action,captchaAnswer?}`，action 为 refresh 或 submit | `{accepted:true}`；submit 必须 6 位字母数字，无需再做 TOTP。 |

credentials 仅允许终态 job，且至少一个凭证已确认可用，否则 409；邮箱确认成功且 AWS 未确认时只返回邮箱密码及 AWS 不可用原因。仅在密码弹窗明确点“查看”时请求，不随轮询调用。解密/审计失败时不返回任何明文，不发送成功 envelope；response 不缓存。

新增审计动作并在 `audit-presentation.ts` 的 explicitActions 登记中文名：

| action | 中文名 |
|---|---|
| ACCOUNT_RECLAIM_BATCH_CREATE | 创建账户回收批次 |
| ACCOUNT_RECLAIM_JOB_RETRY | 重试账户回收 |
| ACCOUNT_RECLAIM_BATCH_CANCEL | 停止未开始的回收账户 |
| ACCOUNT_RECLAIM_JOB_COMPLETED | 账户回收完成 |
| ACCOUNT_RECLAIM_JOB_FAILED | 账户回收失败 |
| ACCOUNT_RECLAIM_JOB_PARTIAL | 账户回收部分完成 |
| ACCOUNT_RECLAIM_CREDENTIALS_VIEW | 查看回收密码 |
| ACCOUNT_RECLAIM_MFA_FAILED | 账户回收二次验证失败 |

审计仅记录 batch/job/account/步骤/机器码/结果/实际操作者及 IP。TOTP 失败沿原 Root 模式审计；验证码答案继续由通用审计敏感字段掩码处理。显式审计成功后设置 `res.locals.audited=true`，避免同一操作重复 API_CALL；不改变其他 API 审计行为。

批次创建、每账户 completed/failed/partial 及凭证查看发送飞书通知，内容仅为相同脱敏元数据。终态审计/通知将完成标记与 **outcomeRevision** 比较，独立于每次 DB 更新递增的 revision；先写事件再记标记，中断允许重复、不允许静默永久丢失，补标记本身不会生成新终态事件。创建审计/通知用同一 batchId 在持久化审计日志查重，tick 对缺失事件补记；创建通知失败由维护告警记录，不重建批次。查看审计失败则请求失败，查看通知失败只告警、不撤销已完成的审计。轮询不记业务审计/通知。

### 5.7 AWS 函数与启动关停

P4 通知实现：回收调用 `sendNotification(title, content, {strict:true})`，15 秒截止，HTTP/业务/网络失败均向调用方报告；旧两参数调用保持兼容。终态通知独立发送、按 job 去重，只在确认后用最新 DB revision 回写匹配 outcomeRevision 的完成标记；失败等待补发，旧通知完成不能确认新结果。关停等待这些有界通知，第五步尚未入队的运行中 attempt 保留原 UUID 供重启接续。

`aws-service.ts` 的 `deleteRootMFA()` 无设备错误补 `code:'ROOT_MFA_NOT_ENABLED'`，保留原 message 和原调用方语义。回收处理返回 failed 数组；不把整个函数改为“从不抛错”。第 3/4 步 IAM 请求复用 `withAbortTimeout(AWS_REQUEST_TIMEOUT_MS, ...)` 的 30 秒可中止调用和 `finally` 释放 client，不能只用 Promise.race 在真实请求未结束时放开编排锁。`recoverRootPassword()` 的已有冲突码及省略 Password 的语义保持。

`index.ts` 启动顺序为 billing 单实例锁 → `startRootEmailRunner()` → `startAccountReclaimRunner()` → 其他现有 runner。新增回收字段的密钥轮换纳入原启动迁移。

关停先同步设置回收 stopping 标记，阻止新的 tick/Root 入队，并在现有 shutdown 的 Promise.all 内加入 `stopAccountReclaimRunner()`。邮箱请求用 AbortSignal 中止，未知结果持久化或保留 running 供重启恢复；AWS 请求等待现有 deadline。Root runner 仍由自己的 stop 处理浏览器提交边界，回收不得自行把 setting_password 改为 failed/成功。保持现有 30 秒优雅关停总期限和单进程部署约束。

## 6. 前端设计

### 6.1 入口、权限与组件

- `Cleanup.tsx`：原默认组件在同文件改名 `ResourceCleanupPanel`，保留原功能、请求和提交逻辑；新默认组件按 props 渲染 Tabs。回收为第一个 Tab，资源清理为第二个；只有一档权限时仅显示该 Tab。
- `MainLayout.tsx`：新增 accountReclaimAccess 状态；`isPageAllowed('cleanup')` 返回原页面授权 **或** accountReclaimAccess=operate；初始化 `/me` 的 independentAccess 增加 cleanup 分支，防止直链被重定向。原 cleanup 的 PAGE_META/nav key/VALID_PAGE_KEYS/pageComponent 沿用，不另建独立路径或可分配页面 key。
- `CleanupPage` props 为 `{canCleanup:boolean;canReclaim:boolean}`；MainLayout 从原 allowedPages/admin 规则计算 canCleanup，从独立权限计算 canReclaim，不能把合并后的页面可见性反过来授予资源清理权限。
- 新建 `web/client/src/components/AccountReclaimPanel.tsx`，只处理回收视图、选择、确认及轮询；不持有邮箱 API token，不直接调用 AWS 或 EwoMail。
- `Settings.tsx` 的用户新建/编辑表单和列表列新增“账户回收”开关/状态，只有 none/operate 两档，admin 显示恒 operate；与原 Root 权限分开。

### 6.2 交互

账户表支持 ID/名称/邮箱搜索、payer 筛选和服务端分页；跨搜索/分页保留已选 ID，最多 20 个，打开确认框前按当前 catalog 结果复核并展示完整已选快照。置灰行显示明确原因；受限账户对非 admin 固定显示「受限账户（敏感权限客户）仅 Admin 可回收」，对 admin 可勾选并带「受限账户」Tag，确认框单独列出所选受限账户。请求不可用时顶部显示未就绪原因，禁用创建按钮。

创建确认框展示五步顺序、已选账户及“停止未开始账户”的范围，输入准确数量和 TOTP。首次确认生成 requestId，网络失败再次提交沿用该 ID；目标选择变化才更换 UUID。409 TOTP 已使用时提示等待新验证码，不擅自重新生成批次请求 ID。

批次表每账户一行，五步按顺序显示状态与可读标签；hover 可补说明，**失败/未知的原因及建议在行内展开可见，不能仅靠 hover**。not_run 显示阻断来源，skipped 显示已满足原因。状态不只靠颜色区分；窄屏允许表格横向滚动，账户、步骤说明及全部动作均可访问。

有未结束任务每 5 秒串行轮询，上一请求未结束不叠加请求，组件卸载清理 timer；手工验证码出现时展示入口，提交后刷新批次。轮询 401/403 停止并关闭密码/验证码弹窗；网络失败保留上次状态及更新时间、显示提示，不能推断任务结束。批次进入全终态后停止自动轮询，保留刷新按钮。

“重试”仅按后端 canRetry 显示，且失败/未知说明始终保留。`password_unknown` 固定建议“邮箱已收回，请用根邮箱手工执行 AWS 忘记密码并确认结果”，没有重试按钮。密码弹窗按项显示可用/不可用原因与复制按钮，关闭/切批次/权限失效时清空组件内明文；不写 localStorage/sessionStorage、URL、console、分析事件或导出文件。

### 6.3 API 与验证码复用契约

`api.ts` 按 §5.6 增加以下方法，沿现有 API response envelope 类型：

```ts
accountReclaimCatalog(query?: AccountReclaimCatalogQuery): Promise<ApiResponse<AccountReclaimCatalog>>;
createAccountReclaimBatch(input: {
  accountIds: string[]; requestId: string; confirmAccountCount: number; totpCode: string;
}): Promise<ApiResponse<{ batch: AccountReclaimBatchView; reused: boolean }>>;
accountReclaimBatches(): Promise<ApiResponse<AccountReclaimBatchView[]>>;
accountReclaimBatch(id: string): Promise<ApiResponse<AccountReclaimBatchView>>;
retryAccountReclaimJob(id: string, totpCode: string): Promise<ApiResponse<AccountReclaimJobView>>;
cancelAccountReclaimBatch(id: string): Promise<ApiResponse<{ cancelled: number; remaining: number }>>;
accountReclaimCredentials(id: string): Promise<ApiResponse<AccountReclaimCredentials>>;
accountReclaimManualCaptcha(id: string): Promise<ApiResponse<RootManualCaptchaView>>;
answerAccountReclaimManualCaptcha(id: string, input: {
  challengeId: string; action: 'refresh' | 'submit'; captchaAnswer?: string;
}): Promise<ApiResponse<{ accepted: true }>>;
```

这里 `ApiResponse<T>` 指 `{success:true;data:T}|{success:false;error:string;code?:string}` 的新增命名类型，仅用于新接口；保持现有 request helper 和旧接口的错误处理约定。用户 create/update 类型及 `/me` 类型同步补 accountReclaimAccess。

`RootManualCaptchaModal` 的 job prop 收窄为现有字段的 Pick，并增加可选 props，默认值沿用旧 Root API：

```ts
type ManualCaptchaJob = Pick<RootEmailJobView,
  'id' | 'accountId' | 'status' | 'detail' | 'manualCaptchaAvailable'>;
type ManualCaptchaApiResult<T> = { success: boolean; data?: T; error?: string };
type ManualCaptchaProps = {
  job: ManualCaptchaJob | null;
  onClose: () => void;
  onProgress: () => void;
  fetchCaptcha?: (id: string) => Promise<ManualCaptchaApiResult<RootManualCaptchaView>>;
  submitCaptcha?: (id: string, values: {
    challengeId: string; action: 'refresh' | 'submit'; captchaAnswer?: string;
  }) => Promise<ManualCaptchaApiResult<{ accepted: true }>>;
};
```

回收传入适配对象的 id 为 **reclaim job ID**，status/detail 取第 5 步映射；注入回收 API 函数，不能错传 rootEmailJobId 给回收路由。旧 BulkRootReset 调用不需要新增 props。取图 effect 纳入函数依赖，父组件稳定传递函数；已有 2 秒取图、一次性 challenge、关闭清空图/答案等逻辑保留。

样式遵守 coding-standards：颜色 `var(--color-*)`、z-index `var(--z-*)`，字重表头 500/卡片标题 600/页面标题 700；使用 AntD 图标，重复样式进 global.css。

## 7. AWS 链路

本期只复用下列链路，不借道 support-quota、OAAR 或 admin-console，也不创建新的角色/StackSet：

```text
平台现有 AWS 身份
  → sts:AssumeRole 到目标账户所属 payer 的已配置 role/tool
  → 区域 STS sts:AssumeRoot（目标成员账户，DurationSeconds=900）
      ├─ 第 3 步 task policy: IAMDeleteRootUserCredentials
      │    → iam:ListMFADevices / iam:DeactivateMFADevice
      │    → 现有 DeleteVirtualMFADevice 清理尝试（不作为解除 MFA 的成功判据）
      └─ 第 4 步 task policy: IAMCreateRootUserPassword
           → iam:CreateLoginProfile（省略 UserName 与 Password）
第 5 步 → 现有官方 AWS 忘记密码网页执行器 + 只读邮件索引
```

创建恢复条件与实际设置新密码分别是第 4、第 5 步，不能合并或互相替代。task policy 使用现有 `ROOT_TASK_POLICY` ARN，不能把完整策略赋予普通用户角色。部署前确认 payer role 已具备 sts:AssumeRoot 及目标特权任务所需权限、组织集中式根访问已开启；本期不自动修改 IAM/SCP。

AWS 官方约束与本项目调用方式已于起草时复核：成员账户目标、区域 STS 端点、最长 900 秒及 task policy 见 [AssumeRoot API](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoot.html)；两类 Root task policy 的动作边界见 [IAM 官方策略说明](https://docs.aws.amazon.com/IAM/latest/UserGuide/security-iam-awsmanpol.html#security-iam-awsmanpol-IAMCreateRootUserPassword)。这些约束不意味着组织已在当前生产环境通过验证。

受限账户仅 admin 可回收；任意 restricted_accounts 记录（含 failed 状态）均算受限，不以“权限收窄尚未成功”放行。admin 回收受限账户走同一条 payer → AssumeRoot 链路，不触碰受限账户的 support-quota/OAAR/admin-console 收窄状态。执行中账户被新标记为受限且创建者不是 admin 时，停在当前步骤，错误码 `ACCOUNT_RESTRICTED`。账户离开组织、邮箱或归属变化时停止，不回退尝试其他 payer。

每账户第 3/4 步各一次特权会话及必要 IAM 请求，最多 20 个账户、全局同步一步；没有跨账户并行放大。Root 队列共享原有 500/60 秒/浏览器槽限制；邮箱写 key 共用 1250ms 队列。限流给出明确等待时间，回收 runner 不额外开启自动循环重试。

## 8. 错误处理与边界

### 8.1 状态转换与 Root 归并

```text
queued → running
  ├─ 第 1–4 步 failed/unknown → failed（后续 not_run）
  │                              └─ TOTP + 预检 + CAS → queued，从阻断步继续
  ├─ 第 5 步等待 Root → running
  │    ├─ password_set → completed
  │    ├─ 明确失败 → partial（仅安全证据允许 TOTP 重试）
  │    └─ password_unknown/证据缺失 → partial（不自动重试）
  └─ 五步均 succeeded/skipped → completed
queued 且从未开始 → cancelled
```

| Root 状态 | 回收第 5 步 / 总状态 | 操作 |
|---|---|---|
| queued/running/waiting_mail/link_ready（自动）/setting_password | running / running，message 使用脱敏的原阶段说明 | 等原执行器；manual_captcha 提供站内入口。 |
| password_set，永久密码可用 | succeeded / completed | 可查看两项已确认密码。 |
| password_unknown | unknown / partial | 禁止任何自动或按钮重试，建议手工忘记密码确认。 |
| failed/password_failed/mail_failed/cancelled/interrupted | failed 或 unknown / partial，保留原 detail 及 failureStage/category | 重试必须 `canRetryFailedRootEmailJob(root) && !hasNewerRootEmailJob(...)`，满足间隔、权限及预检；证据不足则没有重试入口。 |
| email_sent、非自动 link_ready、来源/关联异常、成功却缺永久凭证 | unknown / partial | `ROOT_JOB_LINK_INVALID` 或 `ROOT_CREDENTIAL_UNAVAILABLE`，人工核查，不补发/伪造完成。 |

上一表终态组的映射固定为：`failed/password_failed/mail_failed` 默认映射 failed；`cancelled/interrupted` 仅在 `passwordSubmitAttempted===false` 时映射 failed，否则映射 unknown。任何终态若 `passwordSubmitAttempted===true` 却没有明确 password_set 证据，均映射 unknown 并禁用回收重试。原 root 状态、机器码和 detail 同时保留作说明；是否允许重试仍须满足原安全函数，不能仅看回收步骤映射。

`interrupted` 是否安全由现有函数判定，不能一律视为可重试；Root 恢复后的 setting_password→password_unknown 由原 runner 处理。第 4 步 unknown **不能**继续第 5 步，这是 HANDOFF 旧测试例子的纠正。

### 8.2 错误码与用户说明

| code/场景 | 页面原因与建议 |
|---|---|
| PAYER_NOT_SUPPORTED / ACCOUNT_NOT_ACTIVE / ACCOUNT_NOT_MEMBER | 不支持 payer/非 ACTIVE/非成员；选择有效组织成员，刷新同步后再确认。 |
| ACCOUNT_RESTRICTED | 受限账户（敏感权限客户）仅 Admin 可回收；请由 Admin 创建回收批次。回收功能不自动解除受限标记。 |
| DOMAIN_NOT_HOSTED / MAILBOX_NOT_FOUND / MAILBOX_DISABLED | 逐项显示域名未托管/邮箱不存在/邮箱禁用；先修复邮箱配置。 |
| MAILBOX_SHARED | 多个账户共用根邮箱；先完成邮箱归属拆分，再创建回收。 |
| AUTH_FAILED / SCOPE_DENIED / IP_NOT_ALLOWED | 写 API 鉴权/scope/出口白名单不满足；由邮箱维护者核对 token、服务器时间和白名单。 |
| RATE_LIMITED | 显示可重试时间；等待后新的 TOTP 重试原步骤，禁止忙循环。 |
| MAILBOX_WRITE_UNKNOWN | 调用超时/响应中断，邮箱变更结果未知；用已保存的同一参数经 TOTP 幂等重试，后续未执行。 |
| INTERNAL_ERROR | 邮箱更新或踢会话失败；改密接口 `msg` 以 `doveadm who failed:` / `doveadm kick failed:` 开头时分别映射为「查询在线会话失败」「踢出旧会话失败」（此时密码已写入，同一密码重试幂等），其他 msg 只显示「邮箱服务内部错误」；修复邮箱侧后重试，不能认为已收回邮箱。 |
| NOT_FOUND / HTTPS_REQUIRED | 接口路径或协议配置错误（工具箱侧 bug 或网关变化）；不可重试，由维护者核对 Base URL 与路径。 |
| ROOT_MFA_PARTIAL_FAILURE | 部分 MFA 停用失败；列出目标账户内脱敏原因，修复后重试第 3 步。 |
| AccessDenied / AccessDeniedException | payer/AssumeRoot/特权动作权限或 SCP 拒绝；显示失败阶段，维护者核对组织配置及拒绝原因，不自动扩大权限。 |
| ACCOUNT_CHANGED / CREATOR_PERMISSION_REVOKED | 当前目标信息/创建者权限变化；停止动作，按最新信息重新确认或恢复授权后显式重试。 |
| ROOT_JOB_LINK_INVALID / ROOT_CREDENTIAL_UNAVAILABLE | 原 Root 任务或永久凭证不能可靠关联/读取；保留记录并人工核查，无自动补发。 |

所有 unknown 均显示其已知影响，不能只写“失败”：例如“第 2 步：密码请求超时，可能已修改，但未确认旧会话踢出；第 3–5 步未执行”。普通 exception 先映射成固定中文码/阶段；必要的外部原因限制 200 字并剔除 URL、邮箱接口请求体和敏感值，不用仅截断字符串冒充脱敏。

### 8.3 重启、冲突与边界输入

- 只恢复仍处于 queued/running 的回收 job：第 1–4 步被停机打断而停留在 running 的步骤转回 pending，保留同一密码、startedAt 和尝试记录，说明“服务中断，正在幂等核验/续跑”。启动先复验当前权限及目标。已因 failed/unknown 落为终态 failed/partial 的 job 保持终态，必须等待用户新的 TOTP 重试，不能靠重启绕过确认。
- 第 1 步重复删除幂等；第 2 步同一密码重写并再次踢会话；第 3 步无 MFA 为已满足；第 4 步已可恢复为已满足。服务不中断时，外部失败/未知不自动循环重试；启动恢复只是已有授权任务的恢复。
- Root 入队前当前队列已满/账户冷却中：第 5 步保留“尚未入队”的证据，整体 partial，提示等待并 TOTP 重试；不回滚已完成的邮箱操作。
- 后台任务按账户 ID 互斥；batch create/retry/cancel 的最后同步检查与写入使用 DB revision。每个 await 后先重读再写，旧 revision 的回调不能覆盖新状态。
- 同一根邮箱不得有重叠回收；创建、重试、每步运行前都核对共享邮箱冲突。用户自行在外部修改转发/凭证不在本系统互斥控制范围内，错误说明不能宣称其他访问面已清除。
- 0/21 个目标、重复/无效 ID 在写入前拒绝；1/20 个走相同逻辑。catalog 缺项为不可选，未知 payer/分页返回 400；批次/任务不存在或非本人返回 404。
- 已开始账户不因“停止未开始账户”中断；服务关停时原 Root runner 仍遵守未知密码边界。外部写入不可回滚，不恢复客户旧密码、MFA 或转发。

## 9. 测试计划

本阶段只定义验证计划。单元/服务测试均使用外部依赖替身，不连接真实邮箱、AWS 或生产库；不创建包含真实凭证的 fixture。

| 文件 | 必须覆盖 |
|---|---|
| 新增 `web/tests/account-reclaim-core.test.ts` | 固定五步顺序；16 位密码字符/类别约束；第 1–4 步失败/unknown 阻断；Root 全状态映射；可读原因/建议与脱敏；不能把第 4 步 unknown 视为可继续。 |
| 新增 `web/tests/account-reclaim-service.test.ts` | 完整五步及调用顺序；前四步未完成不入 Root 队列；五步成功 completed；第 2/3/4 步失败 failed+后续 not_run；邮箱超时后同密码 TOTP 重试；MFA 部分失败；无 MFA/恢复已存在 skipped；第 5 步安全失败重试成功、password_unknown 永不可重试；等待 Root 时其他账户前四步继续；只取消未开始账户。 |
| 同一 service 测试的持久化/竞态组 | 整批原子创建；0/1/20/21、重复 ID、错数量；requestId 幂等/冲突；共享邮箱拒绝；创建期间新增受限标记/权限撤销；CAS 双击；重启第 1–4 步续跑；Root 已写而 db 未关联重启补链；安全重试 child 已写时复用；Root 缺失不补发；结果审计/通知补偿。 |
| 新增 `web/tests/mailbox-admin-api.test.ts` | POST 原始 body 签名；改变一个字节签名不同；HTTPS/拒绝重定向；独立 key 配置无旧 token 回退；共享 1250ms 队列；lookup 缺项/重复/超长；HTTP/业务错误码；429 Retry-After；15 秒中止与响应上限；写未知无透明重试；日志不含密码。 |
| 新增 `web/tests/account-reclaim-permissions.test.ts` | none/operate × admin/partadmin/viewer；旧用户默认 none；身份变化401/降权403；非本人404/admin全局；仅回收权限无 root_reset_access 仍可执行；受限账户矩阵（admin 放行、partadmin/viewer 即使 operate 也拒绝、创建者降为非 admin 后后续步骤拒绝）因需读 `restricted_accounts`，**放在 service 测试**。 |
| 新增 `web/tests/account-reclaim-routes.test.ts` | HTTP 守卫实际覆盖全部 GET/POST；创建/重试 TOTP；重复 requestId 返回原结果不再执行；credentials no-store、实际操作者审计、审计失败不发明文；普通 DTO 不含密文/明文/Root 内部快照；人工验证码注入不可从请求控制。 |
| 修改 `web/tests/root-reset-permissions.test.ts`、`root-email.test.ts` | 来源缺失兼容；回收来源在旧所有查看/操作函数一律拒绝；CSV 专门拒绝；origin/reclaimJobId 的加载/幂等/重试保留；Root 普通入队与回收双向冲突；旧 root_reset_access 行为保持。 |
| 修改 `web/tests/root-email-manual.test.ts`，新增 `web/tests/account-reclaim-ui.test.ts` | 回收验证码实时权限/一次性challenge/10分钟期限/旧调用默认不变；有回收无cleanup的直链和Tab；失败原因常显；未知无重试；轮询不重叠/卸载清理；关闭弹窗清除密码状态；受限行对非 admin 置灰、对 admin 可选并带 Tag。UI 测试使用项目现有 node:test/tsx 与 jsdom 依赖，不新增测试框架。 |
| `web/tests/account-reclaim-service.test.ts` 的临时 DB 组 | 缺失顶层数组兼容；批量写无半批；不可变字段/CAS；邮箱字段密钥轮换成功、不可解时失败关闭；备份保留回收数据，不裁剪永久密码记录。 |

实现后先运行新增定向组：

```sh
cd web
node --import tsx --test tests/account-reclaim-core.test.ts tests/account-reclaim-service.test.ts tests/account-reclaim-permissions.test.ts tests/account-reclaim-routes.test.ts tests/account-reclaim-ui.test.ts tests/mailbox-admin-api.test.ts
node --import tsx --test tests/root-email.test.ts tests/root-email-selection.test.ts tests/root-email-manual.test.ts tests/root-email-execution-slot.test.ts tests/root-email-reconcile.test.ts tests/root-email-network.test.ts tests/root-email-security-frame.test.ts tests/root-reset-permissions.test.ts tests/root-mail-links.test.ts tests/mail-api.test.ts
npm test
npm run typecheck
npm run build
```

测试环境需要 config/encryption key 时使用隔离临时配置和测试 key，不复制生产密钥。缺本地运行配置/Chrome 等导致的环境失败要单独报告，不能当成已通过；上线闸门仍要求目标验证环境的必需检查通过。

浏览器人工 QA 以 admin、无权限、仅回收权限三类会话验证导航、直链、Tab、五步进度/失败说明、复制、验证码及刷新后恢复。真实五步联调须确认现有邮箱 API 通过 `mailbox-api-spec.md` 自检，并通过 G3/G4 后，在白名单 EC2 用一个授权测试账户完成。授权测试需要同时核验 webmail/IMAP 状态、转发收信及 AWS 登录；mock 通过不能代替此验收。

## 10. 影响面与风险

当前 README 使用主题章节而非固定“第九节”编号；按流程要求逐项核对相关高危主题：

| 高危主题/文件 | 影响与约束 |
|---|---|
| 权限模型：auth/db/Settings/MainLayout | 旧用户默认 none；回收权限独立，不能授予资源清理、管理员临时凭证或普通 Root 重置权限；所有 API 实时校验。 |
| 根用户凭证与 Root runner | 只加来源分流、内部 bridge 和人工验证码注入；保留单浏览器槽、提交边界、自动重试上限、未知状态及永久凭证策略。 |
| 跨账户与受限账户 | 固定 payer→AssumeRoot；受限账户仅 admin 可回收，非 admin 在创建、重试、每步执行前均阻断；不触碰角色自愈/临时 Admin/ExternalId，也不因 AccessDenied 扩权限。 |
| 数据与密钥轮换：db/Root store/备份 | 新数组向后兼容；双存储先记 attempt 再入队、崩溃补关联；邮箱密码随原轮换；数据与 keyring 分别受控保留，禁止自动裁剪。 |
| 资源清理：Cleanup.tsx | 同文件包 Tab，原扫描/删除接口及权限保持；仅回收用户不能访问原清理动作。 |
| 审计/通知 | 只加明确中文动作及脱敏事件；查看密码先完成审计，图片/答案/密码/链接不进普通日志。 |
| 部署与单实例 | 复用 OS 单实例锁；不支持多 PM2 worker 共享 JSON；startup/shutdown 纳入回收 runner；确认现有邮箱 API 的鉴权与生产连通性。 |

**不可逆影响**：执行后客户转发、旧邮箱凭据、Root MFA 和 Root 密码可能已改变；本功能只回收这两个登录入口，不能宣称 IAM/SSO/Access Key 等全部权限已撤销。前四步失败时即使整体叫 failed，也可能已有步骤生效，页面必须保留逐步事实。

**回滚**：停止新回收批次，保全当前 db.json、root-email-jobs.json 及匹配 keyring，先处理已开始/Root pending 的任务。旧代码可能不认识 origin、可能把回收任务暴露给 `/rootreset`，因此有回收数据后不能直接回退到完全没有来源隔离的版本并开放旧 Root 接口；回滚版本至少保留来源隔离与邮箱字段解密/轮换能力，或临时关闭相关 Root/回收写入口并由维护者处理。只回滚代码不能恢复已变更的外部密码/MFA/转发，禁止用旧数据库快照覆盖新增记录。

**文件影响清单**：

- 新增：`web/server/account-reclaim-core.ts`、`account-reclaim-permissions.ts`、`account-reclaim.ts`、`mailbox-admin-api.ts`，前端 `AccountReclaimPanel.tsx`，以及 §9 新测试。
- 修改：`web/server/db.ts`、`auth.ts`、`aws-service.ts`、`root-email-core.ts`、`root-email-jobs.ts`、`root-reset-permissions.ts`、`routes/aws.ts`、`index.ts`、`audit-presentation.ts`；前端 `api.ts`、`components/MainLayout.tsx`、`components/RootManualCaptchaModal.tsx`、`pages/Cleanup.tsx`、`pages/Settings.tsx`；重复样式需要时改 global.css。
- P5 由协调者同步：APP_VERSION、README、project-context、ROOT_EMAIL 文档中的来源隔离/配置与最终方案；不由实现 worker 改版本/总览。
- 本设计不要求新增 npm 依赖，不修改当前 package-lock 的其他未提交变更。

G1 已于 2026-10-15 批准；P2 产出 tasks.md 和文件所有权/波次，G2 后实现，G3/G4 后发版部署。

## 11. 明确不做什么

- 不重写或在本工具箱工作项中部署 EwoMail 既有 PHP/Dovecot 功能，不改邮箱现有 md5 存储；只对接现有邮箱能力，邮箱侧由用户维护。
- 不删除/调整资源清理原业务，不处理 IAM 用户/角色/Access Key、Identity Center/SSO、账单或备用联系人，也不删除 Root Access Key。
- 不回收 payer、自组织外账户、非 ACTIVE 账户、根邮箱非 EwoMail 账户；受限账户只允许 admin 回收，且不在回收中自动解除受限标记。
- 不增加回收 CSV/Excel 导出、Excel 导入、定时回收、跨进程并行 runner、独立浏览器队列或新 AWS 角色/StackSet。
- 不新写加解密算法，不在普通 API/审计/飞书返回密码或 reset URL，不在回收页提供 reset 链接提取接口。
- 不自动重试 password_unknown，不因超时伪造成功，不恢复客户旧密码/转发/MFA，不把手工改密结果自动记为已确认的新 AWS 密码。
- 不重构旧 Root 页面、OCR/验证码识别算法、只读 `mail-api.ts` 或相邻业务；只补必要接入、互斥与来源隔离。
- 不在 P1 生成 tasks.md、派实现 worker、运行真实 AWS/邮箱写操作、改版本或部署；不提交 data/config/密钥/备份，不使用 git add -A/add . 或危险数据回滚命令。
