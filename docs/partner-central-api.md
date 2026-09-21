# AWS Partner Central API 全景（WebbyAPN 实测版）

> 实测环境：aws-cli 2.36.44 / botocore 1.42.68 / profile `WebbyAPN`
> Account `105673812363`（Webby Group，partner-kgtuwt5hyqom2），IAM user `mark-poc`
> 所有结论均来自对本地 botocore 服务模型的解析 + 对 AWS 的真实 API 调用验证。

---

## 0. 文档已重构（重要）

旧的单体 `selling-api` 文档已拆分。现在的正确入口：

| 用途 | URL |
|---|---|
| API Reference（总入口，5 个服务） | `https://docs.aws.amazon.com/partner-central/latest/APIReference/welcome.html` |
| 全部 Actions 清单 | `https://docs.aws.amazon.com/partner-central/latest/APIReference/API_Operations.html` |
| Developer Guide（SDK/认证） | `https://docs.aws.amazon.com/partner-central/latest/selling-api/welcome.html` |

注意：`.../selling-api/API_Operations.html` 和 `.../dev-guide/*` 已失效（空页 / 404）。

---

## 1. 五个服务的元数据（从本地模型提取，非猜测）

| 服务 | botocore service name | endpointPrefix | signingName | apiVersion | protocol | targetPrefix | 操作数 |
|---|---|---|---|---|---|---|---|
| Selling | `partnercentral-selling` | `partnercentral-selling` | `partnercentral-selling` | 2022-07-26 | json | `AWSPartnerCentralSelling` | 45 |
| Account | `partnercentral-account` | `partnercentral-account` | `partnercentral-account` | 2025-04-04 | json | `PartnerCentralAccount` | 34 |
| Benefits | `partnercentral-benefits` | `partnercentral-benefits` | `partnercentral-benefits` | 2018-05-10 | json | `PartnerCentralBenefitsService` | 17 |
| Channel | `partnercentral-channel` | `partnercentral-channel` | `partnercentral-channel` | 2024-03-18 | json | `PartnerCentralChannel` | 17 |
| Revenue Measurement | `partnercentral-revenue-measurement` | **`partnercentral-prm`** | **`partnercentral`** | 2022-07-26 | **smithy-rpc-v2-cbor** | `PartnerCentralRevenueMeasurement` | 18 |

合计 131 个 operation。

### 关键差异点（踩坑处）

1. **Revenue Measurement 的 endpointPrefix 是 `partnercentral-prm`，不是服务名**，signingName 也只是 `partnercentral`。
2. **Selling / Account / Benefits 是 regional 端点**：`https://<prefix>.<region>.amazonaws.com`
3. **Channel / Revenue Measurement 是 global 端点**：`https://<prefix>.global.api.aws`
   - 用默认 region 解析会拼出 `partnercentral-prm.us-east-1.amazonaws.com`，实测直接 **SSLError**（证书不匹配，该主机不存在）。
   - 必须显式 `endpoint_url='https://partnercentral-prm.global.api.aws'`。
   - 其 auth scheme 是 **sigv4a**（signingRegionSet `*`），fallback sigv4。

---

## 2. 本地工具链支持矩阵（实测）

| 服务 | aws CLI v2.36.44 | 系统 boto3 1.42.68 | 备注 |
|---|---|---|---|
| Selling | ✅ `aws partnercentral-selling` | ✅ | 唯一进了 CLI 的 |
| Account | ❌ | ✅ | CLI 无子命令，走 SDK |
| Benefits | ❌ | ✅ | 同上 |
| Channel | ❌ | ✅ | 同上 |
| Revenue Measurement | ❌ | ❌ `UnknownServiceError` | 需挂 `AWS_DATA_PATH` |

CLI 内置模型目录只有 `partnercentral-selling`：
`/usr/local/aws-cli/awscli/botocore/data/`

系统 botocore 有 4 个（缺 revenue-measurement）：
`/Library/Frameworks/Python.framework/Versions/3.13/lib/python3.13/site-packages/botocore/data/`

