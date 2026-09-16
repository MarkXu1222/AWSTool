# Root 密码恢复：手工发信与批量自动改密

账户详情 → 根用户 →「发送 Root 密码恢复邮件」仍创建单账户手工任务：邮箱从服务器账户缓存读取，调用方不能覆盖；找到恢复链接后由有权限的操作者手工打开 AWS 页面设置密码。

独立导航「批量设置 Root 密码」（`/rootreset`）创建自动改密批次。系统按 payer 选择最多 20 个 ACTIVE 成员账户，发送恢复邮件、精确匹配收件人和请求时间、重新校验 AWS 一次性链接，然后生成并提交 24 位强随机密码。创建批次必须精确输入 payer 名称、账户数量和当前 TOTP。

后台使用独立 Chrome 配置目录进入 AWS 忘记密码页面，通过本地 PP-OCRv6 模型处理 AWS 当前可能出现的两阶段验证码：登录安全验证码通过后进入 Forgot password，再处理恢复邮件验证码；每阶段最多 9 张图片。opening/captcha 阶段的泛化浏览器异常最多重建到 3 次会话；通过跨导航短轮询处理登录安全验证码，并兼容 AWS 先显示 `Verify`、点击后才加载验证码图片的中间态；验证码错误只通过 AWS 明确错误文案判定（兼容直/弯引号 contractions），无法确认时保持只读查邮箱且绝不重发，只有恢复邮件验证码提交前才持久化 `submitting`，此后只查邮箱、不重复发信。找到链接后，同一浏览器执行槽位只接受 `https://signin.aws.amazon.com/resetpassword` 的 `RootUser` 链接，使用不依赖 `tsx` 运行时 helper 的自包含页面函数，要求恰好两个可见密码框和唯一的 `Reset password` / `Set new password` / `Save new password` / `Change password` / `Submit` 按钮。密码页面仅在确认未进入提交边界时最多尝试 3 次。只有 AWS 返回明确成功文案才记录 `password_set`；提交后结果不明确时记录 `password_unknown`，绝不重试一次性链接。恢复邮件浏览器同样逐账户使用独立 Chrome/profile/Page，并持久化浏览器尝试次数及不含 URL/token 的 `failureStage/failureCategory`。仅 `failed` 且持久化证明未跨过恢复邮件提交边界的自动任务可单独重试；重试通过新 TOTP 创建新的单账户批次，旧任务保留并记录 `retryOfJobId/retriedByJobId`，不确定状态一律拒绝。

新密码由 Node.js CSPRNG 生成，固定 24 位并包含大小写、数字和符号。密码以任务上下文作为 AAD，使用用途分离密钥和 AES-256-GCM 永久写入任务文件及随后的备份，不设置 TTL，也不因下载销毁。CSV 下载依赖已完成登录 MFA 的会话，但不再要求额外 TOTP；Owner 可重复下载本人批次，Admin 可重复下载全部批次。服务端每次下载仍按 owner/admin 视图持久化短期 claim 防并发，响应结束后清 claim 并更新最近下载时间。列表 API、审计和飞书通知均不包含明文密码或 reset URL。

### AWS 独立安全验证窗口（0.30.1）

AWS 的 `Verify` 中间页可能打开 `Security Verification` 弹窗，文字验证码位于独立 iframe，不在主页面的 `#captcha_image` 中。执行器同时支持旧版主页面验证码和新版 iframe：仅接受 AWS 官方登录页直接嵌入的 HTTPS `cdn.<region>.threat-mitigation.aws.amazon.com`，在该 frame 内检查唯一图片、输入框和 Submit 控件，截图交给现有本地 OCR，最多 9 张。刷新使用图片刷新按钮，不使用重置整个验证流程的 Reset 按钮。身份验证完成后回到主页面核对邮箱，再进入恢复邮件验证码。

iframe 导航、域名变化、重复控件或不支持的挑战会停止；提交动作不会因失去 frame 响应而在同一调用内重放。等待入口超时归为 `timeout`，已出现但无法识别的独立验证窗口给出明确人工检查提示，避免旧版 `wait_entry/browser_error` 的无效循环。任务原有发信提交边界、邮箱核验及密码未知状态保护保持生效。

