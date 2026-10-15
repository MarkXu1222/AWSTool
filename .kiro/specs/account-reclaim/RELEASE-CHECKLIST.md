# 账户回收上线清单

日期：2026-10-15（Asia/Kuala_Lumpur）。状态：G3/G4 已获用户明确批准；0.56.0 已合入 main 并部署，生产只读检查通过，真实账户五步验收待执行。上线记录见 DEPLOYMENT-RESULT.md。

## 发布候选

- 分支：`integration/account-reclaim`，P4 修复提交 `785456e`。
- 已上线运行代码：`main` / `b9db13b07e6d77d239b7a8448d1b0ef4b0aaeadb`；发布时保留刚进入主干的 POC Solution 更新 `c44f637`，合并差异已独立复查。
- 候选版本：`0.55.1 → 0.56.0`，APP_VERSION、README、project-context、ROOT_EMAIL 与设计/交接已同步。
- 内容：账户回收 Tab、最多 20 个成员账户、TOTP、固定五步、逐步失败说明、安全重试、人工验证码、密码查看/复制、审计与通知。
- 固定顺序：删转发 → 改邮箱密码并踢旧会话 → 删 Root MFA → 允许恢复密码 → 改 AWS Root 密码。
- 权限：新增 account_reclaim_access；admin 恒 operate，其他用户默认 none；非 admin 仅本人批次，受限账户要求创建者当前为 admin。
- 复用邮箱平台与工具箱现有能力；Root 回收来源隔离，普通 Root 管理员操作保持兼容。
- 审核修复：Root 重试关联、普通 Root admin 重试、关停恢复、通知可靠性/不阻塞队列、并发幂等、无效全选控件。详见 P4-REVIEW.md。

## 已完成的本地验证

- [x] 独立审核、缺陷复现、修复及复查通过，无遗留阻断项。
- [x] 最新修复树 `npm test`：456/456，0 failed / cancelled / skipped。
- [x] `npm run typecheck`：client/server 全部通过。
- [x] `npm run build`：client/server/runtime assets 全部通过。
- [x] 运行数据、密钥、其他工作区变更未纳入提交。已有 package-lock 改动属于其他工作，本次没有新增依赖。
- [x] 候选版本 0.56.0 最终重构建通过，已回读生成的 client JS 确认包含 0.56.0。
- [x] 最终主干合并提交 `b9db13b` 重跑：469/469，typecheck 与 build 全通过；EC2 生产构建通过。

## 数据与运行配置

- db.json 新增顶层 `account_reclaim_jobs`；旧库缺失读为 []，无需手工改库或迁移脚本。
- 用户新增 account_reclaim_access，旧用户默认 none；只有 admin 恒有，不自动扩大其他权限。
- 邮箱密码复用现有字段加密，新增 mailbox-password 用途，并纳入密钥轮换；AWS 密码继续存原 Root store，不另复制。
- 回收记录及密码永久保留，不按条数/时间裁剪。备份同时保全 db.json、root-email-jobs.json 与独立匹配 keyring。
- 写邮箱配置：`MAIL_ADMIN_API_SSM_PARAMETER=/toolbox/mail-api-reclaim`；区域 `MAIL_API_SSM_REGION=us-east-1`。
- 只读邮件继续使用原 `/toolbox/mail-api`，与写 token 分离；保留既有 MAIL_API_SSM_PARAMETER 配置。
- 上线前确认服务身份可读取并解密写参数；仅从白名单 EC2 出口联调，配置与 secret 不写入清单或命令输出。
- 需要重启 `aws-toolbox`；保持单 PM2 进程及既有 billing runner 单实例锁，不开启 cluster 多 worker。
- 飞书通知使用已有 webhook。回收通知有 15 秒截止、失败保留补发，不能因通知故障影响账户步骤。

## 待确认与待执行

- [x] G3：用户明确确认 0.56.0 上线内容。
- [x] G4：用户明确授权合入主干、推送及按本清单部署；实际部署与只读验证已完成。
- [x] 部署前记录 `b98118d` / 0.55.1；配置、两份业务 JSON 与独立匹配 keyring 已备份并核验，目录 0700、文件 0600。
- [x] PM2 单进程在线、首页 200、现有 admin 登录会话、回收目录与确认弹窗、未登录 API 401；邮箱 SSM 读取及托管邮箱 lookup 通过。PM2 环境已保存。
- [ ] 选定可用于改密、删转发、移除 Root MFA 的授权测试账户，准备旧邮箱会话及受控转发测试；部署检查没有创建回收任务。
- [ ] 使用不同真实角色验证完整权限矩阵；本次生产页面检查使用现有 admin 会话，其他角色由本地测试覆盖，尚未做生产账号验收。
- [ ] 用授权测试账户完成五步并核验下方业务结果。

下列命令保留为部署操作模板；本次实际命令、主干并发更新与结果见 DEPLOYMENT-RESULT.md。未来执行仍需当次授权和状态复核：

```sh
# 本地：工作区其他改动保持原样，确认集成候选提交后合入并推送。
git switch main
git merge --no-ff integration/account-reclaim
git status --short
git push

# EC2：先按 .kiro/steering/deployment.md 完成受控备份，再更新代码。
cd ~/AWSTool
git pull --ff-only
cd web
npm run build
MAIL_ADMIN_API_SSM_PARAMETER=/toolbox/mail-api-reclaim MAIL_API_SSM_REGION=us-east-1 pm2 restart aws-toolbox --update-env
pm2 save
pm2 status
curl -s -o /dev/null -w '%{http_code}\n' https://markxu.co/
```

不执行 git add -A/add .，不在 EC2 stash/reset/checkout 数据文件；没有新增 npm 依赖，无需为本功能安装依赖。

## 上线后业务验收

- [ ] 删除转发后邮箱仍能收信，客户转发地址不再收到新邮件。
- [ ] 新邮箱密码可登录；旧密码不能登录；已登录旧 webmail 与 IMAP/POP3 客户端不能读取新的恢复邮件。
- [ ] 客户 Root MFA 已解除，恢复条件满足，新 AWS Root 密码可登录，旧密码失效。
- [ ] 页面五步全部满足才显示完成；新 AWS/邮箱密码可反复查看复制，每次有真实操作者审计。
- [ ] 失败/未知逐步说明，前四步阻断后续；password_unknown 无重试入口，API 同样拒绝。
- [ ] 回收来源不出现在 /rootreset，经旧路径查询/取消/重试/CSV/链接均拒绝。
- [ ] 无权限、仅回收权限、admin、受限账户非 admin 的页面及后端行为符合矩阵。
- [ ] 原资源清理、普通 Root 重置/管理员重试、其他工具箱页面无回归。
- [ ] 日志、审计和通知没有密码、邮件正文、验证码答案或 reset URL；关闭弹窗清空明文状态。

本地替身测试与已有邮箱 29/29 上线记录不等于此整套流程已经生产验收。

## 回滚安排

尚未生成回收任务时，可按部署前记录回滚代码及前端资源；保留当前业务数据。
已生成回收任务后，先停止新建入口并保全运行状态。回滚版本必须保留回收 origin 隔离及邮箱密文字段支持，不能将带回收数据的系统直接退回没有来源隔离的旧版并开放 /rootreset。
代码回滚不能恢复客户旧密码、MFA 或转发；不得用旧 DB 快照覆盖新增记录，不销毁匹配 keyring。必要时保留受控维护窗口处理未完成任务。