### 启用 Revenue Measurement 的方法（已验证可用）

本机 uv 缓存里有完整 5 服务模型：
`/Users/mark/.cache/uv/.tmpz2Qpy0/botocore/data/`

```bash
export AWS_DATA_PATH=/Users/mark/.cache/uv/.tmpz2Qpy0/botocore/data
```

挂上后 `boto3.client('partnercentral-revenue-measurement')` 即可创建成功。
（该路径是 uv 临时缓存，不稳定；生产建议把模型目录复制到项目内固定路径。）

---

## 3. 通用调用约定

### Catalog 参数是强制的

**所有 List/Get 操作都必须传 Catalog**，漏传直接 `ParamValidationError`。
取值：`AWS`（生产）/ `Sandbox`（沙箱测试）。

### 大小写陷阱（各服务不统一，非常容易错）

| 服务 | 参数命名 | 示例 |
|---|---|---|
| Selling | PascalCase | `Catalog='AWS'` |
| Account | PascalCase | `Catalog='AWS'` |
| Benefits | PascalCase | `Catalog='AWS'` |
| **Channel** | **camelCase** | **`catalog='AWS'`**，返回字段也是 `items` / `id` / `arn` |
| Revenue Measurement | PascalCase | `Catalog='AWS'` |

Channel 是唯一用 camelCase 的，实测传 `Catalog` 会报 Unknown parameter。

### ARN 格式

```
arn:aws:partnercentral:us-east-1:105673812363:catalog/AWS/<resource-type>/<id>
```

资源类型实例：`opportunity/O28383098`、`solution/S-0099438`、`partner/partner-kgtuwt5hyqom2`、
`benefit-application/benappl-2ytlqygp12lfp7`、`program-management-account/pma-xxx/relationship/rs-xxx`

---

## 4. 各服务操作清单与实测结果

### 4.1 Selling API（45 ops）— 核心，唯一有 CLI

**Opportunity 生命周期**
`CreateOpportunity` `UpdateOpportunity` `GetOpportunity` `ListOpportunities`
`AssignOpportunity` `SubmitOpportunity`

**Engagement / AWS Referral**
`CreateEngagement` `GetEngagement` `ListEngagements` `ListEngagementMembers`
`CreateEngagementInvitation` `GetEngagementInvitation` `ListEngagementInvitations`
`AcceptEngagementInvitation` `RejectEngagementInvitation`
`CreateEngagementContext` `UpdateEngagementContext`
`ListEngagementResourceAssociations`

**异步任务（Task 模式）**
`StartEngagementByAcceptingInvitationTask` / `ListEngagementByAcceptingInvitationTasks`
`StartEngagementFromOpportunityTask` / `ListEngagementFromOpportunityTasks`
`StartOpportunityFromEngagementTask` / `ListOpportunityFromEngagementTasks`
`StartProspectingFromEngagementTask` / `GetProspectingFromEngagementTask` / `ListProspectingFromEngagementTasks`

**实体关联**
`AssociateOpportunity` `DisassociateOpportunity`（关联 AWS Products / Solutions / Marketplace Private Offers）

**Solutions / AWS 视角**
`ListSolutions` `GetAwsOpportunitySummary`
> 注意 SDK 方法名是 `GetAwsOpportunitySummary`（小写 ws），文档里写作 GetAWSOpportunitySummary。

**Resource Snapshot（CRM 同步用）**
`CreateResourceSnapshot` `GetResourceSnapshot` `ListResourceSnapshots`
`CreateResourceSnapshotJob` `StartResourceSnapshotJob` `StopResourceSnapshotJob`
`DeleteResourceSnapshotJob` `GetResourceSnapshotJob` `ListResourceSnapshotJobs`

**系统设置 / 标签**
`GetSellingSystemSettings` `PutSellingSystemSettings`
`TagResource` `UntagResource` `ListTagsForResource`

