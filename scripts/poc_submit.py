"""提交完整的 POC Cash 资金申请（事前预批）。

链路：
  ① 校验商机阶段（必须 Technical Validation 且 ReviewStatus 允许编辑）
  ② 生成定价计算器链接（calculator_api，纯 REST）
  ③ CreateBenefitApplication
  ④ AssociateBenefitApplicationResource（挂商机）
  ⑤ SubmitBenefitApplication

字段来源：schema 的 required 是空数组（校验发生在 Submit 而非 Create），
所以必填项是从 12 条已批准件反推的 —— 17 个字段 100% 出现。
注意 IsEuropeanSovereignCloud 不在 schema 里但 12/12 都有，只看 schema 会漏。

默认 dry-run。加 --execute 才真正创建；再加 --submit 才提交给 AWS。
"""

import argparse
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

sys.path.insert(0, __file__.rsplit("/", 1)[0])

CATALOG = "AWS"
REGION = "us-east-1"
ROLE_ARN = "arn:aws:iam::105673812363:role/partner-central-tool"
EXTERNAL_ID = "webby-apn-poc-cash"

BENEFIT_POC_FUNDING = "ben-un8hh6qdrxqx50"   # 事前预批
_CFG = Config(connect_timeout=20, read_timeout=90, retries={"max_attempts": 4})

# ---- Webby 主体固定信息（11/11 已批准件一致）----
WEBBY = {
    "InvoiceEntityName": "WEBBY SDN BHD",
    "InvoiceRemitCountry": "MY",
    "InvoiceRemitAddress":
        "2-3, Jalan Merbah 1, Bandar Puchong Jaya, 47170 Puchong, Selangor",
    "AccountProfileID": "123749FB67ZJQ",
}
CONTACT = {
    "Email": "sy.siow@webbygroup.com",
    "FirstName": "SY", "LastName": "Siow",
    "BusinessTitle": "Business Strategy Director",
}

HOURLY_MYR = 339.0
USD_TO_MYR = 4.27
MIN_LEAD_DAYS = 14   # 流程硬要求：开始日期须在 14 天后


def _clients():
    sts = boto3.Session(profile_name="mark-center", region_name=REGION).client(
        "sts", config=_CFG)
    cr = sts.assume_role(RoleArn=ROLE_ARN, RoleSessionName="poc-submit",
                         ExternalId=EXTERNAL_ID)["Credentials"]
    s = boto3.Session(
        aws_access_key_id=cr["AccessKeyId"],
        aws_secret_access_key=cr["SecretAccessKey"],
        aws_session_token=cr["SessionToken"], region_name=REGION)
    return (s.client("partnercentral-selling", config=_CFG),
            s.client("partnercentral-benefits", config=_CFG))


def iso(d: datetime) -> str:
    """POC 表单用的 ISO 时间格式（已批准件均为 T00:00:00+00:00）。"""
    return d.strftime("%Y-%m-%dT00:00:00+00:00")


def check_opportunity(sell, opp_id):
    """商机必须到 Technical Validation 且当前允许编辑，否则 POC 会被打回。"""
    o = sell.get_opportunity(Catalog=CATALOG, Identifier=opp_id)
    lc = o.get("LifeCycle") or {}
    stage, review = lc.get("Stage"), lc.get("ReviewStatus")
    spend = (o.get("Project", {}).get("ExpectedCustomerSpend") or [{}])[0]
    mrr = float(spend.get("Amount") or 0)

    problems = []
    if stage != "Technical Validation":
        problems.append(f"阶段是 {stage}，POC 要求 Technical Validation")
    if review not in ("Approved", "Action Required"):
        problems.append(f"ReviewStatus={review}，商机被锁定")
    if not mrr:
        problems.append("商机没有 ExpectedCustomerSpend，无法推导 POC 额度")
    return {
        "arn": o.get("Arn"), "title": (o.get("Project") or {}).get("Title"),
        "company": ((o.get("Customer") or {}).get("Account") or {}).get("CompanyName"),
        "stage": stage, "review": review, "mrr": mrr, "problems": problems,
    }


def compute_amounts(mrr_usd, people, days):
    """金额单向推导。公式见 docs/poc-cash-guide.md 第 4 节。"""
    arr = mrr_usd * 12
    poc_usd = round(arr / 10)
    request_myr = round(poc_usd * USD_TO_MYR, 2)
    total_myr = round(HOURLY_MYR * 8 * people * days, 2)
    partner_myr = round(total_myr - request_myr, 2)
    return {
        "arr_usd": arr, "poc_usd": poc_usd, "request_myr": request_myr,
        "total_myr": total_myr, "partner_myr": partner_myr,
        "partner_pct": (partner_myr / total_myr * 100) if total_myr else 0,
    }


