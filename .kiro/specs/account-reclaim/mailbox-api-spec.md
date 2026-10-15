# 邮箱写接口需求 —— 供 AWSTool「账户回收」调用

> 交付对象：EwoMail 管理平台（`/ewomail/www/ewomail-admin`，服务器 13.228.91.148）的维护者。
> 调用方：AWSTool 后端（https://markxu.co，出口 IP `54.255.131.45`）。
> 现有只读接口 `/Api/Maillog/*` 及其鉴权（`api/ApiAuth.class.php`）保持不变。

## 1. 背景

AWSTool 新增「账户回收」：收回客户离场的 AWS 账户时，需要
① 删除该账户 Root 邮箱的转发规则；② 修改该邮箱的登录密码。
AWSTool 还需要在执行前批量确认邮箱是否托管在本邮箱服务器上。

## 2. 鉴权（沿用 ApiAuth，新增 scope）

签名算法、请求头、时间窗、nonce 防重放、限流全部沿用 `ApiAuth::check()`：

```
X-Signature = hex(hmac_sha256(secret, METHOD|PATH|TIMESTAMP|NONCE|sha256(body)))
```

POST 时 `body` 为原始 JSON 字节串，AWSTool 对**同一字节串**计算 sha256 并发送。

### 2.1 新增 `scopes`

`/ewomail/secure/mailapi.json` 的 token 新增可选字段 `scopes`（字符串数组）：

| scope | 允许的接口 |
|-------|------------|
| `mailbox:read` | `POST /Api/Mailbox/lookup` |
| `mailbox:write` | `POST /Api/Mailbox/forwards/delete`、`POST /Api/Mailbox/password` |

- **没有 `scopes` 字段的旧 token（现有 `toolbox`）不得调用 `/Api/Mailbox/*`**，返回 403 `SCOPE_DENIED`。
  `/Api/Maillog/*` 的行为不变。
- 新建 token 供 AWSTool 使用：

```json
{
  "key_id": "toolbox-reclaim",
  "secret": "<新随机 64 位 hex，不得与 toolbox 相同>",
  "active": 1,
  "allow_ip": ["54.255.131.45"],
  "domains": ["*"],
  "scopes": ["mailbox:read", "mailbox:write"]
}
```

`domains` 语义与现有一致：邮箱域名不在 token 的 `domains` 范围内时，按 `DOMAIN_NOT_HOSTED` 处理（不泄露是否存在）。

### 2.2 请求要求

- 仅接受 `POST`，`Content-Type: application/json`，body ≤ 16 KB，否则 400 `INVALID_REQUEST`
- 邮箱地址统一转小写、去首尾空白后再处理；格式不合法 → 400 `INVALID_EMAIL`
- 强制 HTTPS（沿用）

## 3. 响应格式

成功（沿用 `ApiAuth::ok`）：

```json
{ "status": 1, "msg": "", "data": { ... } }
```

失败：在现有 `{status:0, msg}` 基础上**新增 `code` 字段**（机器可读，AWSTool 据此给出中文说明）：

```json
{ "status": 0, "msg": "Mailbox not found", "code": "MAILBOX_NOT_FOUND" }
```

| HTTP | code | 场景 |
|------|------|------|
| 400 | `INVALID_REQUEST` | 非 JSON、缺字段、body 过大、数组超长 |
| 400 | `INVALID_EMAIL` | 邮箱格式不合法 |
| 400 | `INVALID_PASSWORD` | 密码不满足 §4.3 约束 |
| 403 | `SCOPE_DENIED` | token 无对应 scope |
| 404 | `DOMAIN_NOT_HOSTED` | 域名不在 `i_domains`，或不在 token `domains` 范围 |
| 404 | `MAILBOX_NOT_FOUND` | 域名托管但 `i_users` 无此邮箱 |
| 409 | `MAILBOX_DISABLED` | `i_users.active = 0` |
| 500 | `INTERNAL_ERROR` | 数据库/doveadm 失败（`msg` 写可读原因，**不得含密码**） |

鉴权、签名、限流类错误沿用现有 HTTP 码与 `msg`，并补对应 `code`：
`AUTH_FAILED`（401）、`IP_NOT_ALLOWED`（403）、`RATE_LIMITED`（429，保留 `Retry-After`）。

> **2026-10-15 上线差异（以此为准）**：生产 `https://admin.yottahub.ai`（ewomail-admin `131d49e`），Apache 层 `/Api/Mailbox` 仅放行 `54.255.131.45`。
> ① 改密**不做** `doveadm auth cache flush`（服务器未开认证缓存，改密即时生效），只踢会话；改密 500 的 `msg` 为 `doveadm who failed: ...` 或 `doveadm kick failed: ...`，此时密码已写入，同一密码重试幂等。
> ② 另有 404 `NOT_FOUND`（路径写错）、403 `HTTPS_REQUIRED`。③ §7 自检 29/29 通过。邮箱侧文档：ewomail-admin `docs/账户回收接口.md`。

## 4. 接口

### 4.1 `POST /Api/Mailbox/lookup` —— 批量查询邮箱状态（scope `mailbox:read`）

只读。用于预检（账户列表）与执行前复核。

请求：

```json
{ "emails": ["a@nexstack.asia", "b@example.com"] }
```