**EventBridge 事件**（非 API，是订阅）
Opportunity Created / Opportunity Updated / Engagement Invitation Created / Accepted / Rejected

实测：
```bash
aws partnercentral-selling list-solutions --catalog AWS --profile WebbyAPN
# → S-0099438 Mergebyte Enterprise Cloud Migration (Inactive, Professional Service)
#   S-0094524 Webby AI Platform — Anthropic Claude (Active, Software Product)
#   S-0087929 Webby Intelligence Document Processing (Active, Consulting Service)

aws partnercentral-selling list-opportunities --catalog AWS --max-results 3 --profile WebbyAPN
# → O28383098 Net New Business / Prospect / Approved
#   Customer: WEBBY X SDN. BHD. (MY) / ExpectedSpend 8200 USD Monthly
```

### 4.2 Account API（34 ops）— 2025-04-04，最新

**Partner / Profile**
`CreatePartner` `GetPartner` `ListPartners`
`StartProfileUpdateTask` `GetProfileUpdateTask` `CancelProfileUpdateTask`
`GetProfileVisibility` `PutProfileVisibility`
`GetAllianceLeadContact` `PutAllianceLeadContact`

**Connection（伙伴间互联）**
`CreateConnectionInvitation` `GetConnectionInvitation` `ListConnectionInvitations`
`AcceptConnectionInvitation` `RejectConnectionInvitation` `CancelConnectionInvitation`
`GetConnection` `ListConnections` `CancelConnection`
`GetConnectionPreferences` `UpdateConnectionPreferences`

**Verification / Qualifications**
`StartVerification` `GetVerification` `SendEmailVerificationCode`
`StartQualificationsAssociationTask` `GetQualificationsAssociationTask` `GetQualificationsAssociationDetails`
`StartQualificationsDisassociationTask` `GetQualificationsDisassociationTask`
`AssociateAwsTrainingCertificationEmailDomain` `DisassociateAwsTrainingCertificationEmailDomain`

**标签**：`TagResource` `UntagResource` `ListTagsForResource`

实测：
- `ListPartners` → 1 条：**Webby Group**，`partner-kgtuwt5hyqom2`，创建于 2022-10-31
- `ListConnections` → 2 条 ACTIVE，类型均为 `OPPORTUNITY_COLLABORATION`
  - `pac-hvrzkhoke2q2s` ↔ 账号 915848750337 (pprofile-fbywnjd3j3zwo)
  - `pac-4ceoucbtg2yo2` ↔ 账号 992382688998 (pprofile-ducfiptjsptec)
- `ListConnectionInvitations` → 2 条

### 4.3 Benefits API（17 ops）— 资金 / MDF 申请

**Benefit 目录**：`ListBenefits` `GetBenefit`
**Application 生命周期**：
`CreateBenefitApplication` `UpdateBenefitApplication` `GetBenefitApplication` `ListBenefitApplications`
`SubmitBenefitApplication` `AmendBenefitApplication` `RecallBenefitApplication` `CancelBenefitApplication`
**Allocation**：`ListBenefitAllocations` `GetBenefitAllocation`
**资源关联**：`AssociateBenefitApplicationResource` `DisassociateBenefitApplicationResource`
**标签**：`TagResource` `UntagResource` `ListTagsForResource`

实测（数据量最大）：
- `ListBenefits` → **114 个 ACTIVE benefit**（单页仅 34，必须翻页），含
  VMware Incentives / SCA GTM Funding / SCA Sponsorship Funding /
  SCA GenAI Innovation Sandbox Credits / PS Custom MDF /
  SCA Non-Standard Proof of Concept / Epic Incentives / SCA Strategic Opportunity Funding …
- `ListBenefitApplications` → 100+（有 NextToken），示例：
  ```
  benappl-2ytlqygp12lfp7  Migrated Fund Request FR-POC-CASH-...
  Programs=[POC] FulfillmentTypes=[CASH] Status=APPROVED Stage=FULFILLMENT
  BudgetYear=2026 PO=ML-17982745
  AssociatedResources=[.../opportunity/O7719933]   ← 与 Selling 的 Opportunity 打通
  ```
