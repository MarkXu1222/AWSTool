# POC Cash 创建商机：Solution 默认值改为实时数据 — 需求纪要

## 背景

2026-10-15 用 Mergebytes 主体创建商机后发现没有关联 Solution。排查结论：

- 「关联 Solution」下拉本来就实时调 `ListSolutions`（只列 Active），但**默认值**来自代码里硬编码的
  `PartnerProfile.defaultSolutionId`（Webby `S-0070517`，Mergebytes `''`）。下拉留空时后端用
  `input.solutionId || partner.defaultSolutionId`，Mergebytes 就静默跳过关联。
- 主体字段提示「该主体暂无可关联的 Solution」与下拉 placeholder「默认 S-0070517 Migration services」
  也都是硬编码，与 Partner Central 实际情况脱节。
- 同日已在 Mergebytes 账户建好 `S-0100389`（Active），但代码不会自动用它。

## 目标

Solution 的默认值与提示以 Partner Central 实时数据为准：Solution 增删后无需改代码，也不会再漏关联。

## 使用者与角色

- POC Cash 页面，**仅 admin**（`requireStrictAdmin`，页面 key `poccash` 不可勾选授予）。权限模型不变。

## 范围内

1. 默认值规则（后端统一计算，前端只展示）：
   - 该主体 0 个 Active Solution → 无默认值；
   - 主体配置的**优先 Solution**（仅 Webby：`S-0070517`）在 Active 列表里 → 默认它；
   - 恰好 1 个 Active → 默认它；
   - ≥2 个且无可用优先项 → 无默认值，需要用户选。
2. **必选规则**（用户 2026-10-15 选定）：该主体有 ≥1 个 Active Solution 时「关联 Solution」必选；
   列表为空或查询失败时允许留空，商机照建并记 warning（即今天的行为）。
3. 前端：主体字段提示、Solution 下拉 placeholder / 说明文字改为基于实时列表；加载完成后预选默认值；
   「再建一个」重置表单后重新预选；创建确认框显示将关联的 Solution。
4. 后端：创建前用实时列表校验——所选 Solution 不在 Active 列表 / 有多个 Active 却没选时，
   **在建商机之前**拒绝（400），不建出无 Solution 的商机。
5. 去掉 `defaultSolutionId` 硬编码语义，改为只表达偏好的 `preferredSolutionId`（可缺省）。

## 明确不做

- 不在平台里创建 / 发布 Solution（API 不支持，且 role 显式 Deny Marketplace Catalog）。
- 不给已建商机补关联 Solution（另行在 Partner Central 手动做）。
- 不列出非 Active（Draft / Inactive / Delete）的 Solution。
- 不改 IAM 策略、不改 `config.json`、不改 `data/db.json` schema。
- 不改「商机阶段检查」Tab 的「未关联 Solution」提示与补提交逻辑。

## 验收标准

- [ ] Mergebytes 主体：下拉自动预选 `S-0100389`；提示显示「1 个 Active Solution」，不再出现「暂无可关联」。
- [ ] Webby 主体：下拉自动预选 `S-0070517`（Webby 有 5 个 Active，优先项生效）。
- [ ] 有 Active Solution 时清空下拉再提交 → 表单拦截「请选择要关联的 Solution」。
- [ ] 后端：`solutionId` 不在 Active 列表 → 400 且**未调用 CreateOpportunity**；多个 Active 且未传 → 400；
      0 个 Active 且未传 → 创建成功并带 warning；`ListSolutions` 失败且未传 → Webby 回落优先项、其它主体跳过关联，均带 warning。
- [ ] `cd web && npm test && npm run typecheck && npm run build` 全绿，含新增 `tests/poc-cash-solution-default.test.ts`。

## 已知约束

- `GET /api/poc-cash/solutions` 只返回 Active（Delete/Inactive 关联会被 AWS 拒绝）。
- Solution 按 APN 账户隔离，商机只能关联同账户的 Solution。
- `request()`（client/src/api.ts）对非 2xx 不抛错，会把 `{ error }` resolve 回来，前端必须显式判断。