2026-09-16：58 项测试、前后端类型检查及完整构建通过。使用生产服务器的隔离浏览器实测新版 iframe：第一张图片未取得可靠 OCR 候选，刷新后第二张通过 AWS 身份验证并进入 Forgot password 入口。检查在恢复邮件请求之前停止，未发送邮件、未修改密码；这验证了本次入口兼容修复，不代表所有验证码的 OCR 都能成功。

### 九张自动识别与手工接管（0.31.0）

新任务每个验证码阶段最多自动识别 9 张，浏览器重建仍最多 3 次。9 张用尽后保留当前 AWS 会话，任务进入 `running/manual_captcha`，列表显示「手工输入验证码」链接。操作者在站内弹窗查看裁剪后的验证码、手动刷新或输入 6 位字符；每次图片使用一次性 challenge ID，重复点击、旧图片和其他任务的输入不能复用。提交前重新截图核对图片哈希，AWS 已换图时要求重新输入。只有明确拒绝才允许继续填写；提交结果不明仍转为只读查邮箱，不自动重发。

每个手工阶段从首次进入起保留 10 分钟，刷新或输错不会延长；发信浏览器总执行期限为 40 分钟。等待期间后续浏览器任务暂缓，用户可取消该账户或批次。图片和输入只在进程/弹窗内存中存在，普通列表不返回图片、答案或 URL；持久化只保存阶段及次数。接口沿用登录 MFA 会话并逐次复验 owner/admin 操作权限，无权查看的用户也不能读取图片；验证码字段在通用审计中脱敏。取消、权限撤销和服务停止会解除等待；重启把旧运行会话标记 interrupted，不恢复图片或重放输入。

`emailDeliveryState` 区分 `not_submitted`、`unconfirmed`、`aws_confirmed`、`received`。等待邮箱不代表验证码已通过：未见 AWS 发信确认时显示「发信未确认·核查邮箱」，超时说明也明确可能验证未通过或页面异常。只有 AWS 明确确认才显示「已发信·等待收件」。旧版同类超时记录仅在展示时修正文案，不改写历史任务。成功收到并核对邮件后才继续原来的密码设置流程。

## 权限设置

入口：设置 → 用户 → 编辑用户 → 批量重置 Root 密码权限。创建用户时也可配置。

| 值 | 显示 | 范围 |
| --- | --- | --- |
| none | 不开放 | 菜单隐藏，接口拒绝访问 |
| view | 仅查看 | 账户清单、本人创建的批次进度；不能创建、停止或下载凭证 |
| operate | 可使用 | 查看/创建/停止本人任务；本人批次完成后可下载创建者副本 |

非 admin 只能列出和读取自己创建的批次/任务。管理员可查看和管理全部任务，并重复下载任意批次的 Admin CSV 视图；若管理员同时是创建者，页面会显示 owner/admin 两个权限视图。CSV 下载不再 step-up MFA，但创建批次、单独重试失败账户和手工 fallback 仍必须通过 step-up TOTP。成功密码永久加密保存在本地任务文件及备份，不因下载或时间自动销毁。其他用户缺少字段时默认不开放，原 root_access、allowed_pages 不会自动授予此功能。权限撤销后，旧会话不能继续操作，执行中的任务也会停止。

## 运行依赖

