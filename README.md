# AWS Toolbox

企业级 AWS 多账户（多 Organizations）管理平台。带强制 MFA 登录、页面级权限与全量操作审计。

**线上**：https://markxu.co（EC2 Singapore，PM2 进程 `aws-toolbox`）
**当前版本**：`0.37.3`（见 `web/client/src/version.ts`，左下角展示）

**生产接入规模**（快照 2026-09-06，取自线上 db.json）

| 指标 | 数量 |
|------|------|
| 已配置 AWS Organizations（payer） | 44 |
| 已验收并开放 `consoleAdminPayers` | 43 |
| 全部账户 | 3120 |
| 其中成员账户 | 3077 |
| 已有区域状态记录的账户 | 3121 |
| 已有角色探测记录的账户 | 3068 |
| 已记录离场账户 | 26 |

覆盖账户管理、配额提升（单个 / 批量 / Bedrock）、区域开通、官方账单 PDF 导出、资源清理、提额文档自动生成、MAP 标签合规、根用户凭证操作、审计与飞书通知。

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
- **前端**：React 18 + Vite 6 + Ant Design 5 + recharts + TypeScript。**无 react-router**，`MainLayout` 用 `useState(currentPage)` 切页，另以原生 `pushState`/`popstate` 做 URL 同步（`/billing` 等路径可刷新/直链/前进后退）；按稳定性分三包（vendor/charts/业务代码，并行加载非路由懒加载）+ hash 资源 immutable 缓存一年，运维监控页 `React.lazy` 懒加载；dashboard/accounts/quotas/regions/billing 五个高频页 keep-alive（`display:none` 保活，切回不重新请求）
- **存储**：`data/db.json`，自研 JSON 文件存储 + 内存缓存 + 每日备份（非数据库）
- **认证**：JWT（2h 过期）+ 强制 TOTP MFA（otplib），密码 bcrypt，MFA secret AES-256-CBC 加密落盘
- **AWS**：`@aws-sdk/*` v3，跨账户 STS AssumeRole
- **文档/导出**：`puppeteer-core` + 系统 Chrome（提额 PDF、账单 PDF）
- **通知**：飞书 webhook
- **部署**：EC2 + Nginx + Let's Encrypt + PM2

---

## 功能模块

左侧导航包含十个可分配页面和一个独立权限页（批量提额）。页面 key 必须三处一致：`navItems`、`PAGE_META`（`MainLayout.tsx`）与后端 `ALL_PAGE_KEYS`（`auth.ts`）。页面 key 同时就是 URL 路径（`/accounts` 等，dashboard 归 `/`），由 `navigate()`/`popstate` 同步。运维监控属于敏感页面：admin 恒有，其他角色需在用户的页面权限中显式授权。

| 页面 key | 页面文件 | 主要后端前缀 | 说明 |
|----------|----------|--------------|------|
| `dashboard` | `Dashboard.tsx` | `/api/aws/dashboard/summary` | 无 CE 运营 KPI、账户结构与组织分布、可跳转的待处理事项 |
| `accounts` | `Accounts.tsx` | `/api/aws/accounts*`、`/api/aws/root-credentials*`、`/api/aws/temp-credentials` | 账户列表与详情、免登录进控制台、根用户凭证操作 |
| `quotas` | `Quotas.tsx` | `/api/aws/quotas/*`、`/api/aws/bedrock/quotas/*` | 配额查询、一键提额、流式同步、生成提额 PDF、一键提交文档到 Support Case。Tab：当前配额 / Bedrock 配额 / 当前账户请求 / 在线查询 / 提升记录 |
| `bulkquota` | `BulkQuota.tsx` | `/api/aws/bulk-quota/*` | 批量提额（按 payer 组织 × 多区域）。**不在 `ALL_PAGE_KEYS` 里**，可见性只由独立权限 `bulk_quota_access` 决定 |
| `bedrock` | `Bedrock.tsx` | `/api/bedrock/*` | Bedrock 工具（从桌面版 Bedrock Profile Manager 迁移）：Inference Profile 管理/批量创建/模型测试/模型列表/FTU 开通/Fable 5 数据共享/IAM 用户/交付表格。**敏感页面**：全部走 Admin 凭证，non-admin 需显式授权；创建/打 Tag 的 Tag 必须每次手动输入（前后端均无默认值） |
| `regions` | `Regions.tsx` | `/api/regions/*` | opt-in 区域开通状态扫描与单个/批量开通 |
| `billing` | `Billing.tsx` | `/api/aws/billing/*` | AWS 官方账单 PDF 批量导出、历史任务、取消与 ZIP 下载 |
| `cleanup` | `Cleanup.tsx` | `/api/aws/resources/*` | 扫描最近 7 天的 EC2/EBS/S3/Lambda/IAM 用户，展示 IAM 非敏感详情并手动勾选删除；S3 只读 |
| `tagcompliance` | `TagCompliance.tsx` | `/api/aws/tag-compliance/*` | MAP 标签合规扫描与报告 |
| `audit` | `AuditLog.tsx` | `/api/aws/audit*` | 审计日志查询与 CSV 导出 |
| `ops` | `OpsMonitor.tsx` | `/api/ops/overview` | 运维监控（健康评分/资源趋势/请求延迟/端点排行/后台任务）。admin 恒有；其他角色需在页面权限中显式授权，旧用户默认不授予；后端实时校验数据库权限且不写审计日志（30s 轮询）。指标存进程内存，重启清零 |
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
    │   ├── index.ts                # 入口：中间件、CORS 白名单、限速（GET/写分离）、挂载路由、API 兜底 404、静态服务（immutable 缓存）、启动 scheduler
    │   ├── ops-monitor.ts          # 运维监控：请求/系统指标进程内采集（24h 环形缓冲）+ 健康评分 + /api/ops 页面权限守卫
    │   ├── auth.ts                 # authRouter（登录/MFA/用户CRUD）+ authMiddleware + 页面权限模型
    │   ├── audit.ts                # auditMiddleware：记录所有已认证 API 调用
    │   ├── audit-presentation.ts   # 审计日志展示增强 + CSV 导出
    │   ├── aws-service.ts          # ★AWS 核心：AssumeRole 链、成本、配额、资源、根凭证、控制台 URL
    │   ├── db.ts                   # ★数据层：db.json 读写、字段加密、每日备份
    │   ├── scheduler.ts            # 后台定时同步（账户/配额/区域/仪表盘）
    │   ├── doc-generator.ts        # 生成提额申请 PDF（puppeteer）
    │   ├── doc-templates.ts        # ★公司模板 + 账户→公司 / payer→公司 映射 + 区域显示名
    │   ├── notify.ts               # 飞书通知（账户角色缺失告警）
    │   ├── tag-compliance.ts       # MAP 标签合规（编排中央工具账户的 Step Functions + S3 报告；payer 自身 auto-tagger-role 单独创建）
    │   ├── tag-onboarding.ts       # MAP 全自动接入持久化 runner（资源、索引、StackSet、S3 配置与校验）
    │   ├── account-roles.ts        # ★账户角色自愈：探测 → 缺失则触发 StackSet 补齐 → 超限告警
    │   ├── account-lifecycle.ts    # 离场账户追踪：快照 diff（防 payer 同步失败误判）+ 重新加入 + 历史补录
    │   ├── restricted-accounts.ts  # ★敏感权限客户：账户级权限收窄 + ExternalId（StackSet 下发必须排除）
    │   ├── billing-export-jobs.ts  # 账单导出持久化 job、全局队列、永久历史、重复下载与重启恢复
    │   ├── billing-exporter.ts     # 严格只读抓取 AWS 官方账单 PDF + 可取消 zip 打包
    │   ├── bedrock-tools.ts        # Bedrock 工具：Profile 管理/批量创建/FTU/数据共享/IAM（全部走 Admin 凭证，50min 缓存）
    │   ├── bedrock-delivery.ts     # Bedrock 客户交付 xlsx（v1 三列 / v2 李浩版五列含 TPM/TPD；按变体白名单筛选模型 + 固定排序；校验 map-migrated tag 唯一）
    │   ├── case-doc-submitter.ts   # ★一键提交提额文档到 Support Case（生成 PDF → 联邦登录 → Reply → 传附件 → Submit）
    │   ├── security-alerts.ts      # 安全告警：登录爆破/429、5xx 突增 → 飞书
    │   └── routes/
    │       ├── aws.ts              # ★awsRouter：主业务端点（50+），含权限守卫
    │       ├── regions.ts          # regionsRouter：区域 opt-in 状态/扫描/开通
    │       └── bedrock.ts          # bedrockRouter：Bedrock 工具端点（挂 /api/bedrock；tags 强校验无默认值）
    ├── client/
    │   ├── vite.config.ts          # dev 端口 5174；manualChunks 三包分割（vendor/charts/业务）
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
| `support-quota` | 各成员账户 | 平台一级跳，读配额/成本/只读 | `509399618054:user/mark`（当前模板） |
| `admin-console` | 各成员账户 | 平台一级跳拿 **admin** 凭证 | `509399618054:user/mark`（当前模板） |
| `OrganizationAccountAccessRole` | 各成员账户 | 二级跳兜底 | 各自 payer root |
| `cur-collector` | 各 payer | CUR 账单采集接入 | `509399618054:user/winston` |

成员账户角色通过组织级 `SERVICE_MANAGED` StackSet 下发到根 OU，`AutoDeployment=true` 自动覆盖未来新增账户（含 INVITED），账户退出组织时 `RetainStacksOnAccountRemoval=false`。**管理账户本身不会获得 SERVICE_MANAGED StackSet 实例**，所以仅含管理账户的新组织显示 0 个实例是正常现象，管理账户由 `role/tool` 承担入口。

**配置现状（生产核验快照 2026-08-27）**：平台已配置 44 个 payer，`consoleAdminPayers` 包含 43 个组织。该白名单只控制前端是否显示「只读 / 管理员」双入口，**不能证明角色已成功部署**。新 payer 必须运行 `scripts/setup-org-stacksets.ts` 并回读两个 StackSet 的状态、自动部署设置与失败实例；否则未来成员账户可能没有可用角色。

