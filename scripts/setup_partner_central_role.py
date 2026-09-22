"""在 Webby APN 账户创建跨账户 role，供中心账户的平台调用 Partner Central。

背景：平台原本要存 WebbyAPN 的静态 AK/SK，而该 IAM 用户挂着
AdministratorAccess —— 等于把 APN 账户的管理员权限放进配置文件。
改成信任中心账户的 role 后，权限范围可精确限定，且凭证是临时的。

⚠️ IAM action 前缀是 `partnercentral:`，**不是** `partnercentral-selling:`。
这是实测确认的（建了个无权限 role 调 ListSolutions，AWS 的拒绝信息里写的是
`partnercentral:ListSolutions`）。按服务名写会让整个策略失效。

权限范围（只够跑商机 + POC，不含配额/账单/资源管理）：
  Selling  : 商机的建/读/改/提交、Engagement、Solution 关联
  Benefits : POC 资金申请的建/读/改/提交
  明确排除 : Delete*、账户管理、Channel、Revenue Measurement

默认 dry-run，加 --execute 才真正创建。
"""

import argparse
import json
import os

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

# 支持多个 APN 主体。新增主体时在这里加一行，不要复制整个脚本。
PARTNERS = {
    "webby": {
        "profile": "WebbyAPN", "account": "105673812363",
        "externalId": "webby-apn-poc-cash",
    },
    "mergebytes": {
        "profile": "MergebytesAPN", "account": "072471709462",
        "externalId": "mergebytes-apn-poc-cash",
    },
}

CENTER_ACCOUNT = "509399618054"   # 平台 tools 凭证所在账户
CENTER_PRINCIPAL = f"arn:aws:iam::{CENTER_ACCOUNT}:user/mark"

ROLE_NAME = "partner-central-tool"
POLICY_NAME = "PartnerCentralOpportunityAndPoc"

# 以下三个由 --partner 决定，main() 里赋值
APN_PROFILE = ""
APN_ACCOUNT = ""
# 跨账户信任带 ExternalId（防混淆代理人攻击）。每个主体用不同的值，
# 泄露一个不会波及另一个。环境变量可覆盖以免写死在仓库里。
EXTERNAL_ID = ""

_CFG = Config(connect_timeout=15, read_timeout=60, retries={"max_attempts": 3})

def trust_policy():
    """运行时构造：EXTERNAL_ID 由 --partner 决定，不能在模块加载时固化。"""
    return {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"AWS": CENTER_PRINCIPAL},
            "Action": "sts:AssumeRole",
            "Condition": {"StringEquals": {"sts:ExternalId": EXTERNAL_ID}},
        }],
    }

