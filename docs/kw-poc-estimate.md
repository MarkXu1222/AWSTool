# Korea Wallpaper POC — 定价计算器填写单

> 商机：**O28604112** — Webby - Korea Wallpaper Application Service Migration #ADPL
> 目标：月均 **2,400 USD** → ARR **28,800 USD** → POC 可申请 **2,880 USD**
> 单价来源：AWS Price List API 实时查询（OnDemand），查询时间见脚本运行日志

⚠️ **AWS Pricing Calculator 没有导入功能，也没有创建估算的 API**
（官方文档只提供 export CSV/PDF）。本文是让你在
<https://calculator.aws/#/> 网页上**照着填**的输入单，填完保存才会拿到
`https://calculator.aws/#/estimate?id=...` 链接。

---

## 区域

**Asia Pacific (Malaysia) — `ap-southeast-5`**

与 POC 表单的 `Country Activity is Executed = Malaysia` 保持一致。

---

## 配置清单

| # | 服务 | 规格 | 数量 | 单价 | 月费 (USD) |
|---|---|---|---|---|---|
| 1 | **EC2** 应用服务器 | `m6i.xlarge` Linux 按需 | **7** 台 | 0.20400 /hr | 1,042.44 |
| 2 | **EC2** 压测机 | `c7i.xlarge` Linux 按需 | **4** 台 | 0.17494 /hr | 510.82 |
| 3 | **RDS** PostgreSQL | `db.m6i.large` Single-AZ | **4** 实例 | 0.21000 /hr | 613.20 |
| 4 | **EBS** gp3 | 通用 SSD | **1,800** GB | 0.08640 /GB-月 | 155.52 |
| 5 | **S3** 标准存储 | General Purpose | **500** GB | 0.02250 /GB-月 | 11.25 |
| 6 | **ALB** | Application Load Balancer | **4** 个 | 0.02270 /hr | 66.28 |

```
月合计   2,399.52 USD
年合计  28,794.23 USD   ← 这个数填进 POC 表单的 ARR
```

与目标 28,800 差 **0.02%**。

> 按 730 小时/月（AWS 标准计价月）换算。

---

## 逐项填写说明

### 1–2. EC2

网页路径：`Configure Amazon EC2` → Advanced estimate

| 字段 | 值 |
|---|---|
| Operating system | Linux |
| Workload | Constant usage |
| Instance type | `m6i.xlarge`（第 1 项）/ `c7i.xlarge`（第 2 项） |
| Payment option | On-Demand |
| Quantity | 7 / 4 |

EBS 卷可以在 EC2 配置里一并填（见第 4 项），也可单独加。

### 3. RDS

网页路径：`Configure Amazon RDS for PostgreSQL`

| 字段 | 值 |
|---|---|
| Deployment option | Single-AZ |
| Instance type | `db.m6i.large` |
| Quantity | 4 |
| Pricing model | On-Demand |

### 4. EBS

| 字段 | 值 |
|---|---|
| Volume type | General Purpose SSD (gp3) |
| Storage amount | 1,800 GB |

IOPS / 吞吐用默认值（3000 IOPS / 125 MB/s 免费额度内）。

### 5. S3

| 字段 | 值 |
|---|---|
| Storage class | S3 Standard |
| Storage amount | 500 GB/月 |

请求数和数据传输留空或填 0 —— 本估算只算存储。

### 6. ALB

| 字段 | 值 |
|---|---|
| Number of ALBs | 4 |
| LCU | 留默认 |

⚠️ 不要选 Outposts 变体。

---

## 未计入的费用

以下项本估算**没有包含**，网页上填了会让总额超出目标：

- 数据传输（出网流量）
- EKS 控制面（$0.10/hr/集群）
- NAT Gateway（$0.045/hr + 流量）
- EBS 快照
- ALB 的 LCU 用量费

如果网页算出来明显高于 28,800，优先核对是否多勾了这些项。

---

## 配置与项目描述的对应关系

商机 O28604112 的业务描述里写的是「迁移应用服务与数据库、容器化、
production-equivalent 负载验证」，清单逐项对应：

| 描述中的动作 | 对应配置 |
|---|---|
| migrate application services | EC2 m6i.xlarge ×7（应用层） |
| supporting databases | RDS db.m6i.large ×4 |
| containerising the workloads | EC2 作为 EKS 工作节点 |
| validating under production-equivalent load | EC2 c7i.xlarge ×4（压测机） |
| — 入口与日志 | ALB ×4 + S3 500GB |

AWS 审 POC 时会看配置是否支撑得起项目描述，两者必须自洽。

---

## 拿到链接之后

1. 保存估算 → 复制 `https://calculator.aws/#/estimate?id=...`
2. 填进 POC Fund Request 的「定价计算器链接」字段
3. 导出 PDF 作为附件（实测 25 条 APPROVED 申请 **100%** 都带附件）

配套的资金申请数字（`poc_calc.py --mrr 2400 --people 2 --days 3`）：

```
Total Cost of Activity   16,272.00 MYR   (339 × 8 × 2人 × 3天)
Partner Contribution      3,974.40 MYR
Customer Contribution         0.00 MYR
→ 实际申请额             12,297.60 MYR  (≈ 2,880 USD)
```

---

## 重新生成

```bash
python3 scripts/poc_estimate.py                  # 默认 2400/月
python3 scripts/poc_estimate.py --monthly 3000   # 换目标金额
python3 scripts/poc_estimate.py --region ap-southeast-1
```

单价每次实时查询，AWS 调价后结果会自动跟随。
