# 集成、审核与部署 Runbook

覆盖 P3（集成与审核）、P4（发版收尾）、P5（部署与验证）。

数据安全红线来自 `.kiro/steering/deployment.md`，**优先级高于本文的一切效率考量**。

---

## P3 集成与审核

### 1. 建集成分支

```bash
git fetch --all
git switch -c integration/<需求名> <主干分支>
```

### 2. 串行合入

**一次一个**，顺序按 P1 定的依赖波次。禁止一把梭全合。

```bash
git merge --no-ff <任务分支>     # 或 git cherry-pick <sha>
```

每合入一个，立刻做三件事：

1. **就地审核** —— 对照 `README.md` 第九节高危区 和 `.kiro/steering/coding-standards.md`。必要时调 `superpowers:requesting-code-review`。
2. **跑该任务的验收命令** —— 简报里写的那个。
3. **确认文件越界** —— `git show --stat` 看实际改了什么，和该任务的独占清单比对。越界的改动先回退再谈。

### 3. 冲突处理

冲突由协调者解，解完必须重跑该任务的验收。

**同一对文件连续冲突两次 = 拆分失败。** 停下来，退回 P1 重拆，不要硬解——硬解出来的代码没有任何一个 worker 验证过。

### 4. 审核重点（本项目特有）

按 `README.md` 第九节，这些地方的错误肉眼很难发现：

| 区域 | 审什么 |
|------|--------|
| `bedrock-delivery.ts` 的 `normalizeProfileName()` | scope 词 `us`/`global` 有没有被折叠掉 |
| Bedrock TPD 的 `inherited` 标记 | 是不是按标记判断，而不是按"有没有值" |
| `billing-exporter.ts` | 有没有保持 headed + `--kiosk-printing`、每账户独立浏览器实例、固定 `access='support'` |
| `case-doc-submitter.ts` | 成功判定是不是只认 Reply textarea 收起 |
| `index.ts` 的 CORS | 拒绝是不是 `callback(null, false)` 而不是 throw |
| 任何 CSV 导出 | 数字有没有误加千分位 |
| `restricted-accounts.ts` | `getExcludedAccountIds()` 有没有被"顺手"加上 state 过滤 |
| POC Cash IAM 策略 | action 前缀是 `partnercentral:` 而不是 `partnercentral-selling:` |
| 路由注册顺序 | 具体路径有没有排在通配之前 |
| 前端样式 | 有没有裸 hex、魔法 z-index、emoji 当图标、成功提示带感叹号 |

### 5. 全量回归

全部合完后，在集成分支上跑：

```bash
cd web
npm test          # tests/*.test.ts
npm run typecheck # client + server 两个 tsconfig
npm run build     # vite build + tsc + copy-runtime-assets
```

**三个全绿才算通过。** 有红就修到绿；修不动就退回对应 worker，不要带红进 P4。

收尾调 `superpowers:verification-before-completion` 自查一遍。

---

## P4 发版收尾

这三类文件**只有协调者改**：

1. `web/client/src/version.ts` —— 递增 `APP_VERSION`。小改（样式、文案、小 bug）递增 patch；大改（新功能、结构调整）递增 minor。
2. `README.md` —— 同步功能模块表 / 目录结构 / 接口清单 / 关键实现 / 已知待办。
3. `.kiro/steering/project-context.md` —— 补齐索引；架构决策记到第十节。

### 闸门 G2：向用户汇报

```
本次上线内容
- 需求：<一句话>
- 包含任务：<列表>
- 改动文件：<列表，按 前端/后端/文档 分组>
- 版本号：<旧> → <新>
- 测试：npm test ✅ / typecheck ✅ / build ✅
- schema 变更：<无 / 有，具体说明与兼容策略>
- 需要重启：是（pm2 restart aws-toolbox）
```

等用户明确批准。

---

## P5 部署与验证

**由 Claude 亲自执行，不交给 codex。**

### 闸门 G3

把下面的完整命令清单打给用户，**等用户回明确的确认词**。没回，一条都不准跑。

### 步骤 1：合回主干并推送

