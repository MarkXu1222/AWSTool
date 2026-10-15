# 账户回收 P4 审核与验证记录

日期：2026-10-15（Asia/Kuala_Lumpur）。审核基线 `432b46e`，范围 `b98118d..432b46e`；P4 修复提交 `785456e`，分支 `integration/account-reclaim`。

## 结论

独立审核发现 5 项重要问题、1 项界面问题，已全部复现、修复并通过复查。复查未发现遗留 Critical / Important / Minor 问题，可进入发布准备。本结论不代替 G3/G4 批准或生产五步验收。

## 问题与修复

| 问题 | 根因与影响 | 修复与验证 |
|---|---|---|
| P1：Root 安全重试关联失败 | 子任务已写入时，回收指针仍指向 source；授权及崩溃恢复将其误判为错误关联。 | 仅容许指针保留为当前 attempt 的 retryOfJobId；其余账户、来源、邮箱、payer、创建者及重试血缘仍完全匹配。真实临时 DB + Root store 重启绑定回归通过，错误指针仍拒绝。 |
| P2：普通 Root 管理员重试回归 | 新加的创建者相等检查也应用于普通 Root 任务，导致 admin 不能按原权限重试他人任务。 | 仅回收来源强制保留创建者；普通来源恢复原 admin 接管语义。真实 RootEmailStore 回归及重载验证通过。 |
| P2：关停中断被误记为部分失败 | 第五步尚未入队、正在检查运行依赖时关停，503 被转换为终态 partial，重启不能自动接续。 | stopping 期间保留已持久化 running attempt，启动后继续同一个请求 ID；回归确认无终态事件版本递增。 |
| P2：通知失败误记为送达，挂起阻塞队列 | 原通知 helper 吞掉传输/平台失败，runner 误记 outcomeNotifiedRevision；等待通知还阻塞后续账户。 | 回收调用 strict 模式，15 秒截止、HTTP/业务/网络失败均拒绝；终态发送独立于编排，每账户去重，只在确认后回写最新匹配 outcomeRevision。失败可补发，旧结果不能误确认新结果，关停等待有界通知。旧两参数调用保持原行为。 |
| P2：并发相同 requestId 返回冲突 | 最后一次 replay 检查排在 active-account 冲突后。 | replay 提前到冲突检查之前；并发调用返回同一批次，一次创建、一次审计。 |
| P3：表头全选无效 | controlled selection 只实现单行 onSelect，表头按钮没有处理逻辑。 | 隐藏无效表头全选，保留单行勾选及 20 个上限；真实 React/AntD DOM 回归通过。 |

上述回归均先观察到缺陷导致失败，再验证修复后通过。原桥接测试替身覆盖不足，本轮新增真实 Root store 的桥接集成测试；通知测试直接覆盖生产 helper 的响应处理。

## 验证结果

| 检查 | 结果 |
|---|---|
| 修复前最新集成基线 `npm test` | 444/444，通过，0 skipped |
| 修复后 `npm test` | 456/456，通过，0 failed / cancelled / skipped |
| `npm run typecheck` | 前后端通过，exit 0 |
| `npm run build` | Vite + server tsc + runtime assets，通过，exit 0 |
| 独立复查 | 六项均修复，无新增阻断；另独立通过 UI/通知 17/17、typecheck 及关联/通知竞态检查 |
| `git diff --check` | 通过；未纳入其他工作区改动 |

候选版本更新后再构建，结果见 RELEASE-CHECKLIST.md。测试记录位于本轮临时验证目录 `/tmp/account-reclaim-p4.KRbHry/`；本文件保留可长期复核的结果摘要。

2026-10-15 上线前主干并发更新补验：`origin/main` 新增 POC Solution `c44f637`，保留后合并为 `b9db13b`。独立窄范围复查确认账户回收运行代码未变、双方文档合并完整、路由/权限/依赖无冲突；该提交全量 469/469、typecheck、build 通过。生产构建及部署检查见 DEPLOYMENT-RESULT.md。

非阻断警告：npm 提示已有 `shamefully-hoist` 项目配置不被识别；Vite 提示 vendor chunk 超过 1200 kB。两者不影响本轮退出状态，不在本需求内修改依赖或拆包。

## 验证边界

- 本轮测试使用隔离临时 DB、替身网络及 DOM，没有调用真实 AWS/邮箱写操作，没有发送真实飞书通知。
- 生产邮箱接口、SSM 与白名单沿用 HANDOFF 的既有上线记录；本轮没有重新做生产联调。
- 真实客户旧邮箱会话、转发与新/旧 AWS 登录的完整五步结果，必须在授权测试账户上上线后核验。
- IAM/SSO/Access Key 撤销不在本功能范围。账户内存量资源的清理由原资源清理功能处理。