`yottahub-cma-1`（管理账户 `346133363520`，Organization `o-go486nwkzx`，Root OU `r-3u07`）已完成接入验收：组织共 152 个账户（151 个成员账户）；`support-quota-role-orgwide` 与 `admin-console-role-orgwide` 均为 `ACTIVE`、`SERVICE_MANAGED`、`AutoDeployment=true`，各 151 个 StackInstance 全部 `SUCCEEDED`；平台全量角色复检结果为 `ok=151`、`pending=0`、`unreachable=0`，并已加入 `consoleAdminPayers`。

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

Admin 临时凭证时长默认 1 小时。数据库当前角色为 `admin` 的平台用户可按整数小时选择 1–12 小时；其他仅有 `root_access` 的用户仍固定为 1 小时。超过 1 小时的请求只允许走长期平台身份 → 成员账户 `admin-console` 的直接一级跳，并要求角色 `MaxSessionDuration=43200`；payer 管理账户以及 payer → `OrganizationAccountAccessRole` 二级链受 AWS role chaining 限制，最多 1 小时且不会静默回退。完整 AK/SK/SessionToken 仅保留在当前 React 内存中，不写入 `sessionStorage`，刷新或切换账户后需重新生成。

`config.consoleAdminPayers` 列出已部署 `support-quota` + `admin-console` 的组织，账户列表据此带上 `_consoleDual` 标记，前端才给出「只读 / 管理员」双选项。

`config.adminRoleExcludedAccounts` 是逐账户的 **admin-only 永久排除**：每项必须包含 12 位 `accountId` 和已配置的 `payer`（`reason` 用于运维记录）。排除后，Admin StackSet 部署使用 `DIFFERENCE` 跳过该账户，角色自愈把 `support=true + admin=false + admin_excluded=true` 视为健康，后端拒绝 Admin 临时凭证和 Admin 控制台，前端隐藏 Admin 入口；`support-quota` StackSet、只读/Support 权限以及独立的 Root 特权操作均不受影响。配置变更后必须重启服务；若账户已有 `admin-console`，还需通过 Admin StackSet 删除该账户实例（`RetainStacks=false`）。恢复时移除排除项并重新运行 Admin StackSet 部署。

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
| 离场账户 | `GET /accounts/departed`、`POST /accounts/departed/backfill`（后者 `requireStrictAdmin`） |
| 敏感权限客户账户 | `GET /accounts/restricted`（不返回 ExternalId 明文）、`POST /accounts/restricted`、`DELETE /accounts/restricted/:accountId`、`GET /accounts/restricted/:accountId/external-id`（后三个均 `requireStrictAdmin` 且单独写审计） |
| 仪表盘 | `GET /dashboard/summary` |
| 账单 | PDF job：`POST/GET /billing/export-jobs`、`GET /billing/export-jobs/:jobId`、`POST .../:jobId/cancel`、`GET .../:jobId/download`（均 `requireBillingAccess`，单任务再校验 owner/admin） |
| 配额 | `GET /quotas/:accountId/:serviceCode`、`POST /quotas/increase`(admin)、`GET /quotas/requests`、`GET /quotas/stats`、`GET /quotas/companies`、`GET /quotas/company/:accountId`、`POST /quotas/generate-doc`、`POST /quotas/case-doc-submit`(admin)、`GET /quotas/case-doc-submit/:jobId`（轮询不写审计；**必须注册在 `/quotas/:accountId/:serviceCode` 通配之前**）、`POST /quotas/sync`、`POST /quotas/sync-account/:accountId`、`GET /quotas/sync-status`、`GET /quotas/sync-stream`(SSE) |
| Bedrock 配额 | `GET /bedrock/quotas/:accountId?regions=a,b` |
| Bedrock 工具（独立前缀 `/api/bedrock`） | `GET /profiles/:accountId?regions=`（**最多 12 个区域**）、`GET /models/:accountId?region=`、`GET /foundation-models/:accountId?region=`、`POST /profiles/create`(admin,**tags 必填强校验**)、`POST /profiles/delete`(admin)、`POST /profiles/tag`(admin,tags 必填)、`POST /profiles/untag`(admin)、`POST /invoke`(admin)、`POST /ftu`(admin)、`GET /data-retention/:accountId?regions=`（**最多 20 个区域**）、`POST /data-retention/enable`(strict admin)、`GET /iam-users/:accountId`(admin)、`POST /iam-users/create`(strict admin)、`POST /delivery`(admin，服务端校验 map-migrated tag 唯一且必存在)、`POST /delivery-v2`(admin，李浩版五列含 TPM/TPD) |
| 批量提额 | `GET /bulk-quota/payers`、`GET /bulk-quota/accounts/:payerAccountId`、`POST /bulk-quota/submit`、`GET /bulk-quota/job/:jobId`（全部 `requireBulkQuotaAccess`） |
| 根凭证 | `GET /root-credentials/:accountId`、`GET /temp-credentials/:accountId?durationHours=1`（rootAccess；仅 admin 可请求 2–12 小时）、`POST /root-credentials/:accountId/delete-mfa`(rootAccess)、`.../recover-password`(rootAccess)、`.../delete-access-key`(rootAccess)、`.../delete-key`(admin) |
| 资源清理 | `GET /resources/:accountId/:region`（最近 7 天；Lambda 按最近修改；IAM/S3 为全局；失败服务通过 warnings 返回）、`POST /resources/:accountId/delete`（服务端重新读取时间并复验；EC2/EBS/Lambda 兼容 admin/partadmin，IAM 用户仅实时 strict admin 且级联清理依赖；S3 不可删除） |
| 审计 | `GET /audit`、`GET /audit/export`（均 `requireAuditAccess`） |
| 控制台 | `GET /console-url/:accountId` |
| MAP 标签 | `GET /tag-compliance/status\|config\|executions\|report\|precheck\|notify-emails\|re-indexes/status`；`PUT /config`、`POST /scan`、`POST /notify-emails`、`DELETE /notify-emails`、`POST /re-indexes`、`POST /provision`（写操作均 admin）；全自动接入：`POST /tag-compliance/onboarding`、`GET /tag-compliance/onboarding?payer=...`、`GET /tag-compliance/onboarding/:jobId`、`POST /tag-compliance/onboarding/:jobId/retry` |

**Bedrock 路径特意不放在 `/quotas/` 下**，否则会被 `/quotas/:accountId/:serviceCode` 通配吃掉。

### `/api/regions`（regionsRouter）

`GET /status`、`POST /scan`、`POST /scan/:accountId`、`POST /enable`、`POST /enable-batch`

### 其它

`GET /api/scheduler/status`

### `/api/ops`（opsRouter，admin 或显式页面授权，不写审计）

`GET /overview?range=1h|6h|24h` — 运维监控聚合：健康评分（阈值扣分 + 原因）、系统资源（CPU/内存/磁盘/事件循环延迟）、请求统计（p50/p95/p99、错误率、延迟直方图、端点排行 Top 50）、资源趋势（每分钟采样）、scheduler 与后台任务状态、db.json 大小与备份时间。指标存进程内存（24h 环形缓冲），重启清零。

**权限守卫**（`routes/aws.ts`）：

| 守卫 | 实际放行范围 | 用途 |
|------|--------------|------|
| `requireAdmin` | **admin + partadmin**（只拦 viewer） | 提额、资源删除、MAP 标签写操作、删 access key |
| `requireStrictAdmin` | 仅 admin | 账户权限检测 |
| `requireOpsAccess` | admin 或 `allowed_pages` 显式包含 `ops` | 运维监控；实时读取数据库，旧用户默认拒绝 |
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

`allowed_pages` 控制可见页面（admin 视为全部）。`ops` 包含敏感系统指标，non-admin 只有被显式勾选后才能显示菜单并调用接口；旧用户和新用户默认都不授予。`authMiddleware` 会拦住未绑 MFA 用户访问业务接口。

### 三个独立权限开关

admin 恒有，其他角色必须显式授予，且**都不受 `allowed_pages` 影响**：

- `root_access` → 账户页「根用户」敏感操作（Admin 临时凭证 / 删除 Root MFA / 恢复根密码 / 删除 Root Access Key）以及 Admin 控制台登录；`GET /root-credentials/:accountId` 的状态读取当前不经过该守卫
- `bulk_quota_access` → 「批量提额」页；未授予时菜单完全不可见，后端 `requireBulkQuotaAccess` 也会拒绝
- `root_reset_access` → 「批量设置 Root 密码」页，值为 `none` / `view` / `operate`；非 admin 只看本人批次，admin 查看/管理全部。创建批次仍要求 step-up TOTP；CSV 下载不再额外 MFA，Owner 可重复下载本人永久归档，Admin 可重复下载全部永久归档

