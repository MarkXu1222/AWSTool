# admin-console 改为按需临时开通

## 背景

成员（linked）账户的 `admin-console`（`AdministratorAccess`，`MaxSessionDuration=43200` 即 12 小时，
直接信任 `509399618054:user/mark`）目前由各组织的 `admin-console-role-orgwide`
SERVICE_MANAGED StackSet 下发到 Root OU，`AutoDeployment=true`：任何新加入的账户都会自动获得一个
常驻的完整管理员角色。

用户要求（2026-10-13）：**新账户一律不再自动创建 `admin-console`，存量也全部删除**。需要 admin 时：

- 有 `OrganizationAccountAccessRole`（OAAR）的账户 → 一律走 payer `role/tool` → OAAR
- 没有 OAAR 的账户（通常是邀请加入的 INVITED 账户）→ 由管理员针对该账户**临时开通** `admin-console`，
  一般 2–3 小时，到期从 payer 侧删除 CloudFormation StackSet 实例

payer 管理账户经 `role/tool` 管理，不在本需求范围内；只关注成员账户里的权限。

## 使用者与角色

- 临时开通 / 提前关闭：仅 `admin`，后端 `requireStrictAdmin`（数据库实时校验），开通另需 TOTP step-up
- 开通期内谁能用 Admin 入口（Admin 控制台 / Admin 临时凭证 / Bedrock / 区域开通）：保持现有权限不变
- 页面：现有「账户管理」页（`accounts`），无新页面、无权限字段变化

## 范围内

1. **存量清理**：一次性脚本，按组织删除 `admin-console-role-orgwide` 的全部实例（`RetainStacks=false`），
   清空后删除该 StackSet；之后探测仍能 AssumeRole `admin-console` 的账户，输出残留清单（**只列不删**）
2. **新账户不再获得 `admin-console`**：组织级 StackSet 删除；`setup-org-stacksets.ts` 去掉 `admin` 模式；
   角色自愈不再补建 admin
3. **临时开通**：每个 payer 下一个专用 StackSet `admin-console-role-temporary`（`AutoDeployment=false`，
   平时 0 个实例）。开通 = 对单个账户 `CreateStackInstances`；时长 1 / 2 / 3 小时（默认 2）
4. **开通前置条件**：账户能经 OAAR 进入 → 拒绝；payer 管理账户、`adminRoleExcludedAccounts`、
   敏感权限客户账户 → 拒绝；已有未结束的开通 → 拒绝
5. **到期回收**：开通记录持久化；调度器每分钟扫描到期记录并删除实例，复验 AssumeRole 被拒；
   失败退避重试，连续失败飞书告警，状态不会被误标为已删除；服务重启后继续回收。可提前手动关闭
6. **Admin 链路调整**：成员账户只有在有效开通期内才尝试 `admin-console`，否则只走 OAAR；
   Admin 临时凭证与控制台会话时长不超过开通剩余时间；两条路都不通时返回明确的「需临时开通」提示
7. **角色自愈调整**：只补齐 `support-quota`；未经开通而存在的 `admin-console` 标为异常（不自动删除）
8. **敏感权限客户账户**：标记时删除 `admin-console` 的逻辑兼容「组织级 StackSet 已不存在」并能回收临时开通；
   取消标记**不再补回** `admin-console`，对没有 OAAR 的账户由系统内部临时开通 1 小时完成 IAM 恢复后立即回收
9. 前端：账户页「临时开通 Admin」（选时长 + TOTP）、开通中倒计时与「提前关闭」；
   Admin 入口遇到「需临时开通」时给出提示；临时凭证面板的时长提示与上限随之调整
10. 审计：开通、开通失败、到期回收、提前关闭、回收失败

## 明确不做

- 不改 payer 管理账户的 `role/tool`、不改 `support-quota`、不改 OAAR、不改 Root 特权操作（`AssumeRoot`）
- 不给有 OAAR 的账户开通（服务端实测拒绝）
- 不提供「续期」：到期后重新开通
- 不自动删除不在 StackSet 管理下的手工 `admin-console` 残留（只列清单）
- 不改 APN 账户的 `apn-console`
- `consoleAdminPayers` 配置项保留原样（只控制前端双选项的展示，不再代表已部署 admin-console）

## 验收标准

1. `cd web && npm test && npm run typecheck && npm run build` 全绿
2. 单元测试锁住：开通前置条件（OAAR 可用 / payer / 排除 / 受限 / 重复）、状态机（provisioning → active →
   revoking → revoked，失败进入 revoking 而非 revoked）、到期扫描、回收退避与告警只发一次、
   重启恢复、凭证时长按剩余时间截断、自愈不补建 admin 且把常驻 admin 标为异常、取消标记不补回 admin-console
3. 清理脚本 `--dry-run` 能列出每个组织的 StackSet 状态与实例数，不做任何写操作
4. 线上验收（P6，在你指定的 INVITED 测试账户上）：开通 1 小时 → Admin 控制台可登录 →
   提前关闭 → AssumeRole `admin-console` 被拒；另开通一次等待自动到期回收
5. 线上存量清理先对 1 个组织执行，确认无误后再对其余组织执行
