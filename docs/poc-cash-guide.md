# POC Cash 完整操作指南

> 来源：`poc进度 - POC申请流程.csv`（流程规范）+ `poc进度 - POC.csv`（YanHuang 114 条实操记录）
> 交叉验证：Partner Central Benefits API 真实数据（WebbyAPN，161 条申请）
> 文中所有公式都用 114 条真实记录回归验证过，标注了吻合率。

---

## 0. 一句话概括

POC Cash 是**两段式**：先申请预批（Fund Request），POC 做完后再请款（Cash Claim）。
钱不是你说申请多少就给多少 —— AWS 后台用
**`总成本 − partner投入 − 客户投入`** 倒推，所以这三个金额字段是真正的杠杆。

---

## 1. 全流程七步

```
① 建商机（Opportunity）            → 拿到 OPP ID
② 商机推到「技术验证」阶段          → POC 的前置条件
③ 做定价计算器（Pricing Calculator）→ 拿到 ARR 和 calculator link
④ 提 POC Fund Request（事前预批）   → 拿到 FR-POC-CASH-xxx
⑤ 实施 POC（项目开始/结束）
⑥ 提 Cash Claim（事后请款）         → 附客户签收单
⑦ AWS 打款                         → 记到账金额/日期
```

实操表 `POC阶段` 列对应：`(空)` → `已申请POC` → `已提交Cash_Claim` → `完成✅`

实测 114 条分布：完成 30、已申请 18、已提交 Cash Claim 3、未启动 63。

---

## 2. 命名规范（必须遵守）

| 字段 | 格式 | 实例 |
|---|---|---|
| 项目名称 | `<Partner> - <客户名> - <项目概述>` | `YanHuang - Malatrading - High concurrency testing` |
| PO 名称 | `<客户名> - <项目概述> - POC` | `Mala Trading - High concurrency testing - POC` |

⚠️ 实操表里有踩过的坑：某条 `taovolt` 客户的项目名写成了
`YanHuang - Malatrading - Database Migration` —— 客户名张冠李戴。命名靠手写，容易错。

---

## 3. 项目描述怎么写

流程文件给的标准范例（直接可套）：

> The "YanHuang - Malatrading - High Concurrency Testing" project aims to simulate the
> system performance of an e-commerce platform under high concurrency scenarios.
> The testing environment is built on **Amazon EKS**, combined with **Karpenter** to achieve
> automatic scaling, ensuring that Pods can elastically scale with the load; traffic is
> handled by **ALB** for Ingress load distribution; log data is centrally stored in
> **Amazon S3**; at the same time, **CloudWatch** is used for real-time monitoring of resource
> utilization and service health status, with an alarm mechanism set up to ensure testing
> safety. To realistically replicate the concurrent scenario, multiple **EC2** stress testing
> machines are deployed for continuous concurrent traffic injection, verifying the system's
> stability and elasticity under peak pressure.

**可复用结构**：
1. 项目目标（aims to ...）
2. 用了哪些 AWS 服务、各解决什么（EKS / Karpenter / ALB / S3 / CloudWatch / EC2…）
3. 怎么验证（stress testing / traffic injection / 验证哪些指标）

要点：**必须具体写 partner 做了什么**，不能只说「帮客户上云」。

---

## 4. 金额怎么算（核心，决定给多少钱）

### 4.1 三个联动的美元数字

实操表验证（81 条样本，**100% 吻合**）：

```
ARR（定价计算器年费用） = PO MRR × 12
ARR                    = 申请金额USD × 10
∴ 申请金额USD ≈ ARR / 10 ≈ MRR × 1.2
```

实例：MRR 8,167 → ARR 98,000 → 申请 9,800 USD

### 4.2 申请金额的天花板

实测 114 条：**最大 9,900 USD，无一条超过 10,000**。

高频取值：9,800(12次) / 9,500(11次) / 9,600(6次) / 9,000(6次)

> 实践上限按 **9,900 USD** 卡，对应 ARR 99,000。
> 超过大概率要走别的审批通道。

### 4.3 MYR 三个金额字段（真正的杠杆）

流程文件原话：

> 后台会通过 **total 支出 − partner 支出 − customer 支出** 来决定申请费用

