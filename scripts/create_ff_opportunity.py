"""为 FF Cloud 创建新商机（POC 前置）。

模板来源：O24549699（Webby - FF Cloud-project #ADPL）
  Customer : FF CLOUD PG NETWORK TECHNOLOGY SDN. BHD.
  Industry : Gaming          ← 与 Korea Wallpaper 的 Retail 不同
  Address  : MY / 10250
  Website  : kemaisystems.com
  Marketing: Source=None     ← 注意不是 Marketing Activity
  Owner    : sy.siow@webbygroup.com

金额：MRR 5,000 USD 为驱动值，其余按 docs/poc-cash-guide.md 4.1 联动
  MRR = 5,000 USD/月              ← 填 ExpectedCustomerSpend
  ARR = 5,000 × 12 = 60,000 USD   ← 定价计算器要做到这个数
  POC 可申请 = ARR / 10 = 6,000 USD ≈ 25,620 MYR

完整流程（实测得出，顺序不能变）：
  CreateOpportunity
    → AssociateOpportunity（挂 Solution）
    → StartEngagementFromOpportunityTask（内含提交，不能直接调 SubmitOpportunity）
    → 等 AWS 审批后才能推 Stage

默认 dry-run，加 --execute 才真正创建。
"""

import argparse
import json
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

PROFILE = "WebbyAPN"
REGION = "us-east-1"
CATALOG = "AWS"

# 本机走代理，默认 5s 超时会直接 ReadTimeout
_CFG = Config(connect_timeout=20, read_timeout=90, retries={"max_attempts": 5})

TEMPLATE_ID = "O24549699"

# ---- 以 MRR 为驱动值，改这一个数其余自动跟随 ----
MRR_USD = 5000
ARR_USD = MRR_USD * 12                  # 60,000
TARGET_POC_USD = round(ARR_USD / 10)    # 6,000

# POC 实施规模（决定 Total Cost of Activity）。
# 2 人 6 天 = 12 人天 → Total 32,544 MYR，Partner 投入占 21.3%，比例合理。
# 若用 2 人 5 天，Partner 只剩 1,500 MYR（5.5%），偏低易被质疑。
POC_PEOPLE = 2
POC_DAYS = 6

# 命名沿用账户惯例（两段式）：Webby - <客户> <项目描述> #ADPL
TITLE = "Webby - FF Cloud Application Service Migration #ADPL"

SOLUTION_ID = "S-0070517"               # Migration services（Consulting Service）

BUSINESS_PROBLEM = (
    "FF Cloud is standardizing its delivery on AWS to support enterprise "
    "publishing partners, peak-event elasticity, audit and compliance governance, "
    "and long-term cost control. The workload currently runs on Google Cloud "
    "Platform together with self-managed components, which limits elasticity "
    "during peak events and increases operational overhead. This project covers "
    "the migration of application services and their supporting databases to AWS, "
    "containerising the workloads for consistent deployment across environments, "
    "and validating system behaviour under production-equivalent load before "
    "cutover. Webby will assess the existing architecture, design the target AWS "
    "landing zone, execute the migration of application and database components, "
    "and run performance and failover validation. The initiative aims to improve "
    "elasticity during peak events, strengthen compliance and audit posture, and "
    "establish a repeatable deployment pipeline for future expansion."
)


def build_payload():
    """严格对齐模板 O24549699 的字段结构。"""
    return {
        "Catalog": CATALOG,
        "ClientToken": str(uuid.uuid4()),
        "PrimaryNeedsFromAws": ["Co-Sell - Deal Support"],
        "NationalSecurity": "No",
        "OpportunityType": "Net New Business",
        "Customer": {
            "Account": {
                "Industry": "Gaming",
                "CompanyName": "FF CLOUD PG NETWORK TECHNOLOGY SDN. BHD.",
                "WebsiteUrl": "kemaisystems.com",
                "Address": {"PostalCode": "10250", "CountryCode": "MY"},
            },
        },
        "Project": {
            "Title": TITLE,
            "CustomerBusinessProblem": BUSINESS_PROBLEM,
            # 迁移方向。必须用完整字面量，写成 "Migration" 会被拒。
            "CustomerUseCase": "Migration / Database Migration",
            "DeliveryModels": ["Professional Services"],
            "SalesActivities": ["Customer has shown interest in solution"],
            "ExpectedCustomerSpend": [{
                "Amount": str(MRR_USD),
                "CurrencyCode": "USD",
                "Frequency": "Monthly",
                "TargetCompany": "AWS",
            }],
        },
        # 模板用的是 None，不是 Marketing Activity；无 AwsFundingUsed 字段
        "Marketing": {"Source": "None"},
        "OpportunityTeam": [{
            "Email": "sy.siow@webbygroup.com",
            "FirstName": "SY",
            "LastName": "Siow",
            "BusinessTitle": "OpportunityOwner",
        }],
        "LifeCycle": {
            "Stage": "Prospect",
            "TargetCloseDate": "2027-03-31",
        },
    }