def build_details(*, activity_name, aws_account_id, business_desc,
                  start, end, budget_year, amounts, calculator_url,
                  customer_considering):
    """BenefitApplicationDetails。

    字段集来自 12 条已批准件的交集（17 个字段 100% 出现），不是照 schema 写 ——
    schema 的 required 为空，且漏掉了实际必有的 IsEuropeanSovereignCloud。
    readOnly 字段（PurchaseOrderNumber / ApprovedAmount / RequestedAmount）
    由 AWS 审批后回填，这里绝不能传。
    """
    myr = lambda v: {"Amount": f"{v:.2f}", "Currency": "MYR"}
    return {
        "Program": "Proof Of Concept",
        "Template": "POC",
        "ActivityName": activity_name,
        "BusinessDescription": business_desc,
        "AwsAccountId": aws_account_id,
        "AwsCalculatorUrls": [calculator_url],
        "BudgetYear": budget_year,
        "PlannedStartDate": iso(start),
        "PlannedEndDate": iso(end),
        "AnnualRunRate": {"Amount": f"{amounts['arr_usd']:.2f}", "Currency": "USD"},
        "CustomerConsidering": customer_considering,
        "CustomerRfx": False,
        "ExecutedCountry": "MY",
        "ExecutedState": [],
        "Wwps": False,
        "WwpsConsent": False,
        "IsEuropeanSovereignCloud": False,
        "CreditRequest": {},
        "CashRequest": {
            "CashClaims": [{"StartDate": iso(start), "EndDate": iso(end)}],
            "TotalCostOfActivity": myr(amounts["total_myr"]),
            "PartnerContribution": myr(amounts["partner_myr"]),
            "OtherPartyContribution": myr(0),
            "Currency": "MYR",
            **WEBBY,
        },
    }


def run(args):
    sell, ben = _clients()

    print("=" * 74)
    print(f"POC Cash 提交  ({'EXECUTE' if args.execute else 'DRY-RUN'})")
    print("=" * 74)

    # ① 商机前置检查
    opp = check_opportunity(sell, args.opportunity)
    print(f"\n[1/5] 商机 {args.opportunity}")
    print(f"      {opp['title']}")
    print(f"      {opp['company']} | {opp['stage']} / {opp['review']} "
          f"| MRR {opp['mrr']:,.0f} USD")
    if opp["problems"]:
        for p in opp["problems"]:
            print(f"      ✗ {p}")
        print("\n中止：商机不满足 POC 前置条件。")
        return 1
    print("      ✓ 满足 POC 前置条件")

    # 先把「今天」归零再加天数：直接对 now() 加天数后 replace(hour=0) 会把
    # 当天已过的小时数抹掉，算出来比预期少一天（lead_days=14 → 实际 13 天）。
    today = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0)
    start = today + timedelta(days=args.lead_days)
    end = start + timedelta(days=args.days)
    lead = (start - today).days
    amounts = compute_amounts(opp["mrr"], args.people, args.days)

    print(f"\n[2/5] 金额（MRR {opp['mrr']:,.0f} → ARR {amounts['arr_usd']:,.0f}）")
    print(f"      POC 可申请        {amounts['poc_usd']:>10,} USD")
    print(f"      Total Cost        {amounts['total_myr']:>10,.2f} MYR "
          f"(339×8×{args.people}人×{args.days}天)")
    print(f"      Partner 投入      {amounts['partner_myr']:>10,.2f} MYR "
          f"({amounts['partner_pct']:.1f}%)")
    print(f"      实际申请          {amounts['request_myr']:>10,.2f} MYR")
    print(f"      项目周期          {start:%Y-%m-%d} ~ {end:%Y-%m-%d}"
          f"（{lead} 天后开始）")

    blockers = []
    if lead < MIN_LEAD_DAYS:
        blockers.append(f"开始日期仅 {lead} 天后，流程要求 ≥ {MIN_LEAD_DAYS} 天")
    if amounts["partner_myr"] < 0:
        blockers.append("Partner 投入为负，需增加人天或降低申请额")
    elif amounts["partner_pct"] < 10:
        blockers.append(
            f"Partner 投入仅 {amounts['partner_pct']:.1f}%，低于 10% 易被质疑")
    if amounts["poc_usd"] > 9900:
        blockers.append(f"申请额 {amounts['poc_usd']:,} USD 超过实测上限 9,900")
    for b in blockers:
        print(f"      ⚠️ {b}")

    # ② 计算器链接
    print("\n[3/5] 定价计算器")
    if args.calculator_url:
        calc_url = args.calculator_url
        print(f"      使用已有链接 {calc_url}")
    elif args.execute:
        from calculator_api import build_poc_estimate, save, share_url, verify
        est, _ = build_poc_estimate(
            args.activity_name or opp["title"], args.calc_region, opp["mrr"])
        key = save(est)
        calc_url = share_url(key)
        v = verify(key, expect_total=est["totalCost"]["monthly"],
                   expect_services=len(est["services"]))
        print(f"      已生成 {calc_url}")
        print(f"      读回校验 "
              f"{'✓ 通过' if v['ok'] else '✗ ' + '; '.join(v['problems'])}")
        if not v["ok"]:
            print("\n中止：计算器读回校验未通过。")
            return 1
    else:
        calc_url = "https://calculator.aws/#/estimate?id=<dry-run 未生成>"
        print("      [dry-run] 跳过生成")

    details = build_details(
        activity_name=args.activity_name or opp["title"],
        aws_account_id=args.aws_account,
        business_desc=args.description,
        start=start, end=end, budget_year=args.budget_year,
        amounts=amounts, calculator_url=calc_url,
        customer_considering=args.considering)

    name = args.name or f"POC - {opp['company']}"
    print(f"\n[4/5] 资金申请「{name}」")
    print(f"      benefit={BENEFIT_POC_FUNDING} 账户={args.aws_account}")
    print(f"      联系人={CONTACT['Email']}")

    if not args.execute:
        print("\n[dry-run] 未创建。完整 details：")
        print(json.dumps(details, ensure_ascii=False, indent=1))
        print("\n加 --execute 创建（不提交）；再加 --submit 才提交给 AWS。")
        return 0

    if blockers and not args.force:
        print("\n中止：存在上述问题。确认无误可加 --force 跳过。")
        return 1

    return _do_create(ben, args, opp, name, details)


