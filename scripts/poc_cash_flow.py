"""商机提交 → 改阶段 → POC Cash 资金申请 的端到端 API 流程。

默认 dry-run，不写入任何数据。加 --execute 才真正调用写接口。

三个硬约束（已实测确认）：
  1. SubmitOpportunity 后商机锁定，须等 AWS 审到 Approved/Action Required 才能再改
  2. UpdateOpportunity 用 LastModifiedDate 做乐观锁，必须先 Get 取最新值
  3. LifeCycle.ReviewStatus 只读，只能改 Stage

POC 是两段式：
  ben-un8hh6qdrxqx50  Proof Of Concept Funding program  事前预批（CREDITS/CASH）
  ben-8j7y5dohajcl16  Proof Of Concept Cash Claim       事后请款（CASH）
"""

import argparse
import uuid

from botocore.exceptions import ClientError

from partner_central import CATALOG, client

# 商机阶段（LifeCycle.Stage）合法值，顺序即推进顺序
STAGES = [
    "Prospect",
    "Qualified",
    "Technical Validation",
    "Business Validation",
    "Committed",
    "Launched",
]
CLOSED_LOST = "Closed Lost"

# 提交后只有这两个 ReviewStatus 允许继续编辑
EDITABLE_REVIEW_STATUS = {"Approved", "Action Required"}

POC_FUNDING_BENEFIT = "ben-un8hh6qdrxqx50"  # 事前预批
POC_CASH_CLAIM_BENEFIT = "ben-8j7y5dohajcl16"  # 事后请款


def get_opportunity(sell, identifier):
    return sell.get_opportunity(Catalog=CATALOG, Identifier=identifier)


def can_edit(opp):
    """提交后是否还能改。返回 (bool, 原因)。"""
    review = (opp.get("LifeCycle") or {}).get("ReviewStatus")
    if review in (None, "Pending Submission"):
        return True, "尚未提交，可自由编辑"
    if review in EDITABLE_REVIEW_STATUS:
        return True, f"ReviewStatus={review}，允许编辑"
    return False, f"ReviewStatus={review}，AWS 审核中，商机已锁定"


def update_stage(sell, identifier, new_stage, execute=False):
    """改阶段。自动处理乐观锁：每次都重新 Get 取 LastModifiedDate。"""
    if new_stage not in STAGES + [CLOSED_LOST]:
        raise ValueError(f"非法 Stage: {new_stage}")

    opp = get_opportunity(sell, identifier)
    ok, reason = can_edit(opp)
    if not ok:
        raise RuntimeError(f"不能改阶段: {reason}")

    life = dict(opp.get("LifeCycle") or {})
    current = life.get("Stage")
    # ReviewStatus 等只读字段不能回传
    payload_life = {"Stage": new_stage}
    for key in ("TargetCloseDate", "NextSteps"):
        if life.get(key):
            payload_life[key] = life[key]

    print(f"  Stage: {current} → {new_stage}")
    if not execute:
        print("  [dry-run] 跳过 UpdateOpportunity")
        return None

    return sell.update_opportunity(
        Catalog=CATALOG,
        Identifier=identifier,
        LastModifiedDate=opp["LastModifiedDate"],  # 乐观锁，必须是服务端最新值
        LifeCycle=payload_life,
    )


def submit_opportunity(sell, identifier, involvement="Co-Sell",
                       visibility="Full", execute=False):
    """提交商机给 AWS 审核。注意：提交后商机会被锁定。"""
    print(f"  Submit: InvolvementType={involvement} Visibility={visibility}")
    if not execute:
        print("  [dry-run] 跳过 SubmitOpportunity")
        return None
    return sell.submit_opportunity(
        Catalog=CATALOG,
        Identifier=identifier,
        InvolvementType=involvement,
        Visibility=visibility,
    )


def build_poc_details(activity_name, aws_account_id, business_desc,
                      start_date, end_date, budget_year,
                      total_cost, currency, invoice_entity,
                      invoice_country, invoice_address,
                      calculator_url=None):
    """组装 POC Funding program 的 BenefitApplicationDetails。

    字段来自 GetBenefit 返回的 BenefitRequestSchema（draft-07）。
    不要传 readOnly 字段：PurchaseOrderNumber / ApprovedAmount / RequestedAmount。
    """
    details = {
        "Program": "Proof Of Concept",
        "Template": "POC",
        "ActivityName": activity_name,
        "BusinessDescription": business_desc,
        "AwsAccountId": aws_account_id,
        "BudgetYear": budget_year,
        "PlannedStartDate": start_date,
        "PlannedEndDate": end_date,
        "ExecutedCountry": invoice_country,
        "Wwps": False,
        "WwpsConsent": False,
        "CustomerRfx": False,
        "CashRequest": {
            "CashClaims": [{"StartDate": start_date, "EndDate": end_date}],
            "TotalCostOfActivity": {"Amount": total_cost, "Currency": currency},
            "Currency": currency,
            "InvoiceEntityName": invoice_entity,
            "InvoiceRemitCountry": invoice_country,
            "InvoiceRemitAddress": invoice_address,
        },
    }
    if calculator_url:
        details["AwsCalculatorUrls"] = [calculator_url]
    return details


