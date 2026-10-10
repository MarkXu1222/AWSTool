# 需求纪要：敏感权限客户账户 —— 三个平台角色的收窄规则

## 目标

把「敏感权限客户账户」（`restricted_accounts`）的收窄规则改为对三个角色分别处理：

| 角色 | 要求 |
|------|------|
| `OrganizationAccountAccessRole` | 保留，不修改权限或信任关系 |
| `admin-console` | 移除管理员权限，并禁止自动补回 |
| `support-quota` | 保留配额查询、申请提升、申请进度查询 |

## 使用者与角色

- 标记 / 取消标记：仅 strict admin（沿用 `requireStrictAdmin`，不变）。
- 收窄结果影响所有平台用户对该账户的访问。

## 范围内

1. `support-quota` 收窄策略增加 `servicequotas:RequestServiceQuotaIncrease`（及首次提额所需的 Service Quotas 服务关联角色创建权限）；查询与进度查询沿用 `servicequotas:Get*` / `List*`。
2. 标记时删除该账户的 `admin-console`：从 `admin-console-role-orgwide` StackSet 删除实例（`RetainStacks=false`）；不是 StackSet 管理的手工角色则通过 IAM 删除。删除并复验成功才算 `applied`。
3. 禁止补回：角色自愈（`account-roles.ts`）把受限账户的 `admin-console` 缺失视为正常；`setup-org-stacksets.ts` 已排除受限账户（不改）。
4. 平台侧不再为受限账户签发 Admin 凭证 / Admin 控制台，`assumeToAccount` 不回退到 OAAR（见 design.md 决策 D1，需用户确认）。
5. 取消标记时恢复原状：先补回 `admin-console`，再把 `support-quota` 恢复为默认权限（顺带修复现有 bug：原来不会重新挂 `ReadOnlyAccess` 等策略）。
6. 已经收窄过的生产账户，部署后重新执行一次标记（幂等，ExternalId 不变）以应用新规则。

## 明确不做

- 不改 `OrganizationAccountAccessRole` 的任何权限或信任关系。
- 不改 ExternalId 机制、不轮换已有 ExternalId。
- 不改 `setup-org-stacksets.ts`（已正确排除受限账户的两个 StackSet）。
- 不改 `adminRoleExcludedAccounts` 配置语义。
- 不改 db.json schema。

## 验收标准

- `cd web && npm test && npm run typecheck && npm run build` 全绿，且 `tests/restricted-admin-access.test.ts` 覆盖：
  - 标记后目标账户 `admin-console` 被删除、同组织其他账户不受影响；
  - 手工创建的 `admin-console` 也会被删除；
  - `admin-console` 删除失败时记录为 `failed`，不能报成功；
  - pending / applied / failed 三种状态都拒绝 Admin 临时凭证、Admin 控制台、auto 控制台；
  - 受限账户 `support-quota` 失败时 `assumeToAccount` 不回退 OAAR；
  - 角色自愈把受限账户缺 `admin-console` 视为正常且不补建；
  - 取消标记（含 INVITED 账户）先恢复 `admin-console` 与 `support-quota` 默认权限，再删除记录。
- 部署后（G4 另行批准）对已有受限账户重新执行标记，结果全部 `applied`；只读核对：`admin-console` 不存在，`support-quota` 内联策略含 `RequestServiceQuotaIncrease`，OAAR 未变。

## 已知约束

- IAM 最终一致：删除角色、改信任策略后需轮询复验。
- INVITED 账户没有 OAAR，标记时唯一的管理员入口就是 `admin-console`；删除 `admin-console` 必须放在 `support-quota` 改造完成之后，取消标记时必须先通过 StackSet 补回 `admin-console`。
