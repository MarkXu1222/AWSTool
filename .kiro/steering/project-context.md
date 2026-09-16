# Project Context — AWSTool

AWS 多账户管理平台。用于跨组织管理成员账户：配额提升、账单 PDF 导出、区域开通、资源清理、根用户凭证操作、MAP 标签合规，带 MFA 登录与操作审计。

> 维护须知：本文件是项目的"结构地图 + 改哪里"指南。新增或调整功能后，请同步更新对应章节。
> 部署与数据安全规则见 `deployment.md`；编码规范见 `coding-standards.md`；开发流程见 `development-methodology.md`（本文件不重复这些内容）。

---

## 一、仓库里有两套应用（重要，别改错地方）

| 应用 | 位置 | 包名 / 版本 | 状态 | 说明 |
|------|------|-------------|------|------|
| **Web 版（生产）** | `web/` | `aws-toolbox-web` / `APP_VERSION 0.32.0` | ✅ **在维护** | 部署在 EC2（https://markxu.co）。日常改动几乎都在这里。 |
| 桌面版（旧） | 根 `src/` + `electron/` | `aws-toolbox` / `0.1.0` | ⚠️ 旧版/基本冻结 | 早期 Electron macOS 版，`main: dist/main/index.js`。除非专门维护桌面版，否则**不要动**。 |

**结论：接到"平台/网站"相关的需求，一律在 `web/` 下操作。**

---

## 二、技术栈（Web 版）

- 后端：Node.js + Express 4 + TypeScript，用 `tsx` **直接运行 .ts，不编译**（改 `.ts` `pm2 restart` 即生效）
- 前端：React 18 + Vite 6 + Ant Design 5，TypeScript
- 前端路由：**无 react-router**，`MainLayout` 用 `useState(currentPage)` 切换页面
- 存储：`data/db.json`（自研 JSON 文件存储，非数据库）
- 认证：JWT（2h 过期）+ 强制 TOTP MFA（otplib），bcrypt 存密码
- AWS：`@aws-sdk/*` v3；跨账户 STS AssumeRole
- 文档/导出：`puppeteer-core`（提额 PDF、账单 PDF）
- 通知：飞书 webhook
- 进程：EC2 上用 PM2（进程名 `aws-toolbox`）

---

## 三、目录结构（Web 版）