- Chrome：沿用 `CHROME_PATH`，也会查找 macOS Chrome 和 Linux `/usr/bin/google-chrome[-stable]`。
- Python 3.13 虚拟环境：设置 `ROOT_EMAIL_PYTHON` 为其 Python 可执行文件绝对路径。Mac 默认使用 `~/.cache/aws-ocr-lab/venv/bin/python`。
- Linux headed Chrome 需要 Xvfb，`ROOT_EMAIL_DISPLAY` 默认 `:99`。Chrome 以普通用户、启用沙箱运行。
- 自动改密要求配置邮箱 API，以及 32–4096 字符的 `config.web.encryptionKey` 或 `ENCRYPTION_KEY`。轮换时须先把旧 current key 放入 `config.web.encryptionKeyPrevious`（最多 8 个、每项 32–4096 字符）；配置类型错误、重复或短密钥时，后端会在发送恢复邮件前失败关闭。
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
- 状态流程：`queued → running → waiting_mail → link_ready → setting_password → password_set`。AWS 发信提交结果不明时进入 `waiting_mail` 做只读确认，不重复发信。有效 reset 页在 `DOMContentLoaded` 后短暂切换执行上下文时，提交前最多容忍 6 次 DOM 读取失败；明确失败为 `password_failed`。确认尚未进入提交边界的 Chrome 加载/导航异常最多执行 3 次独立浏览器尝试，并只持久化不含 URL/token 的阶段码与错误分类；点击提交后超时、服务中断或页面异常为 `password_unknown`，密码密文立即销毁且绝不自动重试。自动尝试耗尽、已精确绑定恢复邮件且明确未提交密码时，创建者可在 2 小时内通过新 TOTP 按需重扫同一接收时间的邮件并手工打开/复制链接；候选不唯一、存在同账户更新任务或 `password_unknown` 时拒绝返回。手工设置结果无法由平台确认，不进入 CSV。
- 密码设置成功后，新记录永久保存 `gcm2:<keyId>:<iv>:<tag>:<ciphertext>`；随机 IV 为 96-bit。key ID 取用途分离密钥摘要的前 16 个十六进制字符，不泄露密钥，并作为 AAD 的一部分绑定 job/account/creator。`gcm2` 按 key ID 精确选择 current 或 historical key；旧 `gcm1` 没有 key ID，解密时依次用 current + previous key 做 GCM 认证，成功后才返回。未知 key ID、缺失历史 key 或认证失败都会拒绝整批 CSV。
- 轮换顺序固定为：先把旧 `web.encryptionKey` 原值加入 `web.encryptionKeyPrevious`，再设置新 current key 并重启。启动会在写入前认证全部候选，并分别原子重加密在线 MFA/ExternalId 和永久 Root 凭证到 current key；DB 审计与字段密文同次写入，Root 迁移则持久化待审计补偿标记并写一条有界 `system` 汇总审计，审计未落盘会停止启动并在下次启动重试，允许重复记录但不允许永久缺失。任一历史值不可解时失败关闭且不写半批数据。首次从旧版 JWT-secret CBC 配置 dedicated key 时，`jwtSecret` 仅作为 legacy 字段迁移候选，不进入 Root keyring。在线迁移完成后仍须等待含旧密文的本地/异机备份轮替并完成恢复验证，才能删除 historical key。`encryptionKeyPrevious` 最多 8 个，禁止重复。
- CSV 只包含明确 `password_set` 且仍有永久密文的账户。请求必须显式选择 `owner` 或 `admin` 权限视图：owner 仅创建者，admin 仅当前 Admin。下载不再要求额外 TOTP，可按权限重复执行。每次请求仍先持久化短期 claim 防同一视图并发生成；正常 `finish`、已发送 headers 的提前 `close` 或重启 orphan 都只记录最近下载并清 claim，不删除密文。发送前中止释放 claim。永久归档没有自动 TTL 或下载次数上限，只能通过未来显式删除功能或人工受控操作移除。
- 用户停止会取消未提交的任务；若密码已可能提交则最终标记未知。已发送的恢复邮件无法撤回。
- 服务重启把 `setting_password` 标记为 `password_unknown` 并销毁密文，不重放一次性链接；旧 `queued/running` 仍按保守策略标记 `interrupted`；`waiting_mail` 保留游标继续只读查询；新批次的 `link_ready` 可安全进入首次密码提交。
- 元数据位于 `DB_PATH` 同目录的 `root-email-jobs.json`，原子写入、目录 `0700`、文件 `0600`。该文件是永久凭证库；启动和每日首次 DB 读取会先校验两个源 JSON，同日恢复点一旦创建便不覆盖。Root 快照仅保留明确 `password_set` 且未在旧一次性策略下披露的密文，绝不备份 `setting_password`/failed/unknown 密文，再分别原子写入 `data/backups/db-YYYY-MM-DD.json` 和 `data/backups/root-email-jobs-YYYY-MM-DD.json`，两类各保留 7 天。首次安装会安全创建空 Root store；若已有 Root 备份而主文件缺失则失败关闭，不以空库掩盖数据丢失。自动备份目录不包含 `config.json`，匹配 keyring 必须独立备份；本地备份与源文件同故障域，仍需受控异机/EBS 快照和联合恢复演练。
- 执行器在 billing runner 获得 OS 单实例锁后启动，不支持多个服务进程共享写入。浏览器临时 profile 在任务结束后删除。
- 批次创建、每账户成功/失败/未知、MFA 失败、CSV claim/下载/中止/重启恢复均写审计；高风险事件触发飞书，详情不含密码或 reset URL。任务查询轮询不写审计。

