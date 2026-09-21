"""用 AWS Price List API 取真实单价，凑出目标 ARR 的服务配置清单。

背景：AWS Pricing Calculator 的估算只能在 calculator.aws 网页上交互创建
（estimate ID 由服务端生成，无公开 API），所以本脚本**不生成链接**，
而是输出一份带真实单价的配置清单，照着在网页上填即可。

价格来源：pricing:GetProducts（OnDemand 条款），实时查询，非硬编码。
默认区域 ap-southeast-5（马来西亚），与 POC 的
"Country Activity is Executed = Malaysia" 一致。

用法：
  python3 poc_estimate.py                      # 目标月均 2400 USD
  python3 poc_estimate.py --monthly 2400
  python3 poc_estimate.py --region ap-southeast-1
"""

import argparse
import json

import boto3
from botocore.config import Config

PROFILE = "WebbyAPN"
REGION_DEFAULT = "ap-southeast-5"      # 马来西亚
HOURS_PER_MONTH = 730                  # AWS 计价标准月

_CFG = Config(connect_timeout=20, read_timeout=90, retries={"max_attempts": 4})


def pricing_client():
    # Price List API 只在 us-east-1 / ap-south-1 提供端点
    return boto3.Session(profile_name=PROFILE, region_name="us-east-1").client(
        "pricing", region_name="us-east-1", config=_CFG)


def ec2_hourly(pc, region, instance_type, os_="Linux"):
    """EC2 按需单价（USD/小时）。查不到返回 None。"""
    resp = pc.get_products(ServiceCode="AmazonEC2", MaxResults=20, Filters=[
        {"Type": "TERM_MATCH", "Field": "regionCode", "Value": region},
        {"Type": "TERM_MATCH", "Field": "instanceType", "Value": instance_type},
        {"Type": "TERM_MATCH", "Field": "operatingSystem", "Value": os_},
        {"Type": "TERM_MATCH", "Field": "tenancy", "Value": "Shared"},
        {"Type": "TERM_MATCH", "Field": "capacitystatus", "Value": "Used"},
        {"Type": "TERM_MATCH", "Field": "preInstalledSw", "Value": "NA"},
    ])
    return _first_ondemand_price(resp)


def rds_hourly(pc, region, instance_class, engine="PostgreSQL", multi_az=False):
    """RDS 按需单价（USD/小时）。"""
    resp = pc.get_products(ServiceCode="AmazonRDS", MaxResults=20, Filters=[
        {"Type": "TERM_MATCH", "Field": "regionCode", "Value": region},
        {"Type": "TERM_MATCH", "Field": "instanceType", "Value": instance_class},
        {"Type": "TERM_MATCH", "Field": "databaseEngine", "Value": engine},
        {"Type": "TERM_MATCH", "Field": "deploymentOption",
         "Value": "Multi-AZ" if multi_az else "Single-AZ"},
    ])
    return _first_ondemand_price(resp)


def simple_price(pc, service_code, region, extra_filters, max_results=20,
                 want_usagetype=None, deny_usagetype=None):
    """通用：取某服务某组过滤条件下的第一个 OnDemand 单价。"""
    filters = [{"Type": "TERM_MATCH", "Field": "regionCode", "Value": region}]
    filters += extra_filters
    resp = pc.get_products(ServiceCode=service_code, MaxResults=max_results,
                           Filters=filters)
    return _first_ondemand_price(resp, region, want_usagetype, deny_usagetype)


def _first_ondemand_price(resp, region=None, want_usagetype=None,
                          deny_usagetype=None):
    """从 GetProducts 响应里取第一个可用的非零 USD 单价。

    三层过滤，每一层都是实测踩过的坑：
      1. 跳过价格为 0 的条目（免费层、占位 SKU），否则估算严重偏低；
      2. regionCode 过滤不可靠 —— 查 ap-southeast-5 实测会混入
         usagetype=APS7-（泰国）的条目，故再用 attributes.regionCode 复核；
      3. productFamily/storageClass 可能命中完全不同的计费项
         （S3 的 General Purpose 会撞上 SageMaker Annotations），
         故用 usagetype 关键字白名单/黑名单收敛。
    """
    for pl in resp.get("PriceList", []):
        doc = json.loads(pl)
        attrs = doc["product"]["attributes"]
        if region and attrs.get("regionCode") and attrs["regionCode"] != region:
            continue
        ut = attrs.get("usagetype", "")
        if want_usagetype and want_usagetype not in ut:
            continue
        if deny_usagetype and deny_usagetype in ut:
            continue
        for term in doc.get("terms", {}).get("OnDemand", {}).values():
            for dim in term.get("priceDimensions", {}).values():
                usd = dim.get("pricePerUnit", {}).get("USD")
                if usd is not None and float(usd) > 0:
                    return float(usd), dim.get("unit", ""), attrs
    return None


