# Root 密码恢复：批量发信与邮件链接查询

账户详情 → 根用户 →「发送 Root 密码恢复邮件」。每次选择一个已有 ACTIVE 成员账户，邮箱从服务器账户缓存读取，调用方不能覆盖邮箱。

独立导航「批量重置 Root 密码」（`/rootreset`）使用独立的 `root_reset_access` 权限，支持选择 payer、搜索账户、跨页多选、选择全部筛选结果、复制所选邮箱域名清单，以及查看/停止历史批次。配置邮箱 API 后，AWS 确认发信的任务会继续等待恢复邮件。页面显示「等待邮件」「已找到重置链接」「邮件查询失败」，并提供获取链接的入口。

后台使用独立 Chrome 配置目录进入 AWS 忘记密码页面，通过本地 PP-OCRv6 模型识别验证码。两个固定预处理结果一致且为 6 位字母数字才提交；最多处理 3 张图片。只有 AWS 显示 `Password email sent` 才记录 `sentAt`。配置邮箱 API 时进入 `waiting_mail`，未配置则终止于 `email_sent`。发信和找到链接均不表示密码已修改。

后端按账户精确匹配收件人、请求时间，读取邮件并提取 AWS 重置链接。点击「获取重置链接」后，通过弹窗前往 AWS 页面，由用户填写并提交新密码。平台不生成或保存密码。集中式根访问的「允许恢复密码」仍是现有独立操作，不会随发信任务自动改变账户权限。

## 权限设置

入口：设置 → 用户 → 编辑用户 → 批量重置 Root 密码权限。创建用户时也可配置。

| 值 | 显示 | 范围 |
| --- | --- | --- |
| none | 不开放 | 菜单隐藏，接口拒绝访问 |
| view | 仅查看 | 账户清单、所有批次进度；无发信、停止或重置链接权限 |
| operate | 可使用 | 查看、发信、停止本人任务、获取本人重置链接 |

管理员始终可管理全部任务。其他用户缺少字段时默认不开放，原 root_access、allowed_pages 不会自动授予此功能；管理员需要单独设置。授权记录写入用户审计，未指定具体用户时不会批量修改已有授权。后台每次敏感操作复验，撤销或降为查看后，旧会话不能继续发信或取链接，执行任务也会停止。页面导航在刷新后读取最新权限。

## 运行依赖

- Chrome：沿用 `CHROME_PATH`，也会查找 macOS Chrome 和 Linux `/usr/bin/google-chrome[-stable]`。
- Python 3.13 虚拟环境：设置 `ROOT_EMAIL_PYTHON` 为其 Python 可执行文件绝对路径。Mac 默认使用 `~/.cache/aws-ocr-lab/venv/bin/python`。
- Linux headed Chrome 需要 Xvfb，`ROOT_EMAIL_DISPLAY` 默认 `:99`。Chrome 以普通用户、启用沙箱运行。
- 源码运行方式：`tsx server/index.ts`。`npm run build` 会把 OCR 脚本复制到编译目录；也可用 `ROOT_EMAIL_OCR_SCRIPT` 显式指定脚本路径。

示例安装（在准备部署的机器执行，平台不会在请求过程中安装软件）：

```sh
python3.13 -m venv /opt/aws-toolbox-ocr
/opt/aws-toolbox-ocr/bin/pip install -r server/scripts/root-email-requirements.txt
```

以运行服务的用户预先下载 RapidOCR 官方模型：

```sh
/opt/aws-toolbox-ocr/bin/python - <<'PY'
from rapidocr import RapidOCR, OCRVersion, ModelType, LangRec
RapidOCR(params={
    'Global.use_det': False, 'Global.use_cls': False, 'Global.use_rec': True,
    'Rec.ocr_version': OCRVersion.PPOCRV6,
    'Rec.model_type': ModelType.SMALL, 'Rec.lang_type': LangRec.EN,
})
PY
/opt/aws-toolbox-ocr/bin/python server/scripts/root-email-ocr.py --check
```

环境变量由现有进程管理器注入，设置后重启服务。不要把密钥、账户邮件正文或密码写进此文档。生产依赖检测失败时按钮会显示具体的未就绪原因。