`requireRootAccess` 和 Admin 控制台门禁都会用 `db.getUser(username)` 实时读取数据库，严格要求字段为 `true`（admin 恒有），不信任旧 JWT 中缓存的权限。

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
  "adminRoleExcludedAccounts": [                      // 仅排除 Admin；support-quota 保留
    { "accountId": "123456789012", "payer": "org-name-1", "reason": "Customer requested support-only access" }
  ],
  "consoleAdminPayers": ["..."],                     // 提供控制台双选项的组织
  "tagCompliance": {
    "roleArn": "...", "region": "...", "stateMachineArn": "...",
    "reportsBucket": "...", "orgConfigKey": "...", "topicArn": "...", "notificationEmail": "..."
  },
  "web": {
    "port": 3000,
    "adminPassword": "登录密码",
    "jwtSecret": "128位hex随机串",
    "encryptionKey": "32–4096字符的当前密钥；MFA等敏感字段新写带类型/key ID的认证GCM，并兼容迁移旧CBC；Root使用用途分离gcm2",
    "encryptionKeyPrevious": ["轮换前的旧密钥，最多8个，仅用于认证解密和迁移历史密文"],
    "feishuWebhook": "留空则不通知"
  }
}
```

`encryptionKey` 是新密文的 current key；轮换时必须先把旧值移入 `encryptionKeyPrevious`，再替换 current key。历史项最多 8 个且只用于解密。服务启动会先认证并原子重加密在线 MFA、ExternalId 和永久 Root 凭证到 current key；DB 迁移审计同次写入，Root 使用可重试 marker 加一条有界 `system` 汇总审计。新 Root 密码写为带 16 位 key ID 的 `gcm2`，旧 `gcm1` 会依次尝试 current + historical key。首次从旧版 JWT-secret CBC 配置 dedicated key 时，启动迁移也会把 `jwtSecret` 作为仅限 legacy 字段的候选。在线迁移完成后，仍须等待包含旧密文的 7 天本地备份和异机快照完成轮替及恢复验证，才能删除历史 key。keyring 必须与 `data/root-email-jobs.json` 分开受控备份。

`payers[].name` 格式为 `yanhuang编号-公司名`，用于提额文档与通知匹配公司。

### `data/db.json`（gitignore，运行时数据库）

顶层键：

- `users` — 账号（bcrypt 密码、加密的 mfa_secret、role、allowed_pages、root_access、bulk_quota_access）
- `quota_requests` — 配额提升记录
- `audit_log` — 审计日志，**上限 5000 条滚动**
- `region_data` — 各账户区域 opt-in 状态
- `accounts_cache` + `accounts_cache_time` — 账户列表缓存（调度器每 30min 刷新）
- `tag_onboarding_jobs` — MAP 全自动接入任务、阶段产物、重试与恢复状态
- `billing_export_jobs` — 账单导出队列、进度、结果、取消/中断状态与下载元数据
- `restricted_accounts` — 敏感权限客户账户（加密的 `external_id_enc`、state、last_error）。**同时是 `setup-org-stacksets.ts` 的 StackSet 排除名单来源**
- `departed_accounts` — 已移出组织的账户记录（含 `rejoined_at` 轨迹）

旧数据库可能仍有 `dashboard_cache` 字段；从 0.21.2 起应用不再读取或写入该字段，保留旧值仅为避免直接修改生产运行时数据。

账单 ZIP 存在 `data/exports/billing/<jobId>/` 并在服务器长期保留；只通过鉴权下载端点访问，不写入 Git，也不会由 job runner 自动删除。历史记录通过分页接口查询，可重复下载。

启动和长时间运行期间每天首次 DB 读取时，`backupDB()` 会先校验源 JSON，再分别备份为 `data/backups/db-YYYY-MM-DD.json` 与 `data/backups/root-email-jobs-YYYY-MM-DD.json`；同日恢复点一旦创建便不覆盖，避免尚未认证的源密文破坏已有好备份。Root 快照只保留明确 `password_set` 且未在旧一次性策略下披露的密文，绝不归档 `setting_password`/failed/unknown 密文。两类各保留 7 天。自动备份不包含 `config.json`，匹配的 `encryptionKey` keyring 必须在独立受控位置备份。

---

## 关键实现

### 免登录进入 AWS 控制台 / Support Case

STS Federation。后端先取得目标账户临时凭证，再请求 `signin.aws.amazon.com/federation?Action=getSigninToken` 换取 signin token，最后拼出一次性 login URL。浏览器只收到登录 URL，不接触服务端长期凭证；账户「控制台」按钮和提升记录 Case ID 都复用这条链路。

`access` 参数分为 `support`、`admin`、`auto`，不同账户类型的实际会话如下：

| 目标 | access | AssumeRole 与会话 |
|------|--------|-------------------|
| payer 管理账户 | `admin` | 直接进入 `role/tool`，session name 为 `console-payer-admin`，**不附加 session policy** |
| payer 管理账户 | `support` / `auto` | 仍进入 `role/tool`，但附加 AWS 托管的 `ReadOnlyAccess` managed session policy，session name 为 `console-payer-readonly` |
| 成员账户 | `support` | 一级跳 `support-quota`，session name 为 `console-support-<accountId>` |
| 成员账户 | `admin` | 优先一级跳 `admin-console`，session name 为 `console-admin-<accountId>`；失败才回退 payer `role/tool` → `OrganizationAccountAccessRole` |
| 成员账户 | `auto` | 按兼容回退链选择可用角色，供尚未完成专用角色部署的旧账户使用 |

payer 只读会话的有效权限是 `role/tool` identity policy 与 `ReadOnlyAccess` session policy 的**交集**；session policy 只能收窄，不能增加权限。`admin` 控制台入口必须通过 `root_access` 实时门禁，并记录 `CONSOLE_ADMIN_LOGIN` 审计动作。排查实际会话类型时以 CloudTrail 的 `userIdentity.sessionContext.sessionIssuer`、session name 和请求错误为准，不要只看前端按钮文案。

### 提额文档自动生成（PDF）

HTML 模板 + Puppeteer 渲染。公司背景库在 `doc-templates.ts`（12 家公司，从历史 SOW 总结），架构图在 `doc-templates/architectures/`。

公司解析顺序：账户缓存的 `_payer` → `PAYER_TO_COMPANY` → `ACCOUNT_TO_COMPANY`。**截至 2026-08-27 的 44 个配置 payer 中，只有 11 个有内置映射**，其余识别不出时前端弹出公司挑选，选过的按 payer 记在 localStorage，下次自动预选但仍需确认（刻意不静默套用，避免悄悄用错公司）。

`companyFromPayer` 的后缀兜底做的是「公司部分完全相等」比较，不能用 `endsWith` —— 单字符后缀会命中短名 key（`webby-2` → `malatrading`），静默生成挂着别家公司资料的文档。

动态生成：申请值自动拆解成资源组件表（合计=申请值）；配额类型自动识别 AWS 官方名称（vCPU/EIP/Lightsail/Mac/WorkSpaces 等）；预测值约申请值的 1.5 倍。

### 一键提交提额文档到 Support Case（case-doc-submitter.ts）

配额页对提额请求可一键把文档提交到对应 Support Case：后台 job（内存态、单并发）执行 生成 PDF → 联邦登录直达 Case 页 → 点 Reply → 填 use cases 正文 → 传附件 → Submit → 确认生效。前端 `caseDocSubmit` 提交后轮询 `caseDocJob`；识别不到公司时弹公司选择器（`companyKey` 随请求传入）。`requireAdmin`（会真实回帖客户 Case）。

浏览器自动化的硬性经验（0.22.3 调试实录，改动前必读）：

1. **文件名回显 ≠ 上传完成**。文件一选中就出现在附件表格，但后台 `GetAttachmentUploadLinks → PUT → CompleteAttachmentUpload` 还没走完；此时点 Submit 会被 AWS 前端**静默忽略**（`AddCommunicationToCase` 根本不发出，无任何报错）。必须等附件状态列变为 "Upload completed" 再提交。
2. **成功判定唯一可靠信号是 Reply 表单（textarea）收起**。绝不能用页面文案 `Correspondence` 判断——那是 Case 页固有标题，恒为 true，曾导致假成功。
3. awsui/React 按钮对 JS `el.click()` 不可靠，Reply/Submit 用 `page.mouse` 真实坐标点击 + `elementFromPoint` 命中测试 + 遮罩剥离（控制台引导 tour 带全屏遮罩）+ Enter 兜底。
4. 排障看网络层：监听 `support.us-east-1.amazonaws.com` 的 `x-amz-target`（`AddCommunicationToCase` 200 = 真提交成功）。响应中的 `DryRunOperationException: Request validated successfully` 是 AWS 前端自身的预检请求，不是错误。
5. server tsconfig 无 DOM lib，所有 `page.evaluate`/`waitForFunction` 载荷必须是字符串脚本（与 `billing-exporter.ts` 同约定）。

失败时截图到 `/tmp/case-doc-*.png` 并随 job 状态返回路径。job 存进程内存，重启即失；轮询端点不写审计。

### 配额管理

- **多区域查询**：覆盖 34 个 AWS 区域（含 opt-in），并发查询，8 秒超时跳过未开通区域
- **流式同步（SSE）**：全量同步用 Server-Sent Events 实时推进度，边查边出
- **Bedrock 配额**：按区域查 TPM/RPM/TPD，多区域并发；按 Provider、推理范围（Global Cross-Region / Cross-Region / On-Demand / Latency-Optimized）筛选
- **批量提额**：按 payer 组织 × 多区域批量提交，只传配额名 + 目标值，QuotaCode 后端解析，已达标账户自动跳过；job 模式（submit → jobId → 轮询）

### Bedrock 工具

区域下拉为 30 个 Bedrock 可用区域（带中文别名，支持搜索），与 `Quotas.tsx` 的列表保持一致。**各下拉按后端实际上限设了 `maxCount`**：`/profiles` 与交付表格 12 个、`/data-retention` 20 个、配额查询 30 个 —— 早期区域表只有 10 个时永远碰不到上限，补全后不加限制会直接吃 400。

Profiles 列表的 ARN 列完整展示（不截断、等宽字体），每行带复制按钮，工具栏另有「复制选中 / 全部 ARN」（每行一条，可直接粘进脚本）。批量复制用的是**当前可见且选中**的行，与批量删除/打 Tag 口径一致 —— `selectedKeys` 会包含被搜索框过滤掉的行，直接用会多复制。

**客户交付表格**有两种格式：

| 端点 | 格式 | 说明 |
|---|---|---|
| `POST /delivery` | v1 三列 | Profile Name / ARN / Region |
| `POST /delivery-v2` | v2 五列（李浩版） | 追加 TPM / TPD，服务端实时查 Service Quotas 匹配 |

v2 按 `variant` 筛选核心 6 模型并固定排序：`global`（每区 6 条，默认）或 `full`（每区 12 条，us+global）。老模型（haiku / fable / opus-4-1 / 4-5 / sonnet-4 / 4-5）一律剔除。用**白名单**而非黑名单 —— AWS 随时上新模型，黑名单会漏。

筛选必须在 `prepareDelivery()` **之前**执行：后者对每一行强校验 `map-migrated` tag，老模型往往没打 tag 会直接让整个导出失败，而它们本就不该进交付表。

**Profile 名归一化回退（0.34.2）**：清单是精确字符串白名单，但不少账户的 Profile 用控制台默认命名。实测 `703844615335`（HDL Account 7）6 个核心模型全都在，名字却是 `Global Anthropic Claude Opus 4.6`，与清单的 `sef-global-claude-opus-4-6-v1` 一条都对不上，导出直接报「账户中找不到任何交付清单内的 Profile」。

`normalizeProfileName()` 做形态折叠后回退匹配：去 `sef-` 前缀、去 `anthropic`/`claude` 词、版本号 `.` 视同 `-`、去结尾 `-v1`、非字母数字压成 `-`。**精确优先、回退兜底**，历史交付件按原名对齐的行为不变。

实测遇到的三种账户命名，归一化后必须折叠到同一形态：

| 来源 | 实例 |
|---|---|
| 交付清单 | `sef-global-claude-opus-4-7` |
| 账户 `106360388618` | `Self-global-claude-opus-4-7` |
| 账户 `703844615335` | `Global Anthropic Claude Opus 4.7` |
| 带日期戳与 `:0` 后缀 | `Self-global-claude-sonnet-4-5-20250929-v1:0` |

⚠️ **前缀要同时剥 `sef-` 和 `self-`**（0.37.3）：只剥 `sef-` 会让
`Self-` 系账户残留 `self-global-opus-4-7`，与清单的 `global-opus-4-7`
对不上 —— 实测账户 `106360388618` 的 52 个 Profile **全部匹配失败**。

⚠️ **日期戳要在版本后缀之后剥**：命名是 `...-20250929-v1:0`，
先剥 `-v\d+(-\d+)?$` 再剥 `-\d{8}$`，顺序反了日期戳会留下。
剥完仍须保证 `sonnet-4`（20250514）与 `sonnet-4-5`（20250929）可区分，
且都不等于清单里的 `sonnet-4-6`。

⚠️ **scope 词（us/global）必须保留**：变体 A 里 `sef-us-claude-opus-4-8` 与 `sef-global-claude-opus-4-8` 只靠它区分，折叠掉会让两者互相顶替 —— 交付表出错且几乎不可能人眼发现。这是该函数最大的风险点，回归测试 `tests/bedrock-delivery-name-match.test.ts` 专门锁死。

回退只认清单内的模型，`Fable 5` / `Haiku 4.5` / `Sonnet 4.5` 等非清单型号不会被误纳入。连带修了一处：经回退命中的行原本会同时计入 `dropped`，导致审计日志「剔除 N 种老模型」虚高。

**TPD 口径（2026-09 变更）**：AWS 新增账户级总配额 `Cross-Model Account-Level Tokens Per Day`（`L-E3F10727`，scope 标记为 `Account-Level`），同时**较新的 Claude 型号不再有独立 TPD**（实测 Opus 4.7 只剩 TPM）。取值优先级：

1. 模型自己的 TPD —— 仍大量存在且各不相同（Nova 2 Lite 11.52B、Claude 3.5 Sonnet 2.88B、Claude Opus 4.1 360M……）
2. 回退到**同区域**的账户级 TPD，并置 `tpdShared=true`
3. 两者都没有才写 0（规范红线：不盲套公式）

回退**下沉在 `listBedrockQuotas()` 数据源层**（0.34.1）：返回前给缺 TPD 的逐模型行回填同区域账户级值，打 `inherited: true` 并强制 `adjustable: false`。此前回退只写在交付链路的 `matchProfileTpmTpd()` 里，配额查询页的 TPD 列因此显示 `-`，会被读成「没有日限额」，与事实恰好相反。

`inherited` 标记是硬契约，三处依赖它：前端灰显 +「共享」标签、CSV 的 `TPD来源` 列、交付表的第 9 条须知。`matchProfileTpmTpd()` 必须按该标记而非「有没有值」判断，否则回填值会被当成模型自有配额，`tpdShared` 恒为 false 而丢掉须知。回归测试见 `tests/bedrock-account-tpd.test.ts`。

配额页对继承行**不渲染「提升」按钮** —— 提的是全账户总盘子而非单个模型，须到 `Account-Level` 行操作。

⚠️ 三个容易搞错的点：

- **账户级 TPD 按区域不同**，实测同一账户 `us-east-1`/`us-west-2` 为 540M，而 `ap-southeast-1` 只有 150M。`accountLevelTpd()` 按 region 取值，不可跨区复用。
- **账户级 TPD 的量级差异极大，且未必可自助提额**。实测 `668602396329` 的 `us-east-1` 为 **3 万亿/天**（约为常规 540M 的 5500 倍）且 `Adjustable=false`，只能走 TAM。别拿常规账户的经验套大客户账户。
- **不是所有 Anthropic 都没有独立 TPD**。Claude 3 Haiku / 3.5 Sonnet / 3.7 Sonnet / Sonnet 4 / Opus 4.1 仍有自己的值；只是交付清单里那 6 个核心新型号都落在回退分支，所以同区域内它们的 TPD 会显示为同一个数。

`tpdShared=true` 时交付表自动追加第 9 条须知，说明该额度**由账户下所有模型共享、非每个模型独享**（6 个模型不是 6×540M，仍是 540M）。

> 李浩版规范里「US TPD = TPM×720 / Global TPD = TPM×1440」的档位表，对交付清单中的新 Claude 型号已失效。

配额为 0 或清单型号缺失会通过 `X-Delivery-*` 响应头回传并在页面告警 —— 二进制 body 塞不进 JSON，且跨域下自定义头需在 `cors()` 的 `exposedHeaders` 显式暴露。

> 匹配逻辑有两个已修复的坑（见 `bedrock-tools.ts` 注释）：
> 次版本号正则曾贪婪吞掉 8 位日期（`claude-opus-5-20260301-v1:0` → `5.20260301`），
> 导致 sonnet-5 / opus-5 静默写 0；版本号曾用 `includes` 子串比较，
> `'opus 4.5'.includes('5')` 为真会让 Opus 5 串到 Opus 4.5 的配额，
> 把错误数字当真实配额写进交付表（比写 0 更危险）。现用数字边界锚定整段匹配。

## POC Cash（0.35.0）

创建 AWS Partner Central 商机并提交审核，是 POC 资金申请的前置步骤。
页面 `poccash`，**admin 专属**。

**权限模型比 ops 更严**：`POC_CASH_PAGE_KEY` 刻意不放进 `PAGE_META` /
后端 `ALL_PAGE_KEYS`，所以连「页面权限」勾选都无法授予；后端
`requireStrictAdmin` 实时查库，不信任 token 里的 role。理由是这里创建的是
**真实商机并提交给 AWS**，属于对外发生实际业务动作的写操作。

**凭证走跨账户 role，不存静态密钥**。APN 账户（105673812363）里建
`partner-central-tool` role，信任中心账户的 tools 凭证（`user/mark`）+ ExternalId；
平台 assume 后拿 1 小时临时票据（缓存 50 分钟）。配置在 `config.json` 的
`partnerCentral { roleArn, externalId }`。

> 最初方案是存 APN 的 AK/SK —— 但那个 IAM 用户挂着 **AdministratorAccess**，
> 把长期密钥放进配置文件等于泄露整个 APN 账户的管理员权限。改成 role 后
> 权限可精确限定，凭证也是临时的。

一键创建与验证：

```bash
python3 scripts/setup_partner_central_role.py            # dry-run 看策略
python3 scripts/setup_partner_central_role.py --execute  # 创建
python3 scripts/setup_partner_central_role.py --verify   # 验权限边界
```

⚠️ **IAM action 前缀是 `partnercentral:`，不是 `partnercentral-selling:`**。
这是实测确认的（建无权限 role 调 ListSolutions，AWS 拒绝信息里写的是
`partnercentral:ListSolutions`）。按服务名写会让整个策略静默失效。

权限范围：31 个 action，只含商机生命周期、Engagement、Solution 只读、
POC 资金申请。显式 Deny `Delete*`、账户管理、Channel、Revenue Measurement；
末尾 `NotAction: partnercentral:*` 兜底 —— **配额、账单、EC2 等一律拒绝**。
实测验证：ListSolutions/ListOpportunities/ListBenefits 通过，
EC2 DescribeInstances 与 ServiceQuotas ListServices 被拒。

**三步流程（顺序不可调换，均为实测得出）**：

```
CreateOpportunity                      → 建成 Prospect
  → AssociateOpportunity               → 挂 Solution（默认 S-0070517 Migration services）
  → StartEngagementFromOpportunityTask → 建 engagement 并提交