```
web/
├── server/                     # 后端（Express，tsx 直跑）
│   ├── index.ts                # 入口：中间件、CORS、限速、路由、静态服务、scheduler 与持久化 job runners
│   ├── auth.ts                 # authRouter（登录/MFA/用户CRUD）+ authMiddleware + 页面权限模型
│   ├── audit.ts                # auditMiddleware：记录所有已认证 API 调用
│   ├── audit-presentation.ts   # 审计日志展示增强 + CSV 导出
│   ├── aws-service.ts          # ★AWS 核心：AssumeRole 链、配额、资源、根凭证、控制台URL
│   ├── db.ts                   # ★数据层：data/db.json 读写、字段加密、每日备份
│   ├── scheduler.ts            # 后台定时同步（账户/配额/区域/角色自愈）
│   ├── doc-generator.ts        # 生成配额提升申请 PDF（puppeteer）
│   ├── doc-templates.ts        # ★公司模板 + 账户→公司 / payer→公司 映射 + 区域显示名
│   ├── notify.ts               # 飞书通知（配额变动/达成）
│   ├── tag-compliance.ts       # MAP 标签合规（Step Functions 扫描 + S3 报告）
│   ├── tag-onboarding.ts       # MAP 全自动接入持久化 runner
│   ├── account-roles.ts        # ★账户角色自愈：探测成员账户角色 → 缺失则触发 StackSet 补齐 → 超限告警
│   ├── billing-export-jobs.ts  # 账单导出持久化 job、全局队列、永久历史、重复下载与重启恢复
│   ├── billing-exporter.ts     # 严格只读抓取 AWS 官方账单 PDF + 可取消 zip 打包
│   ├── root-email-jobs.ts      # Root 恢复邮件/自动改密队列、单账户安全重试、永久加密凭证、重复CSV下载（单浏览器并发）
│   ├── root-email-browser.ts   # 独立 Chrome：兼容原页面与 AWS 独立安全验证 iframe 的两阶段OCR + reset填充；提交前最多3次尝试
│   ├── root-email-manual.ts    # 九张OCR用尽后原会话手工接管；一次性图片ID、权限复验、10分钟超时
│   ├── root-email-reconcile.ts # 提交超时后保留会话，短时查邮箱并验证表单后继续验证码
│   ├── root-email-core.ts      # 原子任务存储、提交边界/重试血缘、自动改密状态机和旧任务兼容，见 web/ROOT_EMAIL.md
│   ├── root-password-secrets.ts # 24位CSPRNG、AES-256-GCM任务绑定密文、CSV生成
│   ├── mail-api.ts             # 自建邮箱 HMAC 只读客户端，共用节流队列
│   ├── root-mail-poll.ts       # 按任务游标查询、精确匹配恢复邮件
│   ├── root-mail-links.ts      # AWS RootUser 链接解析；任务不存正文或重置 URL
│   ├── case-doc-submitter.ts   # 一键提交提额文档到 Support Case（浏览器自动化）
│   ├── security-alerts.ts      # 安全告警：登录爆破/新IP/敏感操作/429、5xx 突增 → 飞书
│   ├── ops-monitor.ts          # 运维监控指标采集（24h 环形缓冲）+ /api/ops 守卫
│   ├── bedrock-tools.ts        # Bedrock：Profile 管理/创建/FTU/数据共享/IAM（走 Admin 凭证）
│   ├── bedrock-delivery.ts     # Bedrock 客户交付 xlsx（v1 三列 / v2 李浩版五列含 TPM/TPD）
│   └── routes/
│       ├── aws.ts              # ★awsRouter：主业务端点（50+），含权限守卫
│       ├── regions.ts          # regionsRouter：区域 opt-in 状态/扫描/开通（enable* 需 requireAdmin）
│       └── bedrock.ts          # bedrockRouter：挂 /api/bedrock，tags 强校验无默认值
│
├── client/                     # 前端（React + Vite）
│   ├── index.html
│   ├── vite.config.ts
│   ├── public/                 # 静态资源（image.png 等）
│   └── src/
│       ├── main.tsx            # React 挂载入口
│       ├── App.tsx             # 认证门禁：Login →（未绑MFA）SetupMFA → MainLayout
│       ├── api.ts              # ★统一 HTTP 客户端：封装所有后端接口，token 存 localStorage
│       ├── version.ts          # ★APP_VERSION，单一版本源，每次部署递增
│       ├── components/
│       │   ├── MainLayout.tsx  # ★侧栏导航 + 页面切换（PAGE_META 对齐 ALL_PAGE_KEYS；rootreset/bulkquota 使用独立权限）
│       │   ├── RootCredentialsPanel.tsx  # 根用户凭证敏感操作面板
│       │   ├── RootEmailPanel.tsx # 单账户手工恢复邮件任务与自动改密任务状态；密码仅在批量页导出
│       │   ├── DangerConfirm.tsx         # 危险操作二次确认
│       │   ├── EmptyState.tsx / ErrorBoundary.tsx
│       ├── pages/              # 每个业务页面一个文件（见下表）
│       │   ├── BulkRootReset.tsx # /rootreset：全局搜索/单独重置、Excel导入跨payer、单批20自动改密、失败账户MFA单独重试、永久CSV下载
│       ├── styles/global.css
│       └── utils/              # cache.ts（前端缓存）、color.ts、export.ts
│
├── package.json                # Web 版依赖与脚本
├── Dockerfile / docker-compose.yml
├── setup-nginx.sh              # Nginx + HTTPS 配置脚本
└── README.md

config.json                     # ★真实配置（gitignore，含密钥）
config.example.json             # 配置示例（可提交）
data/db.json                    # ★运行时数据库（gitignore）
data/backups/                   # 每日自动备份（保留 7 天）
doc-templates/architectures/    # 公司架构图（静态资源，可提交）
```

---

