# AWS Toolbox

企业级 AWS 多账户（多 Organizations）管理平台。带强制 MFA 登录、页面级权限与全量操作审计。

**线上**：https://markxu.co（EC2 Singapore，PM2 进程 `aws-toolbox`）
**当前版本**：`0.41.0`（见 `web/client/src/version.ts`，左下角展示）

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
- **认证**：JWT（8h 过期）+ 强制 TOTP MFA（otplib），密码 bcrypt，MFA secret AES-256-CBC 加密落盘
- **AWS**：`@aws-sdk/*` v3，跨账户 STS AssumeRole
- **文档/导出**：`puppeteer-core` + 系统 Chrome（提额 PDF、账单 PDF）
- **通知**：飞书 webhook
- **部署**：EC2 + Nginx + Let's Encrypt + PM2

---

## 功能模块

左侧导航共 14 项 = **11 个可分配页面**（`PAGE_META` / 后端 `ALL_PAGE_KEYS`，可通过「页面权限」勾选授予）+ **3 个独立权限页**（`bulkquota` / `rootreset` / `poccash`，刻意不在 `ALL_PAGE_KEYS` 里，勾选不了，只能由独立权限开关决定）。

可分配页面的 key 必须三处一致：`navItems`、`PAGE_META`（`MainLayout.tsx`）与后端 `ALL_PAGE_KEYS`（`auth.ts`）。页面 key 同时就是 URL 路径（`/accounts` 等，dashboard 归 `/`），由 `navigate()`/`popstate` 同步；合法路径集合 `VALID_PAGE_KEYS` 由 `PAGE_META` + 3 个独立权限页 key 推导。

敏感度分三档：普通可分配页 → `ops` / `bedrock`（在 `ALL_PAGE_KEYS` 里但 non-admin 必须显式勾选，旧用户不自动继承）→ `poccash`（**连勾选都无法授予，仅 admin**）。

| 页面 key | 页面文件 | 主要后端前缀 | 说明 |
|----------|----------|--------------|------|
| `dashboard` | `Dashboard.tsx` | `/api/aws/dashboard/summary` | 无 CE 运营 KPI、账户结构与组织分布、可跳转的待处理事项 |
| `accounts` | `Accounts.tsx` | `/api/aws/accounts*`、`/api/aws/root-credentials*`、`/api/aws/temp-credentials`、`/api/aws/temp-admin*` | 账户列表与详情、免登录进控制台、根用户凭证操作 |
| `quotas` | `Quotas.tsx` | `/api/aws/quotas/*`、`/api/aws/bedrock/quotas/*` | 配额查询、一键提额、流式同步、生成提额 PDF、一键提交文档到 Support Case。Tab：当前配额 / Bedrock 配额 / 当前账户请求 / 在线查询 / 提升记录 |
| `bulkquota` | `BulkQuota.tsx` | `/api/aws/bulk-quota/*` | 批量提额（按 payer 组织 × 多区域）。**不在 `ALL_PAGE_KEYS` 里**，可见性只由独立权限 `bulk_quota_access` 决定 |
| `rootreset` | `BulkRootReset.tsx` | `/api/aws/root-email/*` | 批量设置 Root 新密码。**不在 `ALL_PAGE_KEYS` 里**，由独立权限 `root_reset_access`（`none`/`view`/`operate`）决定可见与可操作。详见「批量自动设置 Root 新密码」与 [`web/ROOT_EMAIL.md`](web/ROOT_EMAIL.md) |
| `bedrock` | `Bedrock.tsx` | `/api/bedrock/*` | Bedrock 工具（从桌面版 Bedrock Profile Manager 迁移）：Inference Profile 管理/批量创建/模型测试/模型列表/FTU 开通/Fable 5 数据共享/IAM 用户/交付表格。**敏感页面**：全部走 Admin 凭证，non-admin 需显式授权；创建/打 Tag 的 Tag 必须每次手动输入（前后端均无默认值），`map-migrated` 值严格校验 `mig` + 10 位大写字母数字、写后从 AWS 回查（0.53.0） |
| `poccash` | `PocCash.tsx` | `/api/poc-cash/*` | POC Cash：创建 AWS Partner Central 商机、阶段检查、POC 资金申请与进展台账。**admin 专属**，连「页面权限」勾选都无法授予（创建的是提交给 AWS 的真实商机）。四 Tab：创建商机 / 商机阶段检查 / POC 申请 / POC 进展 |
| `regions` | `Regions.tsx` | `/api/regions/*` | opt-in 区域开通状态扫描与单个/批量开通 |
| `billing` | `Billing.tsx` | `/api/aws/billing/*` | AWS 官方账单 PDF 批量导出、历史任务、取消与 ZIP 下载 |
| `cleanup` | `Cleanup.tsx`、`AccountReclaimPanel.tsx` | `/api/aws/resources/*`、`/api/aws/account-reclaim/*` | 「资源清理」保留原扫描/删除；「账户回收」以独立权限组合邮箱删转发/改密与既有 Root 操作，最多 20 个账户、逐步进度及失败原因。两个 Tab 按各自权限显示 |
| `tagcompliance` | `TagCompliance.tsx` | `/api/aws/tag-compliance/*` | MAP 标签合规扫描与报告 |
| `audit` | `AuditLog.tsx` | `/api/aws/audit*` | 审计日志查询与 CSV 导出 |
| `ops` | `OpsMonitor.tsx` | `/api/ops/overview` | 运维监控（健康评分/资源趋势/请求延迟/端点排行/后台任务）。admin 恒有；其他角色需在页面权限中显式授权，旧用户默认不授予；后端实时校验数据库权限且不写审计日志（30s 轮询）。指标存进程内存，重启清零 |
| `settings` | `Settings.tsx` | `/api/auth/*` | 改密码、MFA、用户管理 |
| —（登录流程） | `Login.tsx`、`SetupMFA.tsx` | `/api/auth/login`、`/api/auth/mfa/*` | 登录、强制绑定 MFA |

移动端底栏放 4 个高频入口（`MOBILE_PRIMARY_KEYS`：概览 / 账户 / 配额 / Bedrock，底栏用短名），其余全部收进「更多」抽屉。抽屉按 `navItems` 全名展示，**所有有权限的页面在手机上都能进** —— 早先底栏是写死的 5 项，Bedrock/区域/清理/MAP 标签/审计/运维/批量提额在移动端完全无法访问。若高频页因权限缺失不足 4 个，会按 `navItems` 顺序自动补位，避免底栏空位。

---

## 目录结构

