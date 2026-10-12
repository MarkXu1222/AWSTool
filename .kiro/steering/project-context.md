# Project Context — AWSTool

AWS 多账户管理平台。跨组织管理成员账户：配额提升、账单 PDF 导出、区域开通、资源清理、根用户凭证操作、批量 Root 改密、MAP 标签合规、Bedrock 工具、POC Cash，带 MFA 登录与操作审计。

---

## 本文件的定位（先读这段）

这是**结构地图 + 改哪里**的快速索引，不是完整文档。

**`README.md` 是事实来源。** 涉及具体实现、接口参数、踩坑记录、AWS 侧约束时，直接去读 README 的对应章节；两者冲突一律以 README 为准，再顺手把本文件补齐。

> 历史教训：本文件曾长期停在 `0.34.1`，缺 bedrock / poccash / rootreset 三个页面和 16 个后端模块，而 README 是对的。之所以会漂移，是因为两边都在写同样的长文。**现在本文件只保留 README 里没有的、或需要高频查阅的索引，深度内容一律指过去。**

其余规范：部署与数据安全红线见 `deployment.md`；编码规范见 `coding-standards.md`；开发流程见 `development-methodology.md`；心跳汇报见 `heartbeat.md`。本文件不重复这些内容。

---

## 一、仓库里有两套应用（别改错地方）

| 应用 | 位置 | 包名 | 状态 |
|------|------|------|------|
| **Web 版（生产）** | `web/` | `aws-toolbox-web` | ✅ **在维护**，部署在 EC2（https://markxu.co） |
| 桌面版（旧） | 根 `src/` + `electron/` | `aws-toolbox` | ⚠️ 早期 Electron macOS 版，基本冻结，**不要动** |

**接到"平台/网站"相关需求，一律在 `web/` 下操作。**

当前版本以 `web/client/src/version.ts` 的 `APP_VERSION` 为准（**不要在文档里硬写版本号**，写了就会过期）。

---

## 二、技术栈（Web 版）

- 后端：Node.js + Express 4 + TypeScript，用 `tsx` **直接运行 .ts，不编译**（改 `.ts` `pm2 restart` 即生效）
- 前端：React 18 + Vite 6 + Ant Design 5 + recharts，TypeScript
- 前端路由：**无 react-router**，`MainLayout` 用 `useState(currentPage)` 切页 + 原生 `pushState`/`popstate` 同步 URL
- 存储：`data/db.json`（自研 JSON 文件存储，非数据库）+ 独立的 `data/root-email-jobs.json`
- 认证：JWT（8h 过期）+ 强制 TOTP MFA（otplib），bcrypt 存密码，敏感操作另有 step-up TOTP
- AWS：`@aws-sdk/*` v3；跨账户 STS AssumeRole；根特权走 `sts:AssumeRoot`
- 文档/导出：`puppeteer-core` + 系统 Chrome（提额 PDF、账单 PDF、Root 改密自动化）
- 通知：飞书 webhook
- 进程：EC2 上用 PM2（进程名 `aws-toolbox`）

---

## 三、页面总览（14 项导航）

页面 key **同时就是 URL 路径**（dashboard 归 `/`）。分三档敏感度：

**A. 可分配页面（11 个）** — 在 `PAGE_META`（MainLayout.tsx）与后端 `ALL_PAGE_KEYS`（auth.ts）中，可通过「页面权限」勾选授予：

`dashboard` `accounts` `quotas` `bedrock` `regions` `billing` `cleanup` `tagcompliance` `audit` `ops` `settings`

其中 `ops` 与 `bedrock` 属敏感页：在 `ALL_PAGE_KEYS` 里，但 non-admin 必须**显式勾选**，旧用户不自动继承（`DEFAULT_PAGE_KEYS` 只含另外 9 个）。

**B. 独立权限页（3 个）** — 刻意**不在** `PAGE_META` / `ALL_PAGE_KEYS` 里，勾选不到：

| key | 页面 | 由什么决定可见 |
|-----|------|----------------|
| `bulkquota` | `BulkQuota.tsx` | 独立权限 `bulk_quota_access` |
| `rootreset` | `BulkRootReset.tsx` | 独立权限 `root_reset_access`（`none`/`view`/`operate`） |
| `poccash` | `PocCash.tsx` | **仅 `role === 'admin'`**，没有对应权限字段，连勾选都无法授予 |

页面 ↔ 后端前缀的完整对照表见 **README「功能模块」**。

---