- `ListBenefitAllocations` → 100+（有 NextToken）

> 关键洞察：`AssociatedResources` 字段用 Opportunity ARN 把 Benefits 和 Selling 两个服务关联起来，
> 这是做「商机 ↔ 资金申请」联动报表的连接键。

### 4.4 Channel API（17 ops）— 分销 / 渠道，camelCase

**Handshake**：`CreateChannelHandshake` `AcceptChannelHandshake` `RejectChannelHandshake`
`CancelChannelHandshake` `ListChannelHandshakes`
**Relationship**：`CreateRelationship` `GetRelationship` `UpdateRelationship` `DeleteRelationship` `ListRelationships`
**Program Management Account (PMA)**：
`CreateProgramManagementAccount` `UpdateProgramManagementAccount`
`DeleteProgramManagementAccount` `ListProgramManagementAccounts`
**标签**：`TagResource` `UntagResource` `ListTagsForResource`

实测：
- `ListProgramManagementAccounts(catalog='AWS')` → 1 个
  ```
  pma-acjr4lb2zzc60  program=DISTRIBUTION_SELLER  displayName=PMA-DSP-9876
  accountId=006215409876  status=ACTIVE  startDate=2026-07-01
  ```
- `ListRelationships(catalog='AWS')` → 4 条，全部 `associationType=END_CUSTOMER`，`sector=COMMERCIAL`
  ```
  rs-ls3xatfmgu510  WebbyX Agri          → 308513050033  start 2026-09-01
  rs-h37xulo1m9vk1  Sustainable Hrvest   → 872738227852  start 2026-08-01
  (+2)
  ```
- 注意：`ListChannelHandshakes` 还强制要求 `handshakeType` 参数。

> 这说明 WebbyAPN 账号具备 **DISTRIBUTION_SELLER（分销商）** 身份，
> 且 relationship 里的 END_CUSTOMER 账号与你 `~/.aws/config` 里的 profile（如 hrvest）存在对应关系。

### 4.5 Revenue Measurement API（18 ops）— global + sigv4a

**Revenue Attribution**：
`CreateRevenueAttribution` `UpdateRevenueAttribution` `GetRevenueAttribution` `ListRevenueAttributions`
`GetRevenueAttributionAllocation` `ListRevenueAttributionAllocations`
`StartRevenueAttributionAllocationsTask` `GetRevenueAttributionAllocationsTask`

**Marketplace Revenue Share**：
`CreateMarketplaceRevenueShare` `GetMarketplaceRevenueShare` `ListMarketplaceRevenueShares`
`CreateMarketplaceRevenueShareAllocation` `GetMarketplaceRevenueShareAllocation`
`UpdateMarketplaceRevenueShareAllocation` `ListMarketplaceRevenueShareAllocations`

**标签**：`TagResource` `UntagResource` `ListTagsForResource`

实测：`ListRevenueAttributions(Catalog='AWS')` → `RevenueAttributionSummaries: 0`（调用成功，暂无数据）

---

## 5. 统一客户端封装

已落地：`scripts/partner_central.py`，封装三个坑（global 端点 / 模型缺失 / camelCase）。

```python
from scripts.partner_central import client, catalog_kw, paginate, health_check

# 探活五服务
health_check()

# 商机
sell = client("partnercentral-selling")
opps = paginate(sell, "partnercentral-selling",
                "list_opportunities", "OpportunitySummaries", Catalog="AWS")

# 资金申请（务必翻页，单页只有 100）
ben  = client("partnercentral-benefits")
apps = paginate(ben, "partnercentral-benefits",
                "list_benefit_applications", "BenefitApplicationSummaries", Catalog="AWS")

# 渠道关系（camelCase，返回 items）
ch   = client("partnercentral-channel")
rels = paginate(ch, "partnercentral-channel", "list_relationships", "items", catalog="AWS")

# 收入归因（global 端点已自动处理）
prm  = client("partnercentral-revenue-measurement")
ra   = prm.list_revenue_attributions(Catalog="AWS")["RevenueAttributionSummaries"]
```