## 四、页面 ↔ 后端 对应关系

前端页面切换在 `MainLayout.tsx`；页面 key 必须三处一致：前端 `navItems` / `PAGE_META`（MainLayout.tsx）与后端 `ALL_PAGE_KEYS`（auth.ts）。

| 页面 key | 页面文件 | 主要后端前缀 | 说明 |
|----------|----------|--------------|------|
| `dashboard` | `pages/Dashboard.tsx` | `/api/aws/dashboard/summary` | 运营 KPI、账户结构/组织分布、权限/连接/配额/离场待处理事项；仅复用平台数据，不调用 CE |
| `accounts` | `pages/Accounts.tsx` | `/api/aws/accounts*`、`/api/aws/root-credentials*`、`/api/aws/temp-credentials` | 账户列表、账户详情、根用户凭证操作 |
| `quotas` | `pages/Quotas.tsx` | `/api/aws/quotas/*`、`/api/aws/bedrock/quotas/*` | 配额查询、一键提额、同步、生成申请文档；Tab 顺序：当前配额 / Bedrock 配额 / 当前账户请求 / 在线查询 / 提升记录 |
| `bulkquota` | `pages/BulkQuota.tsx` | `/api/aws/bulk-quota/*` | 批量提额（按 payer 组织 × 多区域）。**不在 `ALL_PAGE_KEYS` 里**，可见性只由独立权限 `bulk_quota_access` 决定 |
| `regions` | `pages/Regions.tsx` | `/api/regions/*` | 区域 opt-in 状态与开通 |
| `billing` | `pages/Billing.tsx` | `/api/aws/billing/*` | AWS 官方账单 PDF 批量导出、历史任务、进度、取消与 ZIP 下载 |
| `cleanup` | `pages/Cleanup.tsx` | `/api/aws/resources/*` | 最近 7 天 EC2/EBS/S3/Lambda/IAM 用户扫描；IAM 非敏感详情与手动勾选安全删除，S3 只读 |
| `tagcompliance` | `pages/TagCompliance.tsx` | `/api/aws/tag-compliance/*` | MAP 标签合规扫描与报告 |
| `audit` | `pages/AuditLog.tsx` | `/api/aws/audit*` | 审计日志查询与导出 |
| `ops` | `pages/OpsMonitor.tsx` | `/api/ops/overview` | 运维健康、资源趋势、请求延迟与后台任务；admin 恒有，其他角色需在页面权限中显式授权，旧用户默认不授予 |
| `settings` | `pages/Settings.tsx` | `/api/auth/*` | 修改密码、MFA、用户管理 |
| —（登录流程） | `pages/Login.tsx`、`pages/SetupMFA.tsx` | `/api/auth/login`、`/api/auth/mfa/*` | 登录、强制绑定 MFA |

---

## 五、后端接口清单（前缀 `/api`）

认证路由 `/api/auth`（authRouter，无需登录即可访问的登录相关；其余需 token）：
- `POST /login`、`POST /mfa/setup`、`POST /mfa/confirm`、`GET /me`、`POST /change-password`
- 用户管理（admin）：`GET/POST /users`、`PUT/DELETE /users/:id`、`POST /users/:id/reset-password`