def client():
    return boto3.Session(profile_name=PROFILE, region_name=REGION).client(
        "partnercentral-selling", config=_CFG)


def show_template(sell):
    t = sell.get_opportunity(Catalog=CATALOG, Identifier=TEMPLATE_ID)
    lc, pr = t.get("LifeCycle") or {}, t.get("Project") or {}
    sp = (pr.get("ExpectedCustomerSpend") or [{}])[0]
    a = (t.get("Customer") or {}).get("Account") or {}
    print(f"模板 {TEMPLATE_ID}")
    print(f"  Title     {pr.get('Title')}")
    print(f"  Customer  {a.get('CompanyName')}  [{a.get('Industry')}]")
    print(f"  Stage     {lc.get('Stage')} / {lc.get('ReviewStatus')}")
    print(f"  Spend     {sp.get('Amount')} {sp.get('CurrencyCode')} "
          f"{sp.get('Frequency')}")
    print(f"  Solutions {(t.get('RelatedEntityIdentifiers') or {}).get('Solutions')}")


def run(execute=False, submit=True):
    sell = client()
    payload = build_payload()
    pr = payload["Project"]

    print("=" * 68)
    print(f"新建 FF Cloud 商机  ({'EXECUTE' if execute else 'DRY-RUN'})")
    print("=" * 68)
    show_template(sell)

    print("\n将创建")
    print(f"  Title     {pr['Title']}")
    print(f"  UseCase   {pr['CustomerUseCase']}")
    print(f"  Customer  {payload['Customer']['Account']['CompanyName']}")
    print(f"  Spend     {MRR_USD:,} USD Monthly  "
          f"(ARR {ARR_USD:,} → POC 可申请 {TARGET_POC_USD:,} USD)")
    print(f"  Solution  {SOLUTION_ID}")
    print(f"  提交       {'是' if submit else '否'}")

    if not execute:
        p = dict(payload)
        p["ClientToken"] = "<uuid>"
        print("\n[dry-run] 未创建。完整 payload：")
        print(json.dumps(p, ensure_ascii=False, indent=1))
        print("\n加 --execute 真正创建。")
        return None

    try:
        resp = sell.create_opportunity(**payload)
    except ClientError as e:
        print(f"\n创建失败 {e.response['Error']['Code']}: "
              f"{e.response['Error']['Message'][:300]}")
        return None
    oid = resp["Id"]
    print(f"\n[1/3] 已创建 {oid}")

    # 关联 Solution。AWS 审 POC 时会看商机是否挂了对应的方案。
    try:
        sell.associate_opportunity(
            Catalog=CATALOG, OpportunityIdentifier=oid,
            RelatedEntityType="Solutions", RelatedEntityIdentifier=SOLUTION_ID)
        print(f"[2/3] 已关联 Solution {SOLUTION_ID}")
    except ClientError as e:
        print(f"[2/3] 关联失败: {e.response['Error']['Message'][:200]}")

    if not submit:
        print("[3/3] 跳过提交（--no-submit）")
        return oid

    # ⚠️ 不能直接调 SubmitOpportunity —— 会报
    # "Cannot submit opportunity without an engagement"。
    # StartEngagementFromOpportunityTask 会把建 engagement + 提交合并完成。
    try:
        t = sell.start_engagement_from_opportunity_task(
            Catalog=CATALOG, ClientToken=str(uuid.uuid4()), Identifier=oid,
            AwsSubmission={"InvolvementType": "Co-Sell", "Visibility": "Full"})
        print(f"[3/3] 提交完成  task={t.get('TaskId')} "
              f"status={t.get('TaskStatus')} engagement={t.get('EngagementId')}")
        if t.get("Message"):
            print(f"      message: {t['Message']}")
    except ClientError as e:
        print(f"[3/3] 提交失败: {e.response['Error']['Message'][:300]}")

    final = sell.get_opportunity(Catalog=CATALOG, Identifier=oid)
    lc = final.get("LifeCycle") or {}
    print(f"\n最终状态  Stage={lc.get('Stage')} "
          f"ReviewStatus={lc.get('ReviewStatus')}")
    print(f"  Arn {final.get('Arn')}")
    print(f"\n下一步：做定价计算器（ARR {ARR_USD:,} USD）")
    print(f"  python3 poc_estimate.py --monthly {MRR_USD}")
    print(f"  python3 poc_calc.py --mrr {MRR_USD} "
          f"--people {POC_PEOPLE} --days {POC_DAYS}")
    return oid


def main():
    p = argparse.ArgumentParser(description="为 FF Cloud 建商机")
    p.add_argument("--execute", action="store_true", help="真正创建（默认 dry-run）")
    p.add_argument("--no-submit", action="store_true",
                   help="只创建和关联，不提交给 AWS 审核")
    a = p.parse_args()
    run(execute=a.execute, submit=not a.no_submit)


if __name__ == "__main__":
    main()
