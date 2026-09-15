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
- `data/root-email-jobs.json` — **永久 Root 凭证库**（包含可解密的 AES-256-GCM 密文）
- `data/backups/**` — 数据库与永久 Root 凭证库的本地备份
- `config.json` — **真实密钥**（AK/SK、adminPassword、jwtSecret、encryptionKey、历史 keyring、feishuWebhook）
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
3. 如果是**数据/配置文件**（data/、config.json）→ 绝不能丢弃；先将 `data/db.json`、`data/root-email-jobs.json` 和 `config.json` 复制到权限为 `0700` 的受控备份目录，确认 `.gitignore` 已排除后再处理

## 数据保护机制（已实现）
- `data/db.json`、`data/root-email-jobs.json` 已移出 git 跟踪
- 服务启动以及长时间运行期间每天首次 DB 读取时，校验两个源 JSON，并在 Root 快照中排除 `setting_password`/failed/unknown 及旧策略已披露的密文，再分别原子备份为 `data/backups/db-YYYY-MM-DD.json` 和 `data/backups/root-email-jobs-YYYY-MM-DD.json`；两类各保留最近 7 天，目录 `0700`、文件 `0600`
- 首次安装可安全创建空 `root-email-jobs.json`；一旦已有 Root 备份，主文件缺失会失败关闭，绝不自动创建空库掩盖丢失
- 自动备份目录**不包含** `config.json`。`web.encryptionKey` 与 `web.encryptionKeyPrevious` 必须在独立受控位置备份；密文和匹配 keyring 缺一都无法恢复
- 本机备份与源文件处于同一故障域，仍需使用受控 EBS 快照/AWS Backup 或等效异机备份，并定期做联合恢复演练
- 重大部署前应在 `/home/ec2-user/awstool-deploy-backups/<commit>-<timestamp>/` 中分别备份 `config.json`、`data/db.json` 和 `data/root-email-jobs.json`，目录权限设为 `0700`，文件权限设为 `0600`

## 永久 Root 凭证恢复与密钥轮换
- 恢复前先停止 `aws-toolbox`，保全当前文件，再从同一天快照恢复 `db.json` 和 `root-email-jobs.json`；恢复匹配的独立 keyring 后统一设为 `0600`，离线验证历史 `gcm1`、历史 `gcm2` 和当前 `gcm2` 均可解密，最后启动服务
- 轮换时把旧 `web.encryptionKey` 移入 `web.encryptionKeyPrevious`，再设置新 current key。服务启动会认证并原子重加密在线 MFA、ExternalId 和永久 Root 凭证到 current key：DB 迁移审计与密文同次写入；Root 跨文件迁移持久化待审计补偿标记，并以一条有界 `system` 汇总审计覆盖本轮全部记录，审计未落盘就停止启动并在重启后重试。首次从 JWT-secret CBC 迁移时，旧 `jwtSecret` 仅作为 legacy 字段候选。在线迁移完成后仍须等待包含旧密文的本地/异机备份轮替并完成恢复验证，才能删除 historical key；历史 key 最多 8 个
- key ID 由用途分离密钥计算，不是密钥本身；未知 key ID 或认证失败会关闭下载，不得以删除/改写任务记录规避

## EC2 访问信息
- IP: 54.255.131.45（域名 https://markxu.co）
- SSH: `ssh -i /Users/mark/mark-sg-key.pem ec2-user@54.255.131.45`
- 服务: PM2 进程名 `aws-toolbox`，运行方式 `npx tsx server/index.ts`（不编译，改 .ts 直接生效）