| 字段 | 算法 |
|---|---|
| **Total Cost of Activity** | `339 MYR × 8h × 人数 × 天数` |
| **Partner Contribution** | `活动总成本 − 预估申请资金` |
| **Customer Contribution** | 通常为 **0** |

`339 MYR/小时` 是标准单价，`339 × 8 = 2,712 MYR` 即一人一天。

**验证结果（诚实汇报）**：

| 检验 | 结果 |
|---|---|
| `Total` 是 2,712 的整数倍 | 52 条中 **20 条**吻合 |
| `Total − Partner = 实际申请` | 47 条中 **14 条**精确吻合 |
| `实际申请 ÷ (Total − Partner)` | **中位数 1.0040** |

公式**方向正确**，但实际填写时会按目标申请额反推微调 Total 和 Partner，
不是严格按人天算出来的。**这是实操常态，不是错误。**

### 4.4 汇率

实测 USD → MYR 比值集中在 **4.24 ~ 4.36**，估算取 **4.27**。

```
9,800 USD → 41,849 MYR  (4.270)
9,500 USD → 40,585 MYR  (4.272)
8,200 USD → 35,092 MYR  (4.280)
```

实际申请额中位数 **38,940 MYR**，最大 42,456 MYR。

### 4.5 完整算例

目标申请 9,800 USD：

```
ARR              = 9,800 × 10          = 98,000 USD
PO MRR           = 98,000 / 12         ≈ 8,167 USD
预估申请(MYR)     = 9,800 × 4.27        ≈ 41,846 MYR
Total Cost       = 339 × 8 × 2人 × 9天  = 48,816 MYR
Partner Contrib  = 48,816 − 41,846     = 6,970 MYR
Customer Contrib = 0
→ AWS 倒推: 48,816 − 6,970 − 0 = 41,846 MYR ✓
```

实操表 `taximap - Core Platform Modernization` 正是这组数：
Total 48,816 / Partner 7,256 / 实际申请 41,849。

---

## 5. 表单逐字段填写

### 5.1 基础信息

| 字段 | 填法 |
|---|---|
| 项目名称 | `<Partner> - <客户> - <概述>` |
| 项目描述 | 见第 3 节结构 |
| 定价计算器链接 | `https://calculator.aws/#/estimate?id=...` |
| **OPP ID** | 必须与 Account **一一对应** |
| **账户 ID** | 必须与商机**对应** |

### 5.2 时间

| 字段 | 规则 |
|---|---|
| 项目开启时间 | **必须是 14 天之后**（流程硬要求） |
| 项目截止时间 | 按预估人天工时推算 |

实测项目天数：**中位数 4 天**，最常见 3 天(12次) / 5 天(12次) / 4 天(9次)。
少数长周期 28~34 天。

> ⚠️ 流程文件末尾注明「最下面重复项目时间」——
> 表单底部还要再填一次同样的起止日期，对应 API 的
> `CashRequest.CashClaims[].StartDate/EndDate`。**别漏。**

### 5.3 地区与竞争

| 字段 | 值 |
|---|---|
| Country Activity is Executed | **Malaysia** |
| Customer Also Considering | 选竞争对手，**同一客户前后必须一致** |
| Currency | **MYR** |

API 实测 `CustomerConsidering` 取值示例：`Other`、`No Competition`。

### 5.4 发票信息（YanHuang）

```
Invoice Entity Name    : YANHUANG TECHNOLOGY SDN. BHD.
Invoice Remit Address  : 62, JALAN ANGGERIK 3, TAMAN KULAI UTAMA,
                         81000 KULAI JOHOR MALAYSIA
Invoice Remit Country  : Malaysia
```

> 对比 Webby 的值（来自 API）：`WEBBY SDN BHD` /
> `2-3, Jalan Merbah 1, Bandar Puchong Jaya, 47170 Puchong, Selangor` / `MY`
> **按实际主体填，不要混用。**

### 5.5 附件

流程文件明确：**附件可以留空**。

但 API 实测给出不同信号 —— 25 条 APPROVED 申请中 **100% 都有附件**
（多为 `AWS Pricing Calculator` 的 PDF）。

**建议**：事前 Fund Request 附计算器 PDF；事后 Cash Claim **必须**附客户签收单
（`Customer Sign Off Template`）。