冻结的识别权重 `PP-OCRv6_rec_small.onnx` SHA256 为 `6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884`。每次识别前检查，防止模型更新后继续使用旧评测结论。脚本仅接收 stdin 中的验证码图像、返回候选 JSON，不创建截图/识别报告。现有 6 张开发样本以及一次人工编排的在线发信验证通过，不代表任意验证码都可识别。

## 邮箱 API 配置与轮询

- 生产使用 `MAIL_API_SSM_PARAMETER=/toolbox/mail-api`、`MAIL_API_SSM_REGION=us-east-1`。参数类型必须为 SecureString，值为包含 keyId、secret 的 JSON；后端通过 AWS CLI 和平台现有 AWS 身份读取，在内存缓存 10 分钟。需要该参数的 GetParameter / 解密权限。
- `MAIL_API_SECRET`、`MAIL_API_KEY_ID` 仍支持临时环境注入；生产 PM2 只保存参数路径，不保存邮箱 secret。
- `MAIL_API_KEY_ID`：默认 `toolbox`。接口固定为 `https://admin.yottahub.ai/Api/Maillog/`。
- 当前允许出口为 `54.255.131.45`；Mac 直接调用不在白名单。
- HMAC 签名按接口文档实现，GET path 不含 query；每次生成新的 32 位 hex nonce。
- 同一服务进程内所有列表/详情调用共用队列，启动间隔至少 1250ms，约 48 次/分钟；429 按 Retry-After 退避。一个 key 不应同时运行多个独立轮询进程。
- 每个任务从游标 0 查询，按域名、邮箱搜索并分页；本地再验证精确收件人和请求时间。只对匹配时间与收件人的候选读取正文。每次处理完一页才保存游标，详情读取暂时失败不会跳过该邮件。
- 无更多数据时至少间隔 5 秒查询；多个任务公平轮流等待，因此不保证每个账户 5 秒内查到。单任务从发信确认起最多等待 10 分钟，超时不会自动重发。
- 实测空结果页仍可能返回 has_more=true 且游标不前进，此时按无更多数据处理，避免空转。
- `link_ready` 只保存邮件标识和时间。列表、任务文件与审计均不包含正文或带 token 的 URL；用户获取链接时后端重新读取并校验，响应 no-store。链接仍可能过期，以 AWS 页面为准。
- 邮件 HTML 不渲染。仅解析并接受 HTTPS、精确域名 signin.aws.amazon.com、路径 /resetpassword、RootUser 类型及预期参数。

## 任务和恢复语义

- 当前浏览器全局并发为 1，邮件查询独立进行；最多 500 个排队/执行/等待邮件任务；单批最多 500 个账户。每个账户同时只能有一个任务，创建间隔至少 60 秒。
- 批次仅允许所选 payer 下的 ACTIVE 成员账户。提交与执行前都复验归属，管理账户不可选。所有账户校验通过后原子写入，任何冲突都拒绝整个新批次。
- 客户端为每次选择生成请求 UUID；相同 UUID、创建者、payer 和账户集合的重试返回原批次，避免网络重试重复发信。
- API 和每次浏览器敏感操作前，从数据库复验创建者身份、批量重置操作权限及账户邮箱。
- 已授权查看的用户可查看账户清单和全部批次进度；非管理员只有 operate 权限才能创建任务、取消本人任务和获取本人重置链接。管理员可管理所有任务。
- 提交后的网络超时不自动重发，标记 `interrupted` 并提示检查收件箱。明确的验证码错误才允许换图重试。
- 用户停止或超过 3 分钟会中断任务，关闭浏览器和 OCR 子进程。已经发出的请求无法撤回。
- 服务重启把排队/浏览器执行任务标记为 `interrupted`，不会从头自动触发恢复；已经发信的 `waiting_mail` 任务保留游标与截止时间，继续只读查询。
- 元数据保存在 `DB_PATH` 同目录的 `root-email-jobs.json`，原子写入、权限 `0600`；不会更改主数据库结构。备份时应单独包含此文件。
- 执行器在现有 billing runner 获得 OS 单实例锁后启动，不支持多个服务进程共享写入。
- 审计记录任务创建及结果；任务查询轮询不写审计。浏览器临时配置在任务结束后删除。

## API

全部接口沿用 JWT 身份验证和实时 `root_reset_access` / admin 权限，并返回 `Cache-Control: no-store`。

