# 实现方案：admin-console 改为按需临时开通

> 需求与验收见同目录 `requirements.md`。本文件是实现的唯一依据。

## 1. 需求与验收

成员账户不再常驻 `admin-console`。有 OAAR 的账户经 OAAR 取 Admin；没有 OAAR 的账户由 admin 针对单个账户
临时开通 1–3 小时，到期由平台从 payer 侧删除 StackSet 实例。存量组织级 StackSet 全部清理。

- [ ] `cd web && npm test && npm run typecheck && npm run build` 全绿
- [ ] `cd web && node --import tsx --test tests/temp-admin.test.ts tests/restricted-admin-access.test.ts` 通过（用例见 §8）
- [ ] `cd web && npx tsx scripts/remove-orgwide-admin-console.ts --all` 默认 dry-run，只读，打印每个组织的 StackSet 状态与实例数
- [ ] 账户页：admin 对成员账户可见「临时开通 Admin」，选 1/2/3 小时 + TOTP；开通中显示剩余时间与「提前关闭」
- [ ] 对有 OAAR 的账户点开通 → 提示「该账户可经 OrganizationAccountAccessRole 获得 Admin，无需临时开通」
- [ ] 没有 OAAR 且未开通的账户点 Admin 控制台 → 提示需先临时开通

## 2. 现状分析

- `web/server/aws-service.ts`
  - `ADMIN_ROLE_NAME`（`config.adminRoleName || 'admin-console'`）、`CHILD_ROLE_NAME`（OAAR）
  - `getTempAdminCredentials(accountId, durationHours)`：payer 自身 → `role/tool`（≤1h）；
    `isAdminUnavailable` → 409；受限账户 >1h → 409；**成员账户先直跳 `admin-console`**（支持 >1h），
    失败且 1h 时回退 payer → OAAR
  - `assumeAdminViaOAAR(accountId)`（Admin 控制台）：payer 自身 → `role/tool`；非受限先直跳 `admin-console`（3600s），失败回退 OAAR
  - `getConsoleSigninUrl(accountId, dest, access)`：`access==='admin'` 调 `assumeAdminViaOAAR`
  - `TempCredentialError(message, statusCode: 400|409|503)`
- `web/server/account-roles.ts`：探测 `support-quota` 与 `admin-console`，缺失时按 payer 用
  `STACKSET_FOR = { support: 'support-quota-role-orgwide', admin: 'admin-console-role-orgwide' }` 补齐；
  `AccountRoleRecord` 含 `support/admin/admin_excluded/state/attempts/last_error`
- `web/server/restricted-accounts.ts`：`ADMIN_STACKSET = 'admin-console-role-orgwide'`；
  `removeAdmin()` 先查组织级实例并删除（`RetainStacks=false`），否则 IAM 删手工角色，最后复验被拒；
  `assumeChildAdmin()` 依次试 payer→OAAR、payer→admin-console、平台直跳 admin-console；
  `unmarkRestricted()` **先把账户加回 `admin-console-role-orgwide`**，再恢复 support-quota，最后删记录
- `web/scripts/setup-org-stacksets.ts`：`TEMPLATES.support` / `TEMPLATES.admin`，用法 `<support|admin>`
- `web/server/notify.ts`：`notifyAccountRoleIssues(records)` 把 `!r.admin` 列为缺 `admin-console`；`sendNotification(title, content)`
- `web/server/scheduler.ts`：`startScheduler()` 内用 `setInterval` 注册各同步任务
- `web/server/routes/aws.ts`：`requireStrictAdmin`（54 行）；`/temp-credentials/:accountId`（`requireRootAccess`）；
  `/console-url/:accountId`；`verifyStepUpTotp(identity, code, ip)` 来自 `step-up-mfa.ts`
- `web/server/db.ts`：`ARRAY_FIELDS` + `emptyDB()` 登记顶层数组键；`db` 对象提供各键的读写方法
- `web/server/bedrock-tools.ts`：`adminCreds()` 调 `getTempAdminCredentials(accountId)` 并缓存 50 分钟
- `web/client/src/pages/Accounts.tsx`：`ConsoleButton`、`consoleMenu`、角色状态面板（842/879/910 行）；
  `RootCredentialsPanel` 接收 `isAdmin/isPayer/adminExcluded`，管理员可选 1–12 小时
- nginx `proxy_read_timeout 10m`：同步等待 StackSet 部署可行

## 3. 方案总览

```
 [清理脚本] remove-orgwide-admin-console.ts（EC2 一次性）
   payer role/tool → 关 AutoDeployment → DeleteStackInstances(Root OU, RetainStacks=false) → DeleteStackSet → 残留探测 CSV

 [开通] Accounts 页 →POST /api/aws/temp-admin {accountId,hours,mfaCode}
   requireStrictAdmin + verifyStepUpTotp
   → temp-admin.openTempAdmin()
       前置校验（payer/排除/受限/重复）→ 实测 OAAR（可进 → 409）
       → db 记录 provisioning → [payer 锁] 确保 admin-console-role-temporary 存在
       → CreateStackInstances(单账户) → 等操作完成 → 复验可 AssumeRole → active(expiresAt)

 [使用] getTempAdminCredentials / assumeAdminViaOAAR
   有有效开通 → 直跳 admin-console（时长 ≤ 剩余）  否则 → OAAR（≤1h）  都不通 → TEMP_ADMIN_REQUIRED

 [回收] scheduler 每 60s → sweepTempAdminGrants()
   active 且到期 / revoking 且到重试时间 → [payer 锁] DeleteStackInstances → 复验被拒 → revoked
   失败 → revoking + 退避；第 3 次失败飞书告警一次
```

