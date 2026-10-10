# 实现方案：敏感权限客户账户 —— 三个平台角色的收窄规则

> 状态：**G1 已批准（2026-10-10）**。实现者：Claude 直接实现（用户指定不用 codex）。
> 用户决定：D1 查询类功能不自动回退 OAAR；D2 受限账户保留区域开通（走 OAAR）；D3 工单给 `support:*`；
> D4 INVITED 账户（无 OAAR）收窄后只保留 support-quota。

## 1. 最终规则

| 角色 | 规则 |
|------|------|
| `OrganizationAccountAccessRole`（OAAR） | 保留，不改权限和信任关系。平台经 payer `role/tool` → OAAR 签发 Admin 临时凭证（≤1h）、打开 Admin 控制台、执行区域开通 |
| `admin-console` | 删除角色（StackSet 实例 `RetainStacks=false`；非 StackSet 管理的手工角色走 IAM 删除），删除后复验 AssumeRole 被拒；自愈 / 组织脚本均不补回 |
| `support-quota` | 收窄为：配额查询 + 申请提额 + 提额进度查询 + Support 工单（`support:*`）+ 区域状态查询；信任策略带 ExternalId（不变） |

INVITED 账户本来就没有 OAAR，删掉 admin-console 后**平台只剩 support-quota**：Admin 临时凭证、Admin 控制台、区域开通对它都不可用，平台直接给出明确提示（不去尝试 AssumeRole）。