业务路由 `/api/aws`（awsRouter，经 `authMiddleware`+`auditMiddleware`）：
- 账户：`GET /accounts`、`POST /accounts/refresh`、`GET /accounts/:id/detail`、`GET /connection`
- 账户角色自愈：`GET /accounts/roles-status`、`POST /accounts/roles-check`（均 requireStrictAdmin）。注意这两条必须定义在 `/accounts/:id/detail` 之前，否则被通配吃掉
- 仪表盘：`GET /dashboard/summary`
- 账单 PDF job：`POST/GET /billing/export-jobs`、`GET /billing/export-jobs/:jobId`、`POST /billing/export-jobs/:jobId/cancel`、`GET /billing/export-jobs/:jobId/download`（全部 `requireBillingAccess`，单 job 再校验 owner/admin）
- 配额：`GET /quotas/:accountId/:serviceCode`、`POST /quotas/increase`(admin)、`GET /quotas/requests`、`GET /quotas/stats`、`GET /quotas/companies`、`GET /quotas/company/:accountId`、`POST /quotas/generate-doc`、`POST /quotas/sync`、`POST /quotas/sync-account/:accountId`、`GET /quotas/sync-status`、`GET /quotas/sync-stream`(SSE)
- Bedrock 配额：`GET /bedrock/quotas/:accountId?regions=a,b`（TPM/RPM/TPD，多区域并发；路径特意不放在 `/quotas/` 下，避免被 `/quotas/:accountId/:serviceCode` 通配吃掉）
- 根凭证：`GET /root-credentials/:accountId`、`GET /temp-credentials/:accountId?durationHours=1`（rootAccess；仅 admin 可请求 2–12 小时）、`POST /root-credentials/:accountId/delete-mfa`(rootAccess)、`.../recover-password`(rootAccess)、`.../delete-access-key`(rootAccess)
- 资源清理：`GET /resources/:accountId/:region` 返回最近 7 天 EC2/EBS/S3/Lambda/IAM 用户（Lambda 按 LastModified，IAM/S3 为全局，单服务失败放入 warnings）；`POST /resources/:accountId/delete` 删除前逐项重新读取并复验时间，EC2/EBS/Lambda 保持 admin/partadmin 兼容，IAM 用户仅数据库实时 strict admin 且服务端级联清理全部依赖，S3 永不自动删除
- 审计：`GET /audit`、`GET /audit/export`（均 requireAuditAccess）
- 控制台：`GET /console-url/:accountId`
- MAP 标签：读取端点包括 `GET /tag-compliance/status|config|executions|report|precheck`、`GET /tag-compliance/enabled-regions?payer=...`；所有写端点（onboarding/retry、config、scan、notify、re-indexes、provision）均使用 `requireStrictAdmin`。`POST /scan` 必须携带中央运行模式确认；re-indexes 动态读取 payer + ACTIVE 成员区域，聚合区仅允许 `opt-in-not-required` 默认区域。默认本地区域由 AutoDeployment StackSet 覆盖根 OU，opt-in 区域由独立 `AutoDeployment=false` StackSet 按账户交集精确下发；旧宽泛目标以 `RetainStacks=true` 无损解绑

区域路由 `/api/regions`（regionsRouter）：
- `GET /status`、`POST /scan`、`POST /scan/:accountId`、`POST /enable`、`POST /enable-batch`

其它：`GET /api/scheduler/status`

**权限守卫（routes/aws.ts）**：

| 守卫 | 实际放行范围 | 用途 |
|------|--------------|------|
| `requireAdmin` | **admin + partadmin**（只拦 viewer） | 提额、普通资源删除、删 access key。名字容易误解，但保留既有 partadmin 行为 |
| `requireStrictAdmin` | 仅 admin | MAP 标签全部写操作、账户权限检测（`roles-status` / `roles-check`）、IAM 用户删除。从数据库实时读取并核对用户 ID，不信任 JWT 中可能过期的角色 |
| `requireOpsAccess` | admin 或 `allowed_pages` 显式包含 `ops` | 运维监控；从数据库实时读取，legacy non-admin 默认拒绝 |
| `requireRootAccess` | root_access 或 admin | 根用户敏感操作 |
| `requireAuditAccess` | 审计页可见者 | 审计日志查询/导出 |
| `requireBillingAccess` | billing 页可见者 | 账单 PDF job；状态/取消/下载另校验 owner/admin |
| `requireBulkQuotaAccess` | bulk_quota_access 或 admin | 批量提额 |

注意 `authMiddleware` 是直接把 JWT payload 挂到 `req.user`，所以 `req.user.role` 是签发时的角色。需要严格判断的守卫（`requireStrictAdmin` / `requireOpsAccess` / `requireRootAccess` / `requireAuditAccess` / `requireBillingAccess`）都改为从 `db.getUser()` 实时读，避免降权用户在 token 过期前继续按旧角色通过。

---

## 六、AWS 跨账户访问模型（aws-service.ts）

