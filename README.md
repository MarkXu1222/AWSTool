# AWS Toolbox

AWS 多账户管理工具箱，支持桌面版 (Electron) 和 Web 版（手机可用）。

## 功能

- **账户管理** — 查看所有 Linked Accounts，组织层级，费用，MFA 状态
- **配额管理** — 查询/提升 Service Quotas，记录持久化，同步最新状态
- **资源清理** — 先查账单看资源分布 → 扫描 → 选择性删除（双重确认）
- **账单分析** — 按账户/服务维度查看费用，导出 CSV/JSON
- **多 Payer** — 同时管理多个 Organizations，账户合并展示
- **安全** — Web 版支持 MFA 登录，凭证不暴露给前端

## 项目结构

```
AWS/
├── config.json            # 共享配置（两端共用）
├── electron/              # 桌面版主进程
├── src/                   # 桌面版前端 (React + Ant Design)
├── web/                   # Web 版（Express + React）
│   ├── server/            # API 后端
│   ├── client/            # 前端
│   ├── Dockerfile
│   └── docker-compose.yml
├── package.json           # 桌面版依赖
└── .kiro/                 # 开发指导文件
```

## 配置文件 (config.json)

桌面版和 Web 版共用同一个 `config.json`，改一处两边生效。

```json
{
  "credentials": {
    "accessKeyId": "你的 Access Key ID",
    "secretAccessKey": "你的 Secret Access Key"
  },
  "region": "us-east-1",
  "payers": [
    { "name": "yanhuang11", "roleArn": "arn:aws:iam::133354366329:role/tool" },
    { "name": "yanhuang14", "roleArn": "arn:aws:iam::976592800319:role/tool" }
  ],
  "childRoleName": "OrganizationAccountAccessRole",
  "web": {
    "port": 3000,
    "adminPassword": "Web版登录密码",
    "jwtSecret": "随机32位字符串用于签发token"
  }
}
```

| 字段 | 说明 |
|------|------|
| `credentials` | tools 用户的 AK/SK（134 账户） |
| `region` | 默认 AWS 区域 |
| `payers` | Payer 管理角色列表，支持多个 |
| `childRoleName` | 跳转子账户时使用的角色名 |
| `web.port` | Web 版服务端口 |
| `web.adminPassword` | Web 版登录密码 |
| `web.jwtSecret` | JWT Token 签名密钥 |

## 认证链路

```
tools 用户 AK/SK (134103550877)
    ├── AssumeRole → yanhuang11 (133354366329, Admin)
    │      └── AssumeRole → 子账户 OrganizationAccountAccessRole
    └── AssumeRole → yanhuang14 (976592800319, Admin)
           └── AssumeRole → 子账户 OrganizationAccountAccessRole
```

## 桌面版

### 安装运行

```bash
pnpm install
pnpm approve-builds --all
npx vite build
npx tsc -p tsconfig.main.json
npx electron .
```

### 特点
- macOS 原生窗口样式
- Apple 设计风格 (light theme)
- 本地加密存储配额记录
- 双重确认删除操作

## Web 版

### 本地运行

```bash
cd web
pnpm install --ignore-workspace
npx vite build --config client/vite.config.ts
npx tsx server/index.ts
```

浏览器打开 `http://localhost:3000`

### Docker 部署（EC2）

```bash
cd web
docker-compose up -d
```

### 登录信息
- 用户名: `admin`
- 密码: config.json 中的 `web.adminPassword`
- MFA: 首次登录后在设置中启用

### 安全措施
- 密码 + TOTP MFA 双因素认证
- JWT Token 2小时过期
- 登录限速 (5次/15分钟)
- API 限速 (100次/分钟)
- 凭证只在服务端，前端拿不到
- 操作审计日志

## 更新部署

```bash
# 本地改代码后
git add . && git commit -m "feat: xxx" && git push

# EC2 上
git pull && docker-compose up -d --build
```

## 添加新 Payer

编辑 `config.json`，在 `payers` 数组里加一条：

```json
{ "name": "新组织名", "roleArn": "arn:aws:iam::账户ID:role/tool" }
```

然后重启桌面版或 Web 版即可。
