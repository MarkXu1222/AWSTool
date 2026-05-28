# AWS Toolbox — Web Edition

手机/多设备/多人使用的在线版本，带 MFA 登录保护。

## 架构

```
浏览器 (PC/手机) → HTTPS → Express API → AWS SDK → 你的 AWS 组织
                          ↑
                     凭证只在服务器
                     MFA 登录保护
                     操作审计日志
```

## 快速部署

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入你的真实凭证
```

### 2. Docker 部署（推荐）

```bash
docker-compose up -d
```

访问 `http://your-server:3000`

### 3. 首次使用

1. 用 `admin` / 你设置的 `ADMIN_PASSWORD` 登录
2. 进入设置页面 → 启用 MFA
3. 用 Google Authenticator 扫码绑定
4. 之后每次登录需要密码 + 6 位动态码

## 环境变量说明

| 变量 | 说明 | 示例 |
|------|------|------|
| `AWS_ACCESS_KEY_ID` | tools 用户 AK | `AKIAR6OJR...` |
| `AWS_SECRET_ACCESS_KEY` | tools 用户 SK | `JTnqmI...` |
| `PAYERS` | Payer 列表 (name\|arn 逗号分隔) | `yh11\|arn:...,yh14\|arn:...` |
| `JWT_SECRET` | Token 签名密钥 (≥32位随机字符) | `a7f3b9c...` |
| `ADMIN_PASSWORD` | 初始管理员密码 | `MyStr0ng!` |
| `PORT` | 服务端口 | `3000` |

## 更新部署

```bash
git pull
docker-compose up -d --build
```

## 安全措施

- ✅ 密码 + TOTP MFA 双因素认证
- ✅ JWT Token 2小时过期
- ✅ 登录限速 (5次/15分钟)
- ✅ API 限速 (100次/分钟)
- ✅ Helmet 安全头
- ✅ HTTPS (配合 nginx/cloudflare)
- ✅ 凭证只在服务器内存，不暴露给前端
- ✅ 操作审计日志