## 四、后端模块地图（`web/server/`）

★ = 高频改动或牵连面广。完整职责说明见 **README「目录结构」**。

| 分组 | 文件 |
|------|------|
| 基础设施 | `index.ts`（入口/中间件/限速/路由挂载）、`auth.ts`★（权限模型）、`step-up-mfa.ts`、`db.ts`★、`audit.ts`、`audit-presentation.ts`、`scheduler.ts`、`ops-monitor.ts`、`security-alerts.ts`、`notify.ts` |
| AWS 接入 | `aws-service.ts`★（AssumeRole 链）、`account-roles.ts`★、`account-lifecycle.ts`、`restricted-accounts.ts`★ |
| 提额文档 | `doc-generator.ts`、`doc-templates.ts`★、`case-doc-submitter.ts`★ |
| 账单导出 | `billing-export-jobs.ts`、`billing-exporter.ts` |
| Bedrock | `bedrock-tools.ts`、`bedrock-delivery.ts`★ |
| MAP 标签 | `tag-compliance.ts`、`tag-onboarding.ts` |
| 批量 Root 改密 | `root-email-jobs.ts`、`root-email-core.ts`★、`root-email-browser.ts`、`root-email-execution-slot.ts`、`root-email-manual.ts`、`root-email-reconcile.ts`、`root-password-secrets.ts`、`root-reset-permissions.ts`、`root-mail-poll.ts`、`root-mail-links.ts`、`mail-api.ts`、`mail-api-config.ts` —— **改这块前先读 `web/ROOT_EMAIL.md`** |
| POC Cash | `poc-cash.ts`、`poc-cash-funding.ts`、`poc-calculator.ts`、`pricing-calculator.ts`★、`calculator-services.ts`★、`calculator-rates.ts`★ |
| 路由 | `routes/aws.ts`★（主业务 50+ 端点）、`routes/regions.ts`、`routes/bedrock.ts`、`routes/poc-cash.ts` |

四个 router 的挂载（`index.ts`）：

```
/api/auth      authRouter                                    （登录相关免 token）
/api/aws       authMiddleware + auditMiddleware + awsRouter
/api/regions   authMiddleware + auditMiddleware + regionsRouter
/api/bedrock   authMiddleware + auditMiddleware + bedrockRouter
/api/poc-cash  authMiddleware + auditMiddleware + pocCashRouter   ← router 层再 use(requireStrictAdmin)
/api/ops       authMiddleware + requireOpsAccess + opsRouter      ← 不写审计
```

---

## 五、权限守卫速查

| 守卫 | 实际放行范围 |
|------|--------------|
| `requireAdmin` | **admin + partadmin**（只拦 viewer）—— 名字有误导性，但保留既有行为 |
| `requireStrictAdmin` | 仅 admin，**从数据库实时读取**，不信任 JWT 里的 role |
| `requireOpsAccess` | admin 或 `allowed_pages` 显式含 `ops` |
| `requireRootAccess` | `root_access` 或 admin |
| `requireAuditAccess` / `requireBillingAccess` / `requireBulkQuotaAccess` | 对应页面可见者或独立权限 |
| `root-reset-permissions.ts` | `root_reset_access` 的 `view`/`operate` |

⚠️ **MAP 标签的全部写端点用 `requireStrictAdmin`，不是 `requireAdmin`**（partadmin 进不去）。这条曾在文档里写反，以 `routes/aws.ts` 代码为准。

⚠️ `authMiddleware` 把 JWT payload 直接挂 `req.user`，所以 `req.user.role` 是**签发时**的角色。需要严格判断的守卫都改为 `db.getUser()` 实时读，避免降权用户在 token 过期前继续按旧角色通过。

---

## 六、跨账户访问模型

平台基础身份 `BASE_CREDENTIALS` = `config.json.credentials`（`arn:aws:iam::509399618054:user/mark`）。

只读链路 `assumeToAccount(accountId)`：
1. **一级跳 `support-quota`**（首选，最快）；失败记入内存 `supportRoleUnavailable`，本进程内不再重试
2. **payer 自身** → 直接用该 payer 的 `role/tool`
3. **二级跳** → payer `role/tool` 拿 admin，再 AssumeRole 成员账户 `OrganizationAccountAccessRole`

admin 链路：payer 自身 → **一级跳 `admin-console`** → 二级跳 OAAR。
第 2 步不只是性能优化：**INVITED 账户没有 OAAR**，只有 `admin-console` 进得去。