## 4. 数据模型变更

`data/db.json` 新增顶层数组键 **`temp_admin_grants`**（按需创建；老库没有该键时读为 `[]`）。
在 `ARRAY_FIELDS` 与 `emptyDB()` 中登记，`DBSchema` 增加 `temp_admin_grants: TempAdminGrant[]`。

```ts
export type TempAdminGrantStatus = 'provisioning' | 'active' | 'revoking' | 'revoked' | 'failed';
export type TempAdminGrantReason = 'manual' | 'unmark-restricted';

export interface TempAdminGrant {
  id: string;                    // crypto.randomUUID()
  accountId: string;
  accountName?: string;
  payer: string;                 // config.payers[].name
  hours: 1 | 2 | 3;
  reason: TempAdminGrantReason;
  status: TempAdminGrantStatus;
  requestedBy: string;           // username；系统内部为 'system:unmark-restricted'
  requestedByUserId: number | string | null;
  createdAt: string;             // ISO
  activatedAt?: string;
  expiresAt?: string;            // activatedAt + hours；仅 active 之后有值
  instanceRequested: boolean;    // 是否已调用过 CreateStackInstances（决定失败后是否需要回收）
  revokeRequestedAt?: string;
  revokedAt?: string;
  revokedBy?: string;            // 'system:expiry' | username | 'system:restricted-mark' | 'system:unmark-restricted'
  revokeAttempts: number;
  nextRevokeAt?: string;
  lastError?: string;
  alertedAt?: string;
}
```

`db` 对象新增方法（`web/server/db.ts`）：

```ts
listTempAdminGrants(): TempAdminGrant[];                       // 深拷贝，按 createdAt 降序
insertTempAdminGrant(grant: TempAdminGrant): void;             // 追加后裁剪：终态（revoked/failed）记录只保留最近 500 条
updateTempAdminGrant(id: string, updates: Partial<TempAdminGrant>): TempAdminGrant; // 不存在抛错；id/accountId/payer/createdAt 不可改
```

「未结束」= `status ∈ { provisioning, active, revoking }`。
`config.json` 无变更。`restricted_accounts`、`account_roles` 结构不变（`admin_excluded` 字段保留，不再参与判定，见 §5.4）。

## 5. 后端设计

### 5.1 新建 `web/server/temp-admin.ts`

只 import：`fs`、`path`、`crypto`、`@aws-sdk/client-sts`、`@aws-sdk/client-organizations`、
`@aws-sdk/client-cloudformation`、`./db`、`./notify`。**不得 import `aws-service` / `restricted-accounts` / `account-roles`**（避免循环依赖）。
按 `account-roles.ts` 的方式自行读取 `config.json` 得到 `REGION`、`BASE_CREDENTIALS`、`PAYERS`、
`ADMIN_ROLE = CONFIG.adminRoleName || 'admin-console'`、`CHILD_ROLE = CONFIG.childRoleName || 'OrganizationAccountAccessRole'`、
`adminRoleExcludedAccounts`（只取 `accountId` 集合）。

```ts
export const TEMP_ADMIN_STACKSET = 'admin-console-role-temporary';
export const TEMP_ADMIN_HOURS = [1, 2, 3] as const;
export const TEMP_ADMIN_MAX_SESSION_SECONDS = 10800;
const TRUST_PRINCIPAL = 'arn:aws:iam::509399618054:user/mark';

export class TempAdminError extends Error {
  constructor(message: string, public readonly statusCode: 400 | 404 | 409 | 503) { super(message); this.name = 'TempAdminError'; }
}
/** 成员账户既无 OAAR 也无有效开通时由 Admin 链路抛出，路由映射为 409 + code */
export class TempAdminRequiredError extends Error {
  readonly code = 'TEMP_ADMIN_REQUIRED';
  constructor(accountId: string) {
    super(`账户 ${accountId} 无法经 OrganizationAccountAccessRole 进入（通常是邀请加入的账户）。请管理员在账户页「临时开通 Admin」后重试`);
    this.name = 'TempAdminRequiredError';
  }
}

export function getActiveGrant(accountId: string, now?: number): TempAdminGrant | null;
export function remainingSeconds(grant: TempAdminGrant, now?: number): number;   // max(0, floor((expiresAt-now)/1000))
export function listOpenGrants(): TempAdminGrant[];                               // 未结束的记录

export async function openTempAdmin(input: {
  accountId: string;
  hours: number;
  requestedBy: { id: number | string | null; username: string };
  reason?: TempAdminGrantReason;        // 默认 'manual'
  bypassRestricted?: boolean;           // 仅 unmarkRestricted 内部使用
}): Promise<TempAdminGrant>;

export async function revokeTempAdmin(accountId: string, by: string): Promise<TempAdminGrant | null>; // 无未结束记录返回 null
export async function sweepTempAdminGrants(now?: number): Promise<{ revoked: number; failed: number }>;
export function recoverTempAdminGrantsOnStartup(): number;  // provisioning → revoking(nextRevokeAt=now)，返回改动条数

/** 仅供测试 */
export const __test__ = { TEMPLATE: string; backoffMs(attempts: number): number; resetLocks(): void };
```

