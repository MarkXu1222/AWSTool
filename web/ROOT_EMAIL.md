# Root 密码恢复：手工发信与批量自动改密

账户详情 → 根用户 →「发送 Root 密码恢复邮件」仍创建单账户手工任务：邮箱从服务器账户缓存读取，调用方不能覆盖；找到恢复链接后由有权限的操作者手工打开 AWS 页面设置密码。

独立导航「批量设置 Root 密码」（`/rootreset`）创建自动改密批次。系统按 payer 选择最多 20 个 ACTIVE 成员账户，发送恢复邮件、精确匹配收件人和请求时间、重新校验 AWS 一次性链接，然后生成并提交 24 位强随机密码。创建批次必须精确输入 payer 名称、账户数量和当前 TOTP。

后台使用独立 Chrome 配置目录进入 AWS 忘记密码页面，通过本地 PP-OCRv6 模型识别验证码，最多处理 3 张图片。找到链接后，同一浏览器执行槽位只接受 `https://signin.aws.amazon.com/resetpassword` 的 `RootUser` 链接，要求恰好两个可见密码框和唯一的明确提交按钮。只有 AWS 返回明确成功文案才记录 `password_set`；提交后结果不明确时记录 `password_unknown`，绝不重试一次性链接。

新密码由 Node.js CSPRNG 生成，固定 24 位并包含大小写、数字和符号。密码以任务上下文作为 AAD，使用用途分离密钥和 AES-256-GCM 临时写入任务文件；最多保留 30 分钟。若批次仍未完成，系统会在最早凭证到期前 10 分钟停止剩余任务。批次创建者通过新的 TOTP 下载一次 CSV；服务端发送任何字节前先持久化 claim；正常响应完成时销毁密文，若响应已开始后中断也按可能披露立即销毁。列表 API、审计和飞书通知均不包含明文密码或 reset URL。

## 权限设置

入口：设置 → 用户 → 编辑用户 → 批量重置 Root 密码权限。创建用户时也可配置。

| 值 | 显示 | 范围 |
| --- | --- | --- |
| none | 不开放 | 菜单隐藏，接口拒绝访问 |
| view | 仅查看 | 账户清单、所有批次进度；不能创建、停止或下载凭证 |
| operate | 可使用 | 创建/停止本人任务；本人创建的批次完成后可一次性下载凭证 |

管理员可管理全部任务，但不能覆盖创建者下载其他人的 Root 密码 CSV。其他用户缺少字段时默认不开放，原 root_access、allowed_pages 不会自动授予此功能。后台每次敏感操作复验权限；创建批次和下载 CSV 还必须通过 step-up TOTP。权限撤销后，旧会话不能继续操作，执行中的任务也会停止。

## 运行依赖

- Chrome：沿用 `CHROME_PATH`，也会查找 macOS Chrome 和 Linux `/usr/bin/google-chrome[-stable]`。
- Python 3.13 虚拟环境：设置 `ROOT_EMAIL_PYTHON` 为其 Python 可执行文件绝对路径。Mac 默认使用 `~/.cache/aws-ocr-lab/venv/bin/python`。
- Linux headed Chrome 需要 Xvfb，`ROOT_EMAIL_DISPLAY` 默认 `:99`。Chrome 以普通用户、启用沙箱运行。
- 自动改密要求配置邮箱 API，以及至少 32 字符的 `config.web.encryptionKey` 或 `ENCRYPTION_KEY`。缺任一项时后端在发送恢复邮件前失败关闭。
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
- `link_ready` 只保存邮件标识和时间，不保存 URL。自动批次由执行器重新读取邮件并校验链接；旧手工任务按需返回 no-store 链接。列表、任务文件与审计均不包含正文或带 token 的 URL。
- 邮件 HTML 不渲染。仅解析并接受 HTTPS、精确域名 signin.aws.amazon.com、路径 /resetpassword、RootUser 类型及预期参数。

## 任务和恢复语义