def build_contact(email, first, last, title=None, phone=None):
    """PartnerContacts 条目。Contact shape 无必填约束，但实测完整件都填全。"""
    c = {"Email": email, "FirstName": first, "LastName": last}
    if title:
        c["BusinessTitle"] = title
    if phone:
        c["Phone"] = phone
    return c


def build_file(uri, business_use_case, file_name=None, file_type="application/pdf"):
    """FileDetails 条目。只有 FileURI 必填，pattern 为 (s3://|https://).*

    注意这不是上传接口——文件本身须先放到可访问位置，这里只登记 URI。
    FileType 合法值见 service-2.json 的 FileType 枚举（pdf/png/jpeg/svg/csv/
    msword/openxml 的 docx-xlsx-pptx）。
    """
    f = {"FileURI": uri, "BusinessUseCase": business_use_case, "FileType": file_type}
    if file_name:
        f["FileName"] = file_name
    return f


def build_cash_claim_details(aws_account_id, start_date, end_date,
                             claim_amount, currency, due_date=None,
                             customer_sign_off_attached=False):
    """事后请款（ben-8j7y5dohajcl16）的 details，结构与事前件完全不同。

    Invoice 块由 AWS 侧回填（PayeeCentral 链接、排期付款日），不要自己传。
    """
    d = {
        "Program": "Proof of Concept Cash Claim",
        "Template": "POC",
        "FulfillmentTypes": ["CASH"],
        "AwsAccountId": aws_account_id,
        "StartDate": start_date,
        "EndDate": end_date,
        "ClaimAmount": {"Amount": claim_amount, "Currency": currency},
        "CustomerSignOffAttached": customer_sign_off_attached,
    }
    if due_date:
        d["DueDate"] = due_date
    return d


def create_poc_application(ben, name, details, opportunity_arn=None,
                           benefit_id=POC_FUNDING_BENEFIT, execute=False,
                           contacts=None, files=None):
    """建 POC 申请 → 关联商机 → 提交。返回 application id。

    contacts / files 强烈建议传：实测 25 条 APPROVED 申请中，
    100% 都有附件且 100% 关联了商机，无一例外。
    """
    print(f"  CreateBenefitApplication benefit={benefit_id} name={name}")
    print(f"    contacts={len(contacts or [])} files={len(files or [])} "
          f"assoc={'Y' if opportunity_arn else 'N'}")
    if not (files and opportunity_arn):
        print("    ⚠️ 缺附件或商机关联——实测 APPROVED 件中这两项是 100% 存在的")
    if not execute:
        print("  [dry-run] 跳过 Create/Associate/Submit")
        return None

    kwargs = {}
    if contacts:
        kwargs["PartnerContacts"] = contacts
    if files:
        kwargs["FileDetails"] = files

    resp = ben.create_benefit_application(
        Catalog=CATALOG,
        ClientToken=str(uuid.uuid4()),
        BenefitIdentifier=benefit_id,
        Name=name,
        Description=name,
        FulfillmentTypes=["CASH"],
        BenefitApplicationDetails=details,
        **kwargs,
    )
    app_id = resp["Id"]
    print(f"  created: {app_id}")

    if opportunity_arn:
        ben.associate_benefit_application_resource(
            Catalog=CATALOG,
            BenefitApplicationIdentifier=app_id,
            ResourceArn=opportunity_arn,
        )
        print(f"  associated: {opportunity_arn}")

    ben.submit_benefit_application(Catalog=CATALOG, Identifier=app_id)
    print(f"  submitted: {app_id}")
    return app_id


def inspect(identifier):
    """检查某商机当前状态与可编辑性。只读操作。"""
    sell = client("partnercentral-selling")
    try:
        opp = get_opportunity(sell, identifier)
    except ClientError as exc:
        print(f"读取失败: {exc.response['Error']['Code']} - "
              f"{exc.response['Error']['Message']}")
        return

    life = opp.get("LifeCycle") or {}
    cust = (opp.get("Customer") or {}).get("Account") or {}
    ok, reason = can_edit(opp)

    print(f"Opportunity      {opp.get('Id')}")
    print(f"  Arn            {opp.get('Arn')}")
    print(f"  Customer       {cust.get('CompanyName')} ({cust.get('Industry')})")
    print(f"  Type           {opp.get('OpportunityType')}")
    print(f"  Stage          {life.get('Stage')}")
    print(f"  ReviewStatus   {life.get('ReviewStatus')}")
    print(f"  TargetClose    {life.get('TargetCloseDate')}")
    print(f"  LastModified   {opp.get('LastModifiedDate')}  ← 乐观锁用")
    print(f"  可编辑         {'是' if ok else '否'} — {reason}")

    if ok and life.get("Stage") in STAGES:
        idx = STAGES.index(life["Stage"])
        nxt = STAGES[idx + 1] if idx + 1 < len(STAGES) else None
        if nxt:
            print(f"  下一阶段       {nxt}")