平台基础凭证 `BASE_CREDENTIALS` = `config.json.credentials`（当前为 `arn:aws:iam::509399618054:user/mark`）。

`assumeToAccount(accountId)` 的假设顺序：
1. **一级跳 `support-quota`**：`BASE_CREDENTIALS` 直接 AssumeRole 成员账户的 `role/support-quota`（首选，最快）。失败会记入内存 `supportRoleUnavailable`，本进程内不再重试（重启清空）。
2. **payer 自身**：目标就是某 payer → 直接用该 payer 的 `role/tool` admin 凭证。
3. **二级跳 `OrganizationAccountAccessRole`**：先用 payer 的 `role/tool` 拿 admin，再 AssumeRole 成员账户的 `OrganizationAccountAccessRole`（`config.childRoleName`）。

涉及的角色：
| 角色 | 位置 | 用途 | 信任 |
|------|------|------|------|
| `tool` | 各 payer 管理账户 | 平台管理 payer 的入口 | `509399618054:user/mark`（历史上还有 `134103550877`，观察期兜底） |
| `support-quota` | 各成员账户 | 平台一级跳，读配额/成本/只读 | `134103550877:root` + `509399618054:user/mark` |
| `OrganizationAccountAccessRole` | 各成员账户 | 二级跳兜底 | 各自 payer root |
| `cur-collector` | 各 payer | CUR 账单采集接入 | `509399618054:user/winston` |

`support-quota` 通过组织级 `SERVICE_MANAGED` StackSet `support-quota-role-orgwide` 下发到根 OU（自动覆盖未来新成员账户）；管理账户本身不在 SERVICE_MANAGED 覆盖内，靠 `role/tool` 兜底。

根用户特权操作（删 MFA、恢复密码等）走 `assumeRoot`（`sts:AssumeRoot` 集中式根访问）。

---

## 七、数据与配置

**`config.json`（gitignore，含密钥，勿提交）**：
```
credentials { accessKeyId, secretAccessKey }   # 平台基础身份
region
payers[] { name, roleArn }                     # 各 payer 的 role/tool ARN
childRoleName        # OrganizationAccountAccessRole
adminRoleName        # admin-console
supportRoleName      # support-quota
adminRoleExcludedAccounts[] { accountId, payer, reason } # 逐账户仅排除 Admin，保留 support-quota
web { port, adminPassword, jwtSecret, encryptionKey, encryptionKeyPrevious[], feishuWebhook }
# encryptionKey 为当前写入密钥；encryptionKeyPrevious 最多 8 个，仅用于解密历史 gcm1/gcm2；启动时在线数据会认证后原子重加密到 current key
```

**`data/db.json`（gitignore，运行时数据库）**，顶层键：
- `users`：账号（bcrypt 密码、加密的 mfa_secret、role、allowed_pages、root_access、root_reset_access）
- `quota_requests`：配额提升记录
- `audit_log`：审计日志（上限 5000 条滚动）
- `region_data`：各账户区域 opt-in 状态
- `accounts_cache` + `accounts_cache_time`：账户列表缓存（调度器每 30min 刷新）
- `account_roles`：各账户的 support-quota / admin-console 可用性与自愈状态（`ok` / `partial` / `pending` / `unreachable` + 尝试次数）
- `tag_onboarding_jobs`：MAP 全自动接入持久化任务
- `billing_export_jobs`：账单 PDF job 的队列、进度、结果、取消/中断与下载元数据

旧数据库可能仍残留 `dashboard_cache`；0.21.2 起代码不再读写，部署时不直接修改 `data/db.json`。

账单 ZIP 位于 `data/exports/billing/<jobId>/`（gitignore）并在服务器长期保留，只能通过鉴权端点下载；历史记录通过分页接口查询。禁止提交，且需单独监控磁盘与规划备份。

启动和长时间运行期间每天首次 DB 读取时：先校验两个源 JSON，在 Root 快照中排除 `setting_password`/failed/unknown 及旧策略已披露的密文，再将 `data/db.json` 与同目录 `root-email-jobs.json` 分别原子备份到 `data/backups/db-YYYY-MM-DD.json`、`data/backups/root-email-jobs-YYYY-MM-DD.json`（两类各保留 7 天）。已有 Root 备份而主文件缺失时失败关闭。自动备份不含 `config.json`；匹配 keyring 必须独立受控备份。

