# requirements.md — POC 资金申请支持 Mergebytes 主体

## 目标

让 Mergebytes（APN 账户 `072471709462`）能和 Webby 一样，在 POC Cash 页面创建、提交、跟踪
POC 资金申请（`ben-un8hh6qdrxqx50`）并导出台账。目前商机侧已支持多主体，但 POC 资金
申请整条链路（前置检查 / 创建 / 提交 / 进展 / 导出）写死了 Webby 的凭证、发票信息与联系人。

## 使用者与角色

- 仅 `admin`（与现状一致）：`poccash` 页 `isPageAllowed()` 判 `role === 'admin'`，
  后端 `/api/poc-cash` 在 router 层挂 `requireStrictAdmin`（实时查库）。
- 页面档位不变：独立权限页，不进 `PAGE_META` / `ALL_PAGE_KEYS`。

## 范围内

1. 发票信息与申请联系人按主体配置，Mergebytes 使用以下值（用户 2026-10-14 提供）：
   - Invoice Entity Name：`MERGEBYTES AI SDN. BHD.`
   - Invoice Remit Address：`3-1, JALAN MERBAH 1, BANDAR PUCHONG JAYA, 47170 PUCHONG SELANGOR MALAYSIA`
   - Invoice Remit Country：`MY`（用户给的是 MALAYSIA；API 用 ISO 代码，Webby 已批准件为 `MY`）
   - AccountProfileID（Payee Central profile ID）：`2MGE7NZ9LMR3C`
   - 联系人：`cloud@mergebytes.ai` / FirstName `SY` / LastName `Siow` / BusinessTitle `OpportunityOwner`
2. 人天单价 339 MYR/h、币种 MYR、执行国家 Malaysia、申请名 `POC - <客户公司名>`：与 Webby 相同，沿用。
3. POC 申请、提交、进展、CSV 导出全部按当前选中的主体走对应 APN 账户的凭证。
4. 进展与 CSV **按主体分开**：进展 Tab 只显示当前主体；CSV 列结构不变，按主体分文件留存。
   Webby 文件名保持现状（`poc-cash-<ts>.csv` / `poc-cash-latest.csv`）。
5. 前端「POC 申请」「POC 进展」Tab 加主体选择器，与「阶段检查」共用页面级 `activePartner`。
6. 修复潜在 bug：POC 申请 Tab 的商机下拉按 `activePartner` 加载，而后端 funding 恒用 Webby 凭证。
7. 计算器台账记录所属主体（可选字段），查重仍跨主体全局。

## 明确不做

- Mergebytes 商机标签：已是 `#ADPL` only，不改。
- Cash Claim 请款创建、附件上传（平台本就没有）。
- 新增 Mergebytes 以外的主体；把发票信息挪进 `config.json`。
- 改 CSV 列结构、改金额公式、改计算器生成逻辑。
- 合并两主体的进展表 / CSV。

## 验收标准

- [ ] `cd web && npm test && npm run typecheck && npm run build` 全绿，含新测试
      `tests/poc-cash-partner-funding.test.ts`
- [ ] 线上 admin 登录 → POC Cash → 「POC 进展」切到 Mergebytes，列表正常加载（当前预期 0 条），
      切回 Webby 列表与改动前一致
- [ ] Webby 导出 CSV：文件名仍为 `poc-cash-<ts>.csv`，列数 19，内容与改动前一致；
      Mergebytes 导出文件名为 `poc-cash-mergebytes-<ts>.csv`
- [ ] 「POC 申请」Tab 切到 Mergebytes 后商机下拉只列 Mergebytes 商机，预览金额不报「找不到商机」
- [ ] 首笔真实申请（用户操作）：`O28440608` 推进到 Technical Validation → 选「只创建，暂不提交」→
      Partner Central 控制台核对发票主体 / AccountProfileID / 联系人后再提交

## 已知约束

- Mergebytes 账户此前从未提过 POC（只有 1 条 MAP 类 `benappl-df6i4okvmf67k3`），资格只有提交后才能确认。
- Benefit ID 为目录级通用，两主体相同（实测 `ListBenefits`）。
- `partner-central-tool` role 在 Mergebytes 已含 Benefits 权限（`ListBenefits` / `ListBenefitApplications` 实测通过）。