## 2. `support-quota` 收窄后的内联策略 `SupportQuotaRestricted`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Resource": "*", "Action": [
      "servicequotas:Get*", "servicequotas:List*",
      "servicequotas:RequestServiceQuotaIncrease",
      "support:*",
      "account:GetRegionOptStatus", "account:ListRegions",
      "sts:GetCallerIdentity"
    ]},
    { "Effect": "Allow", "Action": "iam:CreateServiceLinkedRole", "Resource": "*",
      "Condition": { "StringEquals": { "iam:AWSServiceName": "servicequotas.amazonaws.com" } } }
  ]
}
```

- 进度查询 `ListRequestedServiceQuotaChangeHistory*` / `GetRequestedServiceQuotaChange` 由 `Get*`/`List*` 覆盖。
- 提额走 `requestQuotaIncrease()` → `assumeToAccount()` → support-quota；工单回帖/附件走 `case-doc-submitter.ts` → `getConsoleSigninUrl(id, dest, 'support')` → `assumeRoleStrict()`（已带 ExternalId）。两条都不需要改代码。
- `verifyRestricted()` 继续校验：带 ExternalId 能进、不带被拒、`iam:GetRole` 被拒。

## 3. 代码改动（逐文件）

### 3.1 `web/server/restricted-accounts.ts`
保留 Codex 未提交改动（已审核）：`support_policy_backup` 备份、`stackAccounts()` 分页、`requireOperation()`、`removeAdmin()`（StackSet / 手工角色删除 + 6×5s 复验，只把 AccessDenied 当成功）、`unmarkRestricted()`（先 StackSet 补回 admin-console → 按备份恢复 support 托管/内联策略 → 去 ExternalId → 删 `SupportQuotaRestricted` → 删记录）、`assumeChildAdmin()` 直接 AssumeRole admin-console 兜底。

修改：
1. `RESTRICTED_POLICY_DOC` → 第 2 节策略（两条 Statement）。
2. `RESTRICTED_UNAVAILABLE` →
   - `Admin 临时凭证超过 1 小时（admin-console 已移除，只能经 OrganizationAccountAccessRole 签发）`
   - `资源清理扫描（需 ec2/rds/s3/lambda 的 Describe 与 List）`
   - `账户详情的 IAM 安全状态（需 iam 的 List 与 Get）`
   - `INVITED（邀请加入）账户没有 OrganizationAccountAccessRole：Admin 临时凭证、Admin 控制台、区域开通均不可用`
3. 新增导出 `isSupportOnlyRestricted(accountId: string, joinedMethod?: string): boolean` = `isRestricted(accountId) && (joinedMethod ?? 账户缓存中该账户的 JoinedMethod) === 'INVITED'`。账户缓存读 `db.getAccountsCache().accounts`。
4. `markRestricted()`：
   - 进入 payer 循环前，按账户记下原记录 `previous` 的**浅拷贝快照**（在写 pending **之前**；实现时发现 db 记录对象会被 upsert 原地合并，存引用会读到 `pending`，已由测试 10 锁死）；pending upsert 的 `marked_at` 改为 `previous?.marked_at || now`。
   - `assumeChildAdmin()` 抛错时，若 `previous?.state === 'applied'`：**不把状态改成 failed**，保持 `applied`，`last_error` 写入「无法取得管理员凭证，收窄状态保持不变（INVITED 账户删除 admin-console 后无管理员入口属预期）」，结果 `{ ok:false, state:'applied', error }`。实现方式：在每账户 try 内把 `assumeChildAdmin` 单独包一层，抛出带 `code='NO_ADMIN_PATH'` 的错误，外层 catch 按此分支处理。
5. 顶部注释第 3 条与末段更新为本方案语义（admin-console 删除、OAAR 保留、INVITED 只剩 support）。

### 3.2 `web/server/aws-service.ts`
1. **撤销** Codex 对 `isAdminRoleExcluded` 的改动，恢复为只读 `config.adminRoleExcludedAccounts`。
2. 新增本地 `isAdminUnavailable(accountId, joinedMethod?) = isAdminRoleExcluded(accountId) || isSupportOnlyRestricted(accountId, joinedMethod)`。以下 4 处原用 `isAdminRoleExcluded` 的守卫改用它：
   - `listAccounts` 里的 `_adminRoleExcluded` / `_consoleDual`（传 `a.JoinedMethod`，避免读缓存）
   - `getTempAdminCredentials` 情况 2 之前的守卫（文案不变：「该账户已配置为仅保留 support-quota，不提供 Admin 临时凭证」）
   - `assumeAdminViaOAAR` 的守卫
   - `getConsoleSigninUrl` 的 `access !== 'support'` 守卫
3. `getTempAdminCredentials`：守卫之后、情况 2 之前，若 `isRestricted(accountId)`：
   - `durationHours > 1` → `TempCredentialError('该账户为敏感权限客户账户，admin-console 已移除，Admin 临时凭证只能经 OrganizationAccountAccessRole 签发，最长 1 小时', 409)`
   - 否则**跳过** admin-console 一级跳，直接进情况 3（OAAR）。
4. `assumeAdminViaOAAR`：若 `isRestricted(accountId)`，跳过 admin-console 一级跳，直接 OAAR。
5. `assumeToAccount`：把 Codex 插入的守卫条件从 `isAdminRoleExcluded` 改为 `isRestricted(accountId)`，文案改为「账户 X 为敏感权限客户账户，support-quota 不可用时不回退管理员角色（请检查 ExternalId 与角色状态）」。selfPayer 分支在它之前，不受影响。
6. `tryAssumeSupportRole`：受限账户不读也不写 `supportRoleUnavailable` 缓存（标记过程中信任策略切换的短暂拒绝不能把账户永久打入不可用，直到进程重启）。
7. 区域开通（`routes/regions.ts` 的 `enableRegion` → `getTempAdminCredentials(id)`，1h）经第 3 条自动走 OAAR，**routes/regions.ts 不改**；INVITED 受限账户得到第 2 条的 409 文案。区域状态查询仍走 `assumeToAccount`（support-quota 有 `account:ListRegions`）。

### 3.3 `web/server/account-roles.ts`
保留 Codex 改动不变：受限账户缺 `admin-console` 视为正常、不补建；探测 support 时带 ExternalId；所有受限记录（含 failed）跳过组织级 StackSet 补齐。

### 3.4 `web/client/src/pages/Accounts.tsx`
1. 标记弹窗说明（第 514 行起）改为：「收窄 `support-quota`（仅保留配额查询、提额、提额进度、Support 工单和区域状态查询）并启用 `ExternalId`；删除 `admin-console`；`OrganizationAccountAccessRole` 保留，Admin 临时凭证（最长 1 小时）、Admin 控制台和区域开通经它执行。只影响选中的账户，同组织其他账户不变。」
2. 警示条第二句改为：「配额查询与提额、提额进度、Support 工单、区域管理不受影响（INVITED 账户除外）。」
3. 账户选择器中 `JoinedMethod === 'INVITED'` 的选项后缀「· 邀请加入」；已选账户含 INVITED 时，警示条下方追加一行：「已选 N 个邀请加入的账户：它们没有 OrganizationAccountAccessRole，收窄后平台只保留 support-quota，Admin 临时凭证、Admin 控制台、区域开通都将不可用。」
4. 本段内写死的颜色（`rgba(0,0,0,0.55)`、`#fff7e6`/`#ffd591`/`#d46b08`）换成 `var(--color-*)` token（实现时以 `global.css` 现有 token 为准：muted 文字、warning 背景/边框/文字）。

