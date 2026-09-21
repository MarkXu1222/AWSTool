"""POC Cash 金额计算器。

把 docs/poc-cash-guide.md 第 4 节的公式变成可执行工具，避免手算出错。

公式来源：poc进度 - POC申请流程.csv
回归验证：poc进度 - POC.csv 的 114 条真实记录
  ARR = MRR × 12 = 申请USD × 10      81 条样本 100% 吻合
  Total − Partner − Customer = 申请额（AWS 后台倒推逻辑）

用法：
  python3 poc_calc.py --usd 9800 --people 2 --days 9
  python3 poc_calc.py --arr 98000 --people 2 --days 9
"""

import argparse

HOURLY_MYR = 339.0        # 标准人时单价
HOURS_PER_DAY = 8
USD_TO_MYR = 4.27         # 实测 114 条，比值集中在 4.24~4.36
MAX_USD = 9900.0          # 实测上限，无一条超过 10000
ARR_RATIO = 10            # ARR = 申请USD × 10
MONTHS = 12               # ARR = MRR × 12


def compute(target_usd, people, days, rate=USD_TO_MYR, customer_myr=0.0):
    """按目标申请额反推全部字段。返回 dict。"""
    arr_usd = target_usd * ARR_RATIO
    mrr_usd = arr_usd / MONTHS
    request_myr = target_usd * rate
    total_myr = HOURLY_MYR * HOURS_PER_DAY * people * days
    partner_myr = total_myr - request_myr - customer_myr
    return {
        "target_usd": target_usd,
        "arr_usd": arr_usd,
        "mrr_usd": mrr_usd,
        "request_myr": request_myr,
        "total_myr": total_myr,
        "partner_myr": partner_myr,
        "customer_myr": customer_myr,
        "man_days": people * days,
        "rate": rate,
    }


def warnings_for(r):
    """返回需要提醒的问题列表。"""
    out = []
    if r["target_usd"] > MAX_USD:
        out.append(f"申请额 {r['target_usd']:,.0f} USD 超过实测上限 {MAX_USD:,.0f}")
    if r["partner_myr"] < 0:
        out.append(
            f"Partner Contribution 为负（{r['partner_myr']:,.2f}）——"
            f"总成本不够覆盖申请额，需增加人天或降低申请额")
    elif r["partner_myr"] < r["total_myr"] * 0.05:
        out.append(
            f"Partner Contribution 仅占总成本 "
            f"{r['partner_myr'] / r['total_myr'] * 100:.1f}%，偏低易被质疑")
    return out


def suggest_days(target_usd, people, rate=USD_TO_MYR, partner_ratio=0.15):
    """给定申请额与人数，反推需要多少天才能让 partner 投入占比合理。"""
    request_myr = target_usd * rate
    need_total = request_myr / (1 - partner_ratio)
    days = need_total / (HOURLY_MYR * HOURS_PER_DAY * people)
    return max(1, round(days))


def render(r):
    print("=" * 58)
    print(f"目标申请额  {r['target_usd']:>12,.0f} USD")
    print("=" * 58)
    print("【美元侧 — 填商机/PO】")
    print(f"  ARR（定价计算器年费用） {r['arr_usd']:>12,.0f} USD")
    print(f"  PO MRR                 {r['mrr_usd']:>12,.0f} USD")
    print()
    print(f"【马币侧 — 填资金申请表】(汇率 {r['rate']})")
    print(f"  Total Cost of Activity {r['total_myr']:>12,.2f} MYR"
          f"   ({HOURLY_MYR:.0f}×{HOURS_PER_DAY}×{r['man_days']}人天)")
    print(f"  Partner Contribution   {r['partner_myr']:>12,.2f} MYR")
    print(f"  Customer Contribution  {r['customer_myr']:>12,.2f} MYR")
    print(f"  → AWS 倒推申请额        {r['request_myr']:>12,.2f} MYR")
    print()
    check = r["total_myr"] - r["partner_myr"] - r["customer_myr"]
    print(f"  校验 Total−Partner−Customer = {check:,.2f} MYR"
          f"  {'✓' if abs(check - r['request_myr']) < 1 else '✗'}")

    warns = warnings_for(r)
    if warns:
        print("\n⚠️ 提醒")
        for w in warns:
            print(f"  - {w}")
        if r["partner_myr"] < r["total_myr"] * 0.05:
            d = suggest_days(r["target_usd"], r["man_days"] // max(1, r["man_days"]))
            print(f"  建议：人天提高到约 "
                  f"{suggest_days(r['target_usd'], 1)} 人天（单人等效）")


def main():
    p = argparse.ArgumentParser(description="POC Cash 金额计算器")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--usd", type=float, help="目标申请金额（USD）")
    g.add_argument("--arr", type=float, help="定价计算器 ARR（USD），自动 /10")
    g.add_argument("--mrr", type=float, help="PO MRR（USD），自动 ×1.2")
    p.add_argument("--people", type=int, default=2, help="项目人数（默认 2）")
    p.add_argument("--days", type=int, default=9, help="项目天数（默认 9）")
    p.add_argument("--rate", type=float, default=USD_TO_MYR,
                   help=f"USD→MYR 汇率（默认 {USD_TO_MYR}）")
    p.add_argument("--customer", type=float, default=0.0,
                   help="客户投入 MYR（默认 0）")
    a = p.parse_args()

    if a.usd:
        usd = a.usd
    elif a.arr:
        usd = a.arr / ARR_RATIO
    else:
        usd = a.mrr * MONTHS / ARR_RATIO

    render(compute(usd, a.people, a.days, a.rate, a.customer))


if __name__ == "__main__":
    main()
