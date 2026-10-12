# POC 定价计算器：每条申请独一份 + 经得起引擎重算

## 背景

2026-10-12 用户当天提交的两条 Freightly POC（`benappl-2153smiv0gitx1` / `benappl-a9gjkl8wu42c1p`）
计算器**逐项完全相同**：同样 8 个服务、同样台数、同样总额 7,946.93 USD。

根因（`web/server/pricing-calculator.ts` `buildPocEstimate`）：

1. 种子只取 MRR（`seed = round(MRR × 7919) % 1000`），MRR 相同的不同商机产出完全相同的计算器。
2. 服务组合写死：永远是同样 8 个服务、同一套基准比例，只整体缩放。

排查中发现更严重的第二个问题：**平台生成的计算器经不起引擎重算**。
calculator.aws 打开分享链接是只读视图，显示我们写入的 `serviceCost`；
审核人一旦点「Update estimate」，引擎按 `calculationComponents` 重算 ——
今天那份从 7,946.93 变成 **27,767.33 USD**：

- EC2 `storageAmount` 被引擎按**每台实例**计（27 台 × 6500 GB）
- ALB 每台「60 GB/小时」数据处理量，引擎按 LCU 计费
- CloudFront / CloudWatch / CloudTrail 参数格式或免费额度导致重算值与写入值不符

9 月以来平台生成的 13 份计算器都受影响（MRR 相同的还互相撞车）。

## 目标

1. 每条 POC 申请的计算器**总额不同、服务组合不同**，服务丰富多变。
2. 生成的计算器在审核人点「Update estimate」后，**引擎重算金额与提交金额一致**。

## 使用者与角色

- 使用者：admin（POC Cash 页为 admin 专属，后端 `/api/poc-cash` 整个 router `requireStrictAdmin`）
- 页面：现有 `poccash` 独立权限页，「POC 申请」Tab；无新页面、无权限变化

## 范围内

- 种子取自平台本地「计算器台账」记录 ID：创建 POC 前先落一条台账记录，用其 ID 播种生成计算器，
  AWS 返回 `benappl-` 申请 ID 后回填
- 台账存 `data/db.json` 新顶层键 `poc_calculator_ledger`（按需创建，向后兼容）
- 生成后与台账已有记录查重：总额（精确到分）相同或服务签名相同即视为撞车，换种子重生成，最多 20 次
- 服务组合：必选骨架（EC2 1~3 个角色、ALB 1~3 个、S3、CloudWatch）+ 数据库方案四选一
  （RDS MySQL / RDS PostgreSQL / Aurora MySQL / EC2 自建）+ 辅助服务池抽 3~6 个
- 每个服务的 JSON 从人工制作的真实估算克隆，成本公式经 calculator.aws 引擎实测标定
- 总额规则保持：MRR + 100~150 USD 区间内、带零头（非整数）
- 结果页展示计算器总额与服务清单
- 本地验收脚本：puppeteer 打开生成的计算器、点「Update estimate」，核对引擎重算值

## 明确不做

- 不修改审核中的 3 条 POC（Freightly ×2、Korea Wallpaper 10/09），不补发、不撤回
- 不补录历史计算器进台账
- 不加「同客户 MRR 相同」告警（用户确认 MRR 相同本身不是问题）
- 不改商机创建流程、不改金额推导（ARR = MRR × 12、POC = ARR / 10 等）
- 不在页面上展示台账列表
- 只支持 `ap-southeast-5`（单价与模板只在该区域标定过）

## 验收标准

1. `cd web && npm test && npm run typecheck && npm run build` 全绿
2. 单元测试锁住：
   - 本地成本公式对 183 个引擎实测用例误差 ≤ 0.02 USD
   - 同一 MRR 1000 个不同种子，服务签名唯一率 ≥ 99%（MRR ≥ 800）
   - 台账模拟：同一 MRR 连续 300 份，总额与签名全部互不相同
   - 总额恒在 [MRR+100, MRR+151) 且非整数；同种子可复现
3. `npx tsx scripts/verify-calculator-render.ts` 通过：生成的计算器在 calculator.aws
   点「Update estimate」后，每个服务重算值与提交值差 ≤ 0.02 USD，总额差 ≤ 0.10 USD
4. 本地对同一商机（MRR 7,800）连续生成 3 份计算器（只生成不创建 POC），总额与服务组合两两不同

## 已知约束

- calculator.aws 的保存/读取端点是未公开接口（见 `pricing-calculator.ts` 文件头）
- 单价为 2026-10-12 实测快照；AWS 调价后需重跑验收脚本并更新
- 最低支持 MRR 600 USD，低于此值预算放不下最小配置，直接报错