---

## 6. 事后 Cash Claim（第二段）

字段结构与事前件**完全不同**：

| 字段 | 说明 |
|---|---|
| `StartDate` / `EndDate` | POC 实际执行区间 |
| `ClaimAmount` | 请款金额（MYR） |
| `DueDate` | 截止日 |
| `CustomerSignOffAttached` | 是否附客户签收 |
| `AwsAccountId` | 对应账户 |
| `Invoice` | **AWS 侧回填**，含 PayeeCentral 链接与排期付款日 |

真实样本（来自 API）：

```json
{
  "Program": "Proof of Concept Cash Claim",
  "Template": "POC",
  "ClaimAmount": { "Amount": "32714", "Currency": "MYR" },
  "StartDate": "2026-06-10", "EndDate": "2026-06-26",
  "DueDate": "2026-12-16",
  "CustomerSignOffAttached": false,
  "Invoice": {
    "Description": "https://finopscentral-na.amazon.com/payeecentral/invoices/details/284566252#/",
    "ScheduledPaymentDate": "2026-07-30",
    "Amount": { "CurrencyCode": "MYR", "Amount": "32714.00" }
  }
}
```

---

## 7. 编号体系

```
FR-POC-CASH-<partner标识>-<12位hex>

YanHuang : FR-POC-CASH-9d2a12e94488-092990b877e9
Webby    : FR-POC-CASH-e446ba6093e4-05358ce2d1cb
                        └─ partner 标识固定，每家一个
```

实操表 51 条 FR ID 全部是 `FR-POC-CASH-9d2a12e94488-` 前缀，
**格式与 Benefits API 返回的完全一致**。

---

## 8. API 自动化可行性

| 环节 | API | 能否自动 |
|---|---|---|
| 建商机 | `CreateOpportunity` | ✅ |
| 改阶段到技术验证 | `UpdateOpportunity` | ✅ 需先 Get 取 `LastModifiedDate` |
| 定价计算器 | — | ❌ 手工 |
| 事前 Fund Request | `CreateBenefitApplication`（`ben-un8hh6qdrxqx50`） | ✅ |
| 关联商机 | `AssociateBenefitApplicationResource` | ✅ |
| 提交 | `SubmitBenefitApplication` | ✅ |
| 事后 Cash Claim | `CreateBenefitApplication`（`ben-8j7y5dohajcl16`） | ✅ |
| 审批 / 打款 | — | ❌ AWS 侧 |

详见 `docs/partner-central-api.md` 第 8、9 章与 `scripts/poc_cash_flow.py`。

---

## 9. 提交前检查清单

**金额**
- [ ] 申请金额 ≤ 9,900 USD
- [ ] ARR = 申请金额 × 10 = MRR × 12
- [ ] Total − Partner − Customer = 目标申请额（MYR）
- [ ] Customer Contribution = 0
- [ ] Currency = MYR

**对应关系**
- [ ] OPP ID ↔ Account ID 一一对应
- [ ] 项目名称里的客户名与实际客户一致（**易错**）
- [ ] 同一客户的 Customer Also Considering 前后一致

**时间**
- [ ] 开始日期 ≥ 今天 + 14 天
- [ ] 表单底部的项目时间已重复填写

**主体**
- [ ] Invoice Entity / Address / Country 用对了公司主体
- [ ] Country Activity is Executed = Malaysia

**附件**
- [ ] 事前：计算器 PDF（流程说可留空，但 APPROVED 件 100% 有）
- [ ] 事后：客户签收单（必须）

---

## 10. 已知风险点

1. **金额公式非严格**：实际填写会按目标额反推微调 Total/Partner，
   不要机械套人天公式后就不复核（人天公式吻合率仅 20/52）。
2. **命名易错**：实操表中已出现客户名张冠李戴的情况。
3. **9,900 USD 上限**是 114 条记录的经验值，非官方文档明示。
4. **附件口径不一**：流程文件说可留空，但实测已批准件 100% 有附件。
5. **14 天前置**是硬要求，排期务必预留。
6. **本文档基于 YanHuang 的马来西亚实践**（MYR / 339 单价 / Malaysia）。
   换主体或换国家时，单价、币种、发票信息都要重新确认。