**`getActiveGrant`**：取该账户 `status === 'active'` 且 `Date.parse(expiresAt) > now` 的记录；没有返回 null。

**模板 `TEMP_ADMIN_TEMPLATE`**（逐字）：

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: AWSTool temporary admin-console role (per-account, time-boxed, deleted on expiry)
Resources:
  AdminConsoleRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: <ADMIN_ROLE>
      MaxSessionDuration: 10800
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS:
                - arn:aws:iam::509399618054:user/mark
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/AdministratorAccess
      Tags:
        - Key: Purpose
          Value: TemporaryAdmin
        - Key: ManagedBy
          Value: AWSTool
```

**payer 锁**：模块级 `Map<string, Promise<void>>`，`withPayerLock(payer, fn)` 串行化同一 payer 的
StackSet 操作（CloudFormation 同一 StackSet 并发操作会 `OperationInProgressException`）。

**内部工具**（模块私有）：
- `assumePayer(payerName)`：BASE → payer `roleArn`，`DurationSeconds: 3600`，`RoleSessionName: 'awstool-temp-admin'`
- `rootOuId(payerCreds)`：`ListRootsCommand` 取第一个
- `waitOperation(cf, opId, maxMs)`：每 5s `DescribeStackSetOperation`，`SUCCEEDED` 返回；`FAILED/STOPPED` 抛错（含 `StatusReason`）；超时抛错
- `probeOaar(payerCreds, accountId): Promise<'yes' | 'no' | 'unknown'>`：payer 凭证 AssumeRole OAAR（900s）。成功 `yes`；
  `AccessDenied` / `AccessDeniedException` → `no`；其它 → `unknown`
- `waitAssumable(accountId, expect: boolean)`：BASE 直跳 `admin-console`（900s），最多 36 次 × 5s（复用受限账户的 IAM 传播经验）。
  `expect=true` 成功即返回；`expect=false` 只认 `AccessDenied` 为成功，其它错误立即抛出；超出次数抛错

**`openTempAdmin` 流程**（任一校验失败抛 `TempAdminError`，不写记录）：

1. `hours` ∉ {1,2,3} → 400 `'临时 Admin 时长只能是 1、2、3 小时'`；`accountId` 非 12 位 → 400
2. 从 `db.getAccountsCache().accounts` 找账户；不存在或无 `_payer` → 404 `'账户不在缓存中或无组织归属，请先刷新账户列表'`
3. `_isPayer` 或账户 ID 等于任一 payer roleArn 中的账户 → 409 `'payer 管理账户经 role/tool 管理，无需临时开通'`
4. 在 `adminRoleExcludedAccounts` 中 → 409 `'该账户已配置为仅保留 support-quota，不提供 Admin'`
5. `db.getRestrictedAccounts()` 含该账户且 `!bypassRestricted` → 409 `'该账户为敏感权限客户账户，不提供临时 Admin'`
6. 已有未结束记录 → 409 `` `该账户已有临时 Admin（${status}${expiresAt ? `，到期 ${expiresAt}` : ''}）` ``
7. `probeOaar` → `yes`：409 `'该账户可经 OrganizationAccountAccessRole 获得 Admin，无需临时开通'`；`unknown`：503 `'暂时无法确认 OAAR 状态，请稍后重试'`
8. 插入记录：`status: 'provisioning'`、`instanceRequested: false`、`revokeAttempts: 0`
9. `withPayerLock(payer)` 内：
   - `DescribeStackSet(TEMP_ADMIN_STACKSET)`；`StackSetNotFoundException` 时 `CreateStackSet`：`PermissionModel: 'SERVICE_MANAGED'`、
     `AutoDeployment: { Enabled: false }`、`ManagedExecution: { Active: true }`、`Capabilities: ['CAPABILITY_NAMED_IAM']`、
     `CallAs: 'SELF'`、`Tags: [{ManagedBy: AWSTool}, {Purpose: TemporaryAdmin}]`
   - 若 StackSet 已存在但 `AutoDeployment.Enabled === true` → 抛错 `'admin-console-role-temporary 的 AutoDeployment 被开启，拒绝开通，请人工检查'`
   - `CreateStackInstances`：`DeploymentTargets: { OrganizationalUnitIds: [root], Accounts: [accountId], AccountFilterType: 'INTERSECTION' }`、
     `Regions: [REGION]`、`OperationPreferences: { FailureTolerancePercentage: 0, MaxConcurrentPercentage: 100 }`、`CallAs: 'SELF'`；
     调用前先把记录 `instanceRequested` 置 true
   - `waitOperation(maxMs = 5 分钟)`
10. 锁外 `waitAssumable(accountId, true)`
11. 成功：`status: 'active'`、`activatedAt = now`、`expiresAt = now + hours×3600s`，返回记录
12. 第 9–10 步任何失败：`instanceRequested ? { status: 'revoking', nextRevokeAt: now } : { status: 'failed' }`，写 `lastError`；
    抛 `TempAdminError(\`临时开通失败：${msg}\`, 503)`（回收由 sweeper 负责）

**`revokeTempAdmin(accountId, by)`**：取该账户未结束记录（没有返回 null）；`provisioning` 状态 → 409 `'开通进行中，请稍后再关闭'`。
否则调用私有 `runRevoke(grant, by)` 并返回更新后的记录（失败时记录为 revoking，函数抛 `TempAdminError(…, 503)`）。

**`runRevoke(grant, by)`**：
1. 更新 `status: 'revoking'`、`revokeRequestedAt`（首次）、`revokedBy = by`
2. `withPayerLock(payer)` 内：`ListStackInstances(TEMP_ADMIN_STACKSET, StackInstanceAccount=accountId)`；
   StackSet 不存在视为无实例；有实例则 `DeleteStackInstances`（同样的 `DeploymentTargets` INTERSECTION、`RetainStacks: false`），`waitOperation(5 分钟)`
3. 锁外 `waitAssumable(accountId, false)`
4. 成功：`status: 'revoked'`、`revokedAt`、清空 `nextRevokeAt`/`lastError`
5. 失败：`revokeAttempts + 1`、`nextRevokeAt = now + backoffMs(attempts)`、`lastError`；
   `revokeAttempts >= 3 && !alertedAt` → `sendNotification('临时 Admin 回收失败', …)`（含账户、payer、到期时间、错误），写 `alertedAt`。状态**保持 revoking**

`backoffMs(n) = min(2^(n-1) × 60_000, 30 × 60_000)`。

**`sweepTempAdminGrants(now)`**：模块级 `sweeping` 标志防重入（重入直接返回 `{0,0}`）。依次处理：
`active` 且 `expiresAt <= now` → `runRevoke(g, 'system:expiry')`；`revoking` 且 `nextRevokeAt <= now`（无值视为到期）→ `runRevoke(g, g.revokedBy || 'system:expiry')`。
每条独立 try/catch，统计 revoked / failed。每次回收写审计：`db.addAuditLog(null, 'TEMP_ADMIN_REVOKE', …, 'system', null)`（失败为 `TEMP_ADMIN_REVOKE_FAILED`）。

### 5.2 修改 `web/server/aws-service.ts`

import `{ getActiveGrant, remainingSeconds, TempAdminRequiredError } from './temp-admin'`。

`TempCredentialError` 增加可选第三参数 `code?: 'TEMP_ADMIN_REQUIRED'`（`public readonly code?`）。

**`getTempAdminCredentials`**（payer 分支、`isAdminUnavailable`、受限账户分支保持不变），把「情况 2 / 3」改为：

1. `grant = restricted ? null : getActiveGrant(accountId)`
2. 有 grant：`remaining = remainingSeconds(grant)`；`remaining < 900` → 409 `'临时 Admin 剩余不足 15 分钟，请到期后重新开通'`；
   `seconds = min(durationSeconds, remaining)`，BASE 直跳 `admin-console`（`DurationSeconds: seconds`）；成功返回
   `format(resp)` 并附 `cappedByTempAdmin: seconds < durationSeconds`、`tempAdminExpiresAt: grant.expiresAt`；
   失败：`durationHours > 1` 时按原逻辑抛 409/503；=1 时继续第 4 步
3. 无 grant 且 `durationHours > 1` → 409 `'成员账户的 Admin 临时凭证经 OrganizationAccountAccessRole 签发，最长 1 小时；临时开通 Admin 期间可签发更长凭证（不超过剩余时间）'`
4. OAAR 循环（原「情况 3」不变）；全部失败且无可重试错误时：抛
   `new TempCredentialError(new TempAdminRequiredError(accountId).message, 409, 'TEMP_ADMIN_REQUIRED')`

**`assumeAdminViaOAAR`**：删除「非受限先直跳 admin-console」那段，改为：
`grant = isRestricted(accountId) ? null : getActiveGrant(accountId)`；有 grant 时 `remaining < 900` 抛 `TempAdminRequiredError`，
否则直跳 `admin-console`（`DurationSeconds: min(3600, remaining)`），失败继续走 OAAR；
OAAR 全部失败时抛 `TempAdminRequiredError(accountId)`（替换原错误信息）。

文件头与 `ADMIN_ROLE_NAME` 注释改为：「仅在临时开通期间存在（temp-admin.ts），不再由组织级 StackSet 常驻下发」。

### 5.3 修改 `web/server/bedrock-tools.ts`

`adminCreds()` 缓存到期改为 `min(Date.now() + 50 分钟, Date.parse(t.expiration) - 5 分钟)`（临时开通剩余时间可能短于 50 分钟）。

### 5.4 修改 `web/server/account-roles.ts`

- `STACKSET_FOR` 改为 `{ support: 'support-quota-role-orgwide' }`；`deployToAccounts` 只接受 `'support'`；`RoleKind` 保持 `'support' | 'admin'`（记录字段用）
- `probeAccountRoles` 不变（`admin` = 当前能否 AssumeRole `admin-console`）
- `needFix = probed.filter(p => !p.support)`；分组只生成 `|support`
- 判定改为（import `getActiveGrant` from `./temp-admin`）：
  ```ts
  const tempAdmin = !!getActiveGrant(p.acct.Id);
  const residualAdmin = st.admin && !tempAdmin;          // 未经开通而存在
  const nowGood = st.support && !residualAdmin;
  ```
  `st.support && residualAdmin` → `state: 'partial'`、`attempts: 0`、
  `last_error: '存在常驻 admin-console（未经临时开通），请运行 scripts/remove-orgwide-admin-console.ts 或人工删除'`；
  其余沿用原 attempts/unreachable 逻辑（只针对 support）。`admin_excluded` 照旧写入记录，不参与判定
- 文件头注释改为：只补齐 support-quota；admin-console 不再常驻，常驻即异常

### 5.5 修改 `web/server/restricted-accounts.ts`

- import `{ revokeTempAdmin, openTempAdmin, listOpenGrants } from './temp-admin'`
- `stackAccounts(cf, name)`：`StackSetNotFoundException` 返回空 Set（组织级 StackSet 清理后会不存在）
- `removeAdmin(...)` 开头：若该账户有未结束记录 → `await revokeTempAdmin(accountId, 'system:restricted-mark')`（失败抛出，标记失败）；之后原逻辑不变
- `unmarkRestricted(accountId, requestedBy: { id: number | string | null; username: string } = { id: null, username: 'system' })`（可选参数，保证与路由改动可分别合入）：
  - **删除**「恢复 `admin-console`（`ADMIN_STACKSET` Create/UpdateStackInstances）」整段
  - 取 admin 凭证：先 `assumeChildAdmin(creds, accountId)`；失败且错误不是网络/限流时：
    若 `getActiveGrant(accountId)` 已存在（管理员手动开通的）→ 直接复用，**结束时不回收**；否则 →
    `openTempAdmin({ accountId, hours: 1, reason: 'unmark-restricted', bypassRestricted: true, requestedBy })`，再 `assumeChildAdmin` 一次；
    该临时开通在 `finally` 中 `revokeTempAdmin(accountId, 'system:unmark-restricted')`（回收失败只写 `last_error` 并 console.error，不影响取消结果；sweeper 会继续回收）
  - 其余恢复 support-quota、复验、删记录的顺序不变
- 文件头注释第 3、4 条与 `unmarkRestricted` 注释更新：取消标记不再补回 admin-console

### 5.6 修改 `web/server/notify.ts`

`notifyAccountRoleIssues`：删除 `if (!r.admin) miss.push('admin-console');`。

### 5.7 修改 `web/server/scheduler.ts`

import `{ sweepTempAdminGrants, recoverTempAdminGrantsOnStartup } from './temp-admin'`。`startScheduler()` 开头调用
`recoverTempAdminGrantsOnStartup()`（try/catch 打日志），并注册：

```ts
// 临时 Admin 到期回收：每 60 秒
setInterval(() => { sweepTempAdminGrants().catch(e => console.error('[TempAdmin] sweep failed:', e.message)); }, 60 * 1000);
```

### 5.8 修改 `web/server/db.ts`

按 §4 增加键与三个方法；`account_roles` 注释改为「support-quota 可用性 + 是否存在常驻 admin-console」。

### 5.9 修改 `web/server/routes/aws.ts`

import `{ openTempAdmin, revokeTempAdmin, listOpenGrants, TempAdminError, TempAdminRequiredError, TEMP_ADMIN_HOURS }`。
三个路由注册在 `/accounts/:id/detail` **之前**：

| 方法 | 路径 | 守卫 | 请求体 | 响应 |
|---|---|---|---|---|
| GET | `/temp-admin/grants` | 登录即可（无额外守卫） | — | `{ success, data: TempAdminGrant[] }`（`listOpenGrants()`） |
| POST | `/temp-admin` | `requireStrictAdmin` + `verifyStepUpTotp({ id: user.userId, username: user.username }, req.body.mfaCode, req.ip)` | `{ accountId, hours, mfaCode }` | `{ success, data: TempAdminGrant }` |
| DELETE | `/temp-admin/:accountId` | `requireStrictAdmin` | — | `{ success, data: TempAdminGrant \| null }` |

- POST：`hours` 用 `Number(req.body.hours)`；StepUp 失败按 `StepUpMfaError.statusCode` 返回，并写审计 `TEMP_ADMIN_STEPUP_FAILED`；
  成功写 `TEMP_ADMIN_OPEN`：`` `AWS 账户 ${accountId} · 临时开通 Admin ${hours} 小时，到期 ${expiresAt}` ``；
  `TempAdminError` 失败写 `TEMP_ADMIN_OPEN_FAILED` 并返回其 `statusCode`；其它错误 500
- DELETE：成功写 `TEMP_ADMIN_REVOKE`：`` `AWS 账户 ${accountId} · 提前关闭临时 Admin（操作人 ${username}）` ``
- `/temp-credentials/:accountId` 的 catch：响应体增加 `code: e.code`（存在时）
- `/console-url/:accountId` 的 catch：`e instanceof TempAdminRequiredError` → `409 { error, code: 'TEMP_ADMIN_REQUIRED' }`
- `DELETE /accounts/restricted/:accountId` 调 `unmarkRestricted(accountId, { id: user.userId, username: user.username })`

### 5.10 修改 `web/scripts/setup-org-stacksets.ts`

删除 `TEMPLATES.admin` 与所有 `admin` 分支（`readAdminRoleExcludedAccountIds` 等只为 admin 服务的函数一并删除）；
用法改为 `<support> [payerName] [--dry-run] [--refresh-template]`，传 `admin` 时报错：
`'admin-console 已改为按需临时开通（temp-admin.ts），不再提供组织级部署'`。文件头注释同步。

### 5.11 新建 `web/scripts/remove-orgwide-admin-console.ts`（一次性，EC2 执行）

用法：`npx tsx scripts/remove-orgwide-admin-console.ts (--payer <名称> | --all) [--execute] [--out <目录>]`，**默认 dry-run**。
只读 `config.json`，不读写 `data/`。按组织串行：

1. assume payer `role/tool`；`DescribeStackSet('admin-console-role-orgwide')`，不存在 → 打印「无」，跳到第 5 步
2. 打印：AutoDeployment、实例总数及按状态计数
3. `--execute`：
   - AutoDeployment 开启时 `UpdateStackSet({ UsePreviousTemplate: true, Capabilities: ['CAPABILITY_NAMED_IAM'], PermissionModel: 'SERVICE_MANAGED', AutoDeployment: { Enabled: false }, CallAs: 'SELF' })` 并等待完成
   - 有实例时 `DeleteStackInstances({ DeploymentTargets: { OrganizationalUnitIds: [root] }, Regions: [REGION], RetainStacks: false, OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 }, CallAs: 'SELF' })`，等待最长 60 分钟
   - 再次列实例：为 0 → `DeleteStackSet`；不为 0 → 打印剩余实例账户与 `StatusReason`，不删 StackSet（可重跑）
4. `--execute` 完成后（以及 dry-run 时）进入第 5 步
5. 残留探测：Organizations `ListAccounts` 取 ACTIVE 成员账户（排除管理账户），并发 6，BASE 直跳 `admin-console`（900s）；
   能进入的列入残留清单。**不删除**。输出 CSV `orgwide-admin-console-residual-<payer>-YYYYMMDD.csv`
   （列 `payer,accountId,accountName,joinedMethod`；字段双引号包裹，数字不加千分位）
6. 结尾打印每个组织一行汇总

### 5.12 前端

**新建 `web/client/src/components/TempAdminModal.tsx`**：

```ts
const TempAdminModal: React.FC<{
  open: boolean;
  account: { Id: string; Name?: string } | null;
  onClose: () => void;
  onOpened: (grant: any) => void;
}>;
```
- `Radio.Group` 选 1/2/3 小时（默认 2）；6 位 TOTP 输入框（`inputMode="numeric"`、`maxLength={6}`）
- 说明文案：`将通过 payer 对该账户临时部署 admin-console（AdministratorAccess），到期自动删除。仅适用于没有 OrganizationAccountAccessRole 的账户，部署约需 1–5 分钟。`
- 提交调 `api.openTempAdmin({ accountId, hours, mfaCode })`；`confirmLoading`；成功 `message.success('临时 Admin 已开通，到期 …')` 并 `onOpened`；失败 `message.error(err)`

**修改 `web/client/src/api.ts`**：

```ts
listTempAdminGrants: () => request('/aws/temp-admin/grants'),
openTempAdmin: (body: { accountId: string; hours: number; mfaCode: string }) =>
  request('/aws/temp-admin', { method: 'POST', body: JSON.stringify(body) }),
revokeTempAdmin: (accountId: string) => request(`/aws/temp-admin/${accountId}`, { method: 'DELETE' }),
```

**修改 `web/client/src/pages/Accounts.tsx`**：
- 页面加载及每次开通/关闭后调用 `listTempAdminGrants()`，存 `Map<accountId, grant>`；每 30 秒刷新一次剩余时间显示（只重算，不重新请求；每 5 分钟重新请求一次）
- `consoleMenu(accountId)`：`isAdmin` 且账户非 payer / 非 APN / 非 `_adminRoleExcluded` 时追加菜单项 `{ key: 'temp-admin', label: '临时开通 Admin（无 OAAR 账户）' }`；有未结束开通时替换为 `{ key: 'temp-admin-revoke', label: '提前关闭临时 Admin', danger: true }`（`Popconfirm` 不可用于菜单项，改用 `Modal.confirm`）
- `ConsoleButton` 旁：有 `active` 开通时显示 `<Tag color="warning">临时 Admin · 剩余 {h}h{m}m</Tag>`；`revoking` 时显示 `<Tag color="error">回收中</Tag>`；`active` 但剩余时间已到 0（sweeper 尚未执行）显示 `<Tag color="error">到期回收中</Tag>`
- `openConsole` 失败且 `err.code === 'TEMP_ADMIN_REQUIRED'`：`isAdmin` 时 `Modal.confirm` 询问是否打开 `TempAdminModal`；否则 `message.error` 原文
- 角色状态面板：说明文案（774 行）改为「平台访问成员账户依赖 `support-quota`；`admin-console` 只在临时开通期间存在，常驻即异常」；
  842 / 910 行的缺失判断删除 `admin-console`，改为 `x.admin && x.state === 'partial'` 时显示「常驻 admin-console」；
  CSV 列 `admin_console` 改为 `x.admin ? '存在' : '无'`
- `RootCredentialsPanel` 增加 prop `tempAdminExpiresAt?: string`

**修改 `web/client/src/components/RootCredentialsPanel.tsx`**：
- 成员账户时长上限：`tempAdminExpiresAt` 有值时 `max = clamp(floor(剩余小时), 1, 12)`；无值时固定 1（与后端 §5.2 第 3 步一致）
- 提示文案改为：`成员账户经 OrganizationAccountAccessRole 签发，最长 1 小时；临时开通 Admin 期间可签发更长凭证，但不超过剩余时间。`
- 生成成功后若 `res.data.cappedByTempAdmin`，`message.info('凭证有效期已按临时 Admin 剩余时间截断')`

样式：只用 AntD 语义色与 `var(--color-*)`；不写 hex；不用 emoji；成功提示无感叹号。

## 6. AWS 链路

| 动作 | 身份链 | IAM action |
|---|---|---|
| 开通前 OAAR 探测 | BASE → payer `role/tool` → 成员 OAAR | `sts:AssumeRole` |
| 建 / 用临时 StackSet | BASE → payer `role/tool` | `cloudformation:DescribeStackSet/CreateStackSet/CreateStackInstances/DeleteStackInstances/ListStackInstances/DescribeStackSetOperation`，`organizations:ListRoots` |
| 复验 | BASE 直跳成员 `admin-console` | `sts:AssumeRole` |
| 使用 | BASE 直跳 `admin-console`（开通期）/ payer → OAAR | `sts:AssumeRole` |
| 清理脚本 | BASE → payer `role/tool` | 上述 + `UpdateStackSet/DeleteStackSet`，`organizations:ListAccounts` |

`role/tool` 已是 payer 管理员，以上权限均已具备。前提同组织级 StackSet：组织已启用 StackSets 受信任访问（`activate-organizations-access`）。
**SERVICE_MANAGED 不覆盖管理账户**，与本需求一致（payer 不开通）。

## 7. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 两个管理员同时对同一 payer 下不同账户开通 | payer 锁串行；后者等待前者完成 |
| 对同一账户重复开通 | 第二次 409（已有未结束记录） |
| 部署成功但复验超时 | 记录转 `revoking`，sweeper 删除实例；接口 503 |
| 开通过程中服务重启 | 启动时 `provisioning` → `revoking`，sweeper 回收 |
| 到期时 AWS 删除失败 | `revoking` + 退避；第 3 次失败飞书告警一次；继续重试直至成功 |
| 开通期内签发的凭证 / 控制台会话 | 时长不超过剩余时间，到期自然失效 |
| 剩余不足 15 分钟 | 拒绝签发（AWS 最短 900s） |
| 受限账户 | 不允许人工开通；取消标记时内部开通 1h 并立即回收 |
| 标记受限时账户正处于开通期 | 先回收临时开通，再执行原删除与复验 |
| 组织级 StackSet 已被清理脚本删除 | `restricted-accounts` 视为无实例；自愈不再引用 |
| `admin-console-role-temporary` 被人为开启 AutoDeployment | 拒绝开通并提示人工检查 |

## 8. 测试计划

测试按文件所有权拆为三个文件：
- `web/tests/temp-admin.test.ts`：下列用例 1–9 及 Review Focus 2/3/4/5（只依赖 `temp-admin.ts` 与 `db`）
- `web/tests/temp-admin-chain.test.ts`：「account-roles 判定」与「凭证时长」两组（依赖 `aws-service.ts` / `account-roles.ts`）
- `web/tests/restricted-admin-access.test.ts`：受限账户相关修改与新增

**新增 `web/tests/temp-admin.test.ts`**（mock `STSClient.prototype.send`、`CloudFormationClient.prototype.send`、
`OrganizationsClient.prototype.send` 与 `db` 方法，`setTimeout` 改为 microtask，写法参照 `tests/restricted-admin-access.test.ts`）：

1. OAAR 可进入 → 409 且未写记录、未调用 CreateStackInstances
2. payer 管理账户 / `adminRoleExcludedAccounts` / 受限账户（无 bypass）/ 已有未结束记录 / hours=4 → 各自拒绝
3. 正常开通：StackSet 不存在时先创建（断言 `AutoDeployment.Enabled === false`、模板含 `MaxSessionDuration: 10800`），
   CreateStackInstances 只含目标账户（INTERSECTION），记录 active 且 `expiresAt = activatedAt + hours`
4. 部署 FAILED → 记录 `revoking`、接口抛 503；StackSet 创建失败（未请求实例）→ 记录 `failed`
5. sweeper：到期 active → 删除实例 → 复验被拒 → `revoked`；未到期不动；重入保护
6. 回收失败：第 1、2 次只退避，第 3 次 `sendNotification` 调用一次，第 4 次不再发；状态始终 `revoking`
7. `recoverTempAdminGrantsOnStartup`：provisioning → revoking
8. 复验阶段 `admin-console` 返回非 AccessDenied 错误 → 不判定为已回收
9. `getActiveGrant`：过期的 active 视为无效

**修改 `web/tests/restricted-admin-access.test.ts`**（高危区回归测试，属有意修改）：
- fixture 增加 `admin-console-role-temporary` 的实例集合，CloudFormation mock 支持 `DescribeStackSet`/`CreateStackSet`/`ListStackInstances(StackInstanceAccount)`
- `'unrestricting invited accounts restores admin and support grants before clearing the marker'` 改为
  `'unrestricting invited accounts restores support via a 1h temporary admin and leaves no admin-console'`：
  断言 support-quota 恢复、记录删除、临时开通记录为 `revoked`、`admin-console` 不存在、组织级 StackSet 未被加入实例
- 新增：组织级 `admin-console-role-orgwide` 不存在时标记受限仍成功
- 新增：账户处于开通期时标记受限，会先回收临时开通
- 新增：取消标记时账户已有人工开通 → 复用该开通完成恢复，结束后该开通仍为 `active`
- 其余用例保持通过；`'role healing treats intentional admin removal as healthy and never recreates it'` 保持不变

**`account-roles` 判定**（`temp-admin-chain.test.ts`）：
- support 正常、admin 存在且无开通 → `partial` 且 `last_error` 含「常驻 admin-console」，且不调用任何 CreateStackInstances
- support 正常、admin 存在且有有效开通 → `ok`
- support 缺失 → 只对 `support-quota-role-orgwide` 补齐

**凭证时长**（`temp-admin-chain.test.ts`）：开通剩余 30 分钟请求 2 小时 → `DurationSeconds === 1800` 且 `cappedByTempAdmin === true`；
剩余 10 分钟 → 409；无开通请求 2 小时 → 409；无开通且 OAAR 失败 → `code === 'TEMP_ADMIN_REQUIRED'`

### Review Focus（规格隐含、最容易出事的 5 类输入）

1. **取消受限标记时账户已有人工开通** → 复用、不回收（否则会把操作人正在用的权限删掉）。测试：`restricted-admin-access.test.ts` 新增用例
2. **开通期内账户离开组织 / 被暂停** → payer 侧删不掉实例，必须停在 `revoking` 并告警，不能误标 `revoked`。测试：`temp-admin.test.ts` 用例 6 的 DeleteStackInstances 抛错分支
3. **sweeper 回收与人工「提前关闭」同时发生** → payer 锁串行，第二次发现无实例后仍复验并落 `revoked`，不报错。测试：`temp-admin.test.ts` 新增「无实例时 runRevoke 直接复验」
4. **到期与 sweeper 之间的 ≤60 秒窗口** → `getActiveGrant` 以 `expiresAt` 为准立即失效，链路不再直跳 admin-console；前端倒计时到 0 显示「到期回收中」。测试：用例 9
5. **复验时 STS 网络错误** → 不得当作已删除（只认 AccessDenied）。测试：用例 8

必须仍然通过：`tests/restricted-admin-access.test.ts`（修改后）、`tests/apn-accounts.test.ts`、`tests/audit-middleware.test.ts`。

## 9. 影响面与风险

- **破坏性变更（预期）**：部署后、清理前，INVITED 账户的常驻 `admin-console` 仍在，但平台不再使用（无开通记录即不直跳）。
  清理后这些角色被删除；INVITED 账户需要 admin 时必须临时开通
- 高危区（`.kiro/steering/project-context.md` 第九节）：`restricted-accounts.ts` 取消标记顺序 —— 去掉「补回 admin-console」，
  其余「先恢复 support、最后删记录」顺序保持；`getExcludedAccountIds()` 不改
- 清理脚本删除的是完整管理员角色，必须先对 1 个组织执行并验证，再全量
- 回滚：只回滚代码不会恢复已删除的 `admin-console`。如需恢复，用旧版 `setup-org-stacksets.ts admin`（git 历史中）重新部署。
  `temp_admin_grants` 键对旧代码无影响（旧代码不读取）；回滚前应先确认没有 `active`/`revoking` 记录，否则需手工删除其实例

## 10. 明确不做

- 不改 payer `role/tool`、`support-quota`、OAAR、`AssumeRoot`、APN `apn-console`
- 不做续期、不做批量开通
- 不自动删除残留的手工 `admin-console`（清理脚本只列清单）
- 不改 `consoleAdminPayers` 配置及其解析逻辑
- 不重构 `Accounts.tsx` 其它部分
- 不改 `version.ts`、`README.md`、`project-context.md`（P5 统一处理）
