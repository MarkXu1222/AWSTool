"""为 Korea Wallpaper 创建基础设施方向的新商机（POC 前置）。

模板来源：O23557918（Webby - Korea Wallpaper AI Project #ADPL）
  Customer : Korea Wallpaper (KL) Sdn Bhd / Retail / MY / 47170
  Stage    : Technical Validation  ← POC 的前置条件
  Owner    : sy.siow@webbygroup.com

本次差异：AI 方向 → 基础设施方向（迁移/容器化/压测）

金额：首次申请保守起步，以 MRR 2,400 USD 为驱动值反推
（公式见 docs/poc-cash-guide.md 第 4 节，81 条实操记录 100% 吻合）：
  MRR = 2,400 USD/月              ← 填 ExpectedCustomerSpend
  ARR = 2,400 × 12 = 28,800 USD   ← 定价计算器要做到这个数
  POC 可申请 = ARR / 10 = 2,880 USD ≈ 12,298 MYR

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

# 网络不稳时的保护：本机走代理，默认 5s 超时会直接 ReadTimeout
_CFG = Config(connect_timeout=20, read_timeout=90, retries={"max_attempts": 5})

TEMPLATE_ID = "O23557918"

# ---- 以 MRR 为驱动值，其余按 poc-cash-guide.md 4.1 联动 ----
# 首次申请保守起步。改 MRR_USD 一个值即可，ARR 和 POC 额度自动跟随。
MRR_USD = 2400                          # ExpectedCustomerSpend，商机上填这个
ARR_USD = MRR_USD * 12                  # 28,800 —— 定价计算器的年费用目标
TARGET_POC_USD = round(ARR_USD / 10)    # 2,880 —— POC 可申请上限

# POC 实施规模（决定 Total Cost of Activity）。2 人 3 天 = 6 人天，
# Partner 投入占比约 24%，比例合理；实操表项目天数中位数为 4 天。
POC_PEOPLE = 2
POC_DAYS = 3

# 命名沿用账户内实际惯例（两段式，客户名后直接跟项目描述，无第二个连字符）：
#   Webby - Chubb Security cloud-project #ADPL
#   Webby - Anchor Capital project #ADPL
#   Webby - Sustainable Hrvest #ADPL
# 注意不是 YanHuang 的三段式 "Webby - 客户 - 项目"。
TITLE = "Webby - Korea Wallpaper Application Service Migration #ADPL"

BUSINESS_PROBLEM = (
    "Korea Wallpaper plans to migrate its core application services to AWS to "
    "improve scalability and reduce infrastructure operating overhead. The current "
    "environment runs on legacy on-premises servers with limited elasticity, which "
    "causes performance degradation during seasonal promotion peaks and makes "
    "capacity planning difficult. This project covers the migration of application "
    "services and their supporting databases to AWS, containerising the workloads "
    "for consistent deployment across environments, and validating system behaviour "
    "under production-equivalent load before cutover. Webby will assess the existing "
    "application architecture, design the target AWS landing zone, execute the "
    "migration of application and database components, and run performance and "
    "failover validation. The initiative aims to improve scalability during peak "
    "sales periods, strengthen disaster recovery posture, and establish a repeatable "
    "deployment pipeline for future expansion."
)


def build_payload():
    """严格对齐模板 O23557918 的字段结构。"""
    return {
        "Catalog": CATALOG,
        "ClientToken": str(uuid.uuid4()),
        "PrimaryNeedsFromAws": ["Co-Sell - Deal Support"],
        "NationalSecurity": "No",
        "OpportunityType": "Net New Business",
        "Customer": {
            "Account": {
                "Industry": "Retail",
                "CompanyName": "Korea Wallpaper (KL) Sdn Bhd",
                "WebsiteUrl": "https://koreawallpaper.co/",
                "Address": {"PostalCode": "47170", "CountryCode": "MY"},
            },
        },
        "Project": {
            "Title": TITLE,
            "CustomerBusinessProblem": BUSINESS_PROBLEM,
            # 迁移方向的用例（模板 AI 方向用的是 Centralized Operations Management）。
            # ⚠️ 必须用完整字面量，写成 "Migration" 会被拒。
            # 账户内 O26707646 实际用的是带空格的 "Migration / Database Migration"，
            # 与 API 文档的无空格写法略有出入，这里跟随账户既有数据。
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
        "Marketing": {"Source": "Marketing Activity", "AwsFundingUsed": "Yes"},
        "OpportunityTeam": [{
            "Email": "sy.siow@webbygroup.com",
            "FirstName": "SY",
            "LastName": "Siow",
            "BusinessTitle": "OpportunityOwner",
        }],
        "LifeCycle": {
            "Stage": "Prospect",          # 先建为 Prospect，再推到 Technical Validation
            "TargetCloseDate": "2027-03-31",
        },
    }


def client():
    return boto3.Session(profile_name=PROFILE, region_name=REGION).client(
        "partnercentral-selling", config=_CFG)


def show_template(sell):
    """打印模板商机，便于逐字段比对。"""
    t = sell.get_opportunity(Catalog=CATALOG, Identifier=TEMPLATE_ID)
    lc = t.get("LifeCycle") or {}
    pr = t.get("Project") or {}
    sp = (pr.get("ExpectedCustomerSpend") or [{}])[0]
    print(f"模板 {TEMPLATE_ID}")
    print(f"  Title       {pr.get('Title')}")
    print(f"  UseCase     {pr.get('CustomerUseCase')}")
    print(f"  Stage       {lc.get('Stage')} / {lc.get('ReviewStatus')}")
    print(f"  Spend       {sp.get('Amount')} {sp.get('CurrencyCode')} "
          f"{sp.get('Frequency')}")
    print(f"  TargetClose {lc.get('TargetCloseDate')}")


def create(execute=False, target_stage="Technical Validation"):
    sell = client()
    payload = build_payload()

    print("=" * 66)
    print(f"新建商机  ({'EXECUTE' if execute else 'DRY-RUN'})")
    print("=" * 66)
    show_template(sell)

    pr = payload["Project"]
    print("\n将创建")
    print(f"  Title       {pr['Title']}")
    print(f"  UseCase     {pr['CustomerUseCase']}")
    print(f"  Customer    {payload['Customer']['Account']['CompanyName']}")
    print(f"  Spend       {MRR_USD:,} USD Monthly  "
          f"(ARR {ARR_USD:,} → POC 可申请 {TARGET_POC_USD:,} USD)")
    print(f"  TargetClose {payload['LifeCycle']['TargetCloseDate']}")
    print(f"  目标阶段     {target_stage}")

    if not execute:
        print("\n[dry-run] 未创建。完整 payload：")
        p = dict(payload)
        p["ClientToken"] = "<uuid>"
        print(json.dumps(p, ensure_ascii=False, indent=1))
        print("\n加 --execute 真正创建。")
        return None

    try:
        resp = sell.create_opportunity(**payload)
    except ClientError as e:
        print(f"\n创建失败 {e.response['Error']['Code']}: "
              f"{e.response['Error']['Message']}")
        return None

    oid = resp["Id"]
    print(f"\n已创建 {oid}")
    print(f"  Arn {resp.get('Arn')}")

    # 推到 Technical Validation —— POC 申请的前置条件。
    # UpdateOpportunity 用 LastModifiedDate 做乐观锁，必须取服务端最新值。
    if target_stage and target_stage != "Prospect":
        cur = sell.get_opportunity(Catalog=CATALOG, Identifier=oid)
        sell.update_opportunity(
            Catalog=CATALOG,
            Identifier=oid,
            LastModifiedDate=cur["LastModifiedDate"],
            LifeCycle={
                "Stage": target_stage,
                "TargetCloseDate": payload["LifeCycle"]["TargetCloseDate"],
            },
        )
        print(f"  阶段已推进到 {target_stage}")

    print(f"\n下一步：做定价计算器（ARR {ARR_USD:,} USD），再提 POC Fund Request")
    print(f"  python3 poc_calc.py --mrr {MRR_USD} "
          f"--people {POC_PEOPLE} --days {POC_DAYS}")
    return oid


def main():
    p = argparse.ArgumentParser(description="为 Korea Wallpaper 建基础设施方向商机")
    p.add_argument("--execute", action="store_true", help="真正创建（默认 dry-run）")
    p.add_argument("--stage", default="Technical Validation",
                   help="创建后推进到的阶段；传 Prospect 则不推进")
    args = p.parse_args()
    create(execute=args.execute, target_stage=args.stage)


if __name__ == "__main__":
    main()
