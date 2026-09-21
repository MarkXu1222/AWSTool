"""AWS Pricing Calculator —— 纯 REST 生成估算链接，无需浏览器、无需登录。

## 为什么不用 Playwright

calculator.aws 自己的 config.js 里暴露了后端端点：

    SAVE_ESTIMATES_API      https://dnd5zrqcec4or.cloudfront.net/Prod/v2/saveAs
    GET_SAVED_ESTIMATES_API https://d3knqfixx3sbls.cloudfront.net/{key}

实测 POST 一份估算 JSON 即返回 201 + savedKey，分享链接就是
`https://calculator.aws/#/estimate?id={savedKey}`。读回内容与提交一致。

相比浏览器自动化方案，这里不存在那六类坑（区域漂移、搜索打开错服务、
同名字段、隐藏输入框挂死、实例名前缀冲突、显示价格≠保存成功）——
因为根本没有 UI 参与，写进去什么就是什么，而且可以立刻读回核对。

## 取舍与风险

这是**未公开的内部端点**，AWS 可能随时改动。两点缓解：
  1. `verify()` 每次都独立读回核对，端点变了会立即暴露而不是静默出错；
  2. 结构来自真实估算的克隆，不是手写猜测。

## 价格从哪来

服务配置里的 `serviceCost` 是我们自己算的（Price List API 真实单价，
见 poc_estimate.py）。calculator 页面打开时会用自己的引擎重算并展示，
两者可能有小数级差异 —— 以页面显示为准，本工具的数字用于填表。
"""

import argparse
import json
import ssl
import time
from datetime import datetime, timezone
import urllib.request
import uuid

# macOS 的 python.org 安装包不装系统 CA，urllib 会 CERTIFICATE_VERIFY_FAILED
# （curl 却正常，因为它用 Keychain）。优先用 certifi，没有就退回默认上下文。
try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = ssl.create_default_context()

SAVE_API = "https://dnd5zrqcec4or.cloudfront.net/Prod/v2/saveAs"
GET_API = "https://d3knqfixx3sbls.cloudfront.net/{key}"
SHARE_URL = "https://calculator.aws/#/estimate?id={key}"

# 区域码 → calculator 里显示的名字。regionName 只影响展示，
# region 才是计价依据，但两者不一致会让人看不懂，所以一起维护。
REGION_NAMES = {
    "ap-southeast-5": "Asia Pacific (Malaysia)",
    "ap-southeast-1": "Asia Pacific (Singapore)",
    "ap-southeast-3": "Asia Pacific (Jakarta)",
    "ap-northeast-1": "Asia Pacific (Tokyo)",
    "us-east-1": "US East (N. Virginia)",
    "us-west-2": "US West (Oregon)",
}


def _post(url: str, payload: dict, timeout=40) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            # 带上 Origin/Referer：CloudFront 后面的 API 可能校验来源
            "Origin": "https://calculator.aws",
            "Referer": "https://calculator.aws/",
            "User-Agent": "Mozilla/5.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # 把 AWS 返回的错误体带出来，否则只剩一句 "HTTP Error 400"，无从定位
        detail = e.read().decode(errors="replace")[:400]
        raise RuntimeError(f"HTTP {e.code}: {detail}") from None


def _get(url: str, timeout=40, retries=3) -> dict:
    """读取估算。带重试：代理环境下偶发 SSL UNEXPECTED_EOF，
    单次失败不代表端点不可用，直接放弃会误报成「校验失败」。"""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001 - 网络层异常种类多，统一重试
            last = e
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"读取失败（重试 {retries} 次）：{type(last).__name__}: {last}")


def _key(prefix: str) -> str:
    """services 字典的 key 格式：<serviceCode>-<uuid4>。同类服务多条靠 uuid 区分。"""
    return f"{prefix}-{uuid.uuid4()}"


def ec2(region, instance_type, count, monthly_cost, *, os_="linux",
        storage_gb=0, snapshot_gb=0, gp3_iops=3000, gp3_throughput=125):
    """EC2 服务块。结构克隆自真实估算，字段名不可臆造。"""
    return _key("ec2Enhancement"), {
        "calculationComponents": {
            "tenancy": {"value": "shared"},
            "selectedOS": {"value": os_},
            "workloadSelection": {"value": "consistent"},
            "storageType": {"value": "Storage General Purpose gp3 GB Mo"},
            "dataTransferForEC2": {"value": [
                {"entryType": "INBOUND", "value": "", "unit": "tb_month", "fromRegion": ""},
                {"entryType": "OUTBOUND", "value": "", "unit": "tb_month", "toRegion": ""},
                {"entryType": "INTRA_REGION", "value": "", "unit": "tb_month"},
            ]},
            "workload": {"value": {"workloadType": "consistent", "data": str(count)}},
            "detailedMonitoringCheckbox": {"value": False},
            "ec2AdvancedPricingMetrics": {"value": 1},
            "instanceType": {"value": instance_type},
            "pricingStrategy": {"value": {
                "selectedOption": "on-demand", "term": "1 year",
                "utilizationValue": "100", "utilizationUnit": "%Utilized/Month",
            }},
            "storageAmount": {"value": str(storage_gb), "unit": "gb|NA"},
            "snapshotFrequency": {"value": "monthly"},
            "gp3Iops": {"value": str(gp3_iops)},
            "snapshotAmount": {"value": str(snapshot_gb), "unit": "gb|NA"},
            "gp3Throughput": {"value": str(gp3_throughput), "unit": "mbps"},
        },
        "serviceCode": "ec2Enhancement",
        "region": region,
        "estimateFor": "template",
        "version": "0.0.57",
        "description": None,
        "serviceCost": {"monthly": round(monthly_cost, 2), "upfront": 0},
        "serviceName": "Amazon EC2",
        "regionName": REGION_NAMES.get(region, region),
        "configSummary": f"{instance_type} x{count}, {storage_gb} GB gp3",
    }