```
AWS/
├── CLAUDE.md                       # AI 指令入口（导入 .kiro/steering/*）
├── config.json                     # ★真实配置（gitignore，含密钥）
├── config.example.json             # 配置示例（可提交）
├── .kiro/steering/                 # 开发规范与流程（deployment / coding-standards / …）
├── docs/                           # 领域文档：poc-cash-guide、partner-central-api、bedrock-quota-api-and-permissions
├── data/                           # ★全部 gitignore
│   ├── db.json                     # ★运行时数据库
│   ├── root-email-jobs.json        # ★永久 Root 凭证库（AES-256-GCM 密文）
│   ├── backups/                    # db 与 root-email-jobs 每日备份（各保留 7 天）
│   ├── exports/billing/<jobId>/    # 账单 ZIP，长期保留，只经鉴权端点下载
│   └── poc-cash/                   # POC 台账 CSV 快照（首次导出时创建）
├── doc-templates/architectures/    # 各公司架构图（静态资源，可提交）
├── scripts/                        # Python 运维脚本（与 web/scripts 的 TS 脚本分开）
│   ├── cleanup.py                  # 账户资源清空（.kiro/skills/aws-account-cleanup 依赖）
│   ├── setup_partner_central_role.py # ★APN 账户建 partner-central-tool role（dry-run/--execute/--verify）
│   ├── partner_central.py / poc_*.py / create_*_opportunity.py  # POC Cash 相关
│   └── calculator_api.py / find-p-quota.py / …
├── tools/                          # 独立小工具：console-launcher（网页下载版在 web/client/public/downloads/）、ocr-lab
├── electron/ + src/                # 桌面版（冻结）
└── web/
    ├── server/                     # 后端（Express，tsx 直跑）
    │   # —— 基础设施 ——
    │   ├── index.ts                # 入口：中间件、CORS 白名单、限速（GET/写分离）、挂载路由、API 兜底 404、静态服务（immutable 缓存）、启动 scheduler
    │   ├── auth.ts                 # authRouter（登录/MFA/用户CRUD）+ authMiddleware + 页面权限模型（DEFAULT_PAGE_KEYS / ALL_PAGE_KEYS）
    │   ├── step-up-mfa.ts          # 敏感操作二次 TOTP 校验（Root 批次创建、单独重试等）
    │   ├── db.ts                   # ★数据层：db.json 读写、字段加密、每日备份
    │   ├── audit.ts                # auditMiddleware：记录写操作 + 带账户 ID 的读请求（页面自动拉取的列表不记，见「审计」）
    │   ├── audit-presentation.ts   # 审计日志展示增强 + CSV 导出
    │   ├── scheduler.ts            # 后台定时同步（账户 30min / 配额 4h / 区域 24h / 账户角色自愈）
    │   ├── ops-monitor.ts          # 运维监控：请求/系统指标进程内采集（24h 环形缓冲）+ 健康评分 + /api/ops 页面权限守卫
    │   ├── security-alerts.ts      # 安全告警：登录爆破/429、5xx 突增 → 飞书
    │   ├── notify.ts               # 飞书通知（账户角色缺失告警）
    │   # —— AWS 接入 ——
    │   ├── aws-service.ts          # ★AWS 核心：AssumeRole 链、成本、配额、资源、根凭证、控制台 URL
    │   ├── account-roles.ts        # ★账户角色自愈：探测 → 缺失则触发 StackSet 补齐 → 超限告警
    │   ├── account-lifecycle.ts    # 离场账户追踪：快照 diff（防 payer 同步失败误判）+ 重新加入 + 历史补录
    │   ├── restricted-accounts.ts  # ★敏感权限客户：账户级权限收窄 + ExternalId（StackSet 下发必须排除）
    │   # —— 提额文档 ——
    │   ├── doc-generator.ts        # 生成提额申请 PDF（puppeteer）
    │   ├── doc-templates.ts        # ★公司模板 + 账户→公司 / payer→公司 映射 + 区域显示名（仅 yanhuang 系）
    │   ├── doc-industries.ts       # ★行业模板：非 yanhuang payer 用「自家公司名 + 行业」生成文档
    │   ├── case-doc-submitter.ts   # ★一键提交提额文档到 Support Case（生成 PDF → 联邦登录 → Reply → 传附件 → Submit）
    │   # —— 账单导出 ——
    │   ├── billing-export-jobs.ts  # 账单导出持久化 job、全局队列、永久历史、重复下载与重启恢复
    │   ├── billing-exporter.ts     # 严格只读抓取 AWS 官方账单 PDF + 可取消 zip 打包
    │   # —— Bedrock ——
    │   ├── bedrock-tools.ts        # Bedrock 工具：Profile 管理/批量创建/FTU/数据共享/IAM（全部走 Admin 凭证，50min 缓存）；创建/打 Tag 写后回查
    │   ├── bedrock-delivery.ts     # Bedrock 客户交付 xlsx（v1 三列 / v2 李浩版五列含 TPM/TPD；按变体白名单筛选模型 + 固定排序；校验 map-migrated 格式与唯一）
    │   ├── temp-admin.ts           # ★admin-console 按需临时开通（专用 StackSet、到期回收、信任截止；见「临时开通 Admin」）
    │   ├── map-tag-rules.ts        # ★map-migrated 标签规则（纯函数）：值格式、Tag 数组、ARN 归属、写后回查；前端 utils/mapTag.ts 逐字镜像
    │   # —— MAP 标签 ——
    │   ├── tag-compliance.ts       # MAP 标签合规（编排中央工具账户的 Step Functions + S3 报告；payer 自身 auto-tagger-role 单独创建）
    │   ├── tag-onboarding.ts       # MAP 全自动接入持久化 runner（资源、索引、StackSet、S3 配置与校验）
    │   # —— 批量 Root 改密（详见 web/ROOT_EMAIL.md）——
    │   ├── root-email-jobs.ts      # 队列、单账户安全重试、永久加密凭证、重复 CSV 下载、重启恢复
    │   ├── root-email-core.ts      # ★原子任务存储、提交边界/重试血缘、自动改密状态机、旧任务兼容
    │   ├── root-email-browser.ts   # 独立 Chrome：兼容原页面与 AWS 独立安全验证 iframe 的两阶段 OCR + reset 填充
    │   ├── root-email-execution-slot.ts # 单活动执行槽；人工会话挂起不阻塞队列，回复后优先恢复
    │   ├── root-email-manual.ts    # 九张 OCR 用尽后原会话手工接管；一次性图片 ID、权限复验、10 分钟超时
    │   ├── root-email-reconcile.ts # 提交超时后保留会话，短时查邮箱并验证表单后继续验证码
    │   ├── root-password-secrets.ts # 24 位 CSPRNG、AES-256-GCM 任务绑定密文、CSV 生成
    │   ├── root-reset-permissions.ts # root_reset_access 守卫与 none/view/operate 解析
    │   ├── root-mail-poll.ts       # 按任务游标查询、精确匹配恢复邮件
    │   ├── root-mail-links.ts      # AWS RootUser 链接解析；任务不存正文或重置 URL
    │   ├── mail-api.ts             # 自建邮箱 HMAC 只读客户端，共用节流队列
    │   ├── mail-api-config.ts      # 邮箱 API 端点与密钥配置
    │   # —— 账户回收（复用现有邮箱与 Root 能力）——
    │   ├── account-reclaim.ts      # 五步编排、结果归并、重试、查看密码、通知补偿
    │   ├── account-reclaim-core.ts # 类型、状态机、密码生成与脱敏错误说明
    │   ├── account-reclaim-permissions.ts # account_reclaim_access 实时守卫与所有权
    │   ├── mailbox-admin-api.ts    # 独立 SSM 凭据、签名 POST、节流及错误映射
    │   # —— POC Cash ——
    │   ├── poc-cash.ts             # Partner Central 商机：创建 / 关联 Solution / 提交 / 阶段检查
    │   ├── poc-cash-funding.ts     # POC 资金申请、进展查询、CSV 台账
    │   ├── pricing-calculator.ts   # 按台账 ID 播种生成计算器组合（服务池 + 收敛 + 签名），保存/读回 calculator.aws
    │   ├── calculator-services.ts  # 19 种服务的 calculator.aws JSON 块、引擎一致成本公式、英文配置摘要
    │   ├── calculator-rates.ts     # ap-southeast-5 单价快照（calculator.aws Update estimate 实测，非 Price List）
    │   ├── poc-calculator.ts       # 计算器编排：台账预留查重 → 保存 → 读回校验 → 标记就绪
    │   └── routes/
    │       ├── aws.ts              # ★awsRouter：主业务端点（50+），含权限守卫
    │       ├── regions.ts          # regionsRouter：区域 opt-in 状态/扫描/开通
    │       ├── bedrock.ts          # bedrockRouter：挂 /api/bedrock；tags 按 map-tag-rules 强校验无默认值；交付从 AWS 重读标签
    │       └── poc-cash.ts         # pocCashRouter：挂 /api/poc-cash；全部 requireStrictAdmin
    ├── client/
    │   ├── vite.config.ts          # dev 端口 5174；manualChunks 三包分割（vendor/charts/业务）
    │   └── src/
    │       ├── App.tsx             # 认证门禁：Login →（未绑 MFA）SetupMFA → MainLayout
    │       ├── api.ts              # ★统一 HTTP 客户端，token 存 localStorage
    │       ├── version.ts          # ★APP_VERSION，单一版本源，每次部署递增
    │       ├── components/         # MainLayout（导航+URL 同步+keep-alive）/ RootCredentialsPanel / RootEmailPanel
    │       │                       # / RootManualCaptchaModal / DangerConfirm / EmptyState / ErrorBoundary
    │       ├── pages/              # 每个业务页面一个文件（16 个，见「功能模块」表）
    │       └── utils/              # cache(内存TTL) / color / console-launch / export
    │                               # / account-import{,.worker,-config}（浏览器本地 xlsx 解析，不上传）
    │                               # / root-account-selection / root-email-status / root-reset-link
    │                               # / mapTag（map-migrated 前端校验，与 server/map-tag-rules.ts 逐字一致）
    ├── tests/                      # 37 个回归测试文件（bedrock、MAP 策略、poc-cash、计算器标定/台账、root-email 系列等）
    ├── scripts/
    │   ├── verify-calculator-render.ts # POC 计算器联网验收：Chrome 点 Update estimate 逐项核对引擎重算（--plan-only 离线）
    │   ├── setup-org-stacksets.ts  # ★加新 payer 时下发 support-quota StackSet（幂等，支持 --dry-run / --refresh-template；admin 模式已移除）
    │   ├── remove-orgwide-admin-console.ts # 一次性：删除组织级 admin-console StackSet 并列出残留（默认 dry-run，EC2 执行）
    │   ├── setup-payer-tagger.ts   # payer 账户内单独创建 auto-tagger-role（StackSet 覆盖不到）
    │   ├── fix-payer-tagger-policy.ts / audit-org-roles.mts / check-billing-iam-access.mts
    │   ├── audit-bedrock-map-tags.ts # Bedrock map-migrated 存量排查（只读；--plan-only 不调 AWS）
    │   └── print-bills.mts / ce-untagged-audit.ts / probe-*.ts / scan-p-quota.ts   # 一次性排查脚本
    ├── ROOT_EMAIL.md               # ★批量 Root 改密的完整运行与恢复语义
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
| `admin-console` | 仅**临时开通期内**的成员账户（0.54.0 起不再常驻） | 没有 OAAR 的账户（通常是 INVITED）取 **admin** 凭证 | `509399618054:user/mark`，且信任策略带 `aws:CurrentTime` 截止 |
| `OrganizationAccountAccessRole` | 各成员账户 | 二级跳兜底 | 各自 payer root |
| `cur-collector` | 各 payer | CUR 账单采集接入 | `509399618054:user/winston` |

成员账户的 `support-quota` 通过组织级 `SERVICE_MANAGED` StackSet 下发到根 OU，`AutoDeployment=true` 自动覆盖未来新增账户（含 INVITED），账户退出组织时 `RetainStacksOnAccountRemoval=false`。**`admin-console` 不再组织级下发**（0.54.0）：新账户一律不常驻管理员角色，需要时按账户临时开通，见「关键实现 → 临时开通 Admin」。**管理账户本身不会获得 SERVICE_MANAGED StackSet 实例**，所以仅含管理账户的新组织显示 0 个实例是正常现象，管理账户由 `role/tool` 承担入口。

**配置现状（生产核验快照 2026-08-27）**：平台已配置 44 个 payer，`consoleAdminPayers` 包含 43 个组织。该白名单只控制前端是否显示「只读 / 管理员」双入口，**不能证明角色已成功部署**。新 payer 必须运行 `scripts/setup-org-stacksets.ts support` 并回读 StackSet 的状态、自动部署设置与失败实例；否则未来成员账户可能没有可用角色。

`yottahub-cma-1`（管理账户 `346133363520`，Organization `o-go486nwkzx`，Root OU `r-3u07`）已完成接入验收：组织共 152 个账户（151 个成员账户）；`support-quota-role-orgwide` 与 `admin-console-role-orgwide`（后者已于 0.54.0 起逐组织清理）均为 `ACTIVE`、`SERVICE_MANAGED`、`AutoDeployment=true`，各 151 个 StackInstance 全部 `SUCCEEDED`；平台全量角色复检结果为 `ok=151`、`pending=0`、`unreachable=0`，并已加入 `consoleAdminPayers`。

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
2. **临时开通期内**：一级跳 `admin-console`（时长不超过开通剩余时间）
3. 二级跳 `OrganizationAccountAccessRole`（用 `forceFresh` 取新鲜 payer 凭证，保证接近完整 1 小时）
4. 都不通 → 返回 `code: 'TEMP_ADMIN_REQUIRED'`，前端引导 admin 去临时开通

**没有有效开通时绝不尝试 `admin-console`**，即使账户里残留着它（常驻 admin-console 属于待清理的异常）。**INVITED（邀请加入）的账户没有 `OrganizationAccountAccessRole`**，payer 二级跳进不去，只能临时开通。

Admin 临时凭证时长默认 1 小时。数据库当前角色为 `admin` 的平台用户在**临时开通期内**可选择更长时长，上限为开通剩余时间（≤3 小时，`admin-console` 的 `MaxSessionDuration=10800`），剩余不足 15 分钟拒绝签发；其他情况经 payer → `OrganizationAccountAccessRole` 二级链签发，受 AWS role chaining 限制最多 1 小时且不会静默回退。完整 AK/SK/SessionToken 仅保留在当前 React 内存中，不写入 `sessionStorage`，刷新或切换账户后需重新生成。

`config.consoleAdminPayers` 决定账户列表的 `_consoleDual` 标记，前端据此给出「只读 / 管理员」双选项（0.54.0 起不再代表已部署 admin-console；临时开通入口不依赖它）。

`config.adminRoleExcludedAccounts` 是逐账户的 **admin-only 永久排除**：每项必须包含 12 位 `accountId` 和已配置的 `payer`（`reason` 用于运维记录）。排除后不允许临时开通 Admin，后端拒绝 Admin 临时凭证和 Admin 控制台，前端隐藏 Admin 入口；`support-quota` StackSet、只读/Support 权限以及独立的 Root 特权操作均不受影响。配置变更后必须重启服务。

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
| 账户回收 | `/account-reclaim` 下的 catalog、batches 列表/创建/详情、jobs 重试/凭证/验证码、批次停止未开始账户；全部走实时 `createAccountReclaimGuard`，创建/重试另需 TOTP；完整契约见 `.kiro/specs/account-reclaim/design.md` §5.6 |
| 离场账户 | `GET /accounts/departed`、`POST /accounts/departed/backfill`（后者 `requireStrictAdmin`） |
| 临时 Admin（0.54.0） | `GET /temp-admin/grants`（未结束的开通记录，只含元数据）、`POST /temp-admin`（`requireStrictAdmin` + TOTP step-up；body `{accountId, hours: 1\|2\|3, mfaCode}`）、`DELETE /temp-admin/:accountId`（`requireStrictAdmin`，提前关闭）；均单独写审计 |
| 敏感权限客户账户 | `GET /accounts/restricted`（不返回 ExternalId 明文）、`POST /accounts/restricted`、`DELETE /accounts/restricted/:accountId`、`GET /accounts/restricted/:accountId/external-id`（后三个均 `requireStrictAdmin` 且单独写审计） |
| 仪表盘 | `GET /dashboard/summary` |
| 账单 | PDF job：`POST/GET /billing/export-jobs`、`GET /billing/export-jobs/:jobId`、`POST .../:jobId/cancel`、`GET .../:jobId/download`（均 `requireBillingAccess`，单任务再校验 owner/admin） |
| 配额 | `GET /quotas/:accountId/:serviceCode`、`POST /quotas/increase`(admin)、`GET /quotas/requests`、`GET /quotas/stats`、`GET /quotas/companies`、`GET /quotas/company/:accountId`、`POST /quotas/generate-doc`、`POST /quotas/case-doc-submit`(admin)、`GET /quotas/case-doc-submit/:jobId`（轮询不写审计；**必须注册在 `/quotas/:accountId/:serviceCode` 通配之前**）、`POST /quotas/sync`、`POST /quotas/sync-account/:accountId`、`GET /quotas/sync-status`、`GET /quotas/sync-stream`(SSE) |
| Bedrock 配额 | `GET /bedrock/quotas/:accountId?regions=a,b` |
| Bedrock 工具（独立前缀 `/api/bedrock`） | `GET /profiles/:accountId?regions=`（**最多 12 个区域**）、`GET /models/:accountId?region=`、`GET /foundation-models/:accountId?region=`、`POST /profiles/create`(admin,**tags 按 map-tag-rules 强校验，返回逐项回查状态**)、`POST /profiles/delete`(admin)、`POST /profiles/tag`(admin,同上；ARN 须属于该账户与区域，≤100)、`POST /profiles/untag`(admin)、`POST /invoke`(admin)、`POST /ftu`(admin)、`GET /data-retention/:accountId?regions=`（**最多 20 个区域**）、`POST /data-retention/enable`(strict admin)、`GET /iam-users/:accountId`(admin)、`POST /iam-users/create`(strict admin)、`POST /delivery`(admin，**`accountId` 必填**；从 AWS 重读标签，校验 map-migrated 格式且唯一)、`POST /delivery-v2`(admin，李浩版五列含 TPM/TPD；同样从 AWS 重读标签) |
| 批量提额 | `GET /bulk-quota/payers`、`GET /bulk-quota/accounts/:payerAccountId`、`POST /bulk-quota/submit`、`GET /bulk-quota/job/:jobId`（全部 `requireBulkQuotaAccess`） |
| 根凭证 | `GET /root-credentials/:accountId`、`GET /temp-credentials/:accountId?durationHours=1`（rootAccess；仅 admin 可请求 2–12 小时）、`POST /root-credentials/:accountId/delete-mfa`(rootAccess)、`.../recover-password`(rootAccess)、`.../delete-access-key`(rootAccess)、`.../delete-key`(admin) |
| 批量 Root 改密 | 批次：`GET/POST /root-email/batches`、`GET /root-email/batches/:id`、`POST .../:id/credentials-csv`、`POST .../:id/cancel`；单账户：`GET/POST /root-email/accounts/:accountId/jobs`、`POST /root-email/jobs/:id/cancel`、`.../retry`、`.../reset-link`、`.../manual-reset-link`、`.../manual-captcha`、`.../manual-captcha/answer`；其它：`GET /root-email/availability`、`GET /root-email/catalog`。全部经 `root_reset_access` 守卫（`root-reset-permissions.ts`），创建批次与单独重试另需 step-up TOTP（`step-up-mfa.ts`） |
| 资源清理 | `GET /resources/:accountId/:region`（最近 7 天；Lambda 按最近修改；IAM/S3 为全局；失败服务通过 warnings 返回）、`POST /resources/:accountId/delete`（服务端重新读取时间并复验；EC2/EBS/Lambda 兼容 admin/partadmin，IAM 用户仅实时 strict admin 且级联清理依赖；S3 不可删除） |
| 审计 | `GET /audit`、`GET /audit/export`（均 `requireAuditAccess`）；`POST /audit/page-view`（任何已登录用户，`page` 只接受已知页面 key，记一条 `PAGE_VIEW`「进入页面」）。**记录规则（看一次记一次，没看不记）**：写操作（POST/PUT/PATCH/DELETE）全记；GET 只在路径段或查询参数含 12 位账户 ID 时记（每次都记，不去重），外加 `/audit/export`；页面打开时自动拉取的列表/状态接口（`accounts`、`roles-status`、`restricted`、`apn-accounts`、`departed`、`dashboard/summary`、`quotas/stats` 等）和任务轮询不记，由前端 `MainLayout` 每次进入页面上报一次 `PAGE_VIEW` 代替；敏感读取由业务代码显式写审计。规则在 `audit.ts` 的 `shouldAuditRead()`，`tests/audit-middleware.test.ts` 锁定 |
| 控制台 | `GET /console-url/:accountId` |
| MAP 标签 | `GET /tag-compliance/status\|config\|executions\|report\|precheck\|notify-emails\|re-indexes/status`；`PUT /config`、`POST /scan`、`POST /notify-emails`、`DELETE /notify-emails`、`POST /re-indexes`、`POST /provision`（**写操作均 `requireStrictAdmin`**，partadmin 被拒）；`GET /tag-compliance/enabled-regions` 也挂 `requireStrictAdmin`；全自动接入：`POST /tag-compliance/onboarding`、`GET /tag-compliance/onboarding?payer=...`、`GET /tag-compliance/onboarding/:jobId`、`POST /tag-compliance/onboarding/:jobId/retry` |

**Bedrock 路径特意不放在 `/quotas/` 下**，否则会被 `/quotas/:accountId/:serviceCode` 通配吃掉。

### `/api/regions`（regionsRouter）

`GET /status`、`POST /scan`、`POST /scan/:accountId`、`POST /enable`、`POST /enable-batch`

### `/api/poc-cash`（pocCashRouter）

**整个 router 在挂载处 `pocCashRouter.use(requireStrictAdmin)`**，逐条端点无需再加守卫；该守卫实时查库，不信任 token 里的 role。

| 分组 | 端点 |
|------|------|
| 元数据 | `GET /meta`（partner 列表/用例/行业/凭证状态/`fundingEnabled` 与发票主体名）、`GET /solutions`（实时 Active 列表 + 后端算好的 `defaultSolutionId`，0.56.0）、`GET /amounts`、`POST /preview-title` |
| 商机 | `GET /opportunities`、`GET /opportunities/:id`、`POST /opportunities`（创建 → 关联 Solution → 提交）、`GET/POST /opportunities/:id/stage`（阶段检查与推进） |
| POC 资金 | `GET /funding/meta`、`GET /funding/account/:id`（按账户带出项目桶）、`POST /funding/preview`、`POST /funding`、`POST /funding/:id/submit`、`GET /funding`（进展台账） |
| 台账导出 | `POST /funding/export`（19 列 CSV）、`GET /funding/exports` |

`/funding*` 与商机端点一样按 `partnerKey`（query 或 body）分流，缺省 webby，非法值 400（0.55.0）。

### 其它

`GET /api/scheduler/status`

### `/api/ops`（opsRouter，admin 或显式页面授权，不写审计）

`GET /overview?range=1h|6h|24h` — 运维监控聚合：健康评分（阈值扣分 + 原因）、系统资源（CPU/内存/磁盘/事件循环延迟）、请求统计（p50/p95/p99、错误率、延迟直方图、端点排行 Top 50）、资源趋势（每分钟采样）、scheduler 与后台任务状态、db.json 大小与备份时间。指标存进程内存（24h 环形缓冲），重启清零。

**权限守卫**（`routes/aws.ts`）：

| 守卫 | 定义处 | 实际放行范围 | 用途 |
|------|--------|--------------|------|
| `requireAdmin` | `routes/aws.ts` | **admin + partadmin**（只拦 viewer） | 提额、EC2/EBS/Lambda 资源删除、删 access key、Bedrock 多数写操作 |
| `requireStrictAdmin` | `routes/aws.ts` | 仅 admin（实时查库） | **MAP 标签全部写端点**、账户权限检测（`roles-status`/`roles-check`）、离场账户补录、敏感权限客户标记与 ExternalId 查看、IAM 用户删除 |
| `requireStrictAdmin` | `routes/poc-cash.ts` | 仅 admin（实时查库） | 同名但独立定义，**整个 `/api/poc-cash` 在 router 层 `use()`** |
| `requireOpsAccess` | `ops-monitor.ts` | admin 或 `allowed_pages` 显式包含 `ops` | 运维监控；实时读取数据库，旧用户默认拒绝 |
| `requireRootAccess` | `routes/aws.ts` | root_access 或 admin | 根用户敏感操作 |
| `requireAuditAccess` | `routes/aws.ts` | 审计页可见者 | 审计日志 |
| `requireBillingAccess` | `routes/aws.ts` | billing 页可见者 | 账单 PDF job；任务状态、取消和下载另校验创建者或 admin |
| `requireBulkQuotaAccess` | `routes/aws.ts` | bulk_quota_access 或 admin | 批量提额 |
| `root_reset_access` 守卫 | `root-reset-permissions.ts` | `view` / `operate`（admin 恒有） | 批量 Root 改密；创建批次与单独重试另需 step-up TOTP |

⚠️ **MAP 标签的写端点用的是 `requireStrictAdmin` 而非 `requireAdmin`** —— partadmin 进不去。这一条曾在文档里写反过，改动前以 `routes/aws.ts` 实际代码为准。`GET /tag-compliance/enabled-regions` 虽是读取端点，同样挂了 `requireStrictAdmin`。

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

### 四个独立权限开关

admin 恒有，其他角色必须显式授予，且**都不受 `allowed_pages` 影响**：

- `root_access` → 账户页「根用户」敏感操作（Admin 临时凭证 / 删除 Root MFA / 恢复根密码 / 删除 Root Access Key）以及 Admin 控制台登录；`GET /root-credentials/:accountId` 的状态读取当前不经过该守卫
- `bulk_quota_access` → 「批量提额」页；未授予时菜单完全不可见，后端 `requireBulkQuotaAccess` 也会拒绝
- `account_reclaim_access` → `/cleanup` 的「账户回收」Tab，值为 `none` / `operate`，不授予资源清理或其他 Root 权限；仅持此权限也可直链进入。非 admin 仅能操作本人批次，admin 全局可见；受限账户只允许当前为 admin 的创建者回收
- `root_reset_access` → 「批量设置 Root 密码」页，值为 `none` / `view` / `operate`；非 admin 只看本人批次，admin 查看/管理全部。创建批次仍要求 step-up TOTP；CSV 下载不再额外 MFA，Owner 可重复下载本人永久归档，Admin 可重复下载全部永久归档

`poccash` 页**不是开关**：它既不在 `ALL_PAGE_KEYS` 里（勾不到），也没有对应的独立权限字段，`isPageAllowed()` 直接判 `role === 'admin'`，后端 router 层 `requireStrictAdmin` 实时查库。这是全站最严的一档，理由是它创建的是提交给 AWS 的真实商机。

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

`payers[].name` 格式为 `yanhuang编号-公司名`，用于提额文档与通知匹配公司。非 yanhuang payer 的名字会作为提额文档「公司名」的默认值（弹窗里可改）。

### `data/db.json`（gitignore，运行时数据库）

顶层键：

- `users` — 账号（bcrypt 密码、加密的 mfa_secret、role、allowed_pages、root_access、bulk_quota_access）
- `quota_requests` — 配额提升记录
- `audit_log` — 审计日志，**上限 5000 条滚动**
- `region_data` — 各账户区域 opt-in 状态
- `accounts_cache` + `accounts_cache_time` — 账户列表缓存（调度器每 30min 刷新）
- `temp_admin_grants` — 临时 Admin 开通记录（0.54.0，按需创建）：状态 `provisioning/active/revoking/revoked/failed`、开通人、时长、到期与信任截止时间、回收尝试次数；终态记录保留最近 500 条
- `account_roles` — 各账户 `support-quota` 可用性、是否存在常驻 `admin-console` 与自愈状态（`ok` / `partial` / `pending` / `unreachable` + 尝试次数）
- `tag_onboarding_jobs` — MAP 全自动接入任务、阶段产物、重试与恢复状态
- `billing_export_jobs` — 账单导出队列、进度、结果、取消/中断状态与下载元数据
- `restricted_accounts` — 敏感权限客户账户（加密的 `external_id_enc`、state、last_error、可选 `support_policy_backup` 原策略备份）。**同时是 `setup-org-stacksets.ts` 的 StackSet 排除名单来源**
- `departed_accounts` — 已移出组织的账户记录（含 `rejoined_at` 轨迹）
- `poc_calculator_ledger` — POC 定价计算器台账：每条 POC 申请一条（台账 ID 即种子与 `ClientToken`），存总额与服务签名供查重，回填 `benappl-` 申请 ID；失败记录保留并继续参与查重（0.52.0）。可选字段 `partnerKey` 记录所属主体（0.55.0；旧条目缺省即 webby），查重不按主体过滤

这些键**按需创建**：本地开发库通常只有 `users` / `quota_requests` / `audit_log` / `accounts_cache` / `region_data` 几个，缺少 `account_roles`、`billing_export_jobs`、`restricted_accounts` 等属正常现象。**判断 schema 一律以 `db.ts` 代码为准，不要拿本地 `db.json` 当权威** —— 本地库的账户数也远少于生产。

永久 Root 凭证库 `data/root-email-jobs.json` 是**独立文件，不是 `db.json` 的键**，备份与恢复也分开做。

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
| 成员账户 | `admin` | 临时开通期内一级跳 `admin-console`（会话 ≤ min(1h, 剩余)），session name 为 `console-admin-<accountId>`；否则 payer `role/tool` → `OrganizationAccountAccessRole`；都不通返回 409 `TEMP_ADMIN_REQUIRED` |
| 成员账户 | `auto` | 按兼容回退链选择可用角色，供尚未完成专用角色部署的旧账户使用 |

payer 只读会话的有效权限是 `role/tool` identity policy 与 `ReadOnlyAccess` session policy 的**交集**；session policy 只能收窄，不能增加权限。`admin` 控制台入口必须通过 `root_access` 实时门禁，并记录 `CONSOLE_ADMIN_LOGIN` 审计动作。排查实际会话类型时以 CloudTrail 的 `userIdentity.sessionContext.sessionIssuer`、session name 和请求错误为准，不要只看前端按钮文案。

### 独立会话打开控制台（0.49.0 起对所有用户开放）

同一浏览器只能持有一份 AWS 控制台会话。本地助手 `AWSConsoleLauncher.app` 注册 `awsconsole://`，收到调用后按账户 ID 用独立 `--user-data-dir` 启动 Chrome / Chromium / Edge，多个账户可同时保持登录。仅 macOS。

