# 邮箱 API 对接与联调记录

接口依据：`/Users/mark/邮箱平台/邮箱API接口文档.md`，v1，2026-09-14。

## 配置

| 项目 | 当前值 |
| --- | --- |
| 调用方 | AWS Toolbox 后端，平台 https://markxu.co |
| 基础地址 | https://admin.yottahub.ai |
| 路径前缀 | /Api/Maillog/ |
| key_id | toolbox |
| 出口 IPv4 / 白名单 | 54.255.131.45（用户确认已生效，服务器联调成功） |
| domains | 全部（用户当前配置） |
| 凭据配置 | 生产使用 MAIL_API_SSM_PARAMETER=/toolbox/mail-api，MAIL_API_SSM_REGION=us-east-1 |
| 使用接口 | GET list、GET detail；当前不依赖 raw 或 Webhook |

密钥不包含在此文档、仓库或前端。联调通过 SSH stdin 在远端进程内临时使用凭据；部署时以 SecureString 写入 Parameter Store。PM2 只保存参数路径，后端每 10 分钟重新读取一次。Mac 直接访问不符合当前 IP 白名单。

## 签名和查询

签名串为 `GET|PATH|TIMESTAMP|NONCE|SHA256(空字符串)`；PATH 不包含 query。以 secret 的 UTF-8 字符串为 HMAC-SHA256 key，结果为小写 hex。请求头为 X-Api-Key、X-Timestamp、X-Nonce、X-Signature。nonce 为每次随机生成的 32 位 hex，时间戳用 Unix 秒。

列表使用 `since_id`、`limit=100`、`direction=receive`、`domain`、`search=目标邮箱`。search 是模糊过滤，Toolbox 在本地再次精确检查收件人及本次请求时间。详情按 `msg_key` 获取，使用已解码的 body_text / body_html 解析 URL，不渲染邮件 HTML。

每个任务持久保存游标，全部调用共用节流队列，间隔至少 1250ms。处理 429 / Retry-After、Apache HTML 403、鉴权错误和短暂服务故障。详见 [ROOT_EMAIL.md](ROOT_EMAIL.md)。

## 2026-09-14 实测

- 文档中的 PHP/Python 签名测试向量通过。
- 从白名单服务器运行实际 TypeScript MailApiClient，鉴权、列表与详情响应校验通过。
- 授权测试账户 edwardreyes@nexstack.asia 查询到 2 封相关邮件：恢复邮件（ID 4820）和密码已更新通知（ID 4821）。已从恢复邮件正文提取出合法 AWS RootUser 重置 URL；未将 URL 写入代码、报告或任务文件。
- 密码更新通知只能说明邮箱收到了该通知，本次没有重新设置密码或验证登录，也没有重新请求恢复邮件。
- 第一页 2 条，next_since=4821；下一页为空，next_since 仍为 4821。接口两页均返回 has_more=true。Toolbox 已兼容空页不前进的情况，转为间隔轮询。

### 邮箱平台可修正的分页问题

在上述过滤条件下，空结果且游标不前进时，has_more 应为 false。建议使用与 list 相同的 domain / direction / search 条件计算 has_more。Toolbox 的兼容逻辑使该问题不再阻塞接入。

## 上线状态

Toolbox 邮箱查询和页面入口已在本地接入；尚未部署或持久配置生产凭据。后续部署需注入环境变量并重启服务，同时确认浏览器/OCR 运行依赖就绪，再用一个授权账户验证平台全流程。邮箱服务器的建表、索引及 cron 由邮箱平台侧管理，本次没有执行这些操作。