def s3(region, storage_gb, monthly_cost, put_requests=100000, get_requests=100000):
    """S3 是 group 型服务：外层 amazonSimpleStorageServiceGroup + subServices。"""
    return _key("amazonSimpleStorageServiceGroup"), {
        "serviceCode": "amazonSimpleStorageServiceGroup",
        "region": region,
        "description": None,
        "subServices": [{
            "calculationComponents": {
                "moveToStorageClassMethod": {"value": "No movement required"},
                "s3StandardStorageSize": {"value": str(storage_gb), "unit": "gb|month"},
                "s3StandardPutRequests": {"value": str(put_requests)},
                "s3StandardGetRequests": {"value": str(get_requests)},
            },
            "serviceCode": "amazonS3Standard",
            "region": region,
            "estimateFor": "s3Standard",
            "version": "0.0.71",
            "description": None,
            "serviceCost": {"monthly": round(monthly_cost, 2), "upfront": 0},
        }],
        "serviceCost": {"monthly": round(monthly_cost, 2), "upfront": 0},
        "serviceName": "Amazon Simple Storage Service (S3)",
        "regionName": REGION_NAMES.get(region, region),
        "configSummary": f"S3 Standard {storage_gb} GB",
    }


def alb(region, count, monthly_cost, data_gb_hour=60,
        rule_evals=60, requests_per_sec=60):
    """ALB，同样是 group 型（elasticLoadBalancing + subServices）。"""
    return _key("elasticLoadBalancing"), {
        "serviceCode": "elasticLoadBalancing",
        "region": region,
        "description": None,
        "subServices": [{
            "calculationComponents": {
                "numberOfApplicationLoadBalancers": {"value": str(count)},
                "sizeOfDataProcessedForEC2InstanceAndIPAddressTargets": {
                    "value": str(data_gb_hour), "unit": "gb|hour"},
                "averageNumberOfRuleEvaluationsPerRequest": {"value": str(rule_evals)},
                "averageNumberOfRequestsPerALBPerSecond": {"value": str(requests_per_sec)},
            },
            "serviceCode": "applicationLoadBalancer",
            "region": region,
            "estimateFor": "template_0",
            "version": "0.0.28",
            "description": None,
            "serviceCost": {"monthly": round(monthly_cost, 2)},
        }],
        "serviceCost": {"monthly": round(monthly_cost, 2)},
        "serviceName": "Elastic Load Balancing",
        "regionName": REGION_NAMES.get(region, region),
        "configSummary": f"ALB x{count}",
    }


