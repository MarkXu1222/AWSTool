"""AWS Partner Central 五服务统一客户端。

覆盖 Selling / Account / Benefits / Channel / Revenue Measurement。
处理三个坑：global 端点、Revenue Measurement 模型缺失、Channel 的 camelCase。

实测环境：botocore 1.42.68 / profile WebbyAPN / account 105673812363
"""

import os

import boto3
from botocore.config import Config

PROFILE = "WebbyAPN"
REGION = "us-east-1"
CATALOG = "AWS"  # 生产用 "AWS"，测试用 "Sandbox"

# 系统 botocore 不含 partnercentral-revenue-measurement 模型，需外挂目录。
# 该路径为 uv 缓存，若失效可从任意含该模型的 botocore 安装中复制。
EXTRA_MODEL_PATH = "/Users/mark/.cache/uv/.tmpz2Qpy0/botocore/data"

# 这两个服务是 global 端点，靠 region 解析会拼出不存在的主机并抛 SSLError。
GLOBAL_ENDPOINTS = {
    "partnercentral-channel": "https://partnercentral-channel.global.api.aws",
    "partnercentral-revenue-measurement": "https://partnercentral-prm.global.api.aws",
}

# Channel API 使用 camelCase 参数，其余四个使用 PascalCase。
CAMEL_CASE_SERVICES = {"partnercentral-channel"}

SERVICES = (
    "partnercentral-selling",
    "partnercentral-account",
    "partnercentral-benefits",
    "partnercentral-channel",
    "partnercentral-revenue-measurement",
)

_CONFIG = Config(connect_timeout=5, read_timeout=30, retries={"max_attempts": 3})


def client(service, profile=PROFILE, region=REGION):
    """创建 Partner Central 客户端，自动处理模型加载与 global 端点。"""
    if service not in SERVICES:
        raise ValueError(f"unknown service: {service}; expected one of {SERVICES}")

    if service == "partnercentral-revenue-measurement":
        # 必须在 Session 构造前设置，botocore 启动时读取该变量
        os.environ.setdefault("AWS_DATA_PATH", EXTRA_MODEL_PATH)

    session = boto3.Session(profile_name=profile, region_name=region)
    kwargs = {"config": _CONFIG}
    if service in GLOBAL_ENDPOINTS:
        kwargs["endpoint_url"] = GLOBAL_ENDPOINTS[service]
    return session.client(service, **kwargs)


def catalog_kw(service, catalog=CATALOG):
    """返回该服务正确大小写的 Catalog 参数。所有 List/Get 操作都必传。"""
    key = "catalog" if service in CAMEL_CASE_SERVICES else "Catalog"
    return {key: catalog}


def paginate(cli, service, operation, result_key, **kwargs):
    """统一翻页。Channel 用 nextToken/items，其余用 NextToken/PascalCase key。"""
    camel = service in CAMEL_CASE_SERVICES
    token_in = "nextToken" if camel else "NextToken"
    items = []
    token = None
    while True:
        if token:
            kwargs[token_in] = token
        resp = getattr(cli, operation)(**kwargs)
        items.extend(resp.get(result_key, []))
        token = resp.get("nextToken") if camel else resp.get("NextToken")
        if not token:
            return items


def health_check(profile=PROFILE, region=REGION):
    """对五个服务各跑一个 List 操作，返回 {service: 结果描述}。"""
    probes = {
        "partnercentral-selling": ("list_solutions", "SolutionSummaries"),
        "partnercentral-account": ("list_partners", "PartnerSummaryList"),
        "partnercentral-benefits": ("list_benefits", "BenefitSummaries"),
        "partnercentral-channel": ("list_relationships", "items"),
        "partnercentral-revenue-measurement": (
            "list_revenue_attributions",
            "RevenueAttributionSummaries",
        ),
    }
    report = {}
    for service, (operation, result_key) in probes.items():
        try:
            cli = client(service, profile, region)
            resp = getattr(cli, operation)(**catalog_kw(service))
            report[service] = f"OK  {result_key}={len(resp.get(result_key, []))}"
        except Exception as exc:  # noqa: BLE001 - 探活需汇总所有失败类型
            report[service] = f"FAIL {type(exc).__name__}: {str(exc)[:120]}"
    return report


if __name__ == "__main__":
    for svc, status in health_check().items():
        print(f"{svc:38} {status}")