成员账户角色由组织级 `SERVICE_MANAGED` StackSet 下发到根 OU（`AutoDeployment=true` 覆盖未来新账户）；**管理账户本身不在覆盖内**，靠 `role/tool` 兜底。

角色清单、信任主体、新增 payer 的两个前置开关与完整 Runbook 见 **README「跨账户访问模型」与「新增 payer 安全 Runbook」**。

---

## 七、数据与配置

**`config.json`**（gitignore，含密钥）：`credentials`、`region`、`payers[]`、`childRoleName`、`adminRoleName`、`supportRoleName`、`adminRoleExcludedAccounts[]`、`consoleAdminPayers[]`、`tagCompliance{}`、`partnerCentral{}`、`web{}`（含 `encryptionKey` 与最多 8 个 `encryptionKeyPrevious`）。字段语义见 **README「配置与数据」**。

**`data/db.json`**（gitignore）顶层键：`users`、`quota_requests`、`audit_log`（5000 条滚动）、`region_data`、`accounts_cache` + `accounts_cache_time`、`account_roles`、`tag_onboarding_jobs`、`billing_export_jobs`、`restricted_accounts`、`departed_accounts`、`poc_calculator_ledger`。遗留 `dashboard_cache` 不再读写。

⚠️ 这些键**按需创建**。本地开发库通常只有前几个，且账户数远少于生产。**判断 schema 以 `db.ts` 代码为准，不要拿本地 `db.json` 当权威。**

**`data/root-email-jobs.json`** 是**独立文件**（永久 Root 凭证库，AES-256-GCM），不是 `db.json` 的键，备份与恢复分开做。

---

## 八、维护指南 — 常见改动"改哪里"

### 新增一个业务接口
1. `routes/aws.ts`（或对应 router）加路由 + 守卫
2. 需要 AWS 调用时在 `aws-service.ts` 加函数，复用 `assumeToAccount()`
3. `client/src/api.ts` 加方法 → 页面调用

⚠️ **注意注册顺序**：具体路径必须在通配之前。已知两处易踩：
`/quotas/case-doc-submit/:jobId` 要早于 `/quotas/:accountId/:serviceCode`；
`/accounts/roles-status`、`/accounts/departed` 要早于 `/accounts/:id/detail`。
Bedrock 配额特意用 `/api/bedrock` 独立前缀，就是为了躲开 `/quotas/` 通配。

### 新增一个可分配页面
`pages/Xxx.tsx` → `MainLayout.tsx` 的 `navItems` / `PAGE_META` / `pageComponent()` 各加一项（同一 key）→ `auth.ts` 的 `ALL_PAGE_KEYS` 加同名 key。

### 新增一个独立权限页
**不要**加进 `PAGE_META` / `ALL_PAGE_KEYS`。导出 `XXX_PAGE_KEY` 常量，再补 `navItems`、`VALID_PAGE_KEYS`、`isPageAllowed()` 分支、`pageComponent()` 分支，以及按 URL 直达时的 `independentAccess` 判断 —— **漏掉最后一条，有权限的用户直链进不去**。

### 新增一个独立权限字段
`auth.ts`（resolve + me + create/update）、`db.ts`（`getAllUsers` 暴露字段）、`routes/aws.ts`（中间件）、`MainLayout.tsx`（导航 gating）、`Settings.tsx`（勾选 + 列表列）、`api.ts`（createUser/updateUser 参数）。

### 新增 payer
**必须走 README 的「新增 payer 安全 Runbook」全 10 步**，不能只改 `config.json`。
关键：两个组织级开关缺一不可；双 StackSet 脚本**必须在 EC2 执行**（要读生产 `db.json` 的 `restricted_accounts` 排除名单）；验证通过后才能加入 `consoleAdminPayers`；改完 `pm2 restart`。

### 新增公司模板
`doc-templates.ts` 的 `COMPANY_PROFILES` + `ACCOUNT_TO_COMPANY` / `PAYER_TO_COMPANY`；架构图放 `doc-templates/architectures/`。

### 调同步频率
`scheduler.ts`：账户 30min、配额 4h、区域 24h、账户角色自愈（增量跟在账户同步后，全量复检 24h）。

### 发布新版本
递增 `web/client/src/version.ts` 的 `APP_VERSION`（小改 patch，大改 minor）。左下角展示，也用于确认部署是否生效。

---

## 九、改动前必读的高危区

这些地方有反直觉的硬约束，**改之前先读 README 对应章节和文件顶部注释**：