def _do_create(ben, args, opp, name, details):
    """③④⑤：创建 → 关联商机 → 提交。任一步失败都如实报告，不静默继续。"""
    try:
        resp = ben.create_benefit_application(
            Catalog=CATALOG, ClientToken=str(uuid.uuid4()),
            BenefitIdentifier=BENEFIT_POC_FUNDING,
            Name=name, Description=args.description[:200],
            FulfillmentTypes=["CASH"],
            BenefitApplicationDetails=details,
            PartnerContacts=[CONTACT])
    except ClientError as e:
        print(f"\n创建失败 {e.response['Error']['Code']}: "
              f"{e.response['Error']['Message'][:400]}")
        return 1

    app_id = resp["Id"]
    print(f"      ✓ 已创建 {app_id}")

    try:
        ben.associate_benefit_application_resource(
            Catalog=CATALOG, BenefitApplicationIdentifier=app_id,
            ResourceArn=opp["arn"])
        print(f"      ✓ 已关联商机 {args.opportunity}")
    except ClientError as e:
        print(f"      ✗ 关联商机失败：{e.response['Error']['Message'][:200]}")

    print("\n[5/5] 提交")
    if not args.submit:
        print("      未提交（加 --submit 才提交）。可先在控制台核对。")
    else:
        try:
            ben.submit_benefit_application(Catalog=CATALOG, Identifier=app_id)
            print("      ✓ 已提交给 AWS 审核")
        except ClientError as e:
            print(f"      ✗ 提交失败：{e.response['Error']['Message'][:400]}")

    final = ben.get_benefit_application(Catalog=CATALOG, Identifier=app_id)
    print(f"\n最终状态  {app_id}  Status={final.get('Status')} "
          f"Stage={final.get('Stage')}")
    print(f"          附件 {len(final.get('FileDetails') or [])} 个，"
          f"关联资源 {len(final.get('AssociatedResources') or [])} 个")
    if not (final.get("FileDetails") or []):
        print("          ⚠️ 无附件 —— 实测 25 条已批准件 100% 都有附件，"
              "建议补计算器 PDF")
    return 0