PERMISSION_POLICY = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "OpportunityLifecycle",
            "Effect": "Allow",
            "Action": [
                "partnercentral:CreateOpportunity",
                "partnercentral:UpdateOpportunity",
                "partnercentral:GetOpportunity",
                "partnercentral:ListOpportunities",
                "partnercentral:AssignOpportunity",
                "partnercentral:SubmitOpportunity",
                "partnercentral:AssociateOpportunity",
                "partnercentral:DisassociateOpportunity",
                "partnercentral:GetAwsOpportunitySummary",
            ],
            "Resource": "*",
        },
        {
            "Sid": "EngagementForSubmission",
            "Effect": "Allow",
            "Action": [
                # 提交商机必须先建 engagement，AWS 不允许直接 SubmitOpportunity
                "partnercentral:StartEngagementFromOpportunityTask",
                # ⚠️ 上面那个 task 内部会建 Engagement 并关联资源，光给 task
                # 权限不够。缺这三个会报：
                #   is not authorized to perform: partnercentral:CreateEngagement
                # 实测确认（提交一直失败，但错误被吞进 warnings 没暴露出来）。
                "partnercentral:CreateEngagement",
                "partnercentral:CreateEngagementInvitation",
                "partnercentral:CreateResourceSnapshot",
                "partnercentral:CreateResourceSnapshotJob",
                "partnercentral:StartResourceSnapshotJob",
                "partnercentral:ListEngagementFromOpportunityTasks",
                "partnercentral:GetEngagement",
                "partnercentral:ListEngagements",
                "partnercentral:ListEngagementMembers",
                "partnercentral:ListEngagementResourceAssociations",
                "partnercentral:ListEngagementInvitations",
                "partnercentral:GetEngagementInvitation",
                "partnercentral:GetResourceSnapshot",
                "partnercentral:GetResourceSnapshotJob",
                "partnercentral:ListResourceSnapshots",
                "partnercentral:ListResourceSnapshotJobs",
            ],
            "Resource": "*",
        },
        {
            "Sid": "SolutionsReadOnly",
            "Effect": "Allow",
            "Action": ["partnercentral:ListSolutions"],
            "Resource": "*",
        },
        {
            "Sid": "PocBenefitApplications",
            "Effect": "Allow",
            "Action": [
                "partnercentral:ListBenefits",
                "partnercentral:GetBenefit",
                "partnercentral:CreateBenefitApplication",
                "partnercentral:UpdateBenefitApplication",
                "partnercentral:GetBenefitApplication",
                "partnercentral:ListBenefitApplications",
                "partnercentral:SubmitBenefitApplication",
                "partnercentral:AmendBenefitApplication",
                "partnercentral:AssociateBenefitApplicationResource",
                "partnercentral:DisassociateBenefitApplicationResource",
                "partnercentral:ListBenefitAllocations",
                "partnercentral:GetBenefitAllocation",
            ],
            "Resource": "*",
        },
        {
            "Sid": "Tagging",
            "Effect": "Allow",
            "Action": [
                "partnercentral:TagResource",
                "partnercentral:UntagResource",
                "partnercentral:ListTagsForResource",
            ],
            "Resource": "*",
        },
        {
            "Sid": "DenyDestructiveAndOutOfScope",
            "Effect": "Deny",
            "Action": [
                # 显式拒绝：即便将来 Allow 段被放宽，这些也调不到
                "partnercentral:Delete*",
                "partnercentral:CancelBenefitApplication",
                "partnercentral:RecallBenefitApplication",
                "partnercentral:CreatePartner",
                "partnercentral:*Connection*",
                "partnercentral:*ChannelHandshake*",
                "partnercentral:*ProgramManagementAccount*",
                "partnercentral:*Relationship*",
                "partnercentral:*RevenueAttribution*",
                "partnercentral:*MarketplaceRevenueShare*",
                "partnercentral:PutSellingSystemSettings",
            ],
            "Resource": "*",
        },
        {
            "Sid": "DenyEverythingOutsidePartnerCentral",
            "Effect": "Deny",
            # 该 role 只做 Partner Central，不碰配额/账单/EC2 等任何其他服务
            "NotAction": "partnercentral:*",
            "Resource": "*",
        },
    ],
}


def iam_client():
    return boto3.Session(profile_name=APN_PROFILE,
                         region_name="us-east-1").client("iam", config=_CFG)


def setup(execute=False):
    role_arn = f"arn:aws:iam::{APN_ACCOUNT}:role/{ROLE_NAME}"
    print("=" * 70)
    print(f"Partner Central 跨账户 Role  ({'EXECUTE' if execute else 'DRY-RUN'})")
    print("=" * 70)
    print(f"  创建于   {APN_ACCOUNT}（Webby APN）")
    print(f"  Role     {ROLE_NAME}")
    print(f"  信任     {CENTER_PRINCIPAL}")
    print(f"  ExternalId {EXTERNAL_ID}")
    print(f"  ARN      {role_arn}")

    allow = sum(len(s["Action"]) for s in PERMISSION_POLICY["Statement"]
                if s["Effect"] == "Allow")
    print(f"\n  允许 {allow} 个 action（仅商机 + POC）")
    print("  显式拒绝 Delete*/账户管理/Channel/Revenue Measurement")
    print("  NotAction 兜底：partnercentral 之外的所有服务一律拒绝")

    if not execute:
        print("\n[dry-run] 信任策略：")
        print(json.dumps(trust_policy(), indent=1))
        print("\n[dry-run] 权限策略：")
        print(json.dumps(PERMISSION_POLICY, indent=1))
        print("\n加 --execute 真正创建。")
        return

    iam = iam_client()
    try:
        iam.create_role(
            RoleName=ROLE_NAME,
            AssumeRolePolicyDocument=json.dumps(trust_policy()),
            Description="Platform access for Partner Central opportunities and POC funding",
            MaxSessionDuration=3600,
        )
        print(f"\n[1/2] 已创建 role {ROLE_NAME}")
    except ClientError as e:
        if e.response["Error"]["Code"] == "EntityAlreadyExists":
            iam.update_assume_role_policy(
                RoleName=ROLE_NAME, PolicyDocument=json.dumps(trust_policy()))
            print(f"\n[1/2] role 已存在，已更新信任策略")
        else:
            print(f"\n[1/2] 创建失败：{e.response['Error']['Message']}")
            return

    iam.put_role_policy(RoleName=ROLE_NAME, PolicyName=POLICY_NAME,
                        PolicyDocument=json.dumps(PERMISSION_POLICY))
    print(f"[2/2] 已写入内联策略 {POLICY_NAME}")
    print(f"\nRole ARN: {role_arn}")
    print("\n下一步：在 config.json 配置")
    print(json.dumps({"partnerCentral": {
        "roleArn": role_arn, "externalId": EXTERNAL_ID}}, indent=1))