运行结果（实测）：

```
$ python3 scripts/partner_central.py
partnercentral-selling                 OK  SolutionSummaries=6
partnercentral-account                 OK  PartnerSummaryList=1
partnercentral-benefits                OK  BenefitSummaries=34
partnercentral-channel                 OK  items=4
partnercentral-revenue-measurement     OK  RevenueAttributionSummaries=0
```

翻页验证：`list_benefit_applications` 单页 100 → 翻页后 **161** 条。

---

## 6. 当前账号能力快照

| 维度 | 结果 |
|---|---|
| Partner 实体 | Webby Group（2022-10-31 注册） |
| 渠道身份 | DISTRIBUTION_SELLER（PMA-DSP-9876） |
| 终端客户关系 | 4 条 END_CUSTOMER |
| 伙伴互联 | 2 条 ACTIVE OPPORTUNITY_COLLABORATION |
| Solutions | 6 个 |
| 可申请 Benefit | 114 个 ACTIVE |
| 商机 | 245 个（Approved 237 / Rejected 8） |
| 历史资金申请 | 161 条（APPROVED 101 / PENDING_SUBMISSION 49） |
| 收入归因 | 0（未启用） |
| 5 个服务权限 | 全部 List 操作实测通过 ✅ |

---

## 7. 速查：踩坑清单

1. **Catalog 必传**，且 Channel 用小写 `catalog`。
2. Revenue Measurement 端点是 `partnercentral-prm.global.api.aws`，用 region 解析会 **SSLError**。
3. Channel 也是 global 端点（`partnercentral-channel.global.api.aws`）。
4. CLI 只支持 Selling，另外 4 个必须用 SDK。
5. 系统 botocore 缺 revenue-measurement 模型，需 `AWS_DATA_PATH`。
6. SDK 方法名是 `GetAwsOpportunitySummary`（`Aws` 不是 `AWS`）。
7. Benefits 的 List 接口默认带 NextToken，不翻页会漏数据（161 vs 100）。
8. `ListChannelHandshakes` 额外强制 `handshakeType`。
9. Benefits ↔ Selling 通过 `AssociatedResources` 里的 Opportunity ARN 关联。
10. Revenue Measurement 用 sigv4a 签名 + smithy-rpc-v2-cbor 协议，旧 SDK 可能不支持。

---

## 8. 端到端：提交商机 → 改阶段 → 申请 POC Cash

**结论：三步全部可以纯 API 完成，无需碰控制台。** 但有几个硬约束必须先知道。

### 8.1 三步的 API 映射

| 业务动作 | API | 必填参数 |
|---|---|---|
| ① 建商机 | `CreateOpportunity` | `Catalog`, `ClientToken` |
| ① 提交给 AWS 审核 | `SubmitOpportunity` | `Catalog`, `Identifier`, `InvolvementType` |
| ② 改阶段 | `UpdateOpportunity` | `Catalog`, `Identifier`, `LastModifiedDate` |
| ③ 建资金申请 | `CreateBenefitApplication` | `Catalog`, `ClientToken`, `BenefitIdentifier` |
| ③ 关联商机 | `AssociateBenefitApplicationResource` | `Catalog`, `BenefitApplicationIdentifier`, `ResourceArn` |
| ③ 提交资金申请 | `SubmitBenefitApplication` | `Catalog`, `Identifier` |

### 8.2 枚举值（来自模型，权威）