| 区域 | 风险 |
|------|------|
| `bedrock-delivery.ts` 的 `normalizeProfileName()` | scope 词 `us`/`global` 折叠掉会让两个 Profile 互相顶替，交付表出错且肉眼发现不了。`tests/bedrock-delivery-name-match.test.ts` 锁死 |
| Bedrock TPD 的 `inherited` 标记 | 硬契约，三处依赖（前端灰显 / CSV 的「TPD来源」列 / 交付表第 9 条须知）。必须按标记判断，不能按「有没有值」 |
| `billing-exporter.ts` | 必须 headed + `--kiosk-printing`；每账户独立浏览器实例（复用会导出全是第一个账户的内容）；固定 `access='support'`，**绝不回退 admin/OAAR** |
| `case-doc-submitter.ts` | 文件名回显 ≠ 上传完成；成功判定只认 Reply textarea 收起（用页面文案判断会假成功） |
| `index.ts` 的 CORS | 拒绝必须 `callback(null, false)`，**绝不 throw** —— throw 会被 Express 当 500，导致带 `crossorigin` 的静态资源失败、整站白屏 |
| 任何 CSV 导出 | 数字不加千分位，`toLocaleString()` 的逗号会让下游 `split(',')` 串位 |
| `restricted-accounts.ts` | `getExcludedAccountIds()` 刻意不按 state 过滤；收窄会**删除 admin-console**、OAAR 保留（Admin 凭证 ≤1h），INVITED 账户收窄后只剩 support-quota；取消标记顺序不能反（先补回 admin-console 并按备份恢复 support 权限，最后删记录）。`tests/restricted-admin-access.test.ts` 锁死 |
| POC Cash IAM 策略 | action 前缀是 `partnercentral:`，**不是** `partnercentral-selling:`，写错整个策略静默失效 |
| POC 定价计算器（`calculator-rates.ts` / `calculator-services.ts`） | 单价与 JSON 块必须与 calculator.aws「Update estimate」引擎一致，否则审核人一点重算金额就变（旧版 7,946 → 27,767）。单价来自引擎实测而非 Price List；标定时每个参数须独立变化（EFS 读写曾因同比例样本拆错）。`tests/calculator-calibration.test.ts` 锁 183 个实测用例；改动后必须联网跑 `scripts/verify-calculator-render.ts` |
| 批量 Root 改密 | 提交边界语义复杂，`password_unknown` 绝不自动重试。改动前必读 `web/ROOT_EMAIL.md` |

`web/tests/` 下有 14 个回归测试守着上述若干条，改完记得跑。

---

## 十、关键决策记录

- 生产以 **Web 版**为准，桌面版冻结
- 后端 **tsx 直跑不编译**，改 `.ts` 即生效
- 存储用 **JSON 文件 + 内存缓存 + 每日备份**，而非数据库（体量可控、零运维）
- 平台基础身份从 `134103550877` 迁移到 `509399618054:user/mark`（最小权限、精确主体信任）
- 成员账户角色用**组织级 SERVICE_MANAGED StackSet** 统一下发，自动覆盖未来新账户
- 账单 PDF 用**持久化后台 job + 单 job 全局队列**，严格只读 support 会话，可取消，重启中的活动任务明确标为 `interrupted`
- 敏感度分档而非一刀切：可分配页 → 需显式勾选的 `ops`/`bedrock` → 勾不到的 `poccash`
- 强制 **MFA + 审计日志 + 限速**；平台长期凭证只在服务端
- POC Cash 参考旧商机复用客户资料、Marketing 字段和 Solution；新商机的 Use Case 与业务描述由用户按本次标题填写，不沿用旧项目内容
- POC 定价计算器每条申请独一份：以本地台账（`poc_calculator_ledger`）ID 播种并兼作 `ClientToken`，生成后按总额/服务签名查重；成本公式以 calculator.aws 引擎实测为准（0.52.0，见 `.kiro/specs/poc-calculator-uniqueness/`）

---

## References

- **项目事实来源：`README.md`**
- 批量 Root 改密语义：`web/ROOT_EMAIL.md`
- 领域文档：`docs/poc-cash-guide.md`、`docs/partner-central-api.md`、`docs/bedrock-quota-api-and-permissions.md`
- 部署与数据安全：`.kiro/steering/deployment.md`
- 编码规范：`.kiro/steering/coding-standards.md`
- 开发流程：`.kiro/steering/development-methodology.md`
- AWS 文档：https://docs.aws.amazon.com/