## API

全部接口沿用 JWT 身份验证和实时 `root_reset_access` / admin 权限，并返回 `Cache-Control: no-store`。

| 方法 | 路径（前缀 `/api/aws`） | 用途 |
| --- | --- | --- |
| POST | `/root-email/jobs/:id/manual-captcha` | 仅本人操作者或 Admin 获取当前验证码快照，no-store |
| POST | `/root-email/jobs/:id/manual-captcha/answer` | `{ challengeId, action: "submit"或"refresh", captchaAnswer? }`；一次性消费，由原 runner 继续 |
| GET | `/root-email/availability` | Python、模型、Chrome 路径、显示器自检；结果缓存 60 秒 |
| GET | `/root-email/catalog` | 配置的 payer、成员账户缓存与可选状态、缓存时间 |
| GET | `/root-email/batches` | 非 admin 返回本人最近 20 个批次；Admin 返回全局最近 20 个 |
| GET | `/root-email/batches/:id` | 批次进度、密码状态、凭证可用数量与每个账户结果；不返回密文或邮件标识 |
| POST | `/root-email/batches` | `{ payerAccountId, accountIds, requestId, confirmSetPassword: true, confirmPayerName, confirmAccountCount, totpCode }`；最多 20 个账户 |
| POST | `/root-email/batches/:id/credentials-csv` | `{ slot: "owner" | "admin" }`；不额外验证 TOTP；按权限重复下载永久密文，每次用短期 claim 防并发 |
| POST | `/root-email/batches/:id/cancel` | 停止批次；已发送邮件不可撤回，已提交密码可能标记未知 |
| GET | `/root-email/accounts/:accountId/jobs` | 当前用户可见的最近 20 个账户任务 |
| POST | `/root-email/accounts/:accountId/jobs` | 创建旧式手工发信任务，body 为 `{ "confirmSend": true }` |
| POST | `/root-email/jobs/:id/cancel` | 取消排队、停止执行或等待邮件；终态请求幂等 |
| POST | `/root-email/jobs/:id/retry` | `{ confirmRetry: true, totpCode }`；仅明确未提交恢复请求的自动 `failed` 任务，新建单账户批次并保留旧任务血缘 |
| POST | `/root-email/jobs/:id/reset-link` | 仅旧式手工任务按需读取链接；自动改密批次拒绝返回 URL |
| POST | `/root-email/jobs/:id/manual-reset-link` | `{ totpCode }`；仅自动任务创建者在已精确绑定邮件且确认未提交密码后的 2 小时内重扫同一邮件；候选非唯一、更新任务或 `password_unknown` 均拒绝 |

成功响应 `{ "success": true, "data": ... }`；错误响应 `{ "error": "..." }`。重复任务 409、间隔/队列限制 429、运行环境未就绪 503。UI 不把 `email_sent` 标记为「密码重置完成」。

邮箱 API 交接参数及实测出口记录见 [MAIL_API_HANDOFF.md](MAIL_API_HANDOFF.md)。

## 验证

```sh
node --import tsx --test tests/root-email.test.ts tests/root-email-manual.test.ts tests/root-email-security-frame.test.ts tests/root-mail-links.test.ts tests/mail-api.test.ts tests/root-reset-permissions.test.ts
npx tsc --noEmit -p server/tsconfig.json
npx tsc -p client/tsconfig.json
npx vite build --config client/vite.config.ts
```

测试通过模拟外部 AWS 会话验证重试上限、超时不重发、权限撤销/取消、持久化、重启恢复和重复任务限制，不会发送真实邮件。独立窗口测试在有 Chrome 时使用真实浏览器和完全拦截网络的页面夹具，验证跨域 iframe 识别、截图、拒绝、刷新及恢复邮件阶段切换；无 Chrome 时跳过该项。上线后仍需选择授权测试账户验证平台执行器的实际页面兼容性。

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