def submit_existing(app_id, execute=False):
    """提交一条已创建的申请。

    与 run() 分开是为了避免重复创建：--execute 会新建申请，
    对已存在的单子重跑会在账户里留下两条内容相同的记录。
    """
    _, ben = _clients()
    r = ben.get_benefit_application(Catalog=CATALOG, Identifier=app_id)
    d = r.get("BenefitApplicationDetails") or {}
    cash = d.get("CashRequest") or {}

    print("=" * 74)
    print(f"提交已有申请  ({'EXECUTE' if execute else 'DRY-RUN'})")
    print("=" * 74)
    print(f"  {app_id}  {r.get('Name')}")
    print(f"  Status      {r.get('Status')} / Stage {r.get('Stage')}")
    print(f"  关联商机     {r.get('AssociatedResources') or '（无）'}")
    print(f"  联系人       {[c.get('Email') for c in (r.get('PartnerContacts') or [])]}")
    print(f"  AWS 账户     {d.get('AwsAccountId')}")
    print(f"  周期         {str(d.get('PlannedStartDate'))[:10]} ~ "
          f"{str(d.get('PlannedEndDate'))[:10]}")
    print(f"  申请额       Total {cash.get('TotalCostOfActivity', {}).get('Amount')} − "
          f"Partner {cash.get('PartnerContribution', {}).get('Amount')} MYR")
    print(f"  计算器       {(d.get('AwsCalculatorUrls') or ['（无）'])[0]}")
    print(f"  附件         {len(r.get('FileDetails') or [])} 个")

    if r.get("Status") != "PENDING_SUBMISSION":
        print(f"\n中止：当前状态是 {r.get('Status')}，只有 PENDING_SUBMISSION 可提交。")
        return 1
    if not (r.get("AssociatedResources") or []):
        print("\n中止：未关联商机 —— 实测已批准件 100% 都有商机关联。")
        return 1

    if not execute:
        print("\n[dry-run] 未提交。加 --execute 真正提交给 AWS 审核。")
        return 0

    try:
        ben.submit_benefit_application(Catalog=CATALOG, Identifier=app_id)
    except ClientError as e:
        print(f"\n提交失败 {e.response['Error']['Code']}: "
              f"{e.response['Error']['Message'][:400]}")
        return 1

    after = ben.get_benefit_application(Catalog=CATALOG, Identifier=app_id)
    print(f"\n✓ 已提交  Status={after.get('Status')} Stage={after.get('Stage')}")
    return 0


def main():
    p = argparse.ArgumentParser(description="提交 POC Cash 资金申请")
    p.add_argument("--submit-existing", metavar="APP_ID",
                   help="提交已创建的申请（不新建），如 benappl-xxx")
    p.add_argument("--opportunity", help="商机 ID，如 O28604112")
    p.add_argument("--aws-account", help="POC 执行的 AWS 账户（12 位）")
    p.add_argument("--description", help="POC 业务描述（英文）")
    p.add_argument("--activity-name", help="活动名，默认取商机标题")
    p.add_argument("--name", help="申请名称，默认 POC - <客户>")
    p.add_argument("--considering", default="Other",
                   choices=["Other", "No Competition", "AliCloud", "On-Premise"],
                   help="Customer Also Considering")
    p.add_argument("--people", type=int, default=2, help="POC 人数")
    p.add_argument("--days", type=int, default=3, help="POC 天数")
    p.add_argument("--lead-days", type=int, default=MIN_LEAD_DAYS,
                   help=f"开始日期距今天数（≥{MIN_LEAD_DAYS}）")
    p.add_argument("--budget-year", type=int, default=2027)
    p.add_argument("--calc-region", default="ap-southeast-5")
    p.add_argument("--calculator-url", help="已有计算器链接，跳过生成")
    p.add_argument("--execute", action="store_true", help="真正创建")
    p.add_argument("--submit", action="store_true", help="创建后提交给 AWS")
    p.add_argument("--force", action="store_true", help="忽略告警强制执行")
    a = p.parse_args()

    if a.submit_existing:
        sys.exit(submit_existing(a.submit_existing, a.execute))

    # 新建路径的必填项（改成可选是为了让 --submit-existing 能单独用）
    missing = [n for n, v in (("--opportunity", a.opportunity),
                              ("--aws-account", a.aws_account),
                              ("--description", a.description)) if not v]
    if missing:
        p.error(f"新建申请需要 {' '.join(missing)}（或用 --submit-existing 提交已有申请）")
    sys.exit(run(a))


if __name__ == "__main__":
    main()