def build_estimate(name, services):
    """把若干服务块组装成一份完整估算。services 为 (key, block) 列表。"""
    svc_map = dict(services)
    total = round(sum(b["serviceCost"]["monthly"] for b in svc_map.values()), 2)
    return {
        "name": name,
        "services": svc_map,
        "groups": {},
        "groupSubtotal": {"monthly": total, "upfront": 0},
        "totalCost": {"monthly": total, "upfront": 0},
        "support": {},
        # metaData 三个字段都是必须的：实测缺 createdOn 或把 source 写成
        # "calculator.aws" 都会让 saveAs 返回 400。正确值取自真实估算。
        "metaData": {
            "locale": "en_US",
            "currency": "USD",
            "createdOn": datetime.now(timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now().microsecond // 1000:03d}Z",
            "source": "calculator-platform",
        },
    }


def save(estimate) -> str:
    """保存并返回 savedKey。失败会抛异常而不是返回空串。"""
    resp = _post(SAVE_API, estimate)
    # 响应是 Lambda proxy 格式：body 里还套了一层 JSON 字符串
    if resp.get("statusCode") not in (200, 201):
        raise RuntimeError(f"保存失败 statusCode={resp.get('statusCode')}: {resp}")
    body = resp.get("body")
    inner = json.loads(body) if isinstance(body, str) else (body or {})
    key = inner.get("savedKey")
    if not key:
        raise RuntimeError(f"响应里没有 savedKey：{resp}")
    return key


def verify(key, expect_total=None, expect_services=None):
    """独立读回核对 —— 不信任保存过程。

    这一步是整个方案的安全网：端点若被 AWS 改动或静默丢数据，
    这里会立刻暴露，而不是等到客户打开链接才发现空估算。
    """
    got = _get(GET_API.format(key=key))
    problems = []
    svcs = got.get("services", {})
    total = (got.get("totalCost") or {}).get("monthly")

    if expect_services is not None and len(svcs) != expect_services:
        problems.append(f"服务条数 {len(svcs)}，期望 {expect_services}")
    if expect_total is not None and abs((total or 0) - expect_total) > 0.02:
        problems.append(f"总额 {total}，期望 {expect_total}")
    if not svcs:
        problems.append("读回的估算里没有任何服务")

    return {
        "ok": not problems, "problems": problems,
        "name": got.get("name"), "total": total,
        "services": [
            {
                "name": v.get("serviceName"),
                "region": v.get("regionName") or v.get("region"),
                "monthly": (v.get("serviceCost") or {}).get("monthly"),
            } for v in svcs.values()
        ],
    }


def share_url(key: str) -> str:
    return SHARE_URL.format(key=key)


def build_poc_estimate(name, region, monthly_target):
    """按 POC 场景（应用迁移）生成估算，单价取自 Price List API。

    复用 poc_estimate.py 的配比逻辑，保证这里的链接和填表用的数字同源。
    """
    from poc_estimate import pricing_client, build as build_lines

    pc = pricing_client()
    lines, total, _ = build_lines(pc, region, monthly_target)

    def cost_of(prefix):
        for l in lines:
            if l["unit_month"] and l["desc"].startswith(prefix):
                return l["unit_month"] * l["qty"], l["qty"]
        return 0.0, 0

    app_cost, app_qty = cost_of("应用服务器")
    load_cost, load_qty = cost_of("压测机")
    ebs_cost, ebs_qty = cost_of("EBS")
    s3_cost, s3_qty = cost_of("S3")
    alb_cost, alb_qty = cost_of("ALB")
    db_cost, db_qty = cost_of("主数据库")

    services = []
    if app_qty:
        # EBS 挂在应用服务器上（calculator 的 EC2 块自带存储字段），
        # 单独列 EBS 会让页面上出现一个无实例的孤立存储项
        services.append(ec2(region, "m6i.xlarge", app_qty, app_cost + ebs_cost,
                            storage_gb=ebs_qty))
    if load_qty:
        services.append(ec2(region, "c7i.xlarge", load_qty, load_cost))
    if s3_qty:
        services.append(s3(region, s3_qty, s3_cost))
    if alb_qty:
        services.append(alb(region, alb_qty, alb_cost))
    if db_qty:
        # RDS 结构与 EC2 不同且各引擎差异大，先用 EC2 块承载等价算力，
        # 避免凭猜测拼一个可能被 calculator 拒绝的 RDS 块。
        services.append(ec2(region, "m6i.large", db_qty, db_cost))

    est = build_estimate(name, services)
    return est, total


def main():
    p = argparse.ArgumentParser(description="生成 AWS Pricing Calculator 估算链接")
    p.add_argument("--name", default="POC Estimate", help="估算名称")
    p.add_argument("--monthly", type=float, default=2400,
                   help="目标月均支出 USD（默认 2400）")
    p.add_argument("--region", default="ap-southeast-5",
                   help="区域（默认 ap-southeast-5 马来西亚）")
    p.add_argument("--dry-run", action="store_true",
                   help="只打印 JSON 不保存")
    p.add_argument("--inspect", metavar="KEY",
                   help="读回已有估算（传 savedKey 或完整链接）")
    a = p.parse_args()

    if a.inspect:
        key = a.inspect.rsplit("id=", 1)[-1].strip()
        r = verify(key)
        print(f"名称    {r['name']}")
        print(f"总月费  {r['total']} USD")
        for s in r["services"]:
            print(f"  {s['name']:34} {str(s['region']):26} {s['monthly']}")
        print(f"\n链接    {share_url(key)}")
        return

    est, total = build_poc_estimate(a.name, a.region, a.monthly)
    n = len(est["services"])
    print(f"估算「{a.name}」  {n} 个服务  月合计 "
          f"{est['totalCost']['monthly']:,.2f} USD  "
          f"→ ARR {est['totalCost']['monthly'] * 12:,.2f} USD")
    for b in est["services"].values():
        print(f"  {b['serviceName']:34} {b['configSummary'][:38]:40} "
              f"{b['serviceCost']['monthly']:>9,.2f}")

    if a.dry_run:
        print("\n[dry-run] 未保存。完整 JSON：")
        print(json.dumps(est, ensure_ascii=False, indent=1)[:1200] + " ...")
        return

    key = save(est)
    url = share_url(key)
    print(f"\n已保存 {key}")
    print(f"链接   {url}")

    r = verify(key, expect_total=est["totalCost"]["monthly"], expect_services=n)
    if r["ok"]:
        print(f"\n✓ 读回校验通过：{len(r['services'])} 个服务，总额 {r['total']} USD")
    else:
        print("\n✗ 读回校验失败：")
        for x in r["problems"]:
            print(f"   - {x}")


if __name__ == "__main__":
    main()