- 前端：`client/src/utils/console-launch.tsx`。账户管理页「独立会话」开关对所有角色可见；账户页「控制台」和配额页 Case 列都会按该开关打开。这只是浏览器的打开方式，能否拿到登录链接仍由后端 `getConsoleUrl` 校验，不扩大任何权限。
- 安装引导：网页无法探测本机是否注册了 scheme，因此「已安装」由用户点「我已安装」确认，存本浏览器 localStorage（`aws_console_launcher_installed`）。首次开启开关、或开关已开但未确认安装时点「控制台」，会弹出引导并**自动下载** `/downloads/aws-console-launcher-install.sh`，提示在终端运行 `bash ~/Downloads/aws-console-launcher-install.sh`。打开后的提示条有「用普通标签打开」「重新安装助手」两个退路。
- 下载脚本是 `web/client/public/downloads/aws-console-launcher-install.sh`（由 Vite 原样拷入 `dist/client`，`express.static` 提供，无需登录，不含任何密钥），它**逐字内嵌** `tools/console-launcher/launch.sh` 和 `launcher.applescript`。改源文件必须同步下载版，`tests/console-launcher-bundle.test.ts` 会校验一致性。
- `launch.sh` 只接受 12 位账户 ID 和 AWS 官方登录/控制台域名，其它网页无法借 scheme 打开任意站点。日志 `~/Library/Logs/aws-console-launcher.log`；卸载 `rm -rf ~/Applications/AWSConsoleLauncher.app`。

### 提额文档自动生成（PDF）

HTML 模板 + Puppeteer 渲染。公司背景库在 `doc-templates.ts`（12 家公司，从历史 SOW 总结），架构图在 `doc-templates/architectures/`。

**两种模式（按 payer 区分）**：

- **yanhuang 系 payer**（`^yan-?huang`，含 `yan-huang21`）→ 专属公司模板。公司解析顺序：账户缓存的 `_payer` → `PAYER_TO_COMPANY` → `ACCOUNT_TO_COMPANY`；识别不出时前端弹出公司挑选，选过的按 payer 记在 localStorage（`quotaDocCompanyMemo`），下次预选但仍需确认。
- **其它所有 payer**（GDEX、Freightly、SK1、海底捞……）→ **自家公司名 + 手选行业类型**（`server/doc-industries.ts`）。生成文档 / 一键提交 Case 前弹「确认文档公司与行业」：公司名默认 payer 名、可改成完整法定名称；行业从 `INDUSTRY_TEMPLATES` 选（物流、电商、游戏、金融科技、AI、SaaS、视频、通用）。按 payer 记在 localStorage（`quotaDocIdentityMemo`），下次预填仍需确认。**行业文案只以 `{C}`（公司名）为主语，不得出现任何 yanhuang 客户名**；架构图**复用 `doc-templates/architectures/` 里之前的图**（已逐张确认图中无公司名），按行业挑最接近的：物流→taosource、电商→malatrading、游戏→osstable、金融科技→buminiaga、AI→zyronix、SaaS/视频/通用→taiping；行业文案的 Technical Architecture 段与所用图一致。图片缺失时回退 taiping.png，不自绘 —— `tests/doc-industries.test.ts` 锁定这些规则。

