"""在 APN 账户创建**控制台登录专用** role，供平台生成联邦登录链接。

与 setup_partner_central_role.py 的区别（刻意分成两个脚本、两个 role）：

  partner-central-tool  仅 partnercentral:*，NotAction 兜底拒绝其他一切。
                        平台后端跑商机/POC 的自动化，权限越小越好。
  apn-console           AdministratorAccess。人工进控制台操作用。

不合并成一个 role 的原因：把 Administrator 加到那个 role 上，会让所有
POC Cash 的自动化调用**顺带获得管理员权限** —— 一个代码 bug 就能删资源。
职责分开后，自动化路径的权限边界不受控制台需求影响。

⚠️ MaxSessionDuration 设 3600（1 小时）。控制台联邦会话最长 12 小时，
但这是管理员权限，会话越短暴露窗口越小。

默认 dry-run，加 --execute 才真正创建。
"""

import argparse
import json
import os

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

# 与 setup_partner_central_role.py 保持同一份主体清单
PARTNERS = {
    "webby": {
        "profile": "WebbyAPN", "account": "105673812363",
        "externalId": "webby-apn-console",
    },
    "mergebytes": {
        "profile": "MergebytesAPN", "account": "072471709462",
        "externalId": "mergebytes-apn-console",
    },
}

CENTER_ACCOUNT = "509399618054"   # 平台 tools 凭证所在账户
CENTER_PRINCIPAL = f"arn:aws:iam::{CENTER_ACCOUNT}:user/mark"

ROLE_NAME = "apn-console"
ADMIN_POLICY_ARN = "arn:aws:iam::aws:policy/AdministratorAccess"

# 由 --partner 决定，main() 里赋值
APN_PROFILE = ""
APN_ACCOUNT = ""
# ExternalId 与 partner-central-tool 用**不同的值**：
# 两个 role 权限差距悬殊（只读 Partner Central vs 管理员），
# 共用 ExternalId 会让其中一个泄露时把管理员 role 一起暴露。
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


def iam_client():
    return boto3.Session(profile_name=APN_PROFILE,
                         region_name="us-east-1").client("iam", config=_CFG)


def setup(execute=False):
    role_arn = f"arn:aws:iam::{APN_ACCOUNT}:role/{ROLE_NAME}"
    print("=" * 70)
    print(f"APN 控制台登录 Role  ({'EXECUTE' if execute else 'DRY-RUN'})")
    print("=" * 70)
    print(f"  创建于     {APN_ACCOUNT}")
    print(f"  Role       {ROLE_NAME}")
    print(f"  信任       {CENTER_PRINCIPAL}")
    print(f"  ExternalId {EXTERNAL_ID}")
    print(f"  权限       AdministratorAccess（完整管理员）")
    print(f"  会话时长   3600 秒")
    print(f"  ARN        {role_arn}")
    print("\n  ⚠️ 这是管理员权限角色，平台侧需具备根用户权限才能使用")

    if not execute:
        print("\n[dry-run] 信任策略：")
        print(json.dumps(trust_policy(), indent=1))
        print(f"\n[dry-run] 将附加托管策略：{ADMIN_POLICY_ARN}")
        print("\n加 --execute 真正创建。")
        return

    iam = iam_client()
    try:
        iam.create_role(
            RoleName=ROLE_NAME,
            AssumeRolePolicyDocument=json.dumps(trust_policy()),
            Description="Console federation access for platform (admin)",
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

    iam.attach_role_policy(RoleName=ROLE_NAME, PolicyArn=ADMIN_POLICY_ARN)
    print(f"[2/2] 已附加 {ADMIN_POLICY_ARN}")
    print(f"\nRole ARN: {role_arn}")
    print("\n下一步：在 config.json 的 partnerCentral.<主体> 下加")
    print(json.dumps({"consoleRoleArn": role_arn,
                      "consoleExternalId": EXTERNAL_ID}, indent=1))


def verify(center_profile="mark-center"):
    """从中心账户 assume 并确认拿到的确实是目标账户的管理员会话。"""
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

    # 必须确认进的是**目标账户** —— role ARN 填错主体时 assume 一样成功，
    # 只是进错账户，不比对就会把「登进错误账户」当成正常。
    got = s.client("sts", config=_CFG).get_caller_identity()
    ok = got["Account"] == APN_ACCOUNT
    print(f"  {'OK  ' if ok else 'FAIL'} 账户比对 → {got['Account']}"
          f"{'' if ok else f'（期望 {APN_ACCOUNT}）'}")

    checks = [
        ("应允许 IAM ListRoles（管理员）", lambda: s.client(
            "iam", config=_CFG).list_roles(MaxItems=1), True),
        ("应允许 EC2 DescribeRegions", lambda: s.client(
            "ec2", config=_CFG).describe_regions(), True),
        ("应允许 Partner Central ListSolutions", lambda: s.client(
            "partnercentral-selling", config=_CFG).list_solutions(
                Catalog="AWS", MaxResults=1), True),
    ]
    for name, fn, want_ok in checks:
        try:
            fn()
            got_ok = True
        except Exception:
            got_ok = False
        mark = "OK  " if got_ok == want_ok else "FAIL"
        print(f"  {mark} {name} → {'通过' if got_ok else '被拒'}")


def main():
    global APN_PROFILE, APN_ACCOUNT, EXTERNAL_ID
    p = argparse.ArgumentParser(description="配置 APN 控制台登录 role")
    p.add_argument("--partner", default="webby", choices=sorted(PARTNERS),
                   help="APN 主体（默认 webby）")
    p.add_argument("--execute", action="store_true", help="真正创建（默认 dry-run）")
    p.add_argument("--verify", action="store_true", help="从中心账户验证")
    p.add_argument("--center-profile", default="mark-center",
                   help="中心账户 profile（默认 mark-center）")
    a = p.parse_args()

    cfg = PARTNERS[a.partner]
    APN_PROFILE = cfg["profile"]
    APN_ACCOUNT = cfg["account"]
    EXTERNAL_ID = os.environ.get("APN_CONSOLE_EXTERNAL_ID", cfg["externalId"])
    print(f"[partner={a.partner}] profile={APN_PROFILE} account={APN_ACCOUNT}\n")

    if a.verify:
        verify(a.center_profile)
    else:
        setup(a.execute)


if __name__ == "__main__":
    main()