```

⚠️ 两个 AWS 侧的硬约束：

- **不能直接调 `SubmitOpportunity`** —— 返回
  `Cannot submit opportunity without an engagement.`，必须走
  `StartEngagementFromOpportunityTask`（它把建 engagement 和提交合并成一个异步任务）。
- **`Pending Submission` 状态下不能改 Stage** —— 返回
  `You can not update the stage when Opportunity status is Pending Submission.`
  所以商机一律先建成 `Prospect`，待 AWS 审批通过后才能推到 Technical Validation。

关联 Solution 或提交失败**不回滚商机**，而是写进 `warnings` 返回 ——
商机已经建好，回滚反而更危险。

**金额单向推导**（`docs/poc-cash-guide.md` 第 4 节，81 条实操记录 100% 吻合）：

```
ARR = MRR × 12          POC 可申请 = ARR / 10
Total Cost = 339 MYR × 8h × 人数 × 天数
Partner Contribution = Total − 申请额（USD→MYR 汇率 4.27）
```

前端实时预览并在三种情况下告警：Partner Contribution 为负、占比 < 10%、
POC 申请额 > 9,900 USD（实测 114 条记录的经验上限）。

### POC 资金申请（0.37.0）

四个 Tab：创建商机 / 阶段检查 / POC 申请 / **POC 进展**。
申请与进展分开（0.37.2）—— 表单本身就长，再挂一张宽表会挤成一团。
创建成功后自动跳到进展页。

⚠️ 进展表的**状态列不要设 `fixed: 'left'`**：该列较宽（含 Stage），
固定后会盖住相邻的 Fund Request ID 列，实测 ID 被压掉一半。
首列放 ID 更利于对账；只有右侧「操作」列固定。
账户号（12 位）、周期、PO 号都要 `whiteSpace: nowrap` + 足够宽度，
否则会折成两行把行高撑开。

**硬前置：必须先有商机**，且已到 Technical Validation、ReviewStatus 为
Approved / Action Required。不满足直接拒绝，不降级 —— AWS 侧会打回。

**用户只需填 4 项**：商机（下拉）、AWS 账户 ID、业务描述（≥50 字）、人天。
其余全自动：计算器链接、ARR、全部金额、Webby 发票信息、联系人。

**项目桶 = 账户所属 payer**，填完账户 ID 毫秒级带出 —— 走平台
`accounts_cache` 的 `_payer` 字段。**不要**改成遍历 45 个 payer 的
Organizations 反查，实测要 60~90 秒，放表单里不可接受。

账户不在任何 payer 下时**留空**（实扫确认 `105673812363`/`176350488746` 等
5 个账户确实不在任何 payer，是客户自有或 APN 账户，非缓存问题）。
不要回退成公司名 —— 会引入 payer 名与公司名两种命名混用。

⚠️ **`ListBenefitApplications` 返回的 `BenefitApplicationDetails` 是精简版**，
只有 `BudgetYear/Program/PurchaseOrderNumber/ActivityName/ProjectType/Template`，
**没有 `CashRequest`/`AwsAccountId`/`AwsCalculatorUrls`**。直接用会让金额、
项目桶、计算器链接全为空。必须逐条 `GetBenefitApplication` 补全（并发限 6）。

⚠️ **CSV 里的数字不能加千分位**。`toLocaleString()` 产生的 `"28,800"`
里有逗号，虽然 `csvEscape` 会加引号，但下游朴素 `split(',')` 解析仍会串位 ——
实测整行从第 6 列起错位（20 列 vs 18 列表头）。数字一律输出裸值。
回归测试断言"数据列数 == 表头列数"。

**计算器配置（0.37.1）**：8 个服务 —— EC2 应用层 / 压测机 / 数据库、
EBS、S3、ALB、CloudFront、CloudWatch、CloudTrail。后三个是固定小额开销
（监控/审计/CDN），不随算力缩放。

金额刻意**带零头**：整数（2400.00）一看就是凑的。用 MRR 做种子偏移
+30~170 USD，同一商机每次生成结果一致，可复现可对账。

收敛项用 **EBS 而非 S3**：S3 单价仅 0.0225/GB，差额稍大就被压到 100GB
下限而失去调节能力（实测 MRR 5000 时 S3 只剩 100GB，总额仍偏离 133 USD）。
EBS 单价高近 4 倍，调节范围更大。S3 改为按算力等比放大（日志/制品量
本来就跟规模走）。

CSV 19 列严格对齐现有台账，`PO ID` 就是商机 ID。服务器留存带时间戳快照
（`data/poc-cash/`）+ `poc-cash-latest.csv`，同时浏览器下载一份 ——
留存是为了回溯 PO 号、到账金额是何时被 AWS 回填的。

**阶段检查（0.36.0）**：页面分「创建商机 / 阶段检查」两个 Tab。提交后商机被
AWS 锁定，用阶段检查确认审到哪一步了，并在允许时推进阶段。

可编辑性严格跟随 `ReviewStatus`，三段互斥：

| ReviewStatus | 能否改 Stage | 说明 |
|---|---|---|
| `Pending Submission` / 空 | ❌ | 未提交状态下 AWS 拒绝改阶段 |
| `Submitted` / `In review` | ❌ | 审核中，商机被锁 |
| `Approved` / `Action Required` | ✅ | 可推进 |
| `Rejected` | ❌ | 不在白名单 |

`readyForPoc` 需同时满足 **Stage = Technical Validation** 且可编辑 ——
阶段到了但还在审核中不算就绪。就绪时页面直接给出定价计算器目标 ARR 与
POC 可申请额。

⚠️ `UpdateOpportunity` 用 `LastModifiedDate` 做乐观锁，必须是服务端最新值，
否则抛 `ConflictException`。所以推进接口**在服务端自己先 Get 再 Update**，
不接受前端传时间戳（前端值可能已陈旧）。`ReviewStatus` 只读，只能改 Stage；
回传 `LifeCycle` 时只带可写字段，带上只读字段会被拒。

**参考已有商机（0.35.1）**：同一客户做新项目时，从下拉选一条已有商机，
带出客户信息、Use Case、业务描述、Solution。**项目名称与 MRR 刻意不带过来** ——
新项目的描述和金额必须自己填，沿用旧值是常见错误。套用后会提示"业务描述是上一个
项目的，请按本次项目改写"。

⚠️ `ListOpportunities` **不返回 Title / CustomerUseCase / CustomerBusinessProblem**，
只有 `GetOpportunity` 才有。所以列表只显示客户名等摘要，选中后再单独拉完整模板——
不能对每条都 Get（账户里有 246 个商机）。

⚠️ `CreatedDate` 是 timestamp，SDK 反序列化成 Date 对象。用 `String(date).slice(0,10)`
会得到 `Mon Sep 21` —— 既显示错误又让按日期倒序的字符串排序失效。必须走
`toISOString()`。`TargetCloseDate` 是 string 类型，不受影响。

**商机名称**支持自动生成与手动输入。自动模式按账户内惯例拼成两段式
`Webby - <客户简称> <项目描述> #ADPL`（不是 YanHuang 的三段式），并剥掉
`SDN. BHD.` 等公司后缀。`CustomerUseCase` 必须用 AWS 的完整字面量 ——
写成 `Migration` 会被拒，正确值是 `Migration / Database Migration`。