判定入口是 `GET /api/aws/quotas/doc-context/:accountId`（返回 `payer` / `isYanhuang` / 识别到的公司）；行业列表 `GET /api/aws/quotas/industries`。`generate-doc` 与 `case-doc-submit` 都接受 `companyName + industryKey`，两者同时给出时优先于 `companyKey` / 账户映射；`case-doc-submit` 在入队前就校验，避免后台 job 跑到一半才报错。手动「生成申请文档」弹窗顶部可切换两种模式，选中账户属于非 yanhuang payer 时默认行业模式并预填 payer 名。

新增行业：在 `INDUSTRY_TEMPLATES` 加一项（`resourceComponents` 权重之和必须为 1，文案用 `{C}` 代替公司名），无需改前端。

`companyFromPayer` 的后缀兜底做的是「公司部分完全相等」比较，不能用 `endsWith` —— 单字符后缀会命中短名 key（`webby-2` → `malatrading`），静默生成挂着别家公司资料的文档。

动态生成：申请值自动拆解成资源组件表（合计=申请值）；配额类型自动识别 AWS 官方名称（vCPU/EIP/Lightsail/Mac/WorkSpaces 等）；预测值约申请值的 1.5 倍。

文档结构（两种模式相同）：标题 + 概要信息表（公司 / 行业 / 账户 / 区域 / 配额 / 申请值 / 当前环境）→ Project Summary → Workload Description（迁移背景、核心业务、技术架构、运维要求）→ Initial Resource Need（资源拆解）→ **Justification**（按配额类别给出申请量依据：vCPU 的多 AZ 冗余与滚动发布余量、Mac 主机 24 小时最短占用、EIP 的 NAT / 白名单用途等）→ **Capacity Plan**（当前配额 → 上线 → 第 1 月 → 第 2 月，第 2 月 = Projected）→ Quota Request Details → Architecture Overview → **Operations, Security & Cost Governance** → Contact。

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
- **批量提额**：按 payer 组织 × 多区域批量提交，传配额名 + 目标值（预设带 `quotaCode` 时一并传，后端只认代码），否则 QuotaCode 后端按名称解析；已达标账户自动跳过；job 模式（submit → jobId → 轮询）
- **配额预设 `QUOTA_PRESETS`**（0.48.1 起在 `client/src/constants/quota-presets.ts`，`Quotas.tsx` 转出；快速提额 / 批量提额 / 手动生成文档三处共用）：EC2 各 vCPU 族、EIP、Mac 专用主机、Lightsail、WorkSpaces、Fargate、**EBS gp3 存储容量（`ebs` / `L-7A658B76`，单位 TiB，0.44.4 起）**、Route 53 域名、Global Accelerator。EBS 各卷类型配额名同构（`Storage for … (gp2|gp3|io1|io2|st1|sc1) volumes, in TiB`），预设必须写完整官方名，靠精确匹配命中，不能写缩略名
- **Mac 专用主机绑定配额代码（0.48.1）**：

  | 显示名 | 实例类型 | AWS 官方配额名 | 配额代码 |
  |---|---|---|---|
  | Mac M1 专用主机 | `mac2.metal` | Running Dedicated mac2 Hosts | `L-5D8DADF5` |
  | Mac M2 专用主机 | `mac2-m2.metal` | Running Dedicated mac2-m2 Hosts | `L-B90B5B66` |
  | Mac M4 专用主机 | `mac-m4.metal` | Running Dedicated mac-m4 Hosts | `L-2CBA8B92` |

  预设带 `quotaCode` 时，快速提额**只按代码**匹配、批量提额后端用 `GetServiceQuota` 按代码确认，**不做名称模糊匹配**；查不到就明确报错，不会替换成其他型号。⚠️ 同服务下有 mac2-m2pro / mac2-m1ultra / mac-m4pro / mac-m4max / mac-m3ultra / mac1 等同构名称，旧预设写的 `mac.m2` / `mac.m4` 根本不存在，按名称 includes 会静默落到相似型号上。申请值为**目标总配额**（「申请到 2 台」= 总配额 2），必须是整数且大于当前配额；前后端都校验整数（`isIntegerOnlyQuota`）。
  文档生成（`doc-generator.ts` `classifyQuota`）按配额代码或完整官方名识别型号（`server/mac-quotas.ts`），保留官方名称并补「芯片, 实例类型」；识别不到的原样保留名称，**不再默认 M2**。前后端两份映射由 `tests/mac-quotas.test.ts` 锁定一致

### Bedrock 工具

区域下拉为 30 个 Bedrock 可用区域（带中文别名，支持搜索），与 `Quotas.tsx` 的列表保持一致。**各下拉按后端实际上限设了 `maxCount`**：`/profiles` 与交付表格 12 个、`/data-retention` 20 个、配额查询 30 个 —— 早期区域表只有 10 个时永远碰不到上限，补全后不加限制会直接吃 400。

**批量创建的 Provider 归类**（0.44.5）：模型来源是 SYSTEM_DEFINED profile，provider 由 `bedrock-tools.ts` 的 `PROVIDER_HINTS` 按 profile ID 厂商段 + 名称关键词推断，认不出归 `Unknown`。原表只有 9 家，OpenAI / xAI / Moonshot / TwelveLabs / Writer 的 profile（us-east-1 实测 93 个里 30 个）全落进 Unknown，Provider 下拉选不到 OpenAI。现已补齐，规范名与配额页 `BEDROCK_PROVIDER_HINTS` 一致，前端 `KNOWN_PROVIDERS` 同步。AWS 上新厂商时三处一起加，回归测试见 `tests/bedrock-provider.test.ts`。

**模型测试的 Profile 下拉**（0.45.0）：模型输入框是 AutoComplete —— 选区域后自动并发拉取该区域的 Application Profiles（值为 ARN，复用 `/profiles`）和系统 Profiles（值为 profile ID，复用 `/models`），分组展示、按名称/后端模型/ID 搜索；也可以直接手动输入任意 Model ID 或 ARN。切区域时若当前值是从旧区域下拉选的会自动清空（ARN 与区域前缀 profile 跨区调用必然失败），手动输入的值保留。旧请求晚到按序号丢弃，避免把别的区域的 ARN 塞进下拉；任一来源加载失败只提示、不影响手动输入。没有新增后端接口。

Profiles 列表的 ARN 列完整展示（不截断、等宽字体），每行带复制按钮，工具栏另有「复制选中 / 全部 ARN」（每行一条，可直接粘进脚本）。批量复制用的是**当前可见且选中**的行，与批量删除/打 Tag 口径一致 —— `selectedKeys` 会包含被搜索框过滤掉的行，直接用会多复制。

**客户交付表格**有两种格式：

| 端点 | 格式 | 说明 |
|---|---|---|
| `POST /delivery` | v1 三列 | Profile Name / ARN / Region |
| `POST /delivery-v2` | v2 五列（李浩版） | 追加 TPM / TPD，服务端实时查 Service Quotas 匹配 |

v2 按 `variant` 筛选核心 6 模型并固定排序：`global`（每区 6 条，默认）或 `full`（每区 12 条，us+global）。老模型（haiku / fable / opus-4-1 / 4-5 / sonnet-4 / 4-5）一律剔除。用**白名单**而非黑名单 —— AWS 随时上新模型，黑名单会漏。

**交付白名单（0.47.0 起 9 个核心模型）**：原 6 个 + Sonnet 5.5 / Opus 5.5 / Haiku 5.5。原有行顺序不变，5.5 追加在后（global 变体每区最多 9 条，全量版最多 18 条）；账户里没有的型号自动跳过并在下载提示里列出。**AWS 上新模型不会自动进表**，要加到 `bedrock-delivery.ts` 的 `VARIANT_*_ORDER`。Haiku 5.5 进表、Haiku 4.5 仍剔除，见 `tests/bedrock-delivery-55.test.ts`。

筛选必须在 `prepareDelivery()` **之前**执行：后者对每一行强校验 `map-migrated` tag，老模型往往没打 tag 会直接让整个导出失败，而它们本就不该进交付表。

**map-migrated 标签防错（0.53.0）**：曾把 `migmig…`（手敲 mig 又粘贴了带 mig 的 MPE ID）写进 AWS，交付表只校验「全表一致」，整批错值进了客户 Excel。平台**不存储**各 payer 的标准值（由操作者手填），防线只拦格式错误与覆盖写法：

- **格式**：`^mig[A-Z0-9]{10}$` 原样比对，不 trim、不改大小写、不补删 `mig`。`migmig` 判断区分大小写 —— 10 位恰好以 `MIG` 开头的合法值（`migMIGAB12345`）不能误伤
- **Tag 数组**：`map-migrated` 恰好一个；`Map-Migrated` 等大小写变体 key、不分大小写的重复 key、`aws:` 前缀一律拒绝
- **规则同源**：`server/map-tag-rules.ts` 与 `client/src/utils/mapTag.ts` 规则顺序与文案逐字一致，`tests/bedrock-map-tag-guard.test.ts` 锁死（前端放行的请求，服务端不会换一条理由拒绝）
- **写后回查**：创建 / 打 Tag 后逐个 `ListTagsForResource`（最多 3 次、间隔 1s，容忍最终一致性），状态分 `verified` / `create_failed` / `write_failed` / `read_failed` / `mismatch`，**只有 verified 算成功**（响应里 `ok` 的语义随之收紧）。页面结果表可「重试未完成项」，重试沿用发起时的 tags；重试与新一批操作互斥，并用批次号丢弃过期结果
- **自动移除变体 key**：打 Tag 前若资源上已有 `Map-Migrated` 等变体（旧版校验允许过），先 `UntagResource` 移除再写入，记入审计。Bedrock 页没有解 Tag 入口，不移除就永远过不了回查和交付
- **交付只认 AWS**：`/delivery` 与 `/delivery-v2` 丢弃前端传来的 tags（`normalizeDeliveryRows`：ARN 必须属于该账户、region 取 ARN 解析值），再按 ARN 从 AWS 重读；任一读失败即拒绝，不用前端值兜底。`prepareDelivery()` 依次拦缺失 / 大小写变体 / 格式错误，最后才查唯一 —— 「全部一致但全部错误」也过不去。v2 仍是**先筛选后读标签**
- **切换账户**：`<Tabs key={selectedAccount}>` 整体重建各 Tab，rows / 勾选 / 已填 Tag / 结果都不会带到新账户
- **不覆盖**：格式合法但属于别家 payer 的值无法自动识别，靠人工核对
- **存量排查**：`web/scripts/audit-bedrock-map-tags.ts` 从审计日志找做过 Bedrock 创建/打 Tag/交付的账户，读当前 profile 标签输出不合规清单（CSV）。`--plan-only` 只解析审计日志；全量模式对 AWS 只读，但 Admin 链路会经 `db.ts`，当天无备份时会触发每日自动备份。修正方式：页面上重打 Tag（覆盖写）后重新生成交付表

回归测试：`tests/bedrock-map-tag-guard.test.ts`（规则、回查、前后端一致）、`tests/bedrock-delivery-tag-guard.test.ts`（交付校验）。

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

**TPD 口径（2026-09 变更）**：AWS 新增账户级总配额 `L-E3F10727`（scope 标记为 `Account-Level`），同时**较新的 Claude 型号不再有独立 TPD**（实测 Opus 4.7 只剩 TPM）。

> ⚠️ **2026-10 AWS 改名**：`Cross-Model Account-Level Tokens Per Day` → `Cross-Model Max Tokens Per Day`（QuotaCode 不变）。旧逻辑按名称里的 `account-level` 识别，改名后整个回填失效：配额页新型号 TPD 显示 `-`、交付表 TPD 写 0。0.47.0 起**按 QuotaCode 识别**，名称（以 `Cross-Model` 开头）只作兜底，见 `isBedrockAccountLevelQuota()`。

取值优先级：

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

**凭证走跨账户 role，不存静态密钥**。每个 APN 账户里各建一个
`partner-central-tool` role，信任中心账户的 tools 凭证（`user/mark`）+ ExternalId；
平台 assume 后拿 1 小时临时票据（缓存 50 分钟）。

### 多 APN 主体（0.38.0）

| 主体 | APN 账户 | 优先 Solution | 说明 |
|---|---|---|---|
| Webby | `105673812363` | `S-0070517` | 商机 + POC 全流程 |
| Mergebytes | `072471709462` | 无（实时唯一的 Active 即默认，现为 `S-0100389`） | 商机 + POC 全流程（POC 0.55.0 起） |

`config.json` 用**嵌套结构**，每个主体一套 role 与独立 ExternalId：

```jsonc
"partnerCentral": {
  "webby":      { "roleArn": "arn:aws:iam::105673812363:role/partner-central-tool",
                  "externalId": "webby-apn-poc-cash" },
  "mergebytes": { "roleArn": "arn:aws:iam::072471709462:role/partner-central-tool",
                  "externalId": "mergebytes-apn-poc-cash" }
}
```