**权限模型（auth.ts）**：角色 `admin` / `partadmin` / `viewer`；`allowed_pages` 控制可见页面（admin=全部）；`authMiddleware` 强制未绑 MFA 用户不能访问业务接口。`ops` 属于敏感页面：admin 恒有，其他角色只有 `allowed_pages` 显式包含 `ops` 才能显示菜单并访问 `/api/ops`；旧用户缺少 `allowed_pages` 时只继承原有常规页面，不自动获得运维监控。

**独立功能权限**（admin 恒有，其他角色必须显式授予，且都不受 `allowed_pages` 影响）：
- `root_access` → 账户页「根用户」敏感操作（Admin 临时凭证 / 删 Root MFA / 恢复根密码）、Admin 控制台登录；非 admin 即使有此权限也只能签发 1 小时凭证，2–12 小时仅限数据库当前角色为 admin
- `bulk_quota_access` → 「批量提额」页；未授予时该菜单完全不可见，后端 `requireBulkQuotaAccess` 也会拒绝

- `root_reset_access` → 批量设置 Root 新密码：none/view/operate，非 admin 缺省 none；非 admin（包括 view/operate）只看本人创建的批次，operate 可创建和停止本人任务；admin 可查看/管理全部。CSV 下载依赖已完成登录 MFA 的会话但不再额外 step-up；新密码以 AES-256-GCM 永久保存在本地任务文件和备份，owner 可重复下载本人批次，Admin 可重复下载全部批次。创建批次、确认未提交恢复请求的失败账户单独重试与手工 fallback 均要求 step-up TOTP；创建批次还需精确输入账户数；不再要求输入 payer 名称，支持全局搜索和 Excel 导入跨 payer 账户。单独重试创建新的单账户批次并保留旧 job 双向血缘，`interrupted`、已提交和结果未知状态禁止重试。独立于 root_access。守卫与解析见 `root-reset-permissions.ts`。

新增独立权限的改动点：`auth.ts`（resolve 函数 + me + create/update）、`db.ts`（getAllUsers 暴露字段）、`routes/aws.ts`（中间件）、`MainLayout.tsx`（导航 gating）、`Settings.tsx`（授予勾选 + 列表列）、`api.ts`（createUser/updateUser 参数）。

---

## 八、部署（详见 deployment.md）

- EC2：`54.255.131.45`（https://markxu.co），SSH `ssh -i /Users/mark/mark-sg-key.pem ec2-user@54.255.131.45`
- 仓库 `~/AWSTool`，PM2 进程 `aws-toolbox`，运行方式 `npx tsx server/index.ts`（**不编译**，改 `.ts` 直接生效）
- 标准流程：
  ```
  本地: git add <具体代码文件> → commit → push
  EC2 : cd ~/AWSTool && git pull -q
        cd web && npm install(仅依赖变化时) && npx vite build --config client/vite.config.ts
        pm2 restart aws-toolbox
  ```
- **数据安全红线**：绝不提交 `data/`、`config.json`、密钥；绝不 `git add -A`/`git add .`；EC2 上绝不 `git stash`/`git reset --hard`/`git checkout -- data/`。
- Nginx + HTTPS：`web/setup-nginx.sh`；zip 下载流式超时 10 分钟。
- 账单导出依赖可执行 Chrome、Xvfb `:99`、`zip`、CJK 字体及可写的 `data/exports/`。关键变量：`BILLING_EXPORT_MAX_CONCURRENCY`（默认 3）、`BILLING_EXPORT_MAX_QUEUED_JOBS`（默认 10）、`BILLING_EXPORT_OUTPUT_DIR`。ZIP 不自动过期，必须监控磁盘容量。

---

## 九、维护指南 — 常见改动"改哪里"

