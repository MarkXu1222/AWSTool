# TODO: 绑定域名后的安全加固

## 触发条件
当用户提到绑定域名、配置域名、DNS 设置时，提醒执行以下操作。

## 待办事项

### 1. 配置 Nginx 反向代理 + HTTPS
- 安装 Nginx + Certbot
- 配置反向代理 3000 端口
- 申请 Let's Encrypt SSL 证书
- 强制 HTTPS 跳转

### 2. 限制 CORS
- 将 `web/server/index.ts` 中的 `origin: true` 改为 `origin: 'https://具体域名'`
- 重启服务

### 3. Security Group 收紧
- 关闭 3000 端口的公网访问（只允许 localhost）
- 80/443 端口可选只开放 Cloudflare IP（如果用 Cloudflare 代理）
- 或者只开放用户常用 IP

### 4. 可选：Cloudflare 代理
- DNS 走 Cloudflare 代理（橙色云朵）
- 开启 WAF 防护
- Security Group 只允许 Cloudflare IP 段

## EC2 信息
- IP: 54.255.131.45
- 区域: ap-southeast-1 (Singapore)
- SSH: `ssh -i /Users/mark/mark-sg-key.pem ec2-user@54.255.131.45`