```
Stage            = Prospect | Qualified | Technical Validation |
                   Business Validation | Committed | Launched | Closed Lost
ReviewStatus     = Pending Submission | Submitted | In review |
                   Approved | Rejected | Action Required     ← 只读，AWS 侧写
OpportunityType  = Net New Business | Flat Renewal | Expansion
InvolvementType  = For Visibility Only | Co-Sell
Visibility       = Full | Limited
FulfillmentType  = CREDITS | CASH | ACCESS
BenefitApplicationStatus = PENDING_SUBMISSION | IN_REVIEW | ACTION_REQUIRED |
                           APPROVED | REJECTED | CANCELED
```

### 8.3 三个硬约束（会卡住自动化）

**① `SubmitOpportunity` 后商机被锁**

模型原文：
> After you perform this action, the Opportunity becomes **non-editable** until it is
> reviewed by AWS and has `LifeCycle.ReviewStatus` as either `Approved` or `Action Required`.

所以顺序必须是「先把 Stage 调好 → 再 Submit」。提交后想改阶段，得等 AWS 审完
（实测账号 245 个商机里 237 个已 Approved，说明审核通过是常态，但有 8 个 Rejected）。

**② `UpdateOpportunity` 强制乐观锁**

`LastModifiedDate` 是必填，且必须等于服务端当前值，否则抛 `ConflictException`。
→ 改阶段前必须先 `GetOpportunity` 取最新时间戳，不能缓存复用。

**③ `ReviewStatus` 不可写**

只能改 `Stage`，审核状态由 AWS 单方面推进。

### 8.4 POC Cash 的两段式结构（关键）

POC 不是一个 benefit，而是**两个**，分属资金生命周期的前后两段：

| Benefit ID | 名称 | FulfillmentTypes | 用途 |
|---|---|---|---|
| `ben-un8hh6qdrxqx50` | Proof Of Concept Funding program | CREDITS, CASH | **事前**申请预批 |
| `ben-8j7y5dohajcl16` | Proof Of Concept Cash Claim | CASH | **事后**凭发票请款 |

字段 schema 从 `GetBenefit` 的 `BenefitRequestSchema` 取（draft-07 JSON Schema），
嵌在 `properties.BenefitApplicationDetails` 下：

- **Funding program** 字段：`Program`(enum: `Proof Of Concept`)、`Template`(enum: `POC`)、
  `ActivityName`、`BusinessDescription`、`AwsAccountId`、`BudgetYear`、
  `PlannedStartDate`/`PlannedEndDate`、`AnnualRunRate`、`CashRequest`/`CreditRequest`、
  `AwsCalculatorUrls`、`ExecutedCountry`、`Wwps`/`WwpsConsent`、`CustomerConsidering`
- **Cash Claim** 字段：`AwsAccountId`、`StartDate`/`EndDate`、`ClaimAmount`、
  `ProductionDate`、`SubmissionDate`、`AutoApproved`

`CashRequest` 子结构（`CashClaims` 必填 `StartDate`+`EndDate`，1–10 条）：

```
CashRequest.CashClaims[].StartDate / EndDate   ← required
CashRequest.TotalCostOfActivity {Amount,Currency}
CashRequest.Currency / InvoiceRemitCountry / InvoiceRemitAddress
CashRequest.InvoiceEntityName / AccountProfileID
CashRequest.PartnerContribution / OtherPartyContribution
CashRequest.PurchaseOrderNumber   ← readOnly，AWS 批准后回填
CashRequest.ApprovedAmount        ← readOnly
CashRequest.RequestedAmount       ← readOnly
```

> 注意 `readOnly` 字段（PO 号、批准金额）不要在创建时传，由 AWS 审批后写入。

### 8.5 真实样本（benappl-2ytlqygp12lfp7，已 APPROVED）

