# AWS Toolbox

企业级 AWS 多账户（多 Organizations）管理平台。带强制 MFA 登录、页面级权限与全量操作审计。

**线上**：https://markxu.co（EC2 Singapore，PM2 进程 `aws-toolbox`）
**当前版本**：`0.14.0`（见 `web/client/src/version.ts`，左下角展示）

**生产接入规模**（配置快照 2026-08-27；账户数快照 2026-08-13）

| 指标 | 数量 |
|------|------|
| 已配置 AWS Organizations（payer） | 44 |
| 已验收并开放 `consoleAdminPayers` | 43 |
| 全部账户（2026-08-13） | 2532 |
| 其中成员账户（2026-08-13） | 2492 |
| 已有区域状态记录的账户（2026-08-13） | 2519 |

覆盖账户管理、配额提升（单个 / 批量 / Bedrock）、区域开通、账单分析与官方账单 PDF 导出、资源清理、提额文档自动生成、MAP 标签合规、根用户凭证操作、审计与飞书通知。

---

## 目录

- [仓库里有两套应用](#仓库里有两套应用)
- [技术栈](#技术栈)
- [功能模块](#功能模块)
- [目录结构](#目录结构)
- [跨账户访问模型](#跨账户访问模型)
- [接口清单](#接口清单)
- [权限模型](#权限模型)
- [配置与数据](#配置与数据)
- [关键实现](#关键实现)
- [后台定时同步](#后台定时同步)
- [部署与运维](#部署与运维)
- [数据安全](#数据安全)
- [已知待办](#已知待办)

---

## 仓库里有两套应用

改代码前先确认改哪一套。

| 应用 | 位置 | 包名 | 状态 |
|------|------|------|------|
| **Web 版（生产）** | `web/` | `aws-toolbox-web` | ✅ 在维护，日常改动都在这里 |
| 桌面版（旧） | 根 `src/` + `electron/` | `aws-toolbox` | ⚠️ 早期 Electron macOS 版，基本冻结 |

平台/网站相关的需求，一律在 `web/` 下操作。

---

## 技术栈

- **后端**：Node.js + Express 4 + TypeScript，用 `tsx` 直接运行 `.ts`，**不编译**（改 `.ts` 后 `pm2 restart` 即生效）
- **前端**：React 18 + Vite 6 + Ant Design 5 + TypeScript。**无 react-router**，`MainLayout` 用 `useState(currentPage)` 切页；单 bundle 不分包，避免跨境网络分包超时
- **存储**：`data/db.json`，自研 JSON 文件存储 + 内存缓存 + 每日备份（非数据库）
- **认证**：JWT（2h 过期）+ 强制 TOTP MFA（otplib），密码 bcrypt，MFA secret AES-256-CBC 加密落盘
- **AWS**：`@aws-sdk/*` v3，跨账户 STS AssumeRole
- **文档/导出**：`puppeteer-core` + 系统 Chrome（提额 PDF、账单 PDF）
- **通知**：飞书 webhook
- **部署**：EC2 + Nginx + Let's Encrypt + PM2

---

## 功能模块

左侧导航九项（`MainLayout.tsx` 的 `navItems`）加一个独立权限页。页面 key 必须三处一致：`navItems`、`PAGE_META`（`MainLayout.tsx`）与后端 `ALL_PAGE_KEYS`（`auth.ts`）。

| 页面 key | 页面文件 | 主要后端前缀 | 说明 |
|----------|----------|--------------|------|
| `dashboard` | `Dashboard.tsx` | `/api/aws/dashboard/summary` | 费用/账户数/进行中 Case，走缓存秒级加载 |
| `accounts` | `Accounts.tsx` | `/api/aws/accounts*`、`/api/aws/root-credentials*`、`/api/aws/temp-credentials` | 账户列表与详情、免登录进控制台、根用户凭证操作 |
| `quotas` | `Quotas.tsx` | `/api/aws/quotas/*`、`/api/aws/bedrock/quotas/*` | 配额查询、一键提额、流式同步、生成提额 PDF。Tab：当前配额 / Bedrock 配额 / 当前账户请求 / 在线查询 / 提升记录 |
| `bulkquota` | `BulkQuota.tsx` | `/api/aws/bulk-quota/*` | 批量提额（按 payer 组织 × 多区域）。**不在 `ALL_PAGE_KEYS` 里**，可见性只由独立权限 `bulk_quota_access` 决定 |
| `regions` | `Regions.tsx` | `/api/regions/*` | opt-in 区域开通状态扫描与单个/批量开通 |
| `billing` | `Billing.tsx` | `/api/aws/billing/*` | 按账户/服务成本、账单拆分、批量导出官方账单 PDF |
| `cleanup` | `Cleanup.tsx` | `/api/aws/resources/*` | 扫描最近 7 天的 EC2/EBS/S3/Lambda/IAM 用户，展示 IAM 非敏感详情并手动勾选删除；S3 只读 |
| `tagcompliance` | `TagCompliance.tsx` | `/api/aws/tag-compliance/*` | MAP 标签合规扫描与报告 |
| `audit` | `AuditLog.tsx` | `/api/aws/audit*` | 审计日志查询与 CSV 导出 |
| `settings` | `Settings.tsx` | `/api/auth/*` | 改密码、MFA、用户管理 |
| —（登录流程） | `Login.tsx`、`SetupMFA.tsx` | `/api/auth/login`、`/api/auth/mfa/*` | 登录、强制绑定 MFA |

移动端底部导航只保留五项：概览 / 账户 / 配额 / 账单 / 设置。

---

## 目录结构

```
AWS/
├── config.json                     # ★真实配置（gitignore，含密钥）
├── config.example.json             # 配置示例（可提交）
├── data/
│   ├── db.json                     # ★运行时数据库（gitignore）
│   └── backups/                    # 每日自动备份（保留 7 天）
├── doc-templates/architectures/    # 各公司架构图（静态资源，可提交）
├── electron/                       # 桌面版主进程（冻结）
├── src/                            # 桌面版前端（冻结）
└── web/
    ├── server/                     # 后端（Express，tsx 直跑）
    │   ├── index.ts                # 入口：中间件、CORS 白名单、限速、挂载路由、静态服务、启动 scheduler
    │   ├── auth.ts                 # authRouter（登录/MFA/用户CRUD）+ authMiddleware + 页面权限模型
    │   ├── audit.ts                # auditMiddleware：记录所有已认证 API 调用
    │   ├── audit-presentation.ts   # 审计日志展示增强 + CSV 导出
    │   ├── aws-service.ts          # ★AWS 核心：AssumeRole 链、成本、配额、资源、根凭证、控制台 URL
    │   ├── db.ts                   # ★数据层：db.json 读写、字段加密、每日备份
    │   ├── scheduler.ts            # 后台定时同步（账户/配额/区域/仪表盘）
    │   ├── doc-generator.ts        # 生成提额申请 PDF（puppeteer）
    │   ├── doc-templates.ts        # ★公司模板 + 账户→公司 / payer→公司 映射 + 区域显示名
    │   ├── notify.ts               # 飞书通知（配额变动/达成）
    │   ├── tag-compliance.ts       # MAP 标签合规（编排中央工具账户的 Step Functions + S3 报告）
    │   ├── account-roles.ts        # ★账户角色自愈：探测 → 缺失则触发 StackSet 补齐 → 超限告警
    │   ├── billing-exporter.ts     # 批量导出 AWS 控制台账单 PDF → zip
    │   └── routes/
    │       ├── aws.ts              # ★awsRouter：主业务端点（50+），含权限守卫
    │       └── regions.ts          # regionsRouter：区域 opt-in 状态/扫描/开通
    ├── client/
    │   ├── vite.config.ts          # dev 端口 5174
    │   └── src/
    │       ├── App.tsx             # 认证门禁：Login →（未绑 MFA）SetupMFA → MainLayout
    │       ├── api.ts              # ★统一 HTTP 客户端，token 存 localStorage
    │       ├── version.ts          # ★APP_VERSION，单一版本源，每次部署递增
    │       ├── components/         # MainLayout / RootCredentialsPanel / DangerConfirm / EmptyState / ErrorBoundary
    │       ├── pages/              # 每个业务页面一个文件
    │       └── utils/              # cache(内存TTL) / color / console-launch / export
    ├── scripts/
    │   ├── setup-org-stacksets.ts  # ★加新 payer 时下发两个角色 StackSet（幂等，支持 --dry-run）
    │   └── print-bills.mts
    ├── setup-nginx.sh              # Nginx + HTTPS 配置脚本
    └── Dockerfile / docker-compose.yml
```

---

## 跨账户访问模型

平台基础身份 `BASE_CREDENTIALS` = `config.json.credentials`，当前为 `arn:aws:iam::509399618054:user/mark`。

### 涉及的角色

| 角色 | 位置 | 用途 | 信任 |
|------|------|------|------|
| `tool` | 各 payer 管理账户 | 平台管理 payer 的入口（Organizations/STS/ServiceQuotas/CE/Account） | `509399618054:user/mark` |
| `support-quota` | 各成员账户 | 平台一级跳，读配额/成本/只读 | `134103550877:root` + `509399618054:user/mark` |
| `admin-console` | 各成员账户 | 平台一级跳拿 **admin** 凭证 | 直接信任平台身份 |
| `OrganizationAccountAccessRole` | 各成员账户 | 二级跳兜底 | 各自 payer root |
| `cur-collector` | 各 payer | CUR 账单采集接入 | `509399618054:user/winston` |

成员账户角色通过组织级 `SERVICE_MANAGED` StackSet 下发到根 OU，`AutoDeployment` 自动覆盖未来新增账户（含 INVITED）。管理账户本身不在 SERVICE_MANAGED 覆盖内，靠 `role/tool` 兜底。

**配置现状（生产核验快照 2026-08-27）**：平台已配置 44 个 payer，`consoleAdminPayers` 包含 43 个组织。该白名单只控制前端是否显示「只读 / 管理员」双入口，不能替代 StackSet 实例回读。

已有 StackSet 默认不会自动改写模板。只有明确审查模板差异后，才可执行 `npx tsx scripts/setup-org-stacksets.ts admin <payerName> --refresh-template`；该模式强制指定单个 payer，操作异常、非 `SUCCEEDED` 或残留失败实例都会返回非零。

**新组织的两个前置开关**（缺任一都会让 SERVICE_MANAGED StackSet 创建失败，报 `You must enable organizations access to operate a service managed stack set`）：

```bash
# 1) Organizations 侧：允许 StackSets 作为受信任服务
aws organizations enable-aws-service-access \
  --service-principal member.org.stacksets.cloudformation.amazonaws.com --profile <payer>

# 2) CloudFormation 侧：激活组织访问（与上一步是两件事，容易漏）
aws cloudformation activate-organizations-access --profile <payer> --region us-east-1
aws cloudformation describe-organizations-access --profile <payer> --region us-east-1   # 应为 ENABLED
```

新建角色的信任主体只有 `509399618054:user/mark`，不再包含历史身份 `134103550877`（早先建的角色仍带着它）。

### 只读链路 `assumeToAccount(accountId)`

1. **一级跳 `support-quota`** — 基础身份直接 AssumeRole 成员账户的 `role/support-quota`（首选，最快）。失败会记入内存 `supportRoleUnavailable`，本进程内不再重试（重启清空）
2. **payer 自身** — 目标就是某 payer，直接用该 payer 的 `role/tool` admin 凭证
3. **二级跳** — 先用 payer 的 `role/tool` 拿 admin，再 AssumeRole 成员账户的 `OrganizationAccountAccessRole`；已知 payer 优先，未知则遍历探测并缓存映射

### admin 链路（临时凭证 / Admin 控制台）

1. payer 自身 → 直接用 `role/tool`
2. **一级跳 `admin-console`**
3. 二级跳 `OrganizationAccountAccessRole`（用 `forceFresh` 取新鲜 payer 凭证，保证接近完整 1 小时）

第 2 步不只是性能优化：**INVITED（邀请加入）的账户没有 `OrganizationAccountAccessRole`**，payer 二级跳根本进不去，而 `admin-console` 由 StackSet 下发并直接信任平台身份，对这类账户同样有效。

Admin 临时凭证默认 1 小时。数据库当前角色为 `admin` 的平台用户可选择 1–12 个整数小时；其他仅有 `root_access` 的用户固定为 1 小时。超过 1 小时只走平台长期身份 → 成员账户 `admin-console` 的直接一级跳，并要求角色 `MaxSessionDuration=43200`；payer 管理账户与 OAAR 二级链仍最多 1 小时。完整 AK/SK/SessionToken 仅保留在 React 内存中，响应禁止缓存，不写入 `sessionStorage`。

`config.consoleAdminPayers` 列出已部署 `support-quota` + `admin-console` 的组织，账户列表据此带上 `_consoleDual` 标记，前端才给出「只读 / 管理员」双选项。

根用户特权操作走 `sts:AssumeRoot`（集中式根访问），见下文。

---

## 接口清单

### `/api/auth`（authRouter）

`POST /login`、`POST /mfa/setup`、`POST /mfa/confirm`、`GET /me`、`POST /change-password`
用户管理（admin）：`GET/POST /users`、`PUT/DELETE /users/:id`、`POST /users/:id/reset-password`

### `/api/aws`（awsRouter，经 `authMiddleware` + `auditMiddleware`）

| 分组 | 端点 |
|------|------|
| 账户 | `GET /accounts`、`POST /accounts/refresh`、`GET /accounts/:id/detail`、`GET /connection` |
| 账户角色自愈 | `GET /accounts/roles-status`、`POST /accounts/roles-check`（均 `requireStrictAdmin`） |
| 仪表盘 | `GET /dashboard/summary` |
| 账单 | `GET /billing/by-account`、`GET /billing/by-service/:accountId`、`GET /billing/breakdown/:accountId`；PDF job：`POST/GET /billing/export-jobs`、`GET /billing/export-jobs/:jobId`、`POST .../:jobId/cancel`、`GET .../:jobId/download`（均 `requireBillingAccess`，单任务再校验 owner/admin） |
| 配额 | `GET /quotas/:accountId/:serviceCode`、`POST /quotas/increase`(admin)、`GET /quotas/requests`、`GET /quotas/stats`、`GET /quotas/companies`、`GET /quotas/company/:accountId`、`POST /quotas/generate-doc`、`POST /quotas/sync`、`POST /quotas/sync-account/:accountId`、`GET /quotas/sync-status`、`GET /quotas/sync-stream`(SSE) |
| Bedrock 配额 | `GET /bedrock/quotas/:accountId?regions=a,b` |
| 批量提额 | `GET /bulk-quota/payers`、`GET /bulk-quota/accounts/:payerAccountId`、`POST /bulk-quota/submit`、`GET /bulk-quota/job/:jobId`（全部 `requireBulkQuotaAccess`） |
| 根凭证 | `GET /root-credentials/:accountId`、`GET /temp-credentials/:accountId?durationHours=1`（rootAccess；仅 admin 可请求 2–12 小时）、`POST /root-credentials/:accountId/delete-mfa`(rootAccess)、`.../recover-password`(rootAccess)、`.../delete-access-key`(rootAccess)、`.../delete-key`(admin) |
| 资源清理 | `GET /resources/:accountId/:region`（最近 7 天；Lambda 按最近修改；IAM/S3 为全局；失败服务通过 warnings 返回）、`POST /resources/:accountId/delete`（服务端重新读取时间并复验；EC2/EBS/Lambda 兼容 admin/partadmin，IAM 用户仅实时 strict admin 且级联清理依赖；S3 不可删除） |
| 审计 | `GET /audit`、`GET /audit/export`（均 `requireAuditAccess`） |
| 控制台 | `GET /console-url/:accountId` |
| MAP 标签 | `GET /tag-compliance/status\|config\|executions\|report\|precheck\|notify-emails\|re-indexes/status`；`PUT /config`、`POST /scan`、`POST /notify-emails`、`DELETE /notify-emails`、`POST /re-indexes`、`POST /provision`（写操作均 admin） |

**Bedrock 路径特意不放在 `/quotas/` 下**，否则会被 `/quotas/:accountId/:serviceCode` 通配吃掉。

### `/api/regions`（regionsRouter）

`GET /status`、`POST /scan`、`POST /scan/:accountId`、`POST /enable`、`POST /enable-batch`

### 其它

`GET /api/scheduler/status`

**权限守卫**（`routes/aws.ts`）：

| 守卫 | 实际放行范围 | 用途 |
|------|--------------|------|
| `requireAdmin` | **admin + partadmin**（只拦 viewer） | 提额、资源删除、MAP 标签写操作、删 access key |
| `requireStrictAdmin` | 仅 admin | 账户权限检测 |
| `requireRootAccess` | root_access 或 admin | 根用户敏感操作 |
| `requireAuditAccess` | 审计页可见者 | 审计日志 |
| `requireBillingAccess` | billing 页可见者 | 账单 PDF job；任务状态、取消和下载另校验创建者或 admin |
| `requireBulkQuotaAccess` | bulk_quota_access 或 admin | 批量提额 |

`requireAdmin` 的名字容易误解 —— 它放行 partadmin，这是预期行为。需要严格 admin 的场景用 `requireStrictAdmin`。

`authMiddleware` 直接把 JWT payload 挂到 `req.user`，所以 `req.user.role` 是签发时的角色。需要严格判断的守卫都改为从 `db.getUser()` 实时读，避免降权用户在 token 过期前继续按旧角色通过。

---

## 权限模型

定义在 `auth.ts`。

### 角色

| 角色 | 权限 |
|------|------|
| `admin` | 全部页面 + 所有操作 + 用户管理 + 根用户凭证操作 |
| `partadmin` | 仅勾选页面 + 业务操作（配额提升 / 删 key 等），不能管理用户 |
| `viewer` | 仅勾选页面，只读（写操作被 `requireAdmin` 拦截） |

`allowed_pages` 控制可见页面（admin 视为全部）。`authMiddleware` 会拦住未绑 MFA 用户访问业务接口。

### 两个独立权限开关

admin 恒有，其他角色必须显式授予，且**都不受 `allowed_pages` 影响**：

- `root_access` → 账户页「根用户」敏感操作（Admin 临时凭证 / 删 Root MFA / 恢复根密码）、Admin 控制台登录；非 admin 即使有此权限也只能签发 1 小时凭证
- `bulk_quota_access` → 「批量提额」页；未授予时菜单完全不可见，后端 `requireBulkQuotaAccess` 也会拒绝

后端从数据库实时校验，不信任 JWT 里的旧角色/权限。

### 新增独立权限要改的地方

`auth.ts`（resolve 函数 + me + create/update）、`db.ts`（getAllUsers 暴露字段）、`routes/aws.ts`（中间件）、`MainLayout.tsx`（导航 gating）、`Settings.tsx`（授予勾选 + 列表列）、`api.ts`（createUser/updateUser 参数）。

---

## 配置与数据

### `config.json`（gitignore，含密钥，勿提交）

```jsonc
{
  "credentials": { "accessKeyId": "...", "secretAccessKey": "..." },  // 平台基础身份
  "region": "us-east-1",
  "payers": [
    { "name": "yanhuang11-skymora", "roleArn": "arn:aws:iam::133354366329:role/tool" }
  ],
  "childRoleName": "OrganizationAccountAccessRole",  // 二级跳角色
  "adminRoleName": "admin-console",                  // 成员账户 admin 角色，默认 admin-console
  "supportRoleName": "support-quota",                // 只读一级跳角色，默认 support-quota
  "consoleAdminPayers": ["..."],                     // 提供控制台双选项的组织
  "tagCompliance": {
    "roleArn": "...", "region": "...", "stateMachineArn": "...",
    "reportsBucket": "...", "orgConfigKey": "...", "topicArn": "...", "notificationEmail": "..."
  },
  "web": {
    "port": 3000,
    "adminPassword": "登录密码",
    "jwtSecret": "128位hex随机串",
    "encryptionKey": "独立密钥，AES-256-CBC 加密 MFA secret",
    "feishuWebhook": "留空则不通知"
  }
}
```

`payers[].name` 格式为 `yanhuang编号-公司名`，用于提额文档与通知匹配公司。

### `data/db.json`（gitignore，运行时数据库）

顶层键：

- `users` — 账号（bcrypt 密码、加密的 mfa_secret、role、allowed_pages、root_access、bulk_quota_access）
- `quota_requests` — 配额提升记录
- `audit_log` — 审计日志，**上限 5000 条滚动**
- `region_data` — 各账户区域 opt-in 状态
- `accounts_cache` + `accounts_cache_time` — 账户列表缓存（调度器每 30min 刷新）
- `dashboard_cache` — 成本概览缓存

启动时：`migrateEncryptMFASecrets()` 迁移明文 MFA 密钥、`backupDB()` 备份到 `data/backups/db-YYYY-MM-DD.json`（保留 7 天）。

---

## 关键实现

### 免登录进入 AWS 控制台 / Support Case

STS Federation。后端用 AssumeRole 的临时凭证调 `signin.aws.amazon.com/federation` 换 signin token，拼成一次性登录 URL。点账户的「控制台」按钮或提升记录的 Case ID，新标签直接进对应子账户，可直接上传材料。完全免费，不需要 Business Support。

`access` 参数三档：`support`（只读专用角色）、`admin`（管理员）、`auto`（沿用回退链，兼容未部署专用角色的账户）。

### 提额文档自动生成（PDF）

HTML 模板 + Puppeteer 渲染。公司背景库在 `doc-templates.ts`（12 家公司，从历史 SOW 总结），架构图在 `doc-templates/architectures/`。

公司解析顺序：账户缓存的 `_payer` → `PAYER_TO_COMPANY` → `ACCOUNT_TO_COMPANY`。**36 个 payer 里只有 11 个有内置映射**，其余识别不出时前端弹出公司挑选，选过的按 payer 记在 localStorage，下次自动预选但仍需确认（刻意不静默套用，避免悄悄用错公司）。

`companyFromPayer` 的后缀兜底做的是「公司部分完全相等」比较，不能用 `endsWith` —— 单字符后缀会命中短名 key（`webby-2` → `malatrading`），静默生成挂着别家公司资料的文档。

动态生成：申请值自动拆解成资源组件表（合计=申请值）；配额类型自动识别 AWS 官方名称（vCPU/EIP/Lightsail/Mac/WorkSpaces 等）；预测值约申请值的 1.5 倍。

### 配额管理

- **多区域查询**：覆盖 34 个 AWS 区域（含 opt-in），并发查询，8 秒超时跳过未开通区域
- **流式同步（SSE）**：全量同步用 Server-Sent Events 实时推进度，边查边出
- **Bedrock 配额**：按区域查 TPM/RPM/TPD，多区域并发；按 Provider、推理范围（Global Cross-Region / Cross-Region / On-Demand / Latency-Optimized）筛选
- **批量提额**：按 payer 组织 × 多区域批量提交，只传配额名 + 目标值，QuotaCode 后端解析，已达标账户自动跳过；job 模式（submit → jobId → 轮询）

### 批量导出官方账单 PDF

产出的是 AWS 自家生成的打印文档，与手动「打印 → 另存为 PDF」一致。底层流程：严格只读 Federation 会话 → Billing Bills 页面 → 等数据加载 → 点两级「打印」→ AWS 调 `window.print()` → Chrome 静默另存为 PDF → zip。

账号选择支持上传 `.xlsx`：文件只在浏览器本地解析，不上传服务器；扫描所有工作表并提取独立的 12 位 AWS Account ID，只勾选平台账户列表中已存在的账号。单文件限制 5 MiB / 50,000 个单元格，月份仍由页面单独选择，后端继续执行账户白名单与 200 任务上限复验。

编排层在 `billing-export-jobs.ts`：提交接口立即返回 `202 + jobId`，前端在页面可见时约每 3 秒轮询、隐藏时降至约 15 秒，遇到 429/5xx/网络错误会指数退避，并可关闭弹窗后恢复。服务器一次只执行一个 job，job 内并发由 `BILLING_EXPORT_MAX_CONCURRENCY` 统一限制（默认 3），不接受前端虚假并发；每个用户最多一个活跃任务，全局最多 10 个 queued（可用 `BILLING_EXPORT_MAX_QUEUED_JOBS` 调整）。状态包含真实完成数、成功/失败、动态 ETA 和队列位置。取消会停止领取新任务、等待 worker 收尾，并以有界 TERM→KILL 流程关闭活动 Chrome/zip 后清理半成品；若最终期限内仍无法确认进程树退出，当前 job 标记失败且 runner 暂停接单，避免残留进程与下一任务重叠。

安全与生命周期：

- 所有抓取固定调用 `getConsoleSigninUrl(..., 'support')`。payer 使用 `role/tool + ReadOnlyAccess` session policy，成员账户必须进入 `support-quota`；角色缺失时该份失败，**绝不回退 OAAR/admin**
- submit/list/status/cancel/download 都实时检查 `billing` 页面权限；新任务 owner 绑定不可复用的用户 ID，旧记录仅在缺少 ID 时兼容用户名；单任务查询、取消和下载还要求 owner 或 admin。admin 列表可查看全局任务，但页面会优先恢复当前 admin 自己的 active job
- 入队前以及实际执行前都会检查 Chrome、Xvfb socket、`zip` 和输出目录，依赖缺失时不会启动任何浏览器
- job 元数据持久化在 `billing_export_jobs`；PM2 重启后 queued 任务继续排队，原 running/cancelling 标记 `interrupted`，避免伪装为仍在执行
- 完成的 zip 默认保留 24 小时并支持重复鉴权下载；下载先打开文件并持有 lease，TTL 清理会等待活动下载结束，再清理文件并标记 `expired`
- 轮询状态不写审计，提交、取消、下载分别记录 `BILLING_EXPORT_SUBMIT`、`BILLING_EXPORT_CANCEL`、`BILLING_EXPORT_DOWNLOAD`

四个必须遵守的抓取约束（都是踩坑换来的，改这块前务必先读 `billing-exporter.ts` 顶部注释）：

1. **必须 headed + `--kiosk-printing`**。headless 没有打印子系统，AWS 的打印流程跑不完。服务器靠 Xvfb（`:99`）提供 headed 环境，并预设打印首选项锁定「另存为 PDF」
2. **必须等数据真正加载完**。首屏出现「账单周期」≠ 数据就绪，过早点打印会缺内容。等的是加载指示器消失 + 网络空闲 + 固定缓冲
3. **判断弹窗可见性不能用 `offsetParent`**。AWS 弹窗是 `position:fixed`，其 `offsetParent` 恒为 null，会被误判成隐藏。必须用 `getBoundingClientRect` + `getComputedStyle` + `elementFromPoint` 命中测试
4. **每个账户必须用独立浏览器实例**。控制台会话存在 `.amazon.com` cookie 里，复用同一 profile 会让后面的账户沿用前面的会话 —— 导出的多份 PDF 文件名各异但内容全是第一个账户的，属于"看起来成功了"的危险错误

另有两道产出校验：页面显示的 12 位账号必须是目标账户；PDF 只有 1 页视为废纸并丢弃。

### MAP 标签合规

平台不重写扫描/打标逻辑，而是 assume 中央工具账户的 `tag-compliance-console-role`（最小权限：只能操作那一个状态机 + 读写那一个报告桶），去读写 `orgs.json`、触发 Step Functions 扫描、查执行状态、读最新报告。打标本身仍由中央系统用最小权限的 `auto-tagger-role` 执行，安全模型不变。

### 根用户凭证操作

账户页「根用户」tab 的三个敏感操作，均受 `root_access` 控制，全部记入审计。

| 功能 | 机制 | 说明 |
|------|------|------|
| 生成 Admin 临时凭证 | 优先直接 AssumeRole 到成员账户 `admin-console`，**不**走 `support-quota` | 默认 1 小时；仅平台 admin 可选 1–12 小时，超过 1 小时不回退 OAAR；支持复制 AK/SK/Token、导出环境变量、倒计时与重新生成 |
| 删除 Root MFA | `sts:AssumeRoot`（任务策略 `IAMDeleteRootUserCredentials`）→ `DeactivateMFADevice` + `DeleteVirtualMFADevice` | 先用管理员凭证 `ListVirtualMFADevices` 定位 root 设备；仅虚拟 MFA |
| 恢复根用户密码 | `sts:AssumeRoot`（任务策略 `IAMCreateRootUserPassword`）→ `CreateLoginProfile`（省略 UserName/Password） | 触发 AWS 密码恢复流程，向根邮箱发重置邮件 |

**前提**：删 MFA / 恢复密码依赖 AWS 集中式根访问（`sts:AssumeRoot`），需组织已启用，且平台身份具备该权限。AssumeRoot 会话上限 15 分钟，且必须用区域性 STS 端点（不支持全球端点）。

审计动作：`TEMP_CREDENTIALS`、`ROOT_MFA_DELETE`、`ROOT_PASSWORD_RECOVER`。

### 账户角色自愈

新账户加入组织后，两个角色由该组织 StackSet 的 `AutoDeployment` 自动创建，平台不参与。但自动部署并非 100% 可靠：账户未完成激活时 CloudFormation 返回 `OptInRequired`、StackSet 操作可能排队超时、角色也可能被人为删除。这些失败此前只躺在 CloudFormation 里，平台完全不知道 —— 账户在列表里看着正常，点进去什么都读不了。

`account-roles.ts` 补上这个缺口，流程是探测 → 补齐 → 复验 → 记录 → 告警：

- **探测**：直接 AssumeRole 两个角色，看实际能不能进，不依赖配置声明
- **补齐**：按 payer + 角色种类分组，一次 `CreateStackInstances` 打一批账户（`AccountFilterType=INTERSECTION` 限定范围），操作完成后复验
- **重试**：失败累计 3 次标记 `unreachable`，发飞书卡片，然后停止重试，不刷 API
- **增量**：跟在每次 `syncAccounts()` 之后，只查从未检测过的和上轮待重试的，按 `JoinedTimestamp` 降序（新账户优先）。单轮上限 60
- **全量复检**：每 24 小时，按「最久未检查优先」排序轮转，单轮上限 400，用来发现被删除的角色

结果在账户页「权限状态」面板（仅 admin），列出异常账户、缺哪个角色、尝试次数、原因说明，可导出 CSV。账户列表里异常账户名旁会有「权限缺失 / 补齐中」标记。

**已知无解情形**：零账单 + `OptInRequired` 的账户，StackSet 进不去，自愈也补不上，必须先处理账户本身的激活问题。截至 2026-08 有 7 个这类账户（yanhuang5-global 5 个、yanhuang13 2 个）。

### 飞书通知

飞书自定义机器人 Webhook 发交互式卡片。后台同步（每 4 小时）检测到配额**当前值实际变化**时才推送 —— 提交、状态变化都不通知，避免刷屏。内容按账户分组，显示所属组织、配额、区域、旧值→新值、达标标记。首次同步（空快照）不通知，用同步前快照对比避免误判。

---

## 后台定时同步

`scheduler.ts`，服务启动时拉起。

| 任务 | 频率 | 首次延迟 | 说明 |
|------|------|----------|------|
| 账户列表 | 30 分钟 | 10 秒 | 写入缓存，页面秒级加载 |
| 配额记录 + 当前值 | 4 小时 | 2 分钟 | 分批防限流 |
| 区域状态 | 24 小时 | 5 分钟 | opt-in 区域扫描 |
| 概览费用缓存 | 2 小时 | 30 秒 | Cost Explorer 结果缓存 |
| 账户角色自愈（增量） | 跟随账户同步 | — | 只查新账户和待重试，单轮 ≤60 |
| 账户角色自愈（全量） | 24 小时 | — | 最久未检查优先轮转，单轮 ≤400 |

---

## 部署与运维

### 本地开发

```bash
cd web
pnpm install --ignore-workspace
npm run dev        # 前端 5174 + 后端 3000 并行
```

### EC2 部署

```bash
# 本地：只提交具体代码文件
git add <具体代码文件> && git commit -m "..." && git push

# EC2
ssh -i /Users/mark/mark-sg-key.pem ec2-user@54.255.131.45
cd ~/AWSTool && git pull -q
cd web && npm install                                    # 仅依赖变化时
npx vite build --config client/vite.config.ts
pm2 restart aws-toolbox
```

后端 tsx 直跑不编译，改 `.ts` 只需 `pm2 restart`；改前端才需要 `vite build`。

**每次部署递增 `web/client/src/version.ts` 的 `APP_VERSION`**（小改 patch、大改 minor），左下角展示，也用于确认部署是否生效。

### 验证部署生效

```bash
BUNDLE=$(curl -s https://markxu.co/ | grep -oE 'assets/index-[A-Za-z0-9]+\.js' | head -1)
curl -s "https://markxu.co/$BUNDLE" | grep -oE '0\.4\.7'
```

### HTTPS

Nginx 反代 + Let's Encrypt（`markxu.co`，自动续期），80 强制跳 443，HSTS 开启。Node 只监听 `127.0.0.1:3000`，外网只能经 Nginx。配置脚本 `web/setup-nginx.sh`；脚本为 zip 下载设置 10 分钟流式传输窗口，job 控制 API 本身都是短请求。

账单导出运行依赖：可执行 Chrome、常驻 Xvfb（默认 `:99`）、`zip` 与 CJK 字体。可用环境变量：`BILLING_EXPORT_DISPLAY`、`BILLING_EXPORT_SETTLE_MS`、`BILLING_EXPORT_MAX_CONCURRENCY`、`BILLING_EXPORT_MAX_QUEUED_JOBS`、`BILLING_EXPORT_OUTPUT_DIR`、`BILLING_EXPORT_TTL_HOURS`；runner 启动只检查输出目录，提交任务时再完整预检，避免缺依赖导致整个服务无法启动。

### 常见改动改哪里

| 需求 | 改动点 |
|------|--------|
| 新增业务接口 | `routes/aws.ts` 加路由（按需加守卫）→ `aws-service.ts` 加函数复用 `assumeToAccount()` → `api.ts` 加方法 → 页面调用 |
| 新增页面 | `pages/Xxx.tsx` → `MainLayout.tsx` 的 `navItems`/`PAGE_META`/`renderPage()` switch 各加一项（同一 key）→ `auth.ts` 的 `ALL_PAGE_KEYS` 加同名 key；要移动端入口再加 `mobileNavItems` |
| 加 payer | ① 在该 payer 建 `role/tool` 信任平台身份 ② `config.json.payers[]` 加 `{name, roleArn}` 并把组织名加入 `consoleAdminPayers`（本地 + EC2 各一份，勿提交）→ 重启 → `POST /api/aws/accounts/refresh` ③ **跑两次 `npx tsx scripts/setup-org-stacksets.ts support\|admin <payerName>`**，否则该组织新账户拿不到角色 |
| 新增公司模板 | `doc-templates.ts` 的 `COMPANY_PROFILES` 加资料 + `ACCOUNT_TO_COMPANY`/`PAYER_TO_COMPANY` 加映射 → 架构图放 `doc-templates/architectures/` |
| 调同步频率 | `scheduler.ts` |

---

## 数据安全

> ⚠️ **教训**：`data/db.json` 早期被纳入 git 跟踪，部署时 `git stash`/`git pull` 把真实数据当冲突丢弃，导致审计日志和配额记录丢失。已修复。

### 提交纪律

**只 add 具体代码文件**，绝不用 `git add -A` 或 `git add .`。提交前 `git status` 确认没有数据/密钥文件被 staged。

应该提交：`web/server/**`、`web/client/src/**`、`web/package*.json`、`doc-templates/architectures/**`、`config.example.json`、`electron/**`、`src/**`

**绝对不提交**：`data/db.json`、`data/backups/**`、`data/exports/**`、`config.json`、`提额文档/`、`node_modules/`、`dist/`

### EC2 上的禁止操作

- ❌ `git stash` — 会把真实数据文件暂存后丢弃
- ❌ `git checkout -- data/` — 会还原/删除数据库
- ❌ `git reset --hard` — 丢弃所有本地状态
- ❌ 任何会动 `data/`、`config.json` 的 git 操作

`git pull` 报冲突时：先 `git status` 看是哪些文件。代码文件冲突 → `git checkout -- <代码文件>` 丢弃 EC2 本地改动再 pull。数据/配置文件冲突 → **绝不能丢弃**，先 `cp data/db.json /tmp/` 备份，确认 `.gitignore` 已排除后再处理。

### 已实现的防护

- `data/db.json`、`config.json` 已移出 git 跟踪
- 启动时自动备份 db.json 到 `data/backups/`，保留 7 天
- MFA secret AES-256-CBC 加密存储，密码 bcrypt
- 凭证只在服务端，绝不下发前端
- 密码 + TOTP MFA（window=2，150 秒容差），JWT 2 小时过期
- 登录限流 5 次/15 分钟，API 限流 100 次/分钟
- Helmet 安全头 + CORS 白名单（未列入的来源用 `callback(null, false)` 优雅拒绝，**绝不 throw** —— 抛错会被 Express 当 500，导致带 `crossorigin` 的静态资源请求失败、整站白屏）

---

## 已知待办

### 其它

- 前端单 bundle 已 1.47MB（gzip 458KB），暂时为跨境网络稳定性接受不分包
- EC2 上 Node v20，AWS SDK v3 在 2027 年 1 月后要求 Node ≥ 22
- `doc-templates.ts` 的 `taiping` 有完整模板和架构图，但没有任何 payer / 账户映射指向它，只能靠手选或手动生成入口用到
- 7 个账户零账单 + CloudFormation `OptInRequired`，StackSet 与自愈都进不去，需人工先处理账户激活
- `config.consoleAdminPayers` 是静态白名单（现已含全部 36 个组织）。更合理的做法是直接用 `account_roles` 的真实探测结果决定 `_consoleDual`，等检测覆盖率上来后可以替换
- 早先建的 `support-quota` / `admin-console` 角色信任主体里仍有历史身份 `134103550877`，新建的已去掉；是否统一清理待定
- `account_roles` 覆盖率需要时间铺开（增量每轮 60 个）。想立刻建立基线可在账户页点一次「全量复检」

---

## 相关文档

- 部署与数据安全细则：`.kiro/steering/deployment.md`
- 编码规范：`.kiro/steering/coding-standards.md`
- 开发流程：`.kiro/steering/development-methodology.md`
- 项目结构地图（给 AI 用）：`.kiro/steering/project-context.md`
- AWS 文档：https://docs.aws.amazon.com/