ExternalId 每个主体一个，泄露其一不波及另一个。

⚠️ **凭证缓存必须按主体分键**：早期是单个模块级变量，先后访问两个主体会
拿到上一个主体的临时凭证，商机**静默建到错误账户**。现为
`Map<partnerKey, creds>`，会话名也带主体（`poc-cash-mergebytes`）便于查
CloudTrail。

⚠️ **扁平配置只对 webby 生效**：旧的 `partnerCentral { roleArn, externalId }`
仍兼容，但只回落给 webby。若对任意主体都回落，会拿着 Webby 的 role 去建别
的主体的商机。

### APN 账户在账户管理页的呈现（0.42.0）

两个 APN 账户会出现在**账户管理**列表里，带 cyan 的 `APN` 标签（替代 `Payer` 标签），
排序沉底，点开详情有「说明」Tab 展示 role/ExternalId 配置与实测连通性
（admin 可点「实测连通性」，走 `POST /aws/apn-accounts/probe`）。

⚠️ **它们不能写进 `config.payers`**。实测平台基础凭证对这两个账户：

```
AssumeRole  tool / OrganizationAccountAccessRole / support-quota / admin-console
            → 全部 AccessDenied
Organizations DescribeOrganization / ListAccounts
            → AccessDeniedException
```

平台对它们**只有 Partner Central 一条通路**（`partner-central-tool`，权限仅
`partnercentral:*`）。而 `aws-service.listAccounts()` 的 payer 循环是
`catch { skip }` —— 写进 payers 只会让 AssumeRole 失败被**静默吞掉**，
账户永远不出现且界面上看不出任何异常。

因此数据走**独立接口** `GET /aws/apn-accounts`（`server/apn-accounts.ts`，
纯读 config，不发 AWS 调用），仅在**前端展示层**与账户列表合并，
**不进 `accounts_cache`** —— 那份缓存被角色自愈、离场检测、Root 邮件批次、
配额、账单、MAP 标签共用，塞进不可达账户会连锁误报（尤其离场检测会把它们
判为「已移出组织」）。

### APN 控制台登录（0.43.0）

APN 账户可以进控制台，走**独立的 `apn-console` 角色**（`AdministratorAccess`），
由 `scripts/setup_apn_console_role.py` 创建，config 里配 `consoleRoleArn` /
`consoleExternalId`。

```jsonc
"partnerCentral": {
  "mergebytes": {
    "roleArn":        "...role/partner-central-tool",  // 自动化：仅 partnercentral:*
    "externalId":     "mergebytes-apn-poc-cash",
    "consoleRoleArn": "...role/apn-console",           // 人工：AdministratorAccess
    "consoleExternalId": "mergebytes-apn-console"
  }
}
```

⚠️ **两个 role 刻意分开，不要合并**。把 Administrator 加到
`partner-central-tool` 上，会让所有 POC Cash 的自动化调用**顺带获得管理员权限**
—— 一个代码 bug 就能删资源。ExternalId 也用不同的值：权限差距悬殊，
共用会让其中一个泄露时把管理员 role 一起暴露。

⚠️ **门禁与 Admin 控制台一致**：需 `role === 'admin'` 或 `root_access === true`，
每次登录写 `CONSOLE_ADMIN_LOGIN` 审计。会话 1 小时（联邦上限 12 小时，
但这是管理员权限，窗口越短越好）。

⚠️ **生成链接前比对账户 ID**：`consoleRoleArn` 填错主体时 AssumeRole 一样成功，
不比对会把人送进**另一个 APN 账户**的控制台且毫无提示。

路由复用 `GET /aws/console-url/:accountId`，在函数开头按 `apnPartnerKeyForAccount()`
分流 —— 常规链路依赖 support-quota / OAAR / payer 二级跳，这两个账户一个都没有。

**默认落地页是 Partner Central**（`APN_CONSOLE_DESTINATION`），不是通用控制台首页。
用 `console.aws.amazon.com` 会被 AWS 按「该账户上次访问的服务」再跳一次；这两个
账户几乎没有其他资源（实测 0 台 EC2、1 个桶），落点实际由 AWS 决定，不可预期。
显式指定后行为稳定且少一跳。调用方传 `destination` 时仍以其为准。

⚠️ **host 区域与 `region` 参数必须一致**。曾观察到
`us-east-1.console.aws.amazon.com/partnercentral/dashboard?region=us-east-2`
这种互相打架的链接 —— 控制台会按 `region` 再跳一次，在两个区域间摇摆。

对应地，这些功能对 APN 账户仍不可用，前端按钮直接禁用并说明原因：
Root 凭证与密码重置、配额、MAP 标签、账单与区域数据。

⚠️ **APN 账户不查 `/accounts/:id/detail`**：该接口在 assume 失败时会回退到
`PAYERS[0]` 的凭证（`aws-service.ts:1109`），那样会把**另一个账户**的 IAM/MFA
数据显示在这个 APN 账户名下 —— 静默串号，比查不到更危险。前端直接短路。

⚠️ **probe 要比对返回的账户 ID**：role ARN 填错主体时 AssumeRole 一样成功，
只是进错账户。不比对就会把「商机建到错误主体」当成连通正常。

### 客户公司名的权威写法（0.44.0）

`canonicalizeCompanyName()` / `canonicalizeTitle()`（`server/poc-cash.ts`）在
**服务端落库前**把已知主体收敛成权威写法。目前只有一条规则：
Korea Wallpaper 一律为 `Korea Wallpaper (HQ) Sdn Bhd`，标题里的 `(KL)` 同步换成 `(HQ)`。

起因：2026-09 有 3 个商机写成了 (KL)（`O28666903` / `O28666335` / `O28604112`），
其中 `O28666335` 连标题里都嵌着 `(KL)`。实测**这些已经改不回来了**：

```
companyName（Approved 后）→ ACTION_NOT_PERMITTED
project.title（Approved 后）→ ACTION_NOT_PERMITTED
POC 申请 UpdateBenefitApplication 改 Name
  → 返回成功、Revision 变了，但 Name 原封不动（静默丢弃）
```

⚠️ **写错一次就永久留错**，所以只能在创建前拦截。

⚠️ **错误会自我扩散**：前端「复用已有商机」把老商机的 `companyName` 原样带进
新表单，一个错记录会不断复制给后续商机。因此 `getOpportunityTemplate()` 的返回
也做收敛 —— 只在创建时拦截挡不住这条路径。

收敛点覆盖：创建商机、标题预览、复用模板、POC `precheckOpportunity`、
POC 申请名与 ActivityName（含用户手填的 `titleOverride` / `name` / `activityName`）。

规则刻意保持极窄，只处理已确认的主体，不做模糊猜测 —— 猜错等于制造新的错误数据。
新增主体在 `CANONICAL_COMPANIES` 里加一条。

⚠️ **切换主体要清空已加载的列表**：Solutions 与商机列表按账户隔离，不重拉
会让 Mergebytes 的表单里列出 Webby 的选项，选中即报错。「阶段检查」Tab 有
独立的主体选择器 —— 它不在创建表单的 `Form` 里，读不到那个 `partnerKey`。

⚠️ **`request()` 对非 2xx 不抛错**（0.38.1 踩坑）：它把后端的
`{ error: "..." }` 原样 resolve 回来。创建商机若直接 `setResult(r)`，
结果页会渲染出「**商机 undefined 已创建**」，再解引用 `r.amounts.mrrUsd`
就整页崩进 ErrorBoundary —— 用户只看到「页面出错了」，真正的失败原因
（如「业务描述至少 50 字」）被完全吞掉。

调用方必须自己判：`if (r?.error || !r?.opportunityId) throw ...`。
改 `request()` 全局抛错会波及大量既有页面，故只在调用点拦。
回归测试见 `tests/poc-cash-create-result.test.ts`。

配套改了两处可观测性短板：
- ErrorBoundary 把 `error.message` / 堆栈 / 组件栈显示出来并支持一键复制，
  不再只 `console.error`（截图里看不到任何线索，定位得靠猜）。
- 创建商机的 400 分支补 `console.error` 记字段特征（长度、取值，
  不记完整业务描述），此前失败是静默的：审计日志只在成功分支写。

⚠️ **`Marketing.Source` 与 `AwsFundingUsed` 是配对字段**（0.38.2）：

| Source | AwsFundingUsed |
|---|---|
| `Marketing Activity` | **必填**（`Yes`/`No`） |
| `None` | **必须省略** |

违反会被拒：`ACTION_NOT_PERMITTED: You cannot perform Create action.
marketing.awsFundingUsed is required when marketing.source is Yes.`
（文案里的 "Yes" 指「Source 非 None」，不是字面的 `Source='Yes'`。）

此前默认 `Marketing Activity` 却从不传 `AwsFundingUsed`，**创建必失败**。
现在默认改成 `None` —— 账户内 9 个商机实测 8 个是 `None`，且它不需要
额外字段。规则集中在 `buildMarketing()`。

⚠️ **`UpdateOpportunity` 是全量替换，不是增量补丁**（0.38.2）：只传
`LifeCycle` 会被一串 `REQUIRED_FIELD_MISSING` 拒掉 —— `marketing.source`
/ `project.title` / `project.customerBusinessProblem` / `customer.contact`。

所以推进阶段必须先 `Get` 再把**所有必填字段原样回传**，见
`buildUpdateEchoFields()`。同时只能回传可写字段：`Id` / `Arn` /
`ReviewStatus` / `ExpectedCustomerSpend[].EstimationUrl` 带上同样会被拒。

> 这意味着**阶段推进功能此前从未成功过**，直到 0.38.2 才真正跑通
> （实测 `O28440608` Prospect → Qualified → 回滚 Prospect）。

**Solution 默认值以实时 Active 列表为准（0.56.0）**：代码里只有偏好
`PartnerProfile.preferredSolutionId`（仅 Webby `S-0070517`），默认值由
`resolveSolutionDefault` 计算——0 个 Active → 无；优先项在列表里 → 优先项；
恰好 1 个 → 它；多个且无可用优先项 → 必须手选。有 Active Solution 时表单必选；
`createOpportunity` 在 `CreateOpportunity` **之前**用实时列表再校验一次
（`decideSolutionForCreate`）：所选不在 Active 列表、或多个却没选 → 400，不建商机；
列表为空或 `ListSolutions` 失败 → 放行并记 warning（失败时 Webby 回落优先项）。

> 教训：此前硬编码 `defaultSolutionId`（Mergebytes 为空串）。2026-10-15 Mergebytes 在 Partner Central
> 发布了 `S-0100389` 后，平台仍静默跳过关联、提示「暂无可关联的 Solution」。另外 Solution 按 APN 账户隔离，
> 在 Webby 账户里建的「Mergebyte …」Solution（`S-0099438`，Inactive）对 Mergebytes 商机不可见。

> 最初方案是存 APN 的 AK/SK —— 但那个 IAM 用户挂着 **AdministratorAccess**，
> 把长期密钥放进配置文件等于泄露整个 APN 账户的管理员权限。改成 role 后
> 权限可精确限定，凭证也是临时的。

一键创建与验证：

```bash
# 默认 webby
python3 scripts/setup_partner_central_role.py            # dry-run 看策略
python3 scripts/setup_partner_central_role.py --execute  # 创建
python3 scripts/setup_partner_central_role.py --verify   # 验权限边界

# 其他主体用 --partner（脚本内 PARTNERS 里登记）
python3 scripts/setup_partner_central_role.py --partner mergebytes --execute
python3 scripts/setup_partner_central_role.py --partner mergebytes --verify
```

新增主体的完整步骤：① 本地配好该账户的 AWS profile → ② 在脚本的
`PARTNERS` 加一条 → ③ `--execute` 建 role → ④ `--verify` 验边界 →
⑤ `poc-cash.ts` 的 `PARTNERS` 加主体资料 → ⑥ `config.json` 填 role。

⚠️ **提交商机要 `CreateEngagement` 等一组权限**（0.39.0）：光给
`StartEngagementFromOpportunityTask` 不够 —— 那个 task 内部会建
Engagement 并做资源快照。缺权限时报：

```
is not authorized to perform: partnercentral:CreateEngagement
```

需要同时给 `CreateEngagement` / `CreateEngagementInvitation` /
`CreateResourceSnapshot` / `CreateResourceSnapshotJob` /
`StartResourceSnapshotJob`（role 现为 42 个 action）。

> 这个问题此前**一直存在但没暴露**：`createOpportunity` 把提交失败
> 写进 `warnings` 而不是抛错，所以「创建并提交」看起来成功了，实际
> 商机一直停在 `Pending Submission`。

⚠️ **补提交入口**（0.39.0）：创建时选「只创建，暂不提交」会停在
`Pending Submission`。此前阶段检查页提示「需先提交」却**没有提交按钮**，
只能去 Partner Central 控制台。现在 `StageStatus.submittable` 为 true
时显示「提交给 AWS 审核」，走 `POST /opportunities/:id/submit`。

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
  → AssociateOpportunity               → 挂 Solution（默认值见下文「Solution 默认值以实时 Active 列表为准」）
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

四个 Tab：创建商机 / 商机阶段检查 / POC 申请 / **POC 进展**。
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
其余全自动：计算器链接、ARR、全部金额、发票信息、联系人。