| 方法 | 路径（前缀 `/api/aws`） | 用途 |
| --- | --- | --- |
| GET | `/root-email/availability` | Python、模型、Chrome 路径、显示器自检；结果缓存 60 秒 |
| GET | `/root-email/catalog` | 配置的 payer、成员账户缓存与可选状态、缓存时间 |
| GET | `/root-email/batches` | 可见的最近 20 个批次汇总 |
| GET | `/root-email/batches/:id` | 批次进度和每个账户的结果 |
| POST | `/root-email/batches` | `{ payerAccountId, accountIds, requestId, confirmSend: true }`；requestId 为 UUID v4，原子创建批次 |
| POST | `/root-email/batches/:id/cancel` | 停止批次，取消排队项并中断执行项；已发送邮件不受影响 |
| GET | `/root-email/accounts/:accountId/jobs` | 当前用户可见的最近 20 个账户任务 |
| POST | `/root-email/accounts/:accountId/jobs` | body 为 `{ "confirmSend": true }`；成功返回 202 和新任务 |
| POST | `/root-email/jobs/:id/cancel` | 取消排队、停止执行或等待邮件；终态请求幂等 |
| POST | `/root-email/jobs/:id/reset-link` | 按需读取已就绪任务的链接；仅任务所有者或管理员，重新检查批量重置操作权限 |

成功响应 `{ "success": true, "data": ... }`；错误响应 `{ "error": "..." }`。重复任务 409、间隔/队列限制 429、运行环境未就绪 503。UI 不把 `email_sent` 标记为「密码重置完成」。

邮箱 API 交接参数及实测出口记录见 [MAIL_API_HANDOFF.md](MAIL_API_HANDOFF.md)。

## 验证

```sh
node --import tsx --test tests/root-email.test.ts tests/root-mail-links.test.ts tests/mail-api.test.ts tests/root-reset-permissions.test.ts
npx tsc --noEmit -p server/tsconfig.json
npx tsc -p client/tsconfig.json
npx vite build --config client/vite.config.ts
```

测试通过模拟外部 AWS 会话验证重试上限、超时不重发、权限撤销/取消、持久化、重启恢复和重复任务限制，不会发送真实邮件。上线后仍需选择授权测试账户验证平台执行器的实际页面兼容性。

2026-09-14：25 项离线测试、前后端类型检查与生产构建通过；模拟页面已验证三个邮件状态和获取链接弹窗；已从白名单服务器使用实际 TypeScript 客户端验证鉴权、列表分页、详情读取。测试账户的历史恢复邮件可提取 AWS 链接。该次为部署前验证，未触发新的真实恢复邮件。部署结果见下方。

部署配置：服务器已安装 Python 3.13，OCR 环境位于 `/home/ec2-user/.cache/aws-toolbox-ocr/venv`，配置 `ROOT_EMAIL_PYTHON=/home/ec2-user/.cache/aws-toolbox-ocr/venv/bin/python`、`ROOT_EMAIL_DISPLAY=:99`。Parameter Store 凭据在账号 509399618054、区域 us-east-1，版本 1。原密钥未写入 Git 或 PM2 环境快照。

## 生产部署记录（2026-09-15，北京时间）

- 功能代码版本：`5a3c989`，已发布到 https://markxu.co/rootreset ，PM2 aws-toolbox 已重启并保存配置。
- 在生产机器通过 26 项测试与构建；Python/OCR 自检、启用沙箱的 headed Chrome 启动通过。
- 实际后端从 SSM 读取凭据，查询测试账户历史邮件并匹配恢复链接成功；PM2 环境快照不含邮箱 secret。
- 公网页面 HTTP 200，返回新前端资源；未登录访问敏感 API 返回 401。数据库用户、账户缓存、配额申请条数与部署前一致。
- 回退材料：`/home/ec2-user/deploy-backups/root-mail-20260914T155616Z`，包含原版本号、前端资源、原数据库及配置备份。回退代码时保留当前运行时数据库，不能以旧备份覆盖新增业务记录。
- 本次上线检查未创建真实发信任务；新批次仍须由有批量重置操作权限的用户从页面选择账户并提交。

权限更新验证：29 项测试通过，包括 HTTP 读写权限矩阵、旧会话降权、身份变化和任务所有权；模拟页面已验证权限保存回显及只读用户查看批次时不显示操作入口。