```
BenefitId        ben-un8hh6qdrxqx50   Programs=[POC]  FulfillmentTypes=[CASH]
Status           APPROVED             Stage=FULFILLMENT
ActivityName     Webby - HCK cloud-project #ADPL (#ADPL)
AwsAccountId     176350488746         BudgetYear=2026
Planned          2025-07-15 → 2026-01-02
TotalCostOfActivity   45000.00 MYR
RequestedAmount       42114.96 MYR    ApprovedAmount 42114.96 MYR
PurchaseOrderNumber   ML-17982745     ← AWS 回填
InvoiceEntityName     WEBBY SDN BHD   InvoiceRemitCountry MY
AccountProfileID      123749FB67ZJQ
AssociatedResources   .../opportunity/O7719933    ← 与商机绑定
```

### 8.6 实测状态分布（161 条申请）

```
Status : APPROVED 101 | PENDING_SUBMISSION 49 | ACTION_REQUIRED 7 | IN_REVIEW 2 | CANCELED 2
Stage  : (空) 58 | FULFILLMENT 53 | Disbursement 48 | BUSINESS_APPROVAL 2
Fulfil : CASH 154 | CREDITS 6 | ACCESS 1
关联商机：142 / 161
```

> 49 条停在 `PENDING_SUBMISSION` —— 这些是建了但没 `SubmitBenefitApplication` 的，
> 正是自动化可以补救的部分。

### 8.7 完整代码

见 `scripts/poc_cash_flow.py`，含乐观锁重试、两段式 POC、dry-run 模式。

```bash
# 只演练不写入（默认）
python3 scripts/poc_cash_flow.py

# 查看某商机当前可否改阶段
python3 scripts/poc_cash_flow.py --inspect O28383098
```

### 8.8 自动化可行性小结

| 环节 | 能否 API | 备注 |
|---|---|---|
| 创建商机 | ✅ | `ClientToken` 做幂等 |
| 改 Stage | ✅ | 需先 Get 取 `LastModifiedDate` |
| 提交商机 | ✅ | 提交后锁定，顺序要对 |
| 改 ReviewStatus | ❌ | AWS 侧只读 |
| 提交后改 Stage | ⚠️ | 须等 Approved / Action Required |
| 建 POC 申请 | ✅ | 字段按 `BenefitRequestSchema` 组装 |
| 关联商机 | ✅ | `AssociateBenefitApplicationResource` |
| 提交 POC 申请 | ✅ | |
| 上传附件 | ✅ | `FileDetails[].FileURI` 接受 `s3://` 或 `https://`，见 9.3 |
| 审批结果 | ❌ | AWS 人工/系统裁决，只能轮询 |

---

## 9. 「完整 POC」到底由什么构成（只读实证）

对账户内 **49 条 PENDING + 25 条 APPROVED** 逐条拉取比对得出，未做任何写操作。

### 9.1 完整件的字段全集

一条可提交的 POC 申请由**四块**组成，缺一不可：

```
CreateBenefitApplication(
  Catalog, ClientToken, BenefitIdentifier,     # ① 基础
  Name, Description,
  FulfillmentTypes=['CASH'],
  BenefitApplicationDetails={...},              # ② 表单主体
  PartnerContacts=[{...}],                      # ③ 联系人
  FileDetails=[{FileURI, ...}],                 # ④ 附件
)
→ AssociateBenefitApplicationResource(ResourceArn=<opportunity ARN>)   # ⑤ 关联商机
→ SubmitBenefitApplication()
```

**③ PartnerContacts**（`Contact` shape，无必填约束，但实际都填全）

```
Email / FirstName / LastName / BusinessTitle / Phone
```
真实样本：`sy.siow@webbygroup.com` / Shook / Yien Siow / Business Strategy Director

**④ FileDetails**（`FileDetail` shape，**只有 `FileURI` 必填**）

```
FileURI          必填，pattern: (s3://|https://).*
BusinessUseCase  如 "AWS Pricing Calculator" / "Customer Sign Off Template"
FileName / FileType / FileStatus / FileStatusReason / CreatedBy / CreatedAt
```

`FileType` 枚举：`application/pdf`、`image/png`、`image/jpeg`、`image/svg+xml`、
`text/csv`、Word/Excel/PPT 的 openxmlformats 三种、`application/msword`。

### 9.2 两块 100% 干净的信号