**多主体（0.55.0）**：发票主体、Payee Central 收款档案（`AccountProfileID`）与申请联系人
放在 `server/poc-cash.ts` 各主体的 `PartnerProfile.funding`，不放 `config.json`（不是密钥）。
预检 / 创建 / 提交 / 进展 / 导出全部按当前主体取凭证与资料；`getFundingProfile()` 对未配置
`funding` 的主体在任何 AWS 调用前抛错，**绝不回退到 Webby** —— 发票主体错了钱会打给别家，
且建成后很难察觉。人天单价、币种、执行国家、申请名格式两主体相同。

| 主体 | Invoice Entity | AccountProfileID | 联系人 |
|---|---|---|---|
| Webby | `WEBBY SDN BHD` | `123749FB67ZJQ` | sy.siow@webbygroup.com |
| Mergebytes | `MERGEBYTES AI SDN. BHD.` | `2MGE7NZ9LMR3C` | cloud@mergebytes.ai |

⚠️ `InvoiceRemitCountry` 写 ISO 代码 `MY`，不是 `MALAYSIA`（Webby 已批准件实测为 `MY`）。

⚠️ 改动前前端有个隐患：「POC 申请」的商机下拉随页面主体加载，后端却恒用 Webby 凭证 ——
切到 Mergebytes 后选商机一定报 `ResourceNotFoundException`。现在三个 Tab 共用主体选择器，
切换主体时统一清空已选商机、预览与进展列表，并丢弃切换前发出的列表请求的响应。
创建确认框会显示「主体（发票 xxx）」，提交前最后核对一次。

> Mergebytes 账户 0.55.0 之前从未提过 POC，其资料由业务方提供、没有已批准件可对照。
> 首单建议「只创建，暂不提交」，在控制台核对发票与收款档案后再提交。

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

**定价计算器生成（0.52.0）**：每条 POC 申请一份**独一无二**的计算器，
且金额经得起审核人在 calculator.aws 点「Update estimate」重算。方案与实测数据见
`.kiro/specs/poc-calculator-uniqueness/`。

> 起因（2026-10-12）：同日两条 Freightly POC 的计算器逐项完全相同 —— 旧实现只用
> MRR 播种、服务组合写死 8 项，MRR 相同就产出同一份。排查时又发现旧计算器**一点
> Update estimate 就从 7,946.93 变成 27,767.33**：EC2 的 `storageAmount` 被引擎按
> **每台实例**计、ALB 每台「60 GB/小时」处理量按 LCU 计费、CloudFront 参数格式无效重算为 0。
> 9 月以来平台生成的 13 份都受影响，已提交的不改。

- **种子 = 台账 ID**：创建 POC 前先在 `poc_calculator_ledger` 预留一条（`id#attempt`），
  同一 ID 也作 `CreateBenefitApplication` 的 `ClientToken`。生成 → 与台账比对 → 写入
  在同一同步段内（无 `await`），并发提交不会都通过查重
- **查重**：总额（精确到分）或服务签名任一相同即撞车，换 attempt 重生成，最多 20 次。
  同一 MRR 金额窗口只有约 5,100 个分值，随机撞车约 16–20%，查重是必需的
- **组合**：EC2 1~3 个角色（23 个机型）+ 数据库四选一（RDS MySQL / PostgreSQL /
  Aurora MySQL / EC2 自建）+ ALB 1~3 个 + S3 + CloudWatch + 辅助服务池 13 选 3~6，
  每份 8~13 项。总额仍为 **MRR + 100~151 USD、带零头**
- **成本公式 = 引擎实测**，不是 Price List：价格文件与引擎不一致（如 ElastiCache 引擎按
  Memcached 价计）。183 个 Update estimate 实测用例锁在 `tests/calculator-calibration.test.ts`
- 服务块 JSON 一律**克隆人工制作的真实估算**（平台生成的样本参数本身就是错的）
- 只支持 `ap-southeast-5`；最低 MRR 600 USD
- 结果页展示计算器总额与服务组成

⚠️ **标定时必须让每个参数独立变化**。EFS 首轮样本读写量恒相等，只测出读+写=0.099，
按 0.033/0.066 拆分在读写不等时差 0.04；实测为读 0.036、写 0.063。S3 PUT/GET、
RDS 备份、WAF 规则/托管组已单独补测确认。

⚠️ **引擎会把「不合法的组合」静默按错误口径重算，而不是报错**。已知一条：RDS PostgreSQL gp3
存储 ≥400GB 必须同时写 12000 IOPS / 500 MiBps（AWS 基线），仍填 3000/125 时
r6g.xlarge×2 Multi-AZ 650GB 从 1,704.30 被算成 800.55。`buildServiceBlock` 按存储自动切换。
新增服务或扩大参数区间时，必须联网跑大样本验收，别只看单测。

⚠️ 移出服务池：CloudFront（引擎重算恒为 0，无人工样本）、Lambda（免费额度难与引擎对齐）、
ElastiCache r 系列与 Serverless（Required input）、RDS SQL Server（含许可证）、
Aurora t4g 与 PostgreSQL r7g.xlarge（引擎不认）。

**改单价或模板后必须联网验收**：

```bash
cd web
npx tsx scripts/verify-calculator-render.ts --plan-only --mrr 7800 --count 3  # 离线：看组合是否各不相同
npx tsx scripts/verify-calculator-render.ts                                   # 联网：Chrome 打开计算器点 Update estimate 逐项核对
```

联网模式按 MRR 1500 / 7800 / 25000 各生成 2 份，另加覆盖全部 20 类服务的一份，
单项差 ≤ 0.02、总额差 ≤ 0.10，否则退出码 1。AWS 调价后公式会漂移，靠它发现。

CSV 前 18 列严格对齐现有台账，`PO ID` 就是商机 ID；第 19 列「AWS批准金额」
（0.47.1 追加，新列只能加在末尾）。服务器留存带时间戳快照
（`data/poc-cash/`）+ `poc-cash-latest.csv`，同时浏览器下载一份 ——
**按主体分文件**（0.55.0）：Webby 沿用 `poc-cash-<ts>.csv`，其他主体为 `poc-cash-<key>-<ts>.csv`
（如 `poc-cash-mergebytes-latest.csv`），`GET /funding/exports` 只列当前主体的快照 ——
留存是为了回溯 PO 号、批准金额是何时被 AWS 回填的。

**AWS 批准金额（0.47.1）**：进展表与 CSV 的「AWS 批准额」取
`CashRequest.ApprovedAmount`。⚠️ 实测 2026-09 之后批准的件（如
`benappl-kqowjcmd6dzs1e`，APPROVED + 已有 PO）**只回填 `RequestedAmount`，
没有 `ApprovedAmount`**，所以 `approvedOf()` 在 `Status=APPROVED` 时退回申请额；
未批准的件一律留空，绝不拿申请额冒充。

**金额与控制台一致（0.48.0）**：Partner Central 控制台对金额**直接截掉小数**
（API `38133.58` 显示 `38,133`，`14272.80` 显示 `14,272` —— 不是四舍五入）。
进展表与 CSV 统一用 `consoleAmount()`（`Math.trunc`），表格悬停可看 API 原值。

**端到端进度：预批 → Cash Claim → 付款（0.48.0）**。POC 的完整流程到请款
付款才结束，只看预批（Funding）的 APPROVED 会把「还没请款」「请款审核中」
都显示成已批准。进展表的「进度」列由 `computeProgress()` 推导：

| 进度 | 判定 |
|---|---|
| 预批待提交 / 审核中（带审批环节）/ 需补充 / 已取消 | 预批的 Status/Stage |
| 待请款（带请款截止日） | 预批 APPROVED 且名下无请款；截止日 = 预批分配的 `ExpiresAt` |
| 请款待提交 / 请款审核中（发票审核）/ 请款需补充 / 请款被拒 | 主请款的 Status/Stage |
| 请款已批准·待付款 | 请款 APPROVED 但付款分配未 FULFILLED |
| 已完成 | 请款的 Disbursement 分配 `FULFILLED`（查不到时按 `Invoice.ScheduledPaymentDate` 已过）；Credits 型预批批准即完成 |

⚠️ **Cash Claim 不直接挂预批**，而是挂在预批批准后生成的**分配**上：
`Claim.AssociatedResources → benalloc（BenefitId=ben-un8hh6qdrxqx50）→ BenefitApplicationId = 预批`。
实测 Webby 51 笔请款 100% 可经此链路对上。一笔预批可有多笔请款（如
`benappl-tbmp7pm35egal0`），取走得最远的一笔为主并提示笔数。

⚠️ `ListBenefitAllocations` 的 `BenefitIdentifiers` **最多只能传 1 个**，传 2 个报
`ValidationException`，所以按 Funding / Cash Claim 分两次查。

请款关联查询失败时进度显示「请款状态查询失败」，**不能**当成「没有请款」
误报成待请款。CSV 的「POC阶段」用同一套进度；「invoice」「到账金额」「到账日期」
取主请款的 `Invoice`（发票号 / 请款额 / 付款日），未付款留空。

**商机阶段检查（0.36.0，Tab 名 0.37.4 起加「商机」前缀）**：提交后商机被
AWS 锁定，用这个 Tab 确认审到哪一步了，并在允许时推进阶段。

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
带出客户信息、Marketing 字段和 Solution。标题、Use Case、业务描述及 MRR 均需按新项目填写，
避免旧项目内容与新标题不一致。Use Case 必须从 AWS 标准值中选择；业务描述由用户填写。

⚠️ `ListOpportunities` **不返回 Title / CustomerUseCase / CustomerBusinessProblem**，
只有 `GetOpportunity` 才有。所以列表只显示客户名等摘要，选中后再单独拉完整模板——
不能对每条都 Get（账户里有 246 个商机）。

⚠️ `CreatedDate` 是 timestamp，SDK 反序列化成 Date 对象。用 `String(date).slice(0,10)`
会得到 `Mon Sep 21` —— 既显示错误又让按日期倒序的字符串排序失效。必须走
`toISOString()`。`TargetCloseDate` 是 string 类型，不受影响。

**商机名称**支持自动生成与手动输入。自动模式按账户内惯例拼成两段式
`Webby - <客户简称> <项目描述> #ADPL #HarimauBlitz26`（不是 YanHuang 的三段式），并剥掉
`SDN. BHD.` 等公司后缀。`CustomerUseCase` 必须用 AWS 的完整字面量 ——
写成 `Migration` 会被拒，正确值是 `Migration / Database Migration`。
手填标题也会补齐当前 Partner 要求的标签；创建确认框会向服务端重新预览最终标题。

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

#### 组织级额外自定义标签（v0.40.0）

MAP 主标签 `map-migrated` 是固定纪律（key 不可改，每个组织只能定制它的
`tag_value`）。在此之外，每个组织可**额外**再打一组自定义 kv，用于成本
归集等场景，写入 `orgs.json` 的 `extra_tag_key` / `extra_tag_value`：

```jsonc
{
  "org_id": "o-96n4c10zzb",
  "tag_value": "migEY52ZIK63T",      // map-migrated 的值
  "extra_tag_key": "CostCenter",      // 可选，额外标签
  "extra_tag_value": "CC-1001"
}
```

**中央扫描器侧已配套改好**（RE-AUTOTAG 项目，本地 `~/Downloads/RE-AUTOTAG`）：

| 文件 | 改动 |
|---|---|
| `functions/search_handler.py` | 读 org 的两个字段，校验后写进 Distributed Map manifest |
| `functions/tag_handler.py` | `tags = {TAG_KEY: tag_value}` → 再合入额外标签，**同一次 `TagResources` 调用**打两个 tag |
| `tests/test_extra_tag.py` | 新增 9 个用例 |

`config_handler` 原样透传整个 org 对象，State Machine 与 IAM 都不用改
（`auto-tagger-role` 的 `tag:TagResources` 没有 `aws:TagKeys` 限制）。

> ⚠️ **改完要重新部署 SAM 栈才生效**（`sam build && sam deploy`，
> 中央账户 `382309211956`）。平台侧写进 `orgs.json` 的字段，在旧版
> Lambda 上会被静默忽略 —— 资源上只有 `map-migrated`。
> 页面在填了额外标签时会提示这一点，接入后请到资源上确认。

校验规则（`normalizeExtraTag()`，回归测试见 `tests/tag-extra-tag.test.ts`）：

- **只填一半直接报错** —— 单独的 key 或 value 都打不出标签，静默忽略会让
  用户以为配好了
- **key 不能是 `map-migrated`** —— 会和主标签撞车，谁后写谁生效，属于难
  排查的静默覆盖
- **key 不能以 `aws:` 开头**（AWS 保留前缀）
- 长度受 AWS 限制：key ≤ 128、value ≤ 256；字符集 `[\w\s+\-=.:/@]`
- **留空必须删掉键而不是写空串** —— 扫描器若按「字段存在」判断是否打标，
  空串会让它尝试打一个空 key 的标签

**给已接入的组织补标签**（v0.41.0）：一键接入只覆盖**新增**场景。已经跑完
的组织用页面上的「管理额外标签」按钮 —— 它列出 `orgs.json` 里的全部组织，
只编辑这两个字段，其余原样写回。

> 早先只能手改页面底部那块 `orgs.json` 文本。少个逗号、误删 `view_arn`
> 都会让整个组织扫不了，所以把编辑面收窄到两个输入框。
>
> 流程：管理额外标签 → 应用到下方配置 → **保存到 S3** → 下次扫描生效
> （每天 01:20 UTC，或手动触发扫描）。中间那步不点就不会写入。