def verify(center_profile="mark-center"):
    """从中心账户 assume 并验证权限边界（读操作应通过，越权应被拒）。

    必须显式指定中心账户 profile —— 默认 session 在本机没有凭证，
    而平台服务端用的是 config.json 里的同一把 tools 凭证。
    """
    sts = boto3.Session(profile_name=center_profile,
                        region_name="us-east-1").client("sts", config=_CFG)
    ident = sts.get_caller_identity()
    print(f"当前身份 {ident['Arn']}")
    role_arn = f"arn:aws:iam::{APN_ACCOUNT}:role/{ROLE_NAME}"
    try:
        cr = sts.assume_role(RoleArn=role_arn, RoleSessionName="verify",
                             ExternalId=EXTERNAL_ID)["Credentials"]
    except ClientError as e:
        print(f"assume 失败：{e.response['Error']['Message']}")
        return
    print(f"assume 成功 → {role_arn}\n")

    s = boto3.Session(aws_access_key_id=cr["AccessKeyId"],
                      aws_secret_access_key=cr["SecretAccessKey"],
                      aws_session_token=cr["SessionToken"],
                      region_name="us-east-1")
    checks = [
        ("应允许 ListSolutions", lambda: s.client(
            "partnercentral-selling", config=_CFG).list_solutions(
                Catalog="AWS", MaxResults=1), True),
        ("应允许 ListOpportunities", lambda: s.client(
            "partnercentral-selling", config=_CFG).list_opportunities(
                Catalog="AWS", MaxResults=1), True),
        ("应允许 ListBenefits", lambda: s.client(
            "partnercentral-benefits", config=_CFG).list_benefits(
                Catalog="AWS", MaxResults=1), True),
        ("应拒绝 EC2 DescribeInstances", lambda: s.client(
            "ec2", config=_CFG).describe_instances(MaxResults=5), False),
        ("应拒绝 ServiceQuotas ListServices", lambda: s.client(
            "service-quotas", config=_CFG).list_services(MaxResults=1), False),
    ]
    for name, fn, want_ok in checks:
        try:
            fn()
            ok = True
        except Exception:
            ok = False
        mark = "OK  " if ok == want_ok else "FAIL"
        print(f"  {mark} {name} → {'通过' if ok else '被拒'}")


def main():
    global APN_PROFILE, APN_ACCOUNT, EXTERNAL_ID
    p = argparse.ArgumentParser(description="配置 Partner Central 跨账户 role")
    p.add_argument("--partner", default="webby", choices=sorted(PARTNERS),
                   help="APN 主体（默认 webby）")
    p.add_argument("--execute", action="store_true", help="真正创建（默认 dry-run）")
    p.add_argument("--verify", action="store_true", help="从中心账户验证权限边界")
    p.add_argument("--center-profile", default="mark-center",
                   help="中心账户 profile（默认 mark-center）")
    a = p.parse_args()

    cfg = PARTNERS[a.partner]
    APN_PROFILE = cfg["profile"]
    APN_ACCOUNT = cfg["account"]
    EXTERNAL_ID = os.environ.get("PARTNERCENTRAL_EXTERNAL_ID", cfg["externalId"])
    print(f"[partner={a.partner}] profile={APN_PROFILE} account={APN_ACCOUNT}\n")

    if a.verify:
        verify(a.center_profile)
    else:
        setup(execute=a.execute)


if __name__ == "__main__":
    main()