```bash
git switch <主干分支>
git merge --no-ff integration/<需求名>
git status                                  # 确认没有 data/、config.json 被 staged
git push
```

⚠️ **禁止 `git add -A` / `git add .`**。本阶段是 merge，不该有新的 add；如果需要 add，只 add 具体代码文件。

### 步骤 2：EC2 部署前备份

```bash
ssh -i /Users/mark/mark-sg-key.pem ec2-user@54.255.131.45
```

```bash
COMMIT=$(cd ~/AWSTool && git rev-parse --short HEAD)
BK=/home/ec2-user/awstool-deploy-backups/${COMMIT}-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BK" && chmod 0700 "$BK"
cp ~/AWSTool/config.json "$BK"/
cp ~/AWSTool/data/db.json "$BK"/
cp ~/AWSTool/data/root-email-jobs.json "$BK"/
chmod 0600 "$BK"/*
ls -la "$BK"
```

备份没成功就**停在这里**，不要继续。

### 步骤 3：拉代码、构建、重启

```bash
cd ~/AWSTool && git pull -q
cd web
npm install                                     # 仅当 package.json / lock 变化时
npx vite build --config client/vite.config.ts
pm2 restart aws-toolbox
```

### 步骤 4：验证

```bash
pm2 status
pm2 logs aws-toolbox --lines 50 --nostream
curl -sI https://markxu.co | head -1
```

再人工确认：

- [ ] 页面能打开，左下角 `APP_VERSION` 是新版本号（旧版本号说明前端没构建成功）
- [ ] 本次新增/改动的功能实际点一遍
- [ ] `pm2 logs` 没有新的报错
- [ ] 老功能抽查一两个（登录、账户列表）

---

## EC2 上的禁止操作

任何情况下不准执行：

- ❌ `git stash` —— 会把 EC2 上的真实数据文件暂存后丢弃
- ❌ `git checkout -- data/` —— 会还原/删除数据库
- ❌ `git reset --hard` —— 会丢弃所有本地状态
- ❌ 任何会动 `data/`、`config.json` 的 git 操作

`git pull` 报冲突时：

1. 先 `git status` 看是哪些文件冲突
2. **代码文件**冲突 → `git checkout -- <具体代码文件>` 丢弃 EC2 本地改动再 pull
3. **数据/配置文件**（`data/`、`config.json`）冲突 → 绝不能丢弃。先把 `data/db.json`、`data/root-email-jobs.json`、`config.json` 复制到权限 `0700` 的受控备份目录，确认 `.gitignore` 已排除后再处理

---

## 回滚预案

部署后验证失败，**立刻退版，不在生产上调试**。

### 首选：本地 revert 后正向部署

这是唯一不违反红线的回滚方式。

```bash
# 本地
git switch <主干分支>
git revert --no-edit -m 1 <合并 commit 的 sha>
git push
```

```bash
# EC2
cd ~/AWSTool && git pull -q
cd web && npx vite build --config client/vite.config.ts
pm2 restart aws-toolbox
pm2 status && curl -sI https://markxu.co | head -1
```

确认左下角版本号退回旧值。

### 数据层面出问题时

代码回滚**不会**恢复被改动的数据。如果本次上线动了 `data/db.json` 的 schema 或写入了脏数据：

1. 先 `pm2 stop aws-toolbox`，停止继续写入
2. 保全当前文件（另存一份，不要覆盖）
3. 从步骤 2 的部署前备份目录，或 `data/backups/db-YYYY-MM-DD.json` 恢复
4. 权限设回 `0600`
5. `pm2 start aws-toolbox`，验证

涉及 `data/root-email-jobs.json`（永久 Root 凭证库）的恢复，必须同时恢复匹配的 keyring，并离线验证历史 `gcm1`、历史 `gcm2`、当前 `gcm2` 均可解密——密文和 keyring 缺一都无法恢复。详见 `.kiro/steering/deployment.md`。

### 回滚后

向用户汇报：回滚到了哪个版本、数据有没有受影响、失败原因初判、下一步计划。然后**回到 P0 重走流程**，不要在主干上打补丁。