### 新增一个业务接口
1. `web/server/routes/aws.ts`（或 `regions.ts`）加 `awsRouter.<method>('/path', [守卫,] handler)`。
2. 需要 AWS 调用时，在 `aws-service.ts` 加函数并复用 `assumeToAccount()`。
3. 前端 `web/client/src/api.ts` 的 `api` 对象加对应方法。
4. 在页面组件里调用。写操作按需加 `requireAdmin`/`requireRootAccess`。

### 新增一个页面
1. `web/client/src/pages/Xxx.tsx` 新建页面。
2. `MainLayout.tsx`：`navItems`、`PAGE_META`、`renderPage()` 的 switch 各加一项（同一个 key）。
3. `auth.ts` 的 `ALL_PAGE_KEYS` 加同名 key（否则权限系统不认）。
4. 需要移动端入口就再加到 `mobileNavItems`。

### 新增/接入一个 payer 或成员账户能力
加 payer 必须做完这三步，少一步该组织的账户在平台里就只能看到名字：
1. 在该 payer 管理账户创建 `role/tool`，信任 `509399618054:user/mark`。
2. `config.json.payers[]` 增加 `{name, roleArn: arn:...:role/tool}`（本地 + EC2 各一份，勿提交），并把组织名加入 `consoleAdminPayers`；重启后 `POST /api/aws/accounts/refresh`。
3. **先开两个组织级开关**（缺任一都会让 StackSet 创建失败，报 `You must enable organizations access to operate a service managed stack set`。这两个是不同的东西，容易只做前一个）：
   ```
   aws organizations enable-aws-service-access \
     --service-principal member.org.stacksets.cloudformation.amazonaws.com --profile <payer>
   aws cloudformation activate-organizations-access --profile <payer> --region us-east-1
   aws cloudformation describe-organizations-access --profile <payer> --region us-east-1   # 应 ENABLED
   ```
4. **跑两次 StackSet 下发脚本**，否则该组织的新账户拿不到任何角色：
   ```
   cd web
   npx tsx scripts/setup-org-stacksets.ts support <payerName>
   npx tsx scripts/setup-org-stacksets.ts admin   <payerName>
   npx tsx scripts/setup-org-stacksets.ts admin   <payerName> --dry-run   # 只看状态
   ```
   脚本幂等，会把 StackSet 建成「整 Root OU + AutoDeployment」，此后该组织新加入的账户由 CloudFormation 自动建角色。
5. EC2 `pm2 restart aws-toolbox`（config 是模块加载时读的，不重启不生效），等约 10 秒的账户同步，再确认新组织的账户已进入缓存。

成员账户角色快照（2026-08-27）：生产配置共 44 个 payer，`consoleAdminPayers` 已验收并开放 43 个组织；该数量仅表示配置/前端开放口径，不等同于每个 StackSet 实例都成功，迁移或新增 payer 后仍须回读操作状态与失败实例。已验收组织的 `support-quota-role-orgwide` 与 `admin-console-role-orgwide` 均采用 SERVICE_MANAGED + AutoDeployment=true，部署目标为各组织 Root OU。

`admin-console` 为什么必须有：INVITED（邀请加入）的账户不自带 `OrganizationAccountAccessRole`，payer 二级跳进不去，只有直接信任平台身份的 `admin-console` 能拿到 admin 临时凭证。其模板 `MaxSessionDuration=43200`；平台默认签发 1 小时，仅数据库当前角色为 admin 的用户可选 2–12 小时。超过 1 小时的请求只走平台长期身份到成员 `admin-console` 的直接一级跳；payer 管理账户和 OAAR 二级链仍限 1 小时。

个别客户要求永久移除 Admin 时，使用独立的 `config.adminRoleExcludedAccounts`，不要复用 `restricted_accounts`（后者还会改变 `support-quota`）。排除项按 `{ accountId, payer, reason }` 配置：Admin StackSet 使用 `DIFFERENCE` 跳过，自愈将 `support=true + admin=false + admin_excluded=true` 视为健康，Admin 临时凭证/控制台入口被拒绝；support StackSet、现有 support 权限和独立 Root 特权操作不变。已有 Admin 角色必须再用对应 StackSet 的 `DeleteStackInstances`（`RetainStacks=false`）删除；恢复时移除配置并重新部署 Admin StackSet。配置变更后必须重启 PM2。

