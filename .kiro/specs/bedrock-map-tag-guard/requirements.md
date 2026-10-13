# Bedrock map-migrated 标签防错

## 背景

Bedrock 工具页给 Application Inference Profile 打 `map-migrated` 标签时，值由操作者手填，
后端只校验「非空」。实际出现过 `migmig…` 这类重复前缀的错误值，被写进 AWS，
又因为交付表格只校验「全表一致」，整批错误值一路进了客户交付 Excel。

现状漏洞（2026-10-13 读代码确认）：

1. `POST /api/bedrock/profiles/create`、`/profiles/tag` 只校验 key/value 非空（`routes/bedrock.ts` `validateTags`）
2. 额外 Tag 行可以再写一个 `map-migrated` / `Map-Migrated`，与主标签互相覆盖
3. 写入后不回查，`TagResource` 返回成功就计为成功
4. `/delivery`、`/delivery-v2` 用的是**前端传来的** `tags`，不从 AWS 读；只校验全表唯一，不校验格式
5. 切换账户后各 Tab 的 rows / 勾选 / 已填 Tag 都保留（组件 state 不随 `accountId` 重置）

## 目标

`map-migrated` 值格式错误（以 `migmig` 为代表）**进不了 AWS，也进不了交付文件**；
写入结果以 AWS 回查为准，部分失败能看清并只重试未完成项。

## 使用者与角色

- 现有 `bedrock` 页（可分配敏感页，non-admin 需显式勾选）
- 写操作守卫不变：创建 / 打 Tag / 交付 = `requireAdmin`（admin + partadmin）
- 无新页面、无权限变化

## 范围内

- `map-migrated` 值严格格式：`^mig[A-Z0-9]{10}$`，原样比对，不 trim、不改大小写、不自动补或删 `mig`
- Tag 数组规则：`map-migrated` 恰好一个；不分大小写等于 `map-migrated` 的其它写法拒绝；key 不分大小写重复拒绝；`aws:` 前缀拒绝；首尾空格拒绝
- 打 Tag 时 ARN 必须属于请求的账户与区域
- 打 Tag 时若资源上已有 `Map-Migrated` 等大小写变体 key，写入前自动移除（Bedrock 页无解 Tag 入口，不移除就永远过不了回查和交付），记入审计
- 创建 / 打 Tag 写后逐个回查，结果分 `verified` / `create_failed` / `write_failed` / `read_failed` / `mismatch`
- 前端结果表 +「重试未完成项」
- 交付 v1 / v2：服务端按 ARN 从 AWS 重新读标签，ARN 必须属于该账户，格式不合规拒绝
- 前端：切换账户所有 Tab 重新挂载；Tag 输入实时校验；表格里不合规值标红
- 审计补充旧值分布、新值、各状态计数
- 一次性只读排查脚本：从审计日志找做过 Bedrock 创建 / 打 Tag / 交付的账户，读当前 profile 标签，输出不合规清单

## 明确不做

- **不存储**任何 payer 的标准标签值（用户自己填）
- 不检测「格式合法但用了别家 payer 的值」，不和 `orgs.json` 比对
- 交付时不要求二次输入预期值
- 不做定期巡检
- 不改 MAP 标签合规页、`orgs.json`、`tag-compliance.ts`
- 不自动修正存量错误标签（排查脚本只读，修正由用户在页面上重打 Tag 再重新生成交付表）
- `/profiles/untag`、`/profiles/delete` 行为不变

## 验收标准

1. `cd web && npm test && npm run typecheck && npm run build` 全绿
2. `tests/bedrock-map-tag-guard.test.ts` + `tests/bedrock-delivery-tag-guard.test.ts` 锁住：
   - `migmigEY52ZIK63T`、`migey52zik63t`、` migEY52ZIK63T`、`migEY52ZIK63`、`MIGEY52ZIK63T`、空值 → 拒绝；`migEY52ZIK63T`、`migMIGAB12345` → 通过
   - 额外 Tag key 为 `map-migrated` / `Map-Migrated`、key 重复、缺 `map-migrated` → 拒绝
   - 跨账户 / 跨区域 ARN → 拒绝
   - 回查：写成功读回一致 → verified；读回值不同 → mismatch；读全部失败 → read_failed；第一次不一致第二次一致 → verified
   - `prepareDelivery`：全部 profile 都是同一个 `migmig…` 值 → 拒绝
   - 前后端 `checkMapTagValue` 对同一组输入输出完全一致
3. 页面验收（本地或线上，admin 登录 Bedrock 页）：
   - 批量创建 / 批量打 Tag 填 `migmig…` → 红字提示、按钮禁用
   - 账户 A 加载 Profiles 后切到账户 B → 表格清空、已填 Tag 清空
   - 打 Tag 后弹出结果表，按状态分组；有未完成项时「重试未完成项」只重发这些
   - 交付 Tab 对含不合规标签的账户点生成 → 报错并列出具体 profile
4. 排查脚本在 EC2 只读执行，输出 CSV（含海底捞 payer 下账户）

## 六种情况的覆盖说明

| 情况 | 本需求的处理 |
|---|---|
| 重复 `mig` | 前后端拦截，交付拦截 |
| 使用其他 payer 的合法标签 | **不覆盖**（用户决定，靠人工） |
| 切换账户残留旧值 | Tab 按账户重新挂载 |
| 配置缺失 | 无配置存储；等价为「值缺失 / 格式不符即拒绝」 |
| 部分请求失败 | 逐个回查 + 只重试未完成项 |
| 全部一致但全部错误 | 只拦**格式**错误；格式合法的错值不覆盖 |