### 3.5 `web/scripts/setup-org-stacksets.ts`
不改：第 273 行起已对受限账户同时排除 support/admin 两个 StackSet。

## 4. 测试 `web/tests/restricted-admin-access.test.ts`
沿用 Codex 的 fixture（fixture 的 `getAccountsCache` 增加 `JoinedMethod`：`invited` 时为 `INVITED`，否则 `CREATED`），断言：
1. 标记后目标账户 `admin-console` 被删、兄弟账户实例保留；support 内联策略含 `servicequotas:RequestServiceQuotaIncrease` 与 `support:*`；support 托管策略为空、带 ExternalId；记录 `applied`。（改）
2. 手工 `admin-console` 也被删。（保留）
3. `admin-console` 删除失败 → `failed`。（保留）
4. 受限 CREATED 账户：`getTempAdminCredentials(id, 1)` 成功，`issuedRoles` 含 OAAR、不含 `admin-console`；`(id, 2)` 以 409 拒绝且未签发任何角色。（改）
5. 受限 CREATED 账户：`getConsoleSigninUrl(id, …, 'admin')` 经 OAAR（mock `fetch` 返回 `SigninToken`）。（改）
6. 受限 INVITED 账户：`getTempAdminCredentials(id, 1)` 与 `getConsoleSigninUrl(…, 'admin')` 均被拒且未签发任何角色。（新）
7. 受限账户 support 进不去时 `assumeToAccount` 抛错且不调用 OAAR。（保留，改文案匹配）
8. 自愈不补 `admin-console`。（保留）
9. 取消标记（INVITED）先补 `admin-console`、恢复 support 原策略、去 ExternalId，最后删记录。（保留）
10. 已 `applied` 的 INVITED 账户 admin-console 已删后重复标记：结果 `ok:false`，记录仍为 `applied`。（新）

验收：`cd web && npm test && npm run typecheck && npm run build` 全绿。

## 5. 版本与文档
- `APP_VERSION` 0.50.0 → **0.51.0**（权限语义变化）。
- README「敏感权限客户账户」一节按第 1 节重写；project-context 第九节 `restricted-accounts.ts` 一行补充「admin-console 删除、INVITED 只剩 support」。

## 6. 上线后的生产动作（G4 单独批准）
1. 只读列出生产 `restricted_accounts`（账户 ID、payer、state）及各账户 `JoinedMethod`。
2. 对每个账户重新执行标记（幂等，ExternalId 不变，客户无需改配置）→ 全部 `applied`。
3. 只读核对：`admin-console` 不存在；`support-quota` 策略为第 2 节内容；OAAR 存在且未改；CREATED 账户能签发 1 小时 Admin 临时凭证。

## 7. 风险与已知限制
- support 权限从「只读」扩为「能提额 + 能操作工单」，若曾向客户书面承诺「只读」，需同步口径。
- 取消标记后 support-quota 恢复原权限，但仍不回到组织级 StackSet 托管（与当前生产行为一致，同名角色已存在无法由 StackSet 重建），本次不处理。
- INVITED 受限账户删除 admin-console 后，平台无法再修改其 IAM；重复标记只会报错不降级状态，取消标记依赖 payer StackSet 先补回 admin-console。