| 特征 | PENDING(49) | APPROVED(25) |
|---|---|---|
| 有附件 `FileDetails` | 63.3% | **100%** |
| 有关联商机 `AssociatedResources` | 65.3% | **100%** |

APPROVED 里**零反例**——没有任何一条已批准申请是缺附件或缺商机关联的。
所以这两项是提交的**必要条件**。

其余字段（ActivityName / BusinessDescription / BudgetYear / 发票信息…）
在两组里占比接近甚至 PENDING 更高，**不构成区分度**。

### 9.3 但它们不是充分条件（重要反证）

49 条 PENDING 里有 **30 条附件和商机都齐全**，仍然没提交。
说明「字段齐 ≠ 能提交」。继续挖，真正的分水岭是另一件事：

| 分组 | PENDING | APPROVED |
|---|---|---|
| 名称含 `Migrated Fund Request` | **39** | 12 |
| 原生件（自主创建，非迁移） | **0** | 9 |
| 无名件 | 10 | 4 |

**原生件卡在 PENDING 的：0 条。**

49 条 PENDING 中 39 条是 `Migrated Fund Request`，即 AWS 从旧 ACE/Fund Request
系统迁移过来的历史存量，附件 `CreatedBy=MIGRATION`。它们在旧系统里已经走完流程，
迁到新 Benefits 服务后状态停在 `PENDING_SUBMISSION`，**是历史包袱而非待办事项**。

> ⚠️ 结论修正：上一轮我说「49 条停在 PENDING 正是自动化可以补救的部分」，
> 这个判断是错的。它们绝大多数是迁移残留，盲目批量 Submit 会向 AWS
> 重复提交历史资金申请。

### 9.4 两段式在真实数据里的体现

| benefit | PENDING | APPROVED |
|---|---|---|
| `ben-un8hh6qdrxqx50` POC Funding program（事前） | 46 | 15 |
| `ben-8j7y5dohajcl16` POC Cash Claim（事后） | 0 | 10 |

9 条原生 APPROVED 件**全部是事后 Cash Claim**，且 `Stage=Disbursement`。
事后件的字段结构与事前件完全不同：

```json
{
  "Program": "Proof of Concept Cash Claim",
  "Template": "POC",
  "FulfillmentTypes": ["CASH"],
  "AwsAccountId": "873727239650",
  "StartDate": "2026-06-10", "EndDate": "2026-06-26",
  "DueDate": "2026-12-16",
  "ClaimAmount": { "Amount": "32714", "Currency": "MYR" },
  "CustomerSignOffAttached": false,
  "Invoice": {
    "Description": "https://finopscentral-na.amazon.com/payeecentral/invoices/details/284566252#/",
    "ScheduledPaymentDate": "2026-07-30",
    "Amount": { "CurrencyCode": "MYR", "Amount": "32714.00" }
  }
}
```

附件是 `Customer Sign Off Template`（客户签收单），`CreatedBy=PARTNER`。
`Invoice` 块由 AWS 侧回填（含 PayeeCentral 链接与排期付款日）。

### 9.5 所以「能否纯 API 提交完整 POC」

**能。** 全链路都有对应 API，附件也能挂（`FileURI` 传 S3 或 https 均可）。

但有三点必须知道：

1. **附件不是「上传」接口**，`FileDetails` 只存 URI。文件本身要先放到可访问位置；
   AWS 侧返回的 URI 是带 `X-Amz-Security-Token` 的 presigned URL（
   `aws-partner-central-benefits-files.s3.amazonaws.com/<account>/<appId>/...`），
   写入时用自己的 `s3://` 即可。
2. **事前 / 事后是两个独立 benefit**，别混。事后件需要客户签收单和发票信息。
3. **账户里那 49 条 PENDING 不要批量提交**（见 9.3）。真要清理，
   先按 `Name` 过滤掉 `Migrated Fund Request`，只处理原生件 —— 而原生件目前是 0 条。