回归测试见 `tests/poc-cash.test.ts`。

### 批量导出官方账单 PDF

产出的是 AWS 自家生成的打印文档，与手动「打印 → 另存为 PDF」一致。底层流程：严格只读 Federation 会话 → Billing Bills 页面 → 等数据加载 → 点两级「打印」→ AWS 调 `window.print()` → Chrome 静默另存为 PDF → zip。

账号选择支持上传 `.xlsx`：文件只在浏览器本地解析，不上传服务器；扫描所有工作表并提取独立的 12 位 AWS Account ID，只勾选平台账户列表中已存在的账号。单文件限制 5 MiB / 50,000 个单元格，月份仍由页面单独选择，后端继续执行账户白名单与 200 任务上限复验。

编排层在 `billing-export-jobs.ts`：提交接口立即返回 `202 + jobId`，前端在页面可见时约每 3 秒轮询、隐藏时降至约 15 秒，遇到 429/5xx/网络错误会指数退避，并可关闭弹窗后恢复。服务器一次只执行一个 job，job 内并发由 `BILLING_EXPORT_MAX_CONCURRENCY` 统一限制（默认 3），不接受前端虚假并发；每个用户最多一个活跃任务，全局最多 10 个 queued（可用 `BILLING_EXPORT_MAX_QUEUED_JOBS` 调整）。状态包含真实完成数、成功/失败、动态 ETA 和队列位置。取消会停止领取新任务、等待 worker 收尾，并以有界 TERM→KILL 流程关闭活动 Chrome/zip 后清理半成品；若最终期限内仍无法确认进程树退出，当前 job 标记失败且 runner 暂停接单，避免残留进程与下一任务重叠。

安全与生命周期：

- 所有抓取固定调用 `getConsoleSigninUrl(..., 'support')`。payer 使用 `role/tool + ReadOnlyAccess` session policy，成员账户必须进入 `support-quota`；角色缺失时该份失败，**绝不回退 OAAR/admin**
- submit/list/status/cancel/download 都实时检查 `billing` 页面权限；新任务 owner 绑定不可复用的用户 ID，旧记录仅在缺少 ID 时兼容用户名；单任务查询、取消和下载还要求 owner 或 admin。历史列表默认 `scope=mine`，admin 只有显式 `scope=all` 才查看全局
- 入队前以及实际执行前都会检查 Chrome、Xvfb socket、`zip` 和输出目录，依赖缺失时不会启动任何浏览器
- job 元数据持久化在 `billing_export_jobs`；PM2 重启后 queued 任务继续排队，原 running/cancelling 标记 `interrupted`，避免伪装为仍在执行
- 完成的 ZIP 和 job 元数据在服务器长期保留并支持重复鉴权下载；`expired` 仅兼容旧版本已清理或文件确实丢失的历史记录
- 轮询状态不写审计，提交、取消、下载分别记录 `BILLING_EXPORT_SUBMIT`、`BILLING_EXPORT_CANCEL`、`BILLING_EXPORT_DOWNLOAD`

四个必须遵守的抓取约束（都是踩坑换来的，改这块前务必先读 `billing-exporter.ts` 顶部注释）：

1. **必须 headed + `--kiosk-printing`**。headless 没有打印子系统，AWS 的打印流程跑不完。服务器靠 Xvfb（`:99`）提供 headed 环境，并预设打印首选项锁定「另存为 PDF」
2. **必须等数据真正加载完**。首屏出现「账单周期」≠ 数据就绪，过早点打印会缺内容。等的是加载指示器消失 + 网络空闲 + 固定缓冲
3. **判断弹窗可见性不能用 `offsetParent`**。AWS 弹窗是 `position:fixed`，其 `offsetParent` 恒为 null，会被误判成隐藏。必须用 `getBoundingClientRect` + `getComputedStyle` + `elementFromPoint` 命中测试
4. **每个账户必须用独立浏览器实例**。控制台会话存在 `.amazon.com` cookie 里，复用同一 profile 会让后面的账户沿用前面的会话 —— 导出的多份 PDF 文件名各异但内容全是第一个账户的，属于"看起来成功了"的危险错误

另有两道产出校验：页面显示的 12 位账号必须是目标账户；PDF 只有 1 页视为废纸并丢弃。

#### Billing Console 权限前置与排障