- 浏览器全局并发为 1，恢复邮件发信和密码提交共用同一槽位；已验证的一次性链接优先。邮件查询独立进行。全局最多 500 个待处理任务，自动改密单批最多 20 个账户；每账户同时只能有一个任务，创建间隔至少 60 秒。
- 自动批次仅允许所选 payer 下的 ACTIVE 成员账户。所有账户先完成归属、邮箱、数量、typed confirmation、MFA、邮箱 API 和加密密钥检查，再原子写入；任何冲突都拒绝整个新批次。
- 只有新安全批次写入 `autoSetPassword=true`。升级前已存在或单账户手工创建的 `link_ready` 任务不会因部署而自动修改密码。
- 客户端为每次选择生成请求 UUID；相同 UUID、创建者、payer 和账户集合的网络重试返回原批次，避免重复发信。
- API、邮件查询和每次浏览器敏感操作前都从数据库复验创建者身份、operate 权限、payer 归属及账户邮箱。
- 状态流程：`queued → running → waiting_mail → link_ready → setting_password → password_set`。AWS 发信提交结果不明时进入 `waiting_mail` 做只读确认，不重复发信。有效 reset 页在 `DOMContentLoaded` 后短暂切换执行上下文时，提交前最多容忍 6 次 DOM 读取失败；明确失败为 `password_failed`。确认尚未进入提交边界的 Chrome 加载/导航异常会关闭首次浏览器后最多安全重试一次，并只持久化不含 URL/token 的阶段码与错误分类；点击提交后超时、服务中断或页面异常为 `password_unknown`，密码密文立即销毁且绝不自动重试。自动尝试耗尽、已精确绑定恢复邮件且明确未提交密码时，创建者可在 60 分钟内通过新 TOTP 按需重扫同一接收时间的邮件并手工打开/复制链接；候选不唯一、存在同账户更新任务或 `password_unknown` 时拒绝返回。手工设置结果无法由平台确认，不进入 CSV。
- 密码设置成功后仅保存 `gcm1` 密文、随机 96-bit IV、GCM tag 和到期时间。密钥由专用 encryptionKey 做用途分离，AAD 绑定 job/account/creator，防止跨任务替换。
- CSV 只包含已明确 `password_set` 且未过期的账户。最早凭证进入最后 10 分钟前会中止剩余任务，保证批次进入终态并留下下载窗口。创建者重新输入未在当前 time-step 使用过的 TOTP 后，服务端先持久化一次性 claim，再在内存生成响应；正常 `finish` 时销毁整批密文，提前 `close` 且已发送 headers 时也按可能部分披露销毁。发送前中止可释放 claim；进程在 claim 期间重启则按可能已披露处理并销毁。
- 用户停止会取消未提交的任务；若密码已可能提交则最终标记未知。已发送的恢复邮件无法撤回。
- 服务重启把 `setting_password` 标记为 `password_unknown` 并销毁密文，不重放一次性链接；旧 `queued/running` 仍按保守策略标记 `interrupted`；`waiting_mail` 保留游标继续只读查询；新批次的 `link_ready` 可安全进入首次密码提交。
- 元数据位于 `DB_PATH` 同目录的 `root-email-jobs.json`，原子写入、目录 `0700`、文件 `0600`。文件可能含有效期内的 GCM 密文，生产备份必须按敏感凭证处理并单独包含该文件。
- 执行器在 billing runner 获得 OS 单实例锁后启动，不支持多个服务进程共享写入。浏览器临时 profile 在任务结束后删除。
- 批次创建、每账户成功/失败/未知、MFA 失败、CSV 下载和到期销毁均写审计；高风险事件触发飞书，详情不含密码或 reset URL。任务查询轮询不写审计。

## API

全部接口沿用 JWT 身份验证和实时 `root_reset_access` / admin 权限，并返回 `Cache-Control: no-store`。

| 方法 | 路径（前缀 `/api/aws`） | 用途 |
| --- | --- | --- |
| GET | `/root-email/availability` | Python、模型、Chrome 路径、显示器自检；结果缓存 60 秒 |
| GET | `/root-email/catalog` | 配置的 payer、成员账户缓存与可选状态、缓存时间 |
| GET | `/root-email/batches` | 可见的最近 20 个批次汇总 |
| GET | `/root-email/batches/:id` | 批次进度、密码状态、凭证可用数量与每个账户结果；不返回密文或邮件标识 |
| POST | `/root-email/batches` | `{ payerAccountId, accountIds, requestId, confirmSetPassword: true, confirmPayerName, confirmAccountCount, totpCode }`；最多 20 个账户 |
| POST | `/root-email/batches/:id/credentials-csv` | `{ totpCode }`；仅创建者、持久化一次性 claim 后下载，finish/已开始后 close 时销毁密文 |
| POST | `/root-email/batches/:id/cancel` | 停止批次；已发送邮件不可撤回，已提交密码可能标记未知 |
| GET | `/root-email/accounts/:accountId/jobs` | 当前用户可见的最近 20 个账户任务 |
| POST | `/root-email/accounts/:accountId/jobs` | 创建旧式手工发信任务，body 为 `{ "confirmSend": true }` |
| POST | `/root-email/jobs/:id/cancel` | 取消排队、停止执行或等待邮件；终态请求幂等 |
| POST | `/root-email/jobs/:id/reset-link` | 仅旧式手工任务按需读取链接；自动改密批次拒绝返回 URL |
| POST | `/root-email/jobs/:id/manual-reset-link` | `{ totpCode }`；仅自动任务创建者在已精确绑定邮件且确认未提交密码后的 60 分钟内重扫同一邮件；候选非唯一、更新任务或 `password_unknown` 均拒绝 |

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