补不上的账户：账户未完成激活时 CloudFormation 返回 `OptInRequired`(403)，StackSet 无论如何都进不去，`account-roles.ts` 会重试 3 次后标记 `unreachable` 并飞书告警，需人工先处理账户本身（这类账户通常零账单）。

### 修改账单批量导出
- `billing-exporter.ts` 只负责严格 `support` 会话抓取、单任务浏览器隔离、AbortSignal、worker drain 与 Chrome/zip 有界进程树关闭；最终 deadline 仍无法确认退出时必须抛出 `BillingExportProcessCleanupError`。
- `billing-export-jobs.ts` 负责参数规范化、单 job 全局队列、永久历史、分页查询、取消、重复鉴权下载和重启中断语义；completed/expired/orphan 目录不得由 runner 自动删除，进程清理异常时会暂停 runner，避免残留进程与下一 job 重叠。
- `client/src/utils/account-import.ts` / `account-import.worker.ts` / `account-import-config.ts` 负责浏览器本地 `.xlsx` 账户识别：不上传文件；主线程校验 ZIP 目录，Worker 流式复验实际解压量并可在 20 秒超时后终止；限制 5 MiB 文件、12 MiB 单项、24 MiB 总解压量、50,000 单元格，只输出独立 12 位 ID。`Billing.tsx` 再与平台账户列表求交集，后端白名单和 200 任务上限仍是最终边界。
- 新任务必须用稳定 `createdByUserId` 授权；仅迁移前无 ID 的历史任务可回退用户名。每 owner 最多一个活跃任务，全局 queued 默认最多 10；历史列表默认 `scope=mine`，admin 只有显式 `scope=all` 才查看全局，前端自动恢复固定使用 mine。
- API 改动同步 `routes/aws.ts`、`audit.ts`、`audit-presentation.ts`、`client/src/api.ts` 与 `pages/Billing.tsx`。
- 状态轮询不记审计；submit/cancel/download 显式审计。任何改动都必须保持 `access='support'`，不得恢复 `auto` 的 admin 回退。

### 新增一个公司（提额文档模板）
- `web/server/doc-templates.ts`：`COMPANY_PROFILES` 加公司资料；`ACCOUNT_TO_COMPANY` / `PAYER_TO_COMPANY` 加映射；架构图放 `doc-templates/architectures/`。

### 调整定时同步频率
- `web/server/scheduler.ts`：账户 30min、配额 4h、区域 24h、账户角色自愈（增量跟在账户同步之后，全量复检 24h）。

### 发布新版本
- 改 `web/client/src/version.ts` 的 `APP_VERSION`（小改递增 patch，大改递增 minor）。左下角展示，也用于确认部署是否生效。

---

## 十、关键决策记录

- 生产以 **Web 版**为准，桌面版冻结。
- 后端 **tsx 直跑不编译**，部署快、改 `.ts` 即生效。
- 存储用 **JSON 文件 + 内存缓存 + 每日备份**，而非数据库（体量可控、零运维）。
- 平台基础身份从 `134103550877` 迁移到 `509399618054:user/mark`（最小权限、精确主体信任），134 观察期兜底暂留。
- 成员账户角色用**组织级 SERVICE_MANAGED StackSet** 统一下发，自动覆盖未来新账户，避免逐账户手工创建。
- 账单 PDF 使用**持久化后台 job + 单 job 全局队列**；服务器控制并发，严格只读 support 会话，可取消，历史和 ZIP 在服务器长期保留并分页鉴权下载，重启中的活动任务明确标为 interrupted。
- 强制 **MFA + 审计日志 + 限速**。平台长期凭证只在服务端；仅 `root_access` 显式操作可返回短期 Admin 临时凭证。

## References
- AWS Documentation: https://docs.aws.amazon.com/
- 部署与数据安全：`.kiro/steering/deployment.md`
- 编码规范：`.kiro/steering/coding-standards.md`
- 开发流程：`.kiro/steering/development-methodology.md`