一键接入任务（`tag_onboarding_jobs`）也带这两个字段。复用在跑的任务时会
**比对标签是否一致**，不一致则抛冲突而非复用 —— 否则用户新填的额外标签会
被静默丢弃，任务跑完却是旧配置。

> ⚠️ **不要用托管策略 `ResourceGroupsandTagEditorFullAccess` 替代这份内联策略。**
> 它只授予 `tag:TagResources` / `resource-groups:*`，不含各服务自身的打标 API；
> 而 `TagResources` 底层是代调 `athena:TagResource`、`logs:TagResource`、
> `s3:PutBucketTagging` 等，缺了会全线 `AccessDenied`。
> 实测曾因此产生 59 个打标失败（其中 47 个是 `athena:TagResource`）。
> `tests/tag-compliance-policy.test.ts` 会断言 Action 数量与关键 Action 存在，
> 防止模板被重排后正则失配、静默生成空策略。

变更前后实测（Freightly（原 webby02）/ FFCloud / nexstack 三个组织）：`found=142 tagged=81 failed=59` → `found=73 tagged=71 failed=1`。

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

#### 成员账户已有 Resource Explorer 索引（0.45.1）

AWS 每个账户每个区域只允许一个索引。成员账户在接入前自建过索引时，StackSet 实例会以
`AlreadyExists` 失败，CloudFormation 把它们标成 `Status=OUTDATED`（`DetailedStatus=FAILED`）。
旧逻辑只认 `FAILED`、且不覆盖聚合索引 StackSet，结果每 3 分钟重试一次直到 90 分钟超时，
组织始终写不进 `orgs.json`，一个 tag 都打不上（koreawallpaper 实际踩过，15 个实例）。

`wait_stacksets` 现在对 `AlreadyExists` 的实例（三个索引 StackSet、FAILED/OUTDATED 均识别）
用 support-quota 只读核验已有索引，按 `classifyExistingIndex()` 分流：

| 已有索引 | 处理 |
|---|---|
| 聚合区 AGGREGATOR / 本地区 LOCAL 且已向聚合区复制 | 视为覆盖，计入 `ACTIVE_EXISTING_INDEX` |
| 聚合区是 LOCAL | 自动原地升级为 AGGREGATOR（payer 管理员链，每轮一个账户，无损） |
| 变更中，或本地索引尚未开始复制 | 等待下一轮 |
| 本地区被占成 AGGREGATOR、状态异常、读不到 | 立即失败 `EXISTING_INDEX_CONFLICT`，列出账户×区域与人工步骤，不再重试 |

回归测试：`tests/tag-onboarding-existing-index.test.ts`。

#### payer 缺区域时自动开通（0.46.0）

StackSets 要求 payer 管理账户先启用全部目标区域。以前 `deploy_re_indexes` 发现缺区域就直接
失败（`PAYER_REGIONS_NOT_ENABLED` / `AGGREGATOR_REGION_NOT_ENABLED`），要人去控制台逐个开通再回来重试。

现在由 `findPayerMissingRegions()` 算出缺口（聚合区 + 成员已启用而 payer 未启用的区域），
用 payer `role/tool`（`account:EnableRegion`）自动开通，每分钟复查一次，生效后自动继续下发索引：

- **只开 payer 自身缺的区域**，不改任何成员账户的区域设置；开通写 `REGION_ENABLE` 审计
- 开通失败，或 60 分钟仍未生效 → 失败 `PAYER_REGIONS_NOT_ENABLED`，列出区域与受影响成员；重试会再次自动开通
- 可选区域开通后 AWS 不支持中途取消，属账户级不可轻易回退的变更 —— 开的都是成员账户已经在用的区域

回归测试：`tests/tag-onboarding-payer-regions.test.ts`。

### 根用户凭证状态与敏感操作

账户页「根用户」tab 会读取状态，并提供四类敏感操作。敏感操作均受 `root_access` 实时门禁控制并写入审计；状态接口 `GET /root-credentials/:accountId` 当前不经过 `requireRootAccess`。

| 功能 | 当前实现 | 说明 |
|------|----------|------|
| 读取 Root 凭证状态 | 优先 `AssumeRoot(IAMAuditRootUserCredentials)`，在目标 root 会话内调用 `ListAccessKeys`、`ListMFADevices`、`GetLoginProfile` | AssumeRoot 失败时回退管理员权限的 `GetAccountSummary` + Credential Report；Credential Report 最长可能约 4 小时才刷新 |
| 生成 Admin 临时凭证 | 临时开通期内直接 AssumeRole 到成员账户 `admin-console`，否则经 OAAR；**不**走 `support-quota` | 默认 1 小时；仅平台 admin 在开通期内可选更长（不超过剩余时间，被截断时提示）。可复制 AK/SK/Token、导出环境变量、倒计时与重新生成 |
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

### 账户回收

交付给客户的根邮箱、邮箱密码、AWS Root 密码及邮件转发，由一个回收入口统一收回：删除转发 → 改邮箱密码并踢旧 IMAP/POP3 会话 → 删除 Root MFA → 允许恢复密码 → 改 AWS Root 密码。每批 1–20 个 ACTIVE 成员账户，先核对数量并验证 TOTP；payer 自身和邮箱未托管/不存在/禁用的账户拒绝，受限账户仅 admin 创建者可执行。

账户列表默认每页 5 个（0.56.2），支持 ID/名称/邮箱搜索。payer 下拉可搜索、可清空，选项由 catalog 返回全部配置名称，不受当前页或搜索结果限制；切换筛选后回到第 1 页。

前四步复用既有邮箱/AWS 操作，第五步复用原 Root 执行器和全局浏览器槽。前四步失败/未知即停，后续注明未执行；第五步失败为部分完成，`password_unknown` 禁止重试。服务重启保留原密码及 Root 尝试 ID，跨文件中断补关联；旧 `/rootreset` 不能查看或操作回收来源。普通 Root 任务的管理员重试语义保持。

新邮箱密码与已确认的 AWS 密码永久加密保留，页面可反复查看/复制，每次查看审计；列表、审计及通知不含密码或 reset URL。终态飞书通知独立于执行队列，15 秒截止，明确送达后才记完成，失败后补发。数据在 db.json 的 `account_reclaim_jobs` 与既有 Root store；旧库缺少数组自动读为空，不裁剪永久记录。

邮箱写调用使用 `MAIL_ADMIN_API_SSM_PARAMETER=/toolbox/mail-api-reclaim`，区域沿 `MAIL_API_SSM_REGION=us-east-1`；保留只读邮件的独立 `/toolbox/mail-api`，不混用 token。本功能保留账户与邮箱，资源删除仍走资源清理；IAM/SSO/Access Key 撤销不在五步内。上线须在授权测试账户验证新/旧登录、转发及已登录 webmail/IMAP/POP3 会话。设计、审核与上线清单见 `.kiro/specs/account-reclaim/`。

### 临时开通 Admin（0.54.0）

成员账户不再常驻 `admin-console`。有 OAAR 的账户经 payer `role/tool` → OAAR 取 Admin；没有 OAAR 的账户（通常是 INVITED）由 admin 在账户详情点「临时 Admin」开通 1 / 2 / 3 小时（TOTP 二次验证），到期由平台自动删除。实现在 `server/temp-admin.ts`，设计见 `.kiro/specs/admin-console-on-demand/`。

- **只能走 StackSet**：这类账户平台没有任何写权限入口，无法直接 `CreateRole`。每个 payer 一个专用 StackSet `admin-console-role-temporary`（`SERVICE_MANAGED`，**`AutoDeployment` 永远关闭**，平时 0 个实例），开通 = 对单个账户 `CreateStackInstances`（Root OU + `INTERSECTION`），到期 `DeleteStackInstances(RetainStacks=false)`。被人为开启 AutoDeployment 时拒绝开通
- **前置条件**：能经 OAAR 进入 → 拒绝；payer 管理账户、`adminRoleExcludedAccounts`、敏感权限客户账户、已有未结束开通 → 拒绝；**账户里已有常驻 `admin-console`（组织级残留或手工角色）→ 拒绝**（同名角色会让 StackSet 必然失败，回收后复验也永远过不了）
- **竞态防线**：所有同步校验与写入 `provisioning` 占位记录之间没有 `await`，之后才做 AWS 探测；payer 锁内再查一次受限与重复；复验通过后若账户已被标记受限立即回收。并发开通同一账户只有一个成功
- **纵深防御**：角色信任策略带 `DateLessThan aws:CurrentTime`，截止时间按账户用 `ParameterOverrides` 写入（发起时间 + 时长 + 15 分钟部署余量，模板默认 1970 年 fail-closed）。即使回收失败或服务长时间停机，过了截止时间角色也无法再被 AssumeRole；开通到期时间不晚于信任截止
- **回收**：调度器每 60 秒执行，先处理到期的 `active`、再重试到点的 `revoking`；回收前按 id 复读最新状态（避免拿旧快照按账户删掉之后新开通的实例），「正在回收」集合保证同一条记录不会被手动关闭和 sweeper 同时处理。复验**只认 `AccessDenied`**；失败保持 `revoking` 并退避（1、2、4… 分钟，上限 30 分钟，从失败时刻起算），第 3 次失败飞书告警一次。服务启动时把中断的 `provisioning` 转为 `revoking`
- **会话与凭证**：开通期内签发的凭证 / 控制台会话不超过剩余时间；剩余不足 15 分钟拒绝签发
- **审计**：`TEMP_ADMIN_OPEN` / `TEMP_ADMIN_OPEN_FAILED` / `TEMP_ADMIN_STEPUP_FAILED` / `TEMP_ADMIN_REVOKE` / `TEMP_ADMIN_REVOKE_FAILED`；受限标记与取消标记内部的开通、回收同样写审计
- **存量清理**：`scripts/remove-orgwide-admin-console.ts`，默认 dry-run，必须在 EC2 执行。`--payer <名称> --execute` 先关闭 AutoDeployment（不成功即停止）→ 删除全部实例 → 实例清空后删除 StackSet → 探测仍能 AssumeRole `admin-console` 的成员账户输出残留 CSV（只列不删）。先对 1 个组织执行并核对，再 `--all`
- **回滚注意**：只回滚代码不会恢复已删除的 `admin-console`；回滚前确认没有 `active` / `revoking` 记录，否则需手工删除其临时实例

### 账户角色自愈

新账户加入组织后，`support-quota` 由该组织 StackSet 的 `AutoDeployment` 自动创建，平台不参与。`admin-console` 已改为按需临时开通（0.54.0）：自愈**只补齐 support-quota**；未经开通而存在的 `admin-console`（组织级残留或手工创建）标为 `partial`、显示「常驻 Admin」，**不自动删除**，由清理脚本或人工处理；开通未结束（含到期等待回收、回收中）时存在视为正常。但自动部署并非 100% 可靠：账户未完成激活时 CloudFormation 返回 `OptInRequired`、StackSet 操作可能排队超时、角色也可能被人为删除。这些失败此前只躺在 CloudFormation 里，平台完全不知道 —— 账户在列表里看着正常，点进去什么都读不了。

`account-roles.ts` 补上这个缺口，流程是探测 → 补齐 → 复验 → 记录 → 告警：

- **探测**：直接 AssumeRole `support-quota` 与 `admin-console`，看实际能不能进，不依赖配置声明
- **补齐**：只补 `support-quota`，按 payer 分组，一次 `CreateStackInstances` 打一批账户（`AccountFilterType=INTERSECTION` 限定范围），操作完成后复验
- **重试**：失败累计 3 次标记 `unreachable`，发飞书卡片，然后停止重试，不刷 API
- **增量**：跟在每次 `syncAccounts()` 之后，只查从未检测过的和上轮待重试的，按 `JoinedTimestamp` 降序（新账户优先）。单轮上限 60
- **全量复检**：每 24 小时，按「最久未检查优先」排序轮转，单轮上限 400，用来发现被删除的角色

结果在账户页「权限状态」面板（仅 admin），列出异常账户、缺哪个角色、尝试次数、原因说明，可导出 CSV。面板汇总按当前规则对存量记录重新判定（`getAccountRolesSummary` 的 `effectiveState`，0.54.1）：0.54.0 之前按旧规则记为「缺 admin-console」的 partial / unreachable 视为正常；旧规则存下的 `ok` 即使带着组织级 admin-console 也先视为待复检，只有新逻辑实际检测出的常驻 admin-console 才标异常。账户列表里异常账户名旁会有「权限缺失 / 补齐中」标记。

**已知无解情形**：零账单 + `OptInRequired` 的账户，StackSet 进不去，自愈也补不上，必须先处理账户本身的激活问题。截至 2026-08 有 7 个这类账户（yanhuang5-global 5 个、yanhuang13 2 个）。

### 敏感权限客户账户（权限收窄 + ExternalId）

默认下发的 `support-quota` 附带 `ReadOnlyAccess` 托管策略（2900+ action），有客户会审出来并要求收窄。`restricted-accounts.ts` 把收窄**精确到账户级**：同组织其他账户不受影响，平台自己的 StackSet 也不会把宽权限再盖回来。

三个平台角色的规则（0.51.0 起）：