def ebs_gb_month(pc, region, volume_type="gp3"):
    """EBS 存储单价（USD/GB-月）。

    注：ap-southeast-5 的 usagetype 前缀是 APS7-（AWS 内部代号，
    与 region 名里的数字不对应），不要据此判断查错了区域，
    以 attributes.regionCode 为准。
    """
    return simple_price(pc, "AmazonEC2", region, [
        {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Storage"},
        {"Type": "TERM_MATCH", "Field": "volumeApiName", "Value": volume_type},
    ], want_usagetype="VolumeUsage")


def s3_gb_month(pc, region):
    """S3 标准存储单价（USD/GB-月）。

    ⚠️ storageClass=General Purpose 会命中 SageMaker 的 Annotations 计费项，
    必须用 usagetype 里的 TimedStorage-ByteHrs 且排除 Annotation。
    """
    return simple_price(pc, "AmazonS3", region, [
        {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Storage"},
        {"Type": "TERM_MATCH", "Field": "storageClass", "Value": "General Purpose"},
    ], want_usagetype="TimedStorage-ByteHrs", deny_usagetype="Annotation",
        max_results=60)


def alb_hourly(pc, region):
    """ALB 小时费（不含 LCU）。

    ⚠️ 必须排除 Outposts 变体：实测 ap-southeast-5 的第一条命中的是
    APS7-Outposts-LoadBalancerUsage，单价与常规区域 ALB 不同。
    """
    return simple_price(pc, "AWSELB", region, [
        {"Type": "TERM_MATCH", "Field": "productFamily",
         "Value": "Load Balancer-Application"},
    ], want_usagetype="LoadBalancerUsage", deny_usagetype="Outposts",
        max_results=40)


# ---- 配置模板：Application Service Migration 场景 ----
# 结构与项目描述一致：应用服务迁移 + 数据库迁移 + 容器化 + 压测验证。
# 数量留空由 fit_to_target() 按目标金额缩放。
BLUEPRINT = [
    # (分组, 说明, 取价函数key, 参数, 基准数量, 是否可缩放)
    ("Compute", "应用服务器（EKS 工作节点 / 应用层）", "ec2", "m6i.xlarge", 4, True),
    ("Compute", "压测机（临时高并发流量注入）", "ec2", "c7i.xlarge", 2, True),
    ("Database", "主数据库（迁移目标）", "rds", "db.m6i.large", 2, True),
    ("Storage", "EBS gp3 根卷与数据卷（GB）", "ebs", "gp3", 1000, True),
    ("Storage", "S3 日志与制品存储（GB）", "s3", None, 2000, True),
    ("Network", "ALB 入口负载均衡", "alb", None, 2, True),
]


def price_line(pc, region, kind, arg):
    """取单价并换算成"每单位每月"，返回 (月单价, 单位说明, 原始单价串)。"""
    if kind == "ec2":
        r = ec2_hourly(pc, region, arg)
        if r:
            return r[0] * HOURS_PER_MONTH, f"{arg}/台", f"{r[0]:.5f} USD/hr"
    elif kind == "rds":
        r = rds_hourly(pc, region, arg)
        if r:
            return r[0] * HOURS_PER_MONTH, f"{arg}/实例", f"{r[0]:.5f} USD/hr"
    elif kind == "ebs":
        r = ebs_gb_month(pc, region, arg)
        if r:
            return r[0], "GB-月", f"{r[0]:.5f} USD/GB-Mo"
    elif kind == "s3":
        r = s3_gb_month(pc, region)
        if r:
            return r[0], "GB-月", f"{r[0]:.5f} USD/GB-Mo"
    elif kind == "alb":
        r = alb_hourly(pc, region)
        if r:
            return r[0] * HOURS_PER_MONTH, "个", f"{r[0]:.5f} USD/hr"
    return None


def build(pc, region, target_monthly):
    """按基准配置取价，再整体缩放到目标月支出。"""
    lines = []
    for group, desc, kind, arg, qty, scalable in BLUEPRINT:
        p = price_line(pc, region, kind, arg)
        if not p:
            lines.append({"group": group, "desc": desc, "unit_month": None,
                          "qty": qty, "raw": "价格查询失败", "scalable": scalable})
            continue
        unit_month, unit_desc, raw = p
        lines.append({"group": group, "desc": desc, "unit_month": unit_month,
                      "unit_desc": unit_desc, "qty": qty, "raw": raw,
                      "scalable": scalable})

    base = sum(l["unit_month"] * l["qty"] for l in lines if l["unit_month"])
    if base <= 0:
        return lines, 0.0, 1.0

    factor = target_monthly / base
    for l in lines:
        if l["unit_month"] and l["scalable"]:
            q = l["qty"] * factor
            # 台/实例/个按整数取，存储类按 100GB 取整（网页计算器里好填）
            l["qty"] = (max(1, round(q)) if l["qty"] < 100
                        else max(100, round(q / 100) * 100))

    # 取整后必然偏离目标，用存储项做微调收敛 —— 存储粒度最细，
    # 调它不会破坏"几台机器"这种需要解释的数字。
    total = sum(l["unit_month"] * l["qty"] for l in lines if l["unit_month"])
    s3 = next((l for l in lines
               if l["unit_month"] and l["desc"].startswith("S3")), None)
    if s3:
        delta = target_monthly - total
        adj = round(delta / s3["unit_month"] / 100) * 100
        if s3["qty"] + adj >= 100:
            s3["qty"] += adj
            total = sum(l["unit_month"] * l["qty"] for l in lines if l["unit_month"])
    return lines, total, factor


def render(lines, total, region, target_monthly):
    print("=" * 74)
    print(f"AWS 定价估算配置清单  region={region}")
    print(f"目标月均 {target_monthly:,.0f} USD  →  ARR {target_monthly * 12:,.0f} USD")
    print("=" * 74)
    cur = None
    for l in lines:
        if l["group"] != cur:
            cur = l["group"]
            print(f"\n【{cur}】")
        if not l["unit_month"]:
            print(f"  {l['desc']:34} {l['raw']}")
            continue
        sub = l["unit_month"] * l["qty"]
        print(f"  {l['desc']:34} x{l['qty']:<6} {l['raw']:>22}  "
              f"= {sub:>9,.2f} USD/月")

    print("\n" + "-" * 74)
    print(f"  月合计  {total:>12,.2f} USD")
    print(f"  年合计  {total * 12:>12,.2f} USD   ← 填 ARR")
    diff = total - target_monthly
    print(f"  与目标差 {diff:>+11,.2f} USD/月 ({diff / target_monthly * 100:+.1f}%)")
    print("\n注：单价来自 AWS Price List API 实时查询（OnDemand），未含免费层、")
    print("    数据传输、EKS 控制面、NAT 等附加费用；网页计算器会更精确。")


def write_csv(lines, total, region, path):
    """导出 CSV，便于贴进表格或与网页计算器逐项核对。"""
    import csv
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["分组", "项目", "数量", "单价", "月费USD", "区域"])
        for l in lines:
            if not l["unit_month"]:
                continue
            w.writerow([l["group"], l["desc"], l["qty"], l["raw"],
                        f"{l['unit_month'] * l['qty']:.2f}", region])
        w.writerow([])
        w.writerow(["", "月合计", "", "", f"{total:.2f}", ""])
        w.writerow(["", "年合计(ARR)", "", "", f"{total * 12:.2f}", ""])
    print(f"\n已导出 {path}")


def main():
    p = argparse.ArgumentParser(description="用真实单价凑 POC 定价估算")
    p.add_argument("--monthly", type=float, default=2400,
                   help="目标月均支出 USD（默认 2400，对应 ARR 28800）")
    p.add_argument("--region", default=REGION_DEFAULT,
                   help=f"区域（默认 {REGION_DEFAULT} 马来西亚）")
    p.add_argument("--csv", metavar="PATH", help="同时导出 CSV")
    a = p.parse_args()

    pc = pricing_client()
    lines, total, _ = build(pc, a.region, a.monthly)
    render(lines, total, a.region, a.monthly)
    if a.csv:
        write_csv(lines, total, a.region, a.csv)


if __name__ == "__main__":
    main()