账单 PDF 导出只通过浏览器 Billing Console，不调用 Cost Explorer API。目标账户必须由 root 用户在 Billing 首选项中开启 **Activate IAM Access**；该开关只允许 IAM/联合身份参与 Billing 授权，不会替角色补充任何 IAM 权限。

开关启用后可能有数分钟传播窗口，而且旧 Federation/browser session 会保留启用前的结果。遇到账单页提示无权限时按以下顺序处理：

1. 退出旧 AWS Console 会话，关闭原有 Billing 标签页/窗口
2. 从 AWSTool **重新生成**控制台 URL；必要时在全新隐私窗口打开，避免复用 `.amazon.com` cookie
3. 用 CloudTrail 核对真实会话：payer Admin 应为 `console-payer-admin` 且没有 `ReadOnlyAccess` session policy；payer 只读应为 `console-payer-readonly`
4. 记录拒绝事件的 `eventSource`、`eventName`、`errorCode`、`errorMessage`、`recipientAccountId` 与 `sessionIssuer`，再判断是账户开关、会话类型还是 IAM/SCP 拒绝

`IAM user access not activated` 明确指向账户级开关尚未传播、访问了错误账户或仍在使用旧会话，不应通过扩大 `role/tool` 权限解决；普通 `AccessDenied` 才继续检查具体 action、角色 identity policy、session policy、permissions boundary 与 SCP。近期生产诊断已验证：重新生成的 `console-payer-admin` 会话可成功访问 Billing Console 并调用 `billing:ListBillingViews`。

### MAP 标签合规

平台不重写扫描/打标逻辑，而是 assume 中央工具账户的 `tag-compliance-console-role`（最小权限：只能操作指定状态机与报告桶），去读写 `orgs.json`、触发 Step Functions 扫描、查执行状态、读最新报告。打标本身仍由中央系统用最小权限的 `auto-tagger-role` 执行，安全模型不变。

**payer 管理账户同样纳入打标范围（v0.33.0 起）**。`auto-tagger-role` 通过 SERVICE_MANAGED StackSet 下发，而该模式**不会部署到组织管理账户**，所以 payer 自身长期没有打标角色 —— 过去靠 `exclude_accounts` 默认排除 payer 来回避。现在：

- `provisionOrg()` 增加一步，在 payer 账户内**单独创建** `auto-tagger-role`（StackSet 覆盖不到，只能直接建）
- 新建组织不再自动把 payer 写进 `exclude_accounts`，默认全账户打标；仍可显式传值排除特定账户
- payer 角色的权限由 `AUTO_TAGGER_INLINE_POLICY()` 从 `AUTO_TAGGER_ROLE_TEMPLATE` 正则解析生成（约 136 个 Action），与 StackSet 模板**同源**，避免两处维护漂移

> ⚠️ **不要用托管策略 `ResourceGroupsandTagEditorFullAccess` 替代这份内联策略。**
> 它只授予 `tag:TagResources` / `resource-groups:*`，不含各服务自身的打标 API；
> 而 `TagResources` 底层是代调 `athena:TagResource`、`logs:TagResource`、
> `s3:PutBucketTagging` 等，缺了会全线 `AccessDenied`。
> 实测曾因此产生 59 个打标失败（其中 47 个是 `athena:TagResource`）。
> `tests/tag-compliance-policy.test.ts` 会断言 Action 数量与关键 Action 存在，
> 防止模板被重排后正则失配、静默生成空策略。

变更前后实测（webby02 / FFCloud / nexstack 三个组织）：`found=142 tagged=81 failed=59` → `found=73 tagged=71 failed=1`。

> **MAP 计费口径提醒**：payer 管理账户内多为账单桶、CUR 桶等运维基础设施，
> 并非客户迁移的工作负载。是否计入 MAP 报销基数需与 AWS 侧确认；
> 如需回退，把各 org 的 `exclude_accounts` 改回 payer 账户 ID 即可。

排查这类问题时注意区分两种「未打标」：Resource Explorer 会把 `default` 事件总线、
`default.*` 参数组这类**免费内置资源**也算进未打标（数字虚高且无业务意义），
而 MAP 只认有费用的资源 —— 用 Cost Explorer 的 cost allocation tag 维度按
服务/用量类型下钻，才能看出哪些是真正漏打标、哪些是结构上就没有 tag 维度
（Savings Plans 分摊、公网 IPv4、域名注册费、纯 API 调用费等）。

「全自动接入」由 `tag-onboarding.ts` 的持久化 runner 实现，任务保存在 `data/db.json` 的 `tag_onboarding_jobs`，状态为 `queued` / `running` / `waiting_retry` / `completed` / `failed`。同一 payer + 相同 payload 会复用已有任务，不同标签参数会报告冲突；服务重启后 runner 会恢复未完成任务，并对 AWS 最终一致性场景自动等待/重试。

执行阶段固定为：

1. `provision_org` — 创建或核验组织级前置资源
2. `wait_management_index` — 等待管理账户 Resource Explorer 聚合索引与 OrgView
3. `deploy_re_indexes` — 按各成员账户实际启用区域下发多区域索引
4. `wait_stacksets` — 用账户 × 区域矩阵核验 StackSet 覆盖
5. `upsert_org_config` — 原子更新 S3 `orgs.json` 并回读
6. `verify` — 重新执行前置条件检查
7. `done` — 标记完成

因此 API 返回提交成功只表示任务已入队；运维验收必须看到最终 `completed`，并检查阶段产物和回读结果。

### 根用户凭证状态与敏感操作

账户页「根用户」tab 会读取状态，并提供四类敏感操作。敏感操作均受 `root_access` 实时门禁控制并写入审计；状态接口 `GET /root-credentials/:accountId` 当前不经过 `requireRootAccess`。

| 功能 | 当前实现 | 说明 |
|------|----------|------|
| 读取 Root 凭证状态 | 优先 `AssumeRoot(IAMAuditRootUserCredentials)`，在目标 root 会话内调用 `ListAccessKeys`、`ListMFADevices`、`GetLoginProfile` | AssumeRoot 失败时回退管理员权限的 `GetAccountSummary` + Credential Report；Credential Report 最长可能约 4 小时才刷新 |
| 生成 Admin 临时凭证 | 优先直接 AssumeRole 到成员账户 `admin-console`，**不**走 `support-quota` | 默认 1 小时；仅平台 admin 可选 1–12 小时。超过 1 小时不允许回退 OAAR；可复制 AK/SK/Token、导出环境变量、倒计时与重新生成 |
| 删除 Root MFA | `AssumeRoot(IAMDeleteRootUserCredentials)` → root 会话内 `ListMFADevices({})` → `DeactivateMFADevice`；虚拟设备再尝试 `DeleteVirtualMFADevice` | 不依赖管理员会话枚举 root 设备 |
| 恢复根用户密码 | `AssumeRoot(IAMCreateRootUserPassword)` → root 会话内 `CreateLoginProfile({})`（省略 `UserName` / `Password`） | 与 AWS Organizations“允许恢复密码”一致；不会删除、读取、生成或保存现有 root 密码；已有登录密码时返回冲突 |
| 删除 Root Access Key | `AssumeRoot(IAMDeleteRootUserCredentials)` → `DeleteAccessKey({ AccessKeyId })` | 只删除用户二次确认的目标 key |

**AWS 前提与边界**：

- 组织必须启用集中式根访问，调用身份必须具备 `sts:AssumeRoot`
- `AssumeRoot` 使用区域性 STS 端点，会话固定 900 秒；全球 STS 端点不支持
- `TargetPrincipal` 只能是该组织的**成员账户**。payer/management account 自身不能对自己执行 `AssumeRoot`；即使 `role/tool` 已有 `sts:AssumeRoot` 权限也仍会被 AWS 拒绝
- 当前前后端尚未在点击前显式排除 payer，因此在管理账户打开 Root 操作会看到 AWS `AccessDenied`；这是已知产品边界，不应通过继续扩大 IAM 权限规避

审计动作：`TEMP_CREDENTIALS`、`ROOT_MFA_DELETE`、`ROOT_PASSWORD_RECOVER`、`ROOT_ACCESSKEY_DELETE`；Admin 控制台另记 `CONSOLE_ADMIN_LOGIN`。

### 批量自动设置 Root 新密码

独立页面 `/rootreset` 受 `root_reset_access` 控制。每批最多 20 个 ACTIVE 成员账户；创建前必须精确输入 payer 名称、账户数量和当前 TOTP。任务严格串行执行：选择 Root 登录 → 如 AWS 要求则先完成登录安全验证码 → 打开 Forgot password → 完成恢复邮件验证码 → 精确匹配收件人/时间 → 校验 `signin.aws.amazon.com/resetpassword` 一次性链接 → 生成 24 位 CSPRNG 强密码 → 在 AWS 页面填写两处密码并提交。AWS 发信提交结果不明时只读查询邮箱而不重复发信；有效 reset 页面初始执行上下文短暂切换时会在提交前等待稳定。只有 AWS 页面出现明确成功文案才记为 `password_set`；确认尚未进入提交边界的浏览器加载异常最多执行 3 次独立 Chrome 尝试，同时只记录不含 URL/token 的阶段码和错误分类；提交后超时或页面异常记为 `password_unknown`，绝不自动重试。自动尝试耗尽且确认未提交密码时，任务创建者可在 2 小时内通过新的 MFA 按需重扫邮件、直接打开或显式复制链接；手工设置的密码不会进入平台 CSV。发恢复邮件阶段会记录独立 Chrome 尝试次数和不含 URL/token 的 `failureStage/failureCategory`；仅明确未跨过恢复邮件提交边界的 `failed` 任务可通过 MFA 创建新的单账户重试批次，旧任务保留并记录双向重试血缘，`interrupted`、已提交或结果未知任务不开放重试。