def demo(execute=False):
    """演示完整链路。默认 dry-run。"""
    sell = client("partnercentral-selling")
    ben = client("partnercentral-benefits")

    print("=" * 66)
    print(f"POC Cash 端到端流程  ({'EXECUTE' if execute else 'DRY-RUN'})")
    print("=" * 66)

    opps = sell.list_opportunities(Catalog=CATALOG, MaxResults=20)
    candidates = [
        o for o in opps["OpportunitySummaries"]
        if (o.get("LifeCycle") or {}).get("ReviewStatus") in
        (None, "Pending Submission", "Approved", "Action Required")
    ]
    if not candidates:
        print("没有可操作的商机")
        return

    target = candidates[0]
    print(f"\n[1] 目标商机 {target['Id']}")
    inspect(target["Id"])

    print("\n[2] 改阶段")
    try:
        update_stage(sell, target["Id"], "Technical Validation", execute=execute)
    except RuntimeError as exc:
        print(f"  跳过: {exc}")

    print("\n[3] 提交商机（提交后将锁定，直到 AWS 审完）")
    submit_opportunity(sell, target["Id"], execute=execute)

    print("\n[4] POC Cash 资金申请")
    details = build_poc_details(
        activity_name="Webby POC - Demo Activity",
        aws_account_id="176350488746",
        business_desc="Proof of concept to validate AWS services for the workload.",
        start_date="2026-10-01T00:00:00Z",
        end_date="2027-01-31T00:00:00Z",
        budget_year=2027,
        total_cost="45000.00",
        currency="MYR",
        invoice_entity="WEBBY SDN BHD",
        invoice_country="MY",
        invoice_address="2-3, Jalan Merbah 1, Bandar Puchong Jaya, 47170 Puchong",
    )
    create_poc_application(
        ben,
        name="Webby POC Cash - Demo",
        details=details,
        opportunity_arn=target.get("Arn"),
        execute=execute,
        contacts=[build_contact(
            "sy.siow@webbygroup.com", "Shook", "Yien Siow",
            title="Business Strategy Director",
        )],
        files=[build_file(
            "s3://your-bucket/poc/aws-pricing-calculator.pdf",
            business_use_case="AWS Pricing Calculator",
            file_name="aws-pricing-calculator.pdf",
        )],
    )

    print("\n完成。" + ("" if execute else "（dry-run，未写入任何数据）"))


def analyze_pending():
    """分析 PENDING_SUBMISSION 申请，区分迁移残留与真正待提交的原生件。

    只读。实测 49 条 PENDING 中 39 条是 Migrated Fund Request（旧系统迁移的
    历史存量，附件 CreatedBy=MIGRATION），批量提交会向 AWS 重复提交历史申请。
    """
    ben = client("partnercentral-benefits")
    apps = []
    token = None
    while True:
        kw = {"Catalog": CATALOG}
        if token:
            kw["NextToken"] = token
        resp = ben.list_benefit_applications(**kw)
        apps.extend(resp.get("BenefitApplicationSummaries", []))
        token = resp.get("NextToken")
        if not token:
            break

    pending = [a for a in apps if a.get("Status") == "PENDING_SUBMISSION"]
    migrated = [a for a in pending if "Migrated Fund Request" in (a.get("Name") or "")]
    unnamed = [a for a in pending if not a.get("Name")]
    native = [a for a in pending
              if a.get("Name") and "Migrated Fund Request" not in a["Name"]]

    print(f"申请总数 {len(apps)}，其中 PENDING_SUBMISSION {len(pending)} 条")
    print(f"  迁移残留（Migrated Fund Request）: {len(migrated):3}  ← 不要批量提交")
    print(f"  无名件                          : {len(unnamed):3}  ← 多半是废弃草稿")
    print(f"  原生件（真正可能待提交）        : {len(native):3}")
    for a in native:
        print(f"     - {a['Id']} | {(a.get('Name') or '')[:56]}")
    if not native:
        print("     （无。说明没有遗漏未提交的自建申请）")


def main():
    parser = argparse.ArgumentParser(description="POC Cash 端到端流程")
    parser.add_argument("--inspect", metavar="OPP_ID",
                        help="只检查某商机状态（只读）")
    parser.add_argument("--pending", action="store_true",
                        help="分析 PENDING 申请，区分迁移残留与原生件（只读）")
    parser.add_argument("--execute", action="store_true",
                        help="真正执行写操作（默认 dry-run）")
    args = parser.parse_args()

    if args.inspect:
        inspect(args.inspect)
    elif args.pending:
        analyze_pending()
    else:
        demo(execute=args.execute)


if __name__ == "__main__":
    main()
