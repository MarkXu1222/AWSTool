# AWS Toolbox

企业级 AWS 多账户（多 Organizations）管理平台。支持桌面版（Electron）和 Web 版（手机/多人可用，已上线 `https://markxu.co`）。

统一管理 11 个 AWS Organizations、上千个子账户，覆盖账户管理、配额提升、区域开通、账单分析、资源清理、提额文档自动生成、审计与通知等全流程。

---

## 目录
- [核心功能](#核心功能)
- [系统架构](#系统架构)
- [认证链路](#认证链路)
- [功能实现详解](#功能实现详解)
- [配置说明](#配置说明)
- [部署与运维](#部署与运维)
- [数据安全](#数据安全)

---

## 核心功能

| 模块 | 功能 | 说明 |
|------|------|------|
| **概览** | 费用/账户数/进行中 Case 统计 | 数据缓存，秒级加载 |
| **账户管理** | 列表、详情、费用、MFA、根用户状态与凭证操作 | 免登录进控制台、生成临时凭证、删 Root MFA、恢复根密码 |
| **配额管理** | 多区域查询、提升、记录持久化、流式同步 | 含**一键生成提额 PDF 文档** |
| **区域管理** | opt-in 区域开通状态扫描、单个/批量开通 | 含中文区域名 |
| **账单分析** | 按账户查看费用、占比、导出 | Cost Explorer |
| **资源清理** | 分步流程：选账户 → 看账单 → 扫描资源 | 删除需双重确认 |
| **审计日志** | 所有操作记录（含 IP、用户、详情） | 可按用户/操作筛选 |
| **设置** | MFA、密码、用户管理 | 新用户**强制绑定 MFA** |
| **通知** | 飞书机器人推送配额变动 | 当前值实际变化时触发 |

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│  浏览器 (PC/手机 PWA)  →  https://markxu.co                    │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTPS (Let's Encrypt, 自动续期)
┌───────────────────────────▼─────────────────────────────────┐
│  Nginx 反向代理 (EC2 Singapore 54.255.131.45)                 │
│   - 80 → 443 强制跳转, HSTS                                    │
│   - 仅代理 127.0.0.1:3000                                      │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  Express + tsx (PM2 进程 aws-toolbox)                          │
│   - JWT + MFA 认证, RBAC, 限流                                 │
│   - 后台定时同步 (账户/配额/区域)                              │
│   - AWS SDK (STS/Organizations/ServiceQuotas/CE/Account)      │
│   - 数据存 data/db.json (每日自动备份)                         │
│   - Puppeteer + Chrome → 生成提额 PDF                          │
│   - 飞书 Webhook 通知                                          │
└───────────────────────────┬─────────────────────────────────┘
                            │ AssumeRole 链
┌───────────────────────────▼─────────────────────────────────┐
│  11 个 AWS Organizations (yanhuang1~19) → 上千子账户            │
└─────────────────────────────────────────────────────────────┘
```

**技术栈**
- 前端：React 18 + Ant Design 5 + Vite（单 bundle，避免跨境网络分包超时）
- 后端：Express + TypeScript（tsx 直接运行，改 .ts 即生效）
- 数据：JSON 文件存储（`data/db.json`）+ 内存缓存
- 部署：EC2 + Nginx + PM2 + Let's Encrypt

---

## 认证链路

```
工具用户 AK/SK (134103550877)
    │
    ├─ AssumeRole → payer 的 tool 角色 (如 133354366329:role/tool)
    │      └─ AssumeRole → 子账户 OrganizationAccountAccessRole
    │
    └─ (11 个 payer，每个下辖一批子账户)
```

- 工具用户先 AssumeRole 到各 Organization 的 `tool` 角色（拿 Organizations 管理权限）
- 再从 payer AssumeRole 到子账户的 `OrganizationAccountAccessRole`
- 账户→payer 映射缓存，避免重复探测

---

## 功能实现详解

### 1. 免登录进入 AWS 控制台 / Support Case
- **机制**：STS Federation（联合登录）。后端用 AssumeRole 的临时凭证，调用 `signin.aws.amazon.com/federation` 换取 signin token，拼接成一次性登录 URL。
- **效果**：点账户的"控制台"按钮或提升记录的 Case ID → 新标签**免登录**直接进入对应子账户的 AWS 控制台 / Support Case 页面，可直接上传材料。
- **成本**：完全免费，不需要 Business Support 计划。

### 2. 提额文档自动生成（PDF）
- **机制**：HTML 模板 + Puppeteer（系统 Chrome）渲染为 PDF。
- **数据来源**：
  - 公司背景库（`doc-templates.ts`）— 每个 Organization 对应一家公司的统一背景（从历史 SOW 文档总结）
  - 架构图库（`doc-templates/architectures/`）— 每家公司专属架构图
  - 子账户 → 通过缓存的 `_payer` 字段匹配所属公司
- **动态生成**：申请值自动拆解成资源组件表（合计=申请值）；配额类型自动识别 AWS 官方名称（vCPU/EIP/Lightsail/Mac/Workspace 等）；预测值≈申请值的 1.5 倍。
- **入口**：提升记录每行的"生成文档"按钮，一键下载 PDF。

### 3. 配额管理
- **多区域查询**：覆盖全部 33 个 AWS 区域（含 opt-in），并发查询，8 秒超时跳过未开通区域。
- **流式同步（SSE）**：全量同步用 Server-Sent Events 实时推送进度，数据边查边出，支持万级账户。
- **当前值**：单账户查询时实时 enrich 当前配额值；全量同步也补当前值。
- **记录持久化**：所有提升记录存 DB，含状态、Case ID、区域、当前/期望值。

### 4. 区域管理
- 扫描所有账户的 opt-in 区域开通状态（ENABLED/DISABLED/ENABLING）
- 区域总览（开通率进度条）+ 按账户搜索查看
- 支持单个/批量开通，区域显示中文名

### 5. 飞书通知
- **机制**：飞书自定义机器人 Webhook，发送交互式卡片。
- **触发条件**：后台定时同步（每 4 小时）检测到配额**当前值实际变化**时推送（提交、状态变化不通知，避免刷屏）。
- **内容**：按账户分组，显示所属组织（yanhuang几）、配额、区域、旧值→新值、达标标记。
- **防刷屏**：首次同步（空快照）不通知；用同步前快照对比，避免误判。

### 6. 后台定时同步（Scheduler）
| 任务 | 频率 | 说明 |
|------|------|------|
| 账户列表 | 30 分钟 | 写入缓存，页面秒级加载 |
| 配额记录 + 当前值 | 4 小时 | 分批（每批8个，间隔2秒）防限流 |
| 区域状态 | 24 小时 | opt-in 区域扫描 |
| 概览费用缓存 | 2 小时 | Cost Explorer 结果缓存 |

### 7. 强制 MFA + 权限模型（RBAC）
- **强制 MFA**：新用户首次登录必须绑定 MFA 才能使用（前端引导 + 后端 `authMiddleware` 拦截未绑定用户的业务接口）。
- **角色（role）**：
  - `admin` — 全部页面 + 所有操作 + 用户管理 + 根用户凭证操作
  - `partadmin` — 仅勾选页面 + 业务操作（配额提升 / 删 key 等），不能管理用户
  - `viewer` — 仅勾选页面，只读（写操作被 `requireAdmin` 拦截）
- **页面权限（`allowed_pages`）**：admin 视为全部；partadmin / viewer 按勾选的左侧菜单页面显示（在 设置→用户 中分配）。
- **根用户凭证权限（`root_access`）**：独立于角色的开关，控制账户"根用户"tab 的三个敏感功能（生成 Admin 临时凭证 / 删 Root MFA / 恢复根密码）。**admin 恒有**；其他用户由管理员在 设置→用户 中单独勾选授予。后端 `requireRootAccess` 从数据库实时校验（不信任 JWT 中的旧角色/权限），前端无该权限则完全隐藏这三个功能。

### 8. 审计日志
- 所有操作（登录、配额提升、区域启用、用户管理等）记录用户、IP、操作类型、详情、时间。
- IP 自动清理 IPv6-mapped 前缀（`::ffff:`）。

### 9. 根用户凭证操作（账户"根用户"tab）
针对成员账户根用户的三个敏感操作，均受 `root_access` 权限控制（见上方权限模型），且全部记入审计：

| 功能 | 机制 | 有效期 / 说明 |
|------|------|--------------|
| 生成 Admin 临时凭证 | AssumeRole 到账户管理员角色（selfPayer 直连 payer role / 成员账户二级跳 `OrganizationAccountAccessRole`），**不**走受限的 support-quota | 1 小时；支持复制 AK/SK/Token、导出为环境变量、倒计时、刷新 |
| 删除 Root MFA | 集中式根访问 `sts:AssumeRoot`（任务策略 `IAMDeleteRootUserCredentials`）→ `DeactivateMFADevice` + `DeleteVirtualMFADevice` | 先用管理员凭证 `ListVirtualMFADevices` 定位 root 设备；仅虚拟 MFA |
| 恢复根用户密码 | `sts:AssumeRoot`（任务策略 `IAMCreateRootUserPassword`）→ `CreateLoginProfile`（省略 UserName/Password） | 触发 AWS 密码恢复流程，向该账户根邮箱发送重置邮件 |

- **前提**：删 MFA / 恢复密码依赖 AWS **集中式根访问**（`sts:AssumeRoot`，2024 年底特性）——需组织已启用该功能，且工具用户具备 `sts:AssumeRoot` 权限。AssumeRoot 会话上限 15 分钟，且必须使用区域性 STS 端点（不支持全球端点）。
- **权限入口**：设置 → 用户 → 添加/编辑用户 → 勾选"根用户凭证权限"（admin 默认拥有）。用户表有"根用户权限"列可一览。
- **审计动作**：`TEMP_CREDENTIALS`（生成临时凭证）、`ROOT_MFA_DELETE`（删 MFA）、`ROOT_PASSWORD_RECOVER`（恢复密码）。

---

## 配置说明

桌面版和 Web 版共用根目录 `config.json`（在 `.gitignore` 中，不入库）。

```json
{
  "credentials": { "accessKeyId": "...", "secretAccessKey": "..." },
  "region": "us-east-1",
  "payers": [
    { "name": "yanhuang11-skymora", "roleArn": "arn:aws:iam::133354366329:role/tool" }
  ],
  "childRoleName": "OrganizationAccountAccessRole",
  "web": {
    "port": 3000,
    "adminPassword": "登录密码",
    "jwtSecret": "128位hex随机串",
    "encryptionKey": "独立加密密钥(MFA密钥加密用)",
    "feishuWebhook": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
  }
}
```

| 字段 | 说明 |
|------|------|
| `payers[].name` | 组织名，格式 `yanhuang编号-公司名`（用于文档/通知匹配公司） |
| `web.encryptionKey` | 独立于 jwtSecret 的密钥，用 AES-256-CBC 加密存储 MFA secret |
| `web.feishuWebhook` | 飞书机器人 Webhook，留空则不通知 |

### 添加新 Organization
1. 在目标 payer 账户创建 `tool` 角色，信任工具用户 134103550877，授予 Organizations/STS/ServiceQuotas/CE/Account 权限
2. 子账户需有 `OrganizationAccountAccessRole`
3. `config.json` 的 `payers` 加一条，重启服务

---

## 部署与运维

### 本地开发
```bash
cd web
pnpm install --ignore-workspace
npm run dev        # 前端(5174) + 后端(3000) 并行
```

### EC2 部署流程
```bash
# 本地（只提交代码，不提交 data/、config.json）
git add <具体代码文件> && git commit -m "..." && git push

# EC2
ssh -i mark-sg-key.pem ec2-user@54.255.131.45
cd ~/AWSTool && git pull -q
cd web && npx vite build --config client/vite.config.ts
pm2 restart aws-toolbox
```

### HTTPS（已配置）
- Nginx 反向代理 + Let's Encrypt 证书（`markxu.co`，自动续期）
- 80 强制跳 443，HSTS 开启
- Node 仅监听 127.0.0.1，外网只能通过 Nginx 访问

---

## 数据安全

> ⚠️ **重要教训**：`data/db.json` 早期被纳入 git 跟踪，部署时 `git stash`/`pull` 把真实数据当冲突丢弃，导致审计日志丢失。现已修复。

**当前防护：**
- `data/db.json`、`config.json` 已移出 git 跟踪，部署不会覆盖
- 服务启动时自动备份 db.json 到 `data/backups/`（保留最近 7 天）
- MFA secret 用 AES-256-CBC 加密存储
- 凭证只在服务端，不通过任何 API 暴露给前端
- 提交纪律：只 add 具体代码文件，禁用 `git add -A`；EC2 禁用 stash/reset --hard

**登录安全：**
- 密码 + TOTP MFA（window=2，150秒容差）
- JWT 2 小时过期
- 登录限流 5次/15分钟，API 限流 100次/分钟
- Helmet 安全头 + CORS 限制为 markxu.co

---

## 项目结构

```
AWS/
├── config.json                    # 共享配置（不入库）
├── data/db.json                   # 数据库（不入库，自动备份）
├── doc-templates/
│   └── architectures/             # 各公司架构图
├── electron/                      # 桌面版主进程
├── src/                           # 桌面版前端
├── web/
│   ├── server/
│   │   ├── index.ts               # Express 入口
│   │   ├── auth.ts                # JWT/MFA/RBAC
│   │   ├── aws-service.ts         # AWS SDK 封装 + 联合登录
│   │   ├── db.ts                  # JSON 存储 + 备份
│   │   ├── scheduler.ts           # 后台定时同步
│   │   ├── notify.ts              # 飞书通知
│   │   ├── doc-templates.ts       # 公司背景库
│   │   ├── doc-generator.ts       # PDF 生成
│   │   └── routes/                # API 路由
│   └── client/src/                # 前端页面
└── .kiro/steering/                # 开发规范（部署/数据安全等）
```