确认成功的密码以任务 ID、账户 ID、创建者 ID 作为 AAD，使用用途分离密钥和 AES-256-GCM 永久写入 `data/root-email-jobs.json`，不会因下载或时间到期自动销毁。新记录使用 `gcm2` 并携带非敏感 key ID；旧 `gcm1` 通过 current + `web.encryptionKeyPrevious` 兼容解密。CSV 不再要求下载时额外 MFA：Owner 可重复下载本人批次，Admin 可重复下载全部批次；每次请求仍使用短期 durable claim 防止同一视图并发生成，并记录真实操作者。非 admin 只看本人批次，Admin 查看全部。`root-email-jobs.json` 每日与 `db.json` 分别做 7 天本地轮换备份；服务器文件、独立备份的匹配 keyring 和异机快照共同构成永久 Root 凭证库，必须按最高敏感级别保护。列表 API、审计和飞书通知都不包含密码或 reset URL。完整运行与恢复语义见 [`web/ROOT_EMAIL.md`](web/ROOT_EMAIL.md)。

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

### 敏感权限客户账户（权限收窄 + ExternalId）

默认下发的 `support-quota` 附带 `ReadOnlyAccess` 托管策略（2900+ action），有客户会审出来并要求收窄。`restricted-accounts.ts` 把收窄**精确到账户级**：同组织其他账户不受影响，平台自己的 StackSet 也不会把宽权限再盖回来。

收窄后保留的权限只够查配额与区域状态：`servicequotas:Get*/List*`、`account:GetRegionOptStatus`、`account:ListRegions`、`sts:GetCallerIdentity`。信任策略额外要求 `sts:ExternalId`，**每账户一套 ExternalId**，一个泄露不牵连其它账户。

隔离手段三步：

1. 从组织级 StackSet `support-quota-role-orgwide` 移除该账户实例，`DeleteStackInstances` 带 **`RetainStacks=true`** —— 只脱离管理、不删账户内角色，过程中平台访问不中断
2. 角色本身是**就地改造 IAM**（`UpdateAssumeRolePolicy` 加 ExternalId 条件 + `DetachRolePolicy` 摘掉 ReadOnlyAccess + 挂内联策略 `SupportQuotaRestricted`），不是靠 StackSet 部署。改 IAM 需要写权限，只读的 `support-quota` 改不了自己，所以要用 payer 二级跳拿成员账户 admin
3. `AutoDeployment` 只在账户「加入 OU」时触发，已移除的实例不会被自动重建

⚠️ **最容易漏的一环**：手工跑 `scripts/setup-org-stacksets.ts` 会重新覆盖，因此该脚本必须读取 `data/db.json` 的 `restricted_accounts` 排除名单（已实现，见脚本第 59 行）。这也是 README 部署章节强调「必须在 EC2 权威数据环境执行、不能用空白或陈旧本地 DB」的原因。

`getExcludedAccountIds()` **刻意不按 state 过滤**：只要账户被标记过（记录未删）就一律排除。`state=failed` 表示收窄执行失败，但账户很可能已从组织级 StackSet 摘除，若因 failed 漏掉排除，下次全量下发就会把宽权限重新盖回客户账户，直接违反对客户的承诺。取消标记走 `unmarkRestricted()`，它会删除记录。

复验（`verifyRestricted`）要同时满足三条，缺一即判失败：带 ExternalId 能 AssumeRole、**不带 ExternalId 必须被拒**（否则条件没生效）、`iam:GetRole` 必须被拒（否则收窄没生效）。IAM 最终一致，改完信任策略要轮询重试（6 次 × 5 秒）。

取消标记的**顺序不能反**：先装回默认权限（去掉 ExternalId 条件 + 删内联策略），再删受限 StackSet 让组织级 StackSet 重新托管。反过来会有一段时间完全无法访问该账户。

调用侧：`aws-service.ts` 在 AssumeRole 时对 `support-quota` 自动带上 `getExternalId(accountId)`（admin 类角色不受此约束）。受限账户会失去**账单成本分析、资源清理扫描、账户详情的 IAM 安全状态**，属预期取舍 —— 调用方应据 `isRestricted()` 给出明确提示，而不是抛裸 `AccessDenied`。ExternalId 加密存储（`external_id_enc`），列表接口不返回明文，只有严格 admin 可单独调 `/external-id` 取用于交付客户，并记 `ACCOUNT_EXTERNALID_VIEW` 审计。

审计动作：`ACCOUNT_RESTRICT`、`ACCOUNT_UNRESTRICT`、`ACCOUNT_EXTERNALID_VIEW`。

### 离场账户追踪

账户被移出组织后，`ListAccounts` 立即不再返回它，平台账户缓存下一轮就没了，但遗留数据（`region_data` 等）仍在库里，表现为「未知组织」的孤儿记录，也无从追溯这个账户曾经是谁、什么时候走的。`account-lifecycle.ts` 补这个缺口，挂在 `scheduler.ts` 账户同步里（缓存被覆盖写入**之前**调用 `recordDepartures`）。

**核心难点是避免误判**。`listAccounts()` 对 assume 失败的 payer 是静默 skip 的，所以「从缓存消失」有两种完全不同的原因：账户真的被移出组织（应记录），或该 payer 这一轮同步失败（该组织所有账户都会消失，**绝不能记录**）。判据：只有当同组织仍有其他账户存活时，才认为消失的那些是真的离开了；一个组织的账户整体归零一律判为同步失败并跳过（日志里会列出 `skippedPayers`）。

- **重新加入**：此前记为离开、现在又出现在列表里的，写 `rejoined_at` 而**不删记录**，保留完整轨迹
- **历史补录**：`backfillDepartures()` 把「有遗留数据但已不在缓存里」的账户登记进来 —— 模块上线前就已离开的账户不会再触发 diff 检测。目前唯一的遗留数据来源是 `region_data`
- **已查证记录**：`KNOWN_DEPARTURES` 常量硬编码了一批上线前离开的账户，`departedAt` / `actor` 来自各原组织管理账户的 CloudTrail `RemoveAccountFromOrganization` 事件；查不到确切离开方式的（如 `ConstraintViolationException`）在 `note` 里如实说明

前端在账户管理页的「已离开」入口展示，汇总按 payer 分组。

### 飞书通知

飞书自定义机器人 Webhook 发交互式卡片。配置在 `config.json` 的 `web.feishuWebhook`，未配置时静默跳过。

当前只保留**异常告警**，不做常规业务播报：

| 通知 | 来源 | 触发条件 | 冷却 |
| --- | --- | --- | --- |
| 🚨 登录爆破 | `security-alerts.ts` | 同 IP 10 分钟内登录失败 ≥5 次 | 30 分钟/IP |
| 🚨 账号被集中尝试 | `security-alerts.ts` | 同用户名 10 分钟内失败 ≥5 次 | 30 分钟/用户 |
| 🚨 限速被持续触发 | `security-alerts.ts` | 5 分钟内 ≥20 次 429 | 30 分钟 |
| 🚨 服务端错误突增 | `security-alerts.ts` | 5 分钟内 ≥5 次 5xx | 30 分钟 |
| 账户角色缺失 | `account-roles.ts` | 每日全量检测后新变成 `unreachable` 的账户 | 只推本轮新增 |

> **2026-09-15 按运营要求移除**：配额变动通知、新 IP 登录提醒、敏感操作实时推送（原 18 个动作）。
> 这些行为**仍然完整写入审计日志与数据库**，只是不再推飞书 —— 追溯请查审计页/配额页，
> 不要因为没收到通知就认为没有记录。

---

## 后台定时同步

`scheduler.ts`，服务启动时拉起。

| 任务 | 频率 | 首次延迟 | 说明 |
|------|------|----------|------|
| 账户列表 | 30 分钟 | 10 秒 | 写入缓存，页面秒级加载 |
| 配额记录 + 当前值 | 4 小时 | 2 分钟 | 分批防限流 |
| 区域状态 | 24 小时 | 5 分钟 | opt-in 区域扫描 |
| 账户角色自愈（增量） | 跟随账户同步 | — | 只查新账户和待重试，单轮 ≤60 |
| 账户角色自愈（全量） | 24 小时 | — | 最久未检查优先轮转，单轮 ≤400 |