| 角色 | 受限账户上的规则 |
|------|------------------|
| `OrganizationAccountAccessRole`（OAAR） | **保留不动**。Admin 临时凭证（角色链，AWS 硬上限 **1 小时**）、Admin 控制台、区域开通都经 payer `role/tool` → OAAR 执行 |
| `admin-console` | **不存在**：处于临时开通期则回收临时开通；否则删组织级残留实例（`RetainStacks=false`，组织级 StackSet 已删除时视为无实例）或走 IAM 删手工角色，删完复验 AssumeRole 必须被拒（只认 `AccessDenied`，网络错误不算成功）。受限账户不允许人工临时开通；若再次出现，`account-roles.ts` 把账户标为 `partial` 持续暴露 |
| `support-quota` | 收窄为内联策略 `SupportQuotaRestricted`：`servicequotas:Get*/List*`（含提额进度）、`servicequotas:RequestServiceQuotaIncrease`、`support:*`（提额文档自动回帖与附件上传依赖 Support Center，AWS 未完整公开其 action）、`account:GetRegionOptStatus/ListRegions`、`sts:GetCallerIdentity`，加限定 `servicequotas.amazonaws.com` 的 `iam:CreateServiceLinkedRole`。信任策略要求 `sts:ExternalId`，**每账户一套** |

**INVITED 账户**本来就没有 OAAR，删掉 admin-console 后平台**只剩 support-quota**：`isSupportOnlyRestricted()`（受限 + 账户缓存 `JoinedMethod === 'INVITED'`）为真时，Admin 临时凭证、Admin 控制台、区域开通直接 409 提示，不去尝试 AssumeRole。标记弹窗对选中的 INVITED 账户单独警示。

隔离手段：

1. 从组织级 StackSet `support-quota-role-orgwide` 移除该账户实例，`DeleteStackInstances` 带 **`RetainStacks=true`** —— 只脱离管理、不删账户内角色，过程中平台访问不中断
2. 角色本身是**就地改造 IAM**（首次修改前把原托管/内联策略备份到记录的 `support_policy_backup` → `DetachRolePolicy` 摘掉 ReadOnlyAccess + 挂 `SupportQuotaRestricted` → `UpdateAssumeRolePolicy` 加 ExternalId 条件），不是靠 StackSet 部署。改 IAM 需要写权限，所以用 payer 二级跳拿成员账户 OAAR；**首次标记没有 OAAR 的账户**（INVITED）时内部临时开通 1 小时 Admin（审计 `TEMP_ADMIN_OPEN`），中途失败也会立即回收
3. 复验通过后确保 `admin-console` 不存在（回收内部开通 / 删残留）
4. `AutoDeployment` 只在账户「加入 OU」时触发，已移除的实例不会被自动重建

⚠️ **最容易漏的一环**：手工跑 `scripts/setup-org-stacksets.ts` 会重新覆盖，因此该脚本必须读取 `data/db.json` 的 `restricted_accounts` 排除名单（support StackSet 排除受限账户）。这也是 README 部署章节强调「必须在 EC2 权威数据环境执行、不能用空白或陈旧本地 DB」的原因。

`getExcludedAccountIds()` **刻意不按 state 过滤**：只要账户被标记过（记录未删）就一律排除。`state=failed` 表示收窄执行失败，但账户很可能已从组织级 StackSet 摘除，若因 failed 漏掉排除，下次全量下发就会把宽权限重新盖回客户账户，直接违反对客户的承诺。取消标记走 `unmarkRestricted()`，它会删除记录。

复验（`verifyRestricted`）要同时满足三条，缺一即判失败：带 ExternalId 能 AssumeRole、**不带 ExternalId 必须被拒**（否则条件没生效）、`iam:GetRole` 必须被拒（否则收窄没生效）。IAM 最终一致，每一项都要轮询重试（`VERIFY_MAX_ATTEMPTS` 36 次 × 5 秒，约 3 分钟，生效即返回）；删除 admin-console 后的「必须被拒」复验同样适用。原先 6 次 × 5 秒（30 秒）不够：2026-10-10 生产 4 个账户在 30 秒内不带 ExternalId 仍被放行，被误判为 failed，几分钟后复测全部被拒。重跑收窄是幂等的：已存在的 `support_policy_backup` 不会被覆盖，角色上已有 `SupportQuotaRestricted` 时备份记为默认策略，ExternalId 沿用原值。

**重复标记幂等**：ExternalId 不变、`marked_at` 保留首次时间、已有备份不覆盖。已 `applied` 的 INVITED 账户删除 admin-console 后再标记会拿不到管理员凭证 —— 此时尚未改动任何 IAM，记录**保持 `applied`**，只写 `last_error`，不降级为 failed。

取消标记的**顺序不能反**：先取得管理员凭证（OAAR；没有 OAAR 时借用已有的人工开通，否则内部临时开通 1 小时，结束后立即回收；**0.54.0 起不再补回 `admin-console`**）→ 按 `support_policy_backup` 恢复 support 原托管/内联策略（旧记录无备份时用默认 ReadOnlyAccess + AWSSupportAccess + SupportQuotaPerms）→ 去掉 ExternalId 条件 → 删 `SupportQuotaRestricted` → 最后删记录。已知限制：恢复后的 support-quota 不回到组织级 StackSet 托管（同名角色已存在，StackSet 无法重建）。

调用侧（`aws-service.ts`）：
- AssumeRole `support-quota` 自动带上 `getExternalId(accountId)`；受限账户的 support 拒绝**不写入** `supportRoleUnavailable` 缓存（标记过程中信任策略切换的短暂拒绝不能把账户打入不可用直到重启）
- `assumeToAccount()` 对受限账户在 support 失败时**直接报错，不回退 OAAR**（查询类功能不自动提权）
- `getTempAdminCredentials()` / `assumeAdminViaOAAR()` 对受限账户忽略临时开通记录，直接走 OAAR；`durationHours > 1` 返回 409
- 区域开通（`routes/regions.ts` → `getTempAdminCredentials(id)`，1h）因此自动走 OAAR，路由不需要改；区域状态查询仍走 support-quota

受限账户会失去**资源清理扫描、账户详情的 IAM 安全状态、超过 1 小时的 Admin 临时凭证**，属预期取舍 —— 调用方应据 `isRestricted()` 给出明确提示，而不是抛裸 `AccessDenied`。ExternalId 加密存储（`external_id_enc`），列表接口不返回明文，只有严格 admin 可单独调 `/external-id` 取用于交付客户，并记 `ACCOUNT_EXTERNALID_VIEW` 审计。

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
| 新增页面 | `pages/Xxx.tsx` → `MainLayout.tsx` 的 `navItems`/`PAGE_META`/`pageComponent()` switch 各加一项（同一 key）→ `auth.ts` 的 `ALL_PAGE_KEYS` 加同名 key。<br>**若是独立权限页**（不想让「页面权限」勾选到）：**不要**加进 `PAGE_META` / `ALL_PAGE_KEYS`，改为导出一个 `XXX_PAGE_KEY` 常量，再补 `navItems`、`VALID_PAGE_KEYS`、`isPageAllowed()` 分支、`pageComponent()` 分支，以及 `MainLayout` 里按 URL 直达时的 `independentAccess` 判断——**漏掉最后一条会让有权限的用户直链进不去**。<br>移动端底栏 4 个高频位在 `MOBILE_PRIMARY_KEYS` + `MOBILE_SHORT_LABEL`；不放底栏的页面会自动出现在「更多」抽屉，无需额外登记。key 会自动成为 URL 路径（`VALID_PAGE_KEYS` 由 PAGE_META + 独立权限页推导）。高频页可加进 `KEEP_ALIVE_PAGES` 保活，但有轮询定时器的页面别加（隐藏时白轮询） |
| 加 payer | 按下方「新增 payer 安全 Runbook」执行；角色、双 StackSet、生产配置和验收缺一不可，不能只改 `config.json` |
| 新增公司模板 | `doc-templates.ts` 的 `COMPANY_PROFILES` 加资料 + `ACCOUNT_TO_COMPANY`/`PAYER_TO_COMPANY` 加映射 → 架构图放 `doc-templates/architectures/` |
| 调同步频率 | `scheduler.ts` |
| 客户要求收窄平台权限 | 账户页标记为「敏感权限客户」（`POST /accounts/restricted`）→ 收窄逻辑在 `restricted-accounts.ts`；改收窄范围要同步改 `RESTRICTED_POLICY_DOC` 与 `RESTRICTED_UNAVAILABLE` 提示，并跑 `tests/restricted-admin-access.test.ts` |

### 新增 payer 安全 Runbook

新增 payer 会创建高权限入口并向整个组织自动部署角色，必须按以下顺序执行。**禁止跳过验证后直接把组织加入 `consoleAdminPayers`。**

1. **核实身份与组织**：用独立 AWS Profile 查询 `sts get-caller-identity`、`organizations describe-organization`、`list-roots`、`list-accounts`，记录 management account、Organization ID、Root ID、成员数量和账户状态，确认没有连错组织。
2. **创建或核验管理账户 `role/tool`**：新建信任策略只允许 `arn:aws:iam::509399618054:user/mark`。当前平台模型依赖该角色管理 Organizations、StackSets、STS、配额、费用与账户能力，因此要求 `AdministratorAccess`；这是高权限入口，必须同时核验信任策略、permissions boundary 和实际 AssumeRole。
3. **启用 SERVICE_MANAGED 前置**：执行上文的 `enable-aws-service-access` 与 `activate-organizations-access`，并确认 `describe-organizations-access` 返回 `ENABLED`。
4. **先只登记 payer**：备份本地与 EC2 的 `config.json`，在两边 `payers[]` 加 `{ "name": "<payerName>", "roleArn": "arn:aws:iam::<managementAccountId>:role/tool" }`。此时不要加入 `consoleAdminPayers`；`config.json` 含密钥且被 gitignore，绝不能提交。
5. **在 EC2 权威数据环境部署 support-quota StackSet**：脚本会读取 `data/db.json.restricted_accounts`，所以必须在生产 `web/` 目录执行，不能用空白或陈旧的本地 DB 替代（`admin-console` 不再组织级下发，脚本的 `admin` 模式已移除）：

   ```bash
   cd ~/AWSTool/web
   npx tsx scripts/setup-org-stacksets.ts support <payerName>
   npx tsx scripts/setup-org-stacksets.ts support <payerName> --dry-run
   ```

6. **检查脚本结果**：任一组织异常会汇总为非零退出码；同时必须检查输出中的 `❌` 以及 `ok` / `susp` / `fail` 汇总，确保没有失败或异常挂起账户。
7. **回读 CloudFormation**：`support-quota-role-orgwide` 状态 `ACTIVE`、`PermissionModel=SERVICE_MANAGED`、`AutoDeployment.Enabled=true`、`RetainStacksOnAccountRemoval=false`，最近操作 `SUCCEEDED` 且失败实例为 0。仅有 management account 的组织显示实例数 0 是正常现象。
8. **注意模板漂移**：默认模式遇到已存在 StackSet 时仍使用 `UsePreviousTemplate=true`，不会自动改写角色定义。只有明确审查过模板差异后，才可执行 `npx tsx scripts/setup-org-stacksets.ts support <payerName> --refresh-template`；该模式强制指定单个 payer，会更新 StackSet 模板并对 Root OU 的已有实例执行 `UpdateStackInstances`。脚本会在刷新异常、operation 非 `SUCCEEDED` 或残留失败实例时返回非零，但仍须按第 6、7 步独立回读。
9. **通过后再开放 Admin UI**：本地与 EC2 的 `consoleAdminPayers` 唯一加入 `<payerName>`，`pm2 restart aws-toolbox`，然后刷新账户缓存。
10. **完整验收**：确认 payer 账户带 `_isPayer=true`、`_consoleDual=true`；分别实测 payer `role/tool`、成员 `support-quota` 与 OAAR；对一个 INVITED 账户临时开通 1 小时并提前关闭，确认 `admin-console` 可用后被删除；再检查区域扫描、Billing Console、PM2 online 和 HTTPS 200。只有这些检查通过才算接入完成。

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
- 平台长期凭证只在服务端；具备 `root_access` 的用户可显式请求 1 小时 Admin 临时凭证，只有数据库当前角色为 admin 才可在临时开通期内选择更长时长（不超过剩余时间）。长时请求仅走开通期内的 `admin-console` 直接一级跳；成员账户不再常驻管理员角色，临时开通仅限实时校验的 admin + TOTP；所有签发均实时鉴权、记录实际时长/到期时间且不落盘
- 密码 + TOTP MFA（window=2，150 秒容差），JWT 8 小时过期（固定时长，从登录起算，不滑动续期）
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
- 区域下拉已抽到 `client/src/constants/regions.ts`（0.46.1，34 个商业区全覆盖），配额 / 批量提额 / Bedrock 共用；label 写「国家·城市」，否则搜「巴西」「美国」搜不到（曾被误报为区域缺失）。`tests/regions.test.ts` 对照 AWS 全集锁定。`Cleanup.tsx`、`utils/export.ts` 仍各有一份区域表，AWS 开新区时要同步

---

## 相关文档

- 部署与数据安全细则：`.kiro/steering/deployment.md`
- 编码规范：`.kiro/steering/coding-standards.md`
- 开发流程：`.kiro/steering/development-methodology.md`
- 项目结构地图（给 AI 用）：`.kiro/steering/project-context.md`
- AWS 文档：https://docs.aws.amazon.com/
