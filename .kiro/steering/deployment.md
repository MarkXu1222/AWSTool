# 部署与数据安全规则（强制遵守）

## 背景教训
早期把 `data/db.json` 纳入了 git 跟踪，部署时 EC2 的 `git stash`/`git pull` 把真实数据当作代码冲突处理，导致**审计日志和配额记录被覆盖丢失**。此规则用于防止再次发生。

---

## ✅ 应该提交（代码 + 静态资源）
- `web/server/**` — 后端代码
- `web/client/src/**` — 前端代码
- `web/package.json` / `web/package-lock.json` — 依赖清单
- `doc-templates/architectures/**` — 架构图（静态资源）
- `web/server/doc-templates.ts` — 公司模板
- `config.example.json` — 配置示例（无真实密钥）
- `electron/**`、`src/**` — 桌面版代码

## ❌ 绝对不提交（运行时数据 + 密钥）
这些已在 `.gitignore`，永远不要提交：
- `data/db.json` — **数据库**（审计日志、配额记录、用户、账户缓存、MFA 密钥）
- `data/backups/**` — 数据库备份
- `config.json` — **真实密钥**（AK/SK、adminPassword、jwtSecret、encryptionKey、feishuWebhook）
- `提额文档/` — 参考文档（体积大）
- `node_modules/`、`dist/`

---

## 提交纪律（关键）
1. **只 add 具体的代码文件**，例如：
   ```
   git add web/server/xxx.ts web/client/src/pages/xxx.tsx
   ```
2. **绝不使用** `git add -A` 或 `git add .` —— 会把 db.json、config.json 等运行时文件带进去
3. 提交前先 `git status` 确认没有数据/密钥文件被 staged

## EC2 部署流程（安全版）
```
本地:  git add <具体代码文件> → git commit → git push
EC2:   cd ~/AWSTool && git pull -q
       cd web && npm install(仅当依赖变化) && npx vite build --config client/vite.config.ts
       pm2 restart aws-toolbox
```

## EC2 上的禁止操作（会毁数据）
- ❌ `git stash` —— 会把 EC2 上的真实数据文件暂存后丢弃
- ❌ `git checkout -- data/` —— 会还原/删除数据库
- ❌ `git reset --hard` —— 会丢弃所有本地状态
- ❌ 任何会动 `data/`、`config.json` 的 git 操作

如果 EC2 `git pull` 报冲突：
1. 先 `git status` 看是哪些文件冲突
2. 如果是**代码文件**冲突 → `git checkout -- <代码文件>` 丢弃 EC2 本地改动再 pull
3. 如果是**数据/配置文件**（data/、config.json）→ 绝不能丢弃，先备份 `cp data/db.json /tmp/`，确认 .gitignore 已排除后再处理

## 数据保护机制（已实现）
- `data/db.json` 已移出 git 跟踪
- 服务启动时自动备份 db.json 到 `data/backups/db-YYYY-MM-DD.json`，保留最近 7 天
- 部署前如有重大变更，可手动备份：`cp data/db.json /tmp/db-manual-$(date +%s).json`

## EC2 访问信息
- IP: 54.255.131.45（域名 https://markxu.co）
- SSH: `ssh -i /Users/mark/mark-sg-key.pem ec2-user@54.255.131.45`
- 服务: PM2 进程名 `aws-toolbox`，运行方式 `npx tsx server/index.ts`（不编译，改 .ts 直接生效）