另有 `ops-monitor.ts` 独立于 scheduler：每 60 秒采样 CPU/内存/磁盘/事件循环延迟（进程内存环形缓冲，保留 24h），请求指标由 `index.ts` 日志中间件实时打点。

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
ssh -i server-access/mark-sg-key.pem ec2-user@54.255.131.45   # 密钥在项目 server-access/（gitignore）
cd ~/AWSTool && git pull -q
cd web && npm install                                    # 仅依赖变化时
npx vite build --config client/vite.config.ts
pm2 restart aws-toolbox
```

后端 tsx 直跑不编译，改 `.ts` 只需 `pm2 restart`；改前端才需要 `vite build`。

**每次部署递增 `web/client/src/version.ts` 的 `APP_VERSION`**（小改 patch、大改 minor），左下角展示，也用于确认部署是否生效。

### 验证部署生效

```bash
EXPECTED_VERSION=$(awk -F"'" '/export const APP_VERSION/{print $2}' web/client/src/version.ts)
# 注意：分包后版本号在业务包 index-*.js 里（不在 vendor/charts）；vite hash 含 - 和 _
BUNDLE=$(curl -s https://markxu.co/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)
curl -s "https://markxu.co/$BUNDLE" | grep -F "$EXPECTED_VERSION"
```

### HTTPS

Nginx 反代 + Let's Encrypt（`markxu.co`，自动续期），80 强制跳 443，HSTS 开启。Node 只监听 `127.0.0.1:3000`，外网只能经 Nginx。配置脚本 `web/setup-nginx.sh`；脚本为 zip 下载设置 10 分钟流式传输窗口，job 控制 API 本身都是短请求。

账单导出运行依赖：可执行 Chrome、常驻 Xvfb（默认 `:99`）、`zip` 与 CJK 字体。可用环境变量：`BILLING_EXPORT_DISPLAY`、`BILLING_EXPORT_SETTLE_MS`、`BILLING_EXPORT_MAX_CONCURRENCY`、`BILLING_EXPORT_MAX_QUEUED_JOBS`、`BILLING_EXPORT_OUTPUT_DIR`；runner 启动只检查输出目录，提交任务时再完整预检。ZIP 不自动过期，需监控 `data/exports/` 所在磁盘容量并纳入独立备份策略。

### 常见改动改哪里

| 需求 | 改动点 |
|------|--------|
| 新增业务接口 | `routes/aws.ts` 加路由（按需加守卫）→ `aws-service.ts` 加函数复用 `assumeToAccount()` → `api.ts` 加方法 → 页面调用 |
| 新增页面 | `pages/Xxx.tsx` → `MainLayout.tsx` 的 `navItems`/`PAGE_META`/`pageComponent()` switch 各加一项（同一 key）→ `auth.ts` 的 `ALL_PAGE_KEYS` 加同名 key；要移动端入口再加 `mobileNavItems`。key 会自动成为 URL 路径（`VALID_PAGE_KEYS` 由 PAGE_META + 独立权限页推导）。高频页可加进 `KEEP_ALIVE_PAGES` 保活，但有轮询定时器的页面别加（隐藏时白轮询） |
| 加 payer | 按下方「新增 payer 安全 Runbook」执行；角色、双 StackSet、生产配置和验收缺一不可，不能只改 `config.json` |
| 新增公司模板 | `doc-templates.ts` 的 `COMPANY_PROFILES` 加资料 + `ACCOUNT_TO_COMPANY`/`PAYER_TO_COMPANY` 加映射 → 架构图放 `doc-templates/architectures/` |
| 调同步频率 | `scheduler.ts` |
| 客户要求收窄平台权限 | 账户页标记为「敏感权限客户」（`POST /accounts/restricted`）→ 收窄逻辑在 `restricted-accounts.ts`；改收窄范围要同步改 `RESTRICTED_POLICY_DOC` 与 `RESTRICTED_UNAVAILABLE` 提示 |

### 新增 payer 安全 Runbook

新增 payer 会创建高权限入口并向整个组织自动部署角色，必须按以下顺序执行。**禁止跳过验证后直接把组织加入 `consoleAdminPayers`。**

1. **核实身份与组织**：用独立 AWS Profile 查询 `sts get-caller-identity`、`organizations describe-organization`、`list-roots`、`list-accounts`，记录 management account、Organization ID、Root ID、成员数量和账户状态，确认没有连错组织。
2. **创建或核验管理账户 `role/tool`**：新建信任策略只允许 `arn:aws:iam::509399618054:user/mark`。当前平台模型依赖该角色管理 Organizations、StackSets、STS、配额、费用与账户能力，因此要求 `AdministratorAccess`；这是高权限入口，必须同时核验信任策略、permissions boundary 和实际 AssumeRole。
3. **启用 SERVICE_MANAGED 前置**：执行上文的 `enable-aws-service-access` 与 `activate-organizations-access`，并确认 `describe-organizations-access` 返回 `ENABLED`。
4. **先只登记 payer**：备份本地与 EC2 的 `config.json`，在两边 `payers[]` 加 `{ "name": "<payerName>", "roleArn": "arn:aws:iam::<managementAccountId>:role/tool" }`。此时不要加入 `consoleAdminPayers`；`config.json` 含密钥且被 gitignore，绝不能提交。
5. **在 EC2 权威数据环境部署双 StackSet**：脚本会读取 `data/db.json.restricted_accounts`，所以必须在生产 `web/` 目录执行，不能用空白或陈旧的本地 DB 替代：

   ```bash
   cd ~/AWSTool/web
   npx tsx scripts/setup-org-stacksets.ts support <payerName>
   npx tsx scripts/setup-org-stacksets.ts admin <payerName>
   npx tsx scripts/setup-org-stacksets.ts support <payerName> --dry-run
   npx tsx scripts/setup-org-stacksets.ts admin <payerName> --dry-run
   ```

6. **检查脚本结果**：任一组织异常会汇总为非零退出码；同时必须检查输出中的 `❌` 以及 `ok` / `susp` / `fail` 汇总，确保没有失败或异常挂起账户。
7. **回读 CloudFormation**：两个 StackSet 应分别为 `support-quota-role-orgwide` 与 `admin-console-role-orgwide`，状态 `ACTIVE`、`PermissionModel=SERVICE_MANAGED`、`AutoDeployment.Enabled=true`、`RetainStacksOnAccountRemoval=false`，最近操作 `SUCCEEDED` 且失败实例为 0。仅有 management account 的组织显示实例数 0 是正常现象。
8. **注意模板漂移**：默认模式遇到已存在 StackSet 时仍使用 `UsePreviousTemplate=true`，不会自动改写角色定义。只有明确审查过模板差异后，才可执行 `npx tsx scripts/setup-org-stacksets.ts admin <payerName> --refresh-template`；该模式强制指定单个 payer，会更新 StackSet 模板并对 Root OU 的已有实例执行 `UpdateStackInstances`。脚本会在刷新异常、operation 非 `SUCCEEDED` 或残留失败实例时返回非零，但仍须按第 6、7 步独立回读。
9. **通过后再开放 Admin UI**：本地与 EC2 的 `consoleAdminPayers` 唯一加入 `<payerName>`，`pm2 restart aws-toolbox`，然后刷新账户缓存。
10. **完整验收**：确认 payer 账户带 `_isPayer=true`、`_consoleDual=true`；分别实测 payer `role/tool`、成员 `support-quota` / `admin-console` 与必要的 OAAR 回退；再检查区域扫描、Billing Console、PM2 online 和 HTTPS 200。只有这些检查通过才算接入完成。

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
- 平台长期凭证只在服务端；具备 `root_access` 的用户可显式请求 1 小时 Admin 临时凭证，只有数据库当前角色为 admin 才可选择 2–12 小时。长时请求仅走成员账户 `admin-console` 直接一级跳；所有签发均实时鉴权、记录实际时长/到期时间且不落盘
- 密码 + TOTP MFA（window=2，150 秒容差），JWT 2 小时过期
- 登录限流 5 次/15 分钟；API 限流读写分离：GET 300 次/分钟（监控轮询 + 多标签页），写操作 100 次/分钟
- 未匹配的 `/api/*` 一律返回 404 JSON（不掉进 SPA fallback 返回 200 + index.html，避免鼓励扫描器探测）
- Helmet 安全头 + CORS 白名单（未列入的来源用 `callback(null, false)` 优雅拒绝，**绝不 throw** —— 抛错会被 Express 当 500，导致带 `crossorigin` 的静态资源请求失败、整站白屏）
- 安全告警（`security-alerts.ts`）：登录爆破、429/5xx 突增实时推飞书；已在生产验证触发。新 IP 登录与敏感操作推送已于 2026-09-15 移除（审计日志仍完整记录）

---

## 已知待办

### 其它

- ~~前端单 bundle 不分包~~ 已改为三包分割（vendor 1.36MB / charts 398KB / 业务 252KB）+ immutable 缓存，日常发版用户只需重下业务包（gzip 76KB）
- ~~EC2 上 Node v20~~ 已于 2026-09-06 升级到 v22.23.2（nodesource 源，`dnf install nodejs-2:22.23.2`），AWS SDK 2027 年 1 月的 Node ≥ 22 要求已满足；回退备份在 `~/node_modules-pre-node22.tar.gz` 与 `~/AWSTool/data/db-pre-node22-upgrade.json`，观察数日无异常后可删
- `doc-templates.ts` 的 `taiping` 有完整模板和架构图，但没有任何 payer / 账户映射指向它，只能靠手选或手动生成入口用到
- 7 个账户零账单 + CloudFormation `OptInRequired`，StackSet 与自愈都进不去，需人工先处理账户激活
- `config.consoleAdminPayers` 是静态白名单（生产核验快照 2026-08-27：44 个 payer 中已开放 43 个组织）。更合理的做法是直接用 `account_roles` 的真实探测结果决定 `_consoleDual`，等检测覆盖率上来后可以替换
- 早先建的 `support-quota` / `admin-console` 角色信任主体里仍有历史身份 `134103550877`，新建的已去掉；是否统一清理待定
- `account_roles` 覆盖率需要时间铺开（增量每轮 60 个）。想立刻建立基线可在账户页点一次「全量复检」
- MAP 打标状态机对 EventBridge Connection 的 ARN 格式不兼容（`Provided Arn is not in correct format`），每轮扫描固定失败 1 个。代码在中央工具账户 `382309211956` 的 Lambda 里，不在本仓库
- MAP 打标是每日定时扫描（01:20 UTC），新建资源最长要等 24 小时才被打标。真正的根治是 EventBridge 事件驱动实时打标 + 定时扫描兜底，改动较大待评估
- payer 账户资源是否计入 MAP 报销基数尚未与 AWS 侧确认（账单桶 / CUR 桶属运维基础设施而非迁移工作负载）
- **`listBedrockQuotas()` 对配额数量大的账户会静默丢数据**。单区域硬超时 15 秒（`BEDROCK_REGION_TIMEOUT_MS`），而大客户账户 Bedrock 配额可达 1000+ 条需翻 27 页，必然超时。超时区域虽会进 `errors` 并在页面顶部告警，但**已拉到的残缺数据仍照常渲染**，表现为部分模型 TPM/TPD 显示 `-`，极易被当成「没有该配额」。实测 `668602396329` us-east-1 即触发。交付表导出风险更大（截断会被写成 TPM=0）。待办：超时改为可配置/自适应，且超时区域的残缺行不应参与渲染与导出
- `Bedrock.tsx`、`Quotas.tsx`、`Cleanup.tsx` 各自维护一份区域表。前两者已对齐为 30 个，但仍是三份拷贝，AWS 开新区时要改多处；建议抽到 `client/src/constants/regions.ts` 做单一数据源

---

## 相关文档

- 部署与数据安全细则：`.kiro/steering/deployment.md`
- 编码规范：`.kiro/steering/coding-standards.md`
- 开发流程：`.kiro/steering/development-methodology.md`
- 项目结构地图（给 AI 用）：`.kiro/steering/project-context.md`
- AWS 文档：https://docs.aws.amazon.com/