- `emails` 1–100 个，去重后处理

响应 `data`：

```json
{
  "items": [
    { "email": "a@nexstack.asia", "domainHosted": true,  "exists": true,  "active": true,
      "forwards": ["customer@gmail.com"] },
    { "email": "b@example.com",   "domainHosted": false, "exists": false, "active": false,
      "forwards": [] }
  ]
}
```

- 返回顺序与去重后的请求顺序一致，每个请求邮箱恰好一项
- 单个邮箱不托管/不存在**不让整个请求失败**，在该项里用字段表达
- `forwards`：`i_aliases` 中 `source = email AND destination != email AND active = 1` 的 `destination` 列表；
  自投递行（`source = destination`）不列出

### 4.2 `POST /Api/Mailbox/forwards/delete` —— 删除邮箱转发（scope `mailbox:write`）

请求：

```json
{ "email": "a@nexstack.asia" }
```

行为：

1. 校验域名托管、邮箱存在（不存在 → 对应错误码；`active=0` 仍允许删转发）
2. 删除 `i_aliases` 中 `source = email AND destination != email` 的**所有**行（含 `active = 0` 的）
3. **保留**自投递行 `source = destination = email`；若自投递行不存在则补一条（`active=1`），
   保证删除转发后本邮箱仍能正常收信
4. 写操作日志（§5）

响应 `data`：

```json
{ "deleted": 1, "removed": ["customer@gmail.com"] }
```

- **幂等**：没有转发时返回 `{"deleted": 0, "removed": []}`，HTTP 200
- 本接口不处理「邮件组（Group）」成员关系

### 4.3 `POST /Api/Mailbox/password` —— 修改邮箱密码（scope `mailbox:write`）

请求：

```json
{ "email": "a@nexstack.asia", "password": "<AWSTool 生成的新密码>" }
```

密码约束（服务端校验，不满足 → `INVALID_PASSWORD`）：

- 长度 12–32
- 仅可打印 ASCII（0x21–0x7E），**不含**空格、`'`、`"`、`\`、`` ` ``

> AWSTool 实际生成 16 位，字符集 `A-Z a-z 0-9` 与 `!@#%^*-_=+`。
> 不复用后台表单 `User::checkPassword` 的 8–20 位限制。

行为：

1. 校验域名托管、邮箱存在、`active = 1`（禁用 → `MAILBOX_DISABLED`）
2. 按现有方式写入 `i_users.password`（与 `module/Center/Users.php` / `api/User.class.php` 相同的 `md5()`，
   确保 Dovecot 与 webmail 认证一致）
3. **使旧凭据立即失效**：
   - 刷新 Dovecot 认证缓存：`doveadm auth cache flush <email>`（未开启缓存时该命令无害）
   - 踢掉该用户现有 IMAP/POP3 会话：`doveadm kick <email>`
   - 两条命令在容器内执行（`docker exec ewomail ...` 或平台现有方式）；
     **任一失败 → 返回 500 `INTERNAL_ERROR`，`msg` 说明哪条失败**（密码已写入也照此返回，
     AWSTool 会用同一密码重试，因此步骤 2 必须幂等）
4. 写操作日志（§5），**不记录密码**

响应 `data`：

```json
{ "updated": true, "sessionsKicked": 2 }
```

- **幂等**：用同一密码重复调用必须返回成功

## 5. 审计

每次 `/Api/Mailbox/*` 调用写入现有 ApiAuth 日志，另对写操作写 `i_admin_log`（或等效操作日志表）：

- key_id、客户端 IP、动作（`forwards_delete` / `password_set`）、邮箱、结果、`deleted` 数量 / 删除的目标地址
- **绝不记录**请求 body 原文与密码

## 6. 限流

沿用单 key 60 次/分钟。AWSTool 侧自身串行、间隔 ≥ 1250 ms，正常不会触发。

## 7. 自检清单（实现方完成后请逐条确认）

- [ ] 旧 `toolbox` key 调 `/Api/Mailbox/lookup` → 403 `SCOPE_DENIED`；`/Api/Maillog/list` 仍正常
- [ ] 新 `toolbox-reclaim` key 从非白名单 IP 调用 → 403
- [ ] `lookup` 混合托管/非托管/不存在/禁用邮箱，每项字段正确，HTTP 200
- [ ] 测试邮箱先加一条转发，`forwards/delete` 返回 `deleted:1`；再调一次返回 `deleted:0`；
      自投递行仍在，向该邮箱发信仍能收到，原转发地址收不到
- [ ] `password` 改完：webmail 新密码可登录、旧密码不可登录；已登录的 IMAP 客户端被断开；
      同一密码再调一次返回成功
- [ ] 密码含空格/引号/反斜杠或长度 11 → 400 `INVALID_PASSWORD`
- [ ] 日志里查不到任何密码明文
- [ ] 签名用 POST body 原文计算，body 改一个字节 → 401

## 8. 交付给 AWSTool 的信息

实现完成后请提供（不要把 secret 发在聊天里，直接写入 AWS SSM）：

1. 写入 Parameter Store SecureString `/toolbox/mail-api-reclaim`（账号 509399618054，us-east-1），
   值为 `{"keyId":"toolbox-reclaim","secret":"..."}`
2. 告知已完成 §7 自检
