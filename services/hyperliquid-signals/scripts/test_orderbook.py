#!/usr/bin/env python3
"""
Test Hyperliquid orderbook spread and depth for a list of coins.

Usage:
    python test_orderbook.py                          # default: coins from our trade history
    python test_orderbook.py BTC ETH SOL HYPE ONDO   # specific coins
    python test_orderbook.py --json                   # output as JSON

Outputs for each coin:
    - Mid price
    - Spread in bps (flag if > 10 bps)
    - Bid/Ask depth USD at 1, 5, 10, 50 bps from mid

Requirements: pip install requests
"""
import json
import sys
import time
import requests

HL_API = "https://api.hyperliquid.xyz/info"

# Coins that appear in our recent live trade history — default test set
DEFAULT_COINS = [
    # High-frequency (>3 trades in 30d)
    "BTC", "ETH", "SOL", "HYPE", "ONDO", "ENA", "KAITO", "AVAX",
    # Mid-frequency
    "ZEC", "DOGE", "XRP", "ARB", "SUI", "JTO", "GMT", "MERL",
    # Low-frequency / long tail
    "CELO", "PNUT", "IOTA", "ANIME", "ZORA", "BIGTIME", "BSV",
    "POLYX", "GMX", "SOPH", "HYPER",
]

SPREAD_LIMIT_BPS = 10  # bot will skip coins above this threshold


def get_l2_book(coin: str) -> dict:
    resp = requests.post(
        HL_API,
        json={"type": "l2Book", "coin": coin},
        timeout=5,
    )
    resp.raise_for_status()
    return resp.json()


def analyze_coin(coin: str) -> dict:
    try:
        book = get_l2_book(coin)
    except Exception as e:
        return {"coin": coin, "error": str(e)}

    levels = book.get("levels", [])
    if len(levels) < 2 or not levels[0] or not levels[1]:
        return {"coin": coin, "error": "empty book"}

    bids = [(float(b["px"]), float(b["sz"])) for b in levels[0]]
    asks = [(float(a["px"]), float(a["sz"])) for a in levels[1]]

    best_bid = bids[0][0]
    best_ask = asks[0][0]
    mid = (best_bid + best_ask) / 2.0
    spread_bps = (best_ask - best_bid) / mid * 10_000

    def depth_usd(side: list[tuple[float, float]], max_bps: float) -> float:
        return sum(
            px * sz for px, sz in side
            if abs(px - mid) / mid * 10_000 <= max_bps
        )

    return {
        "coin": coin,
        "mid": mid,
        "best_bid": best_bid,
        "best_ask": best_ask,
        "spread_bps": round(spread_bps, 3),
        "tradeable": spread_bps <= SPREAD_LIMIT_BPS,
        "bid_1bps":  round(depth_usd(bids,  1)),
        "ask_1bps":  round(depth_usd(asks,  1)),
        "bid_5bps":  round(depth_usd(bids,  5)),
        "ask_5bps":  round(depth_usd(asks,  5)),
        "bid_10bps": round(depth_usd(bids, 10)),
        "ask_10bps": round(depth_usd(asks, 10)),
        "bid_50bps": round(depth_usd(bids, 50)),
        "ask_50bps": round(depth_usd(asks, 50)),
    }


def fmt_usd(v: float) -> str:
    if v >= 1_000_000:
        return f"${v / 1_000_000:.1f}M"
    if v >= 1_000:
        return f"${v / 1_000:.0f}K"
    return f"${v:.0f}"


def fmt_px(v: float) -> str:
    if v >= 10_000:
        return f"{v:,.0f}"
    if v >= 1:
        return f"{v:.4f}"
    if v >= 0.0001:
        return f"{v:.6f}"
    return f"{v:.3e}"


def print_table(results: list[dict]) -> None:
    col_w = 12
    header = (
        f"{'Coin':<{col_w}} {'Mid Price':>14} {'Spread':>9} {'OK?':>4}"
        f" | {'Bid@1':>8} {'Ask@1':>8}"
        f" | {'Bid@5':>8} {'Ask@5':>8}"
        f" | {'Bid@10':>9} {'Ask@10':>9}"
        f" | {'Bid@50':>9} {'Ask@50':>9}"
    )
    print()
    print(header)
    print("-" * len(header))

    ok_coins  = []
    bad_coins = []
    err_coins = []

    for r in results:
        if "error" in r:
            print(f"{r['coin']:<{col_w}} ERROR: {r['error']}")
            err_coins.append(r["coin"])
            continue

        ok  = "✓" if r["tradeable"] else "✗"
        (ok_coins if r["tradeable"] else bad_coins).append(r["coin"])

        print(
            f"{r['coin']:<{col_w}} ${fmt_px(r['mid']):>13} {r['spread_bps']:>7.2f}bps {ok:>4}"
            f" | {fmt_usd(r['bid_1bps']):>8} {fmt_usd(r['ask_1bps']):>8}"
            f" | {fmt_usd(r['bid_5bps']):>8} {fmt_usd(r['ask_5bps']):>8}"
            f" | {fmt_usd(r['bid_10bps']):>9} {fmt_usd(r['ask_10bps']):>9}"
            f" | {fmt_usd(r['bid_50bps']):>9} {fmt_usd(r['ask_50bps']):>9}"
        )

    print()
    print(f"✓ TRADEABLE  ({len(ok_coins)}, spread ≤10bps): {', '.join(ok_coins) or 'none'}")
    print(f"✗ WIDE SPREAD ({len(bad_coins)}, spread >10bps): {', '.join(bad_coins) or 'none'}")
    if err_coins:
        print(f"! ERRORS      ({len(err_coins)}): {', '.join(err_coins)}")
    print()


def main() -> None:
    args = sys.argv[1:]
    as_json = "--json" in args
    coins   = [a for a in args if not a.startswith("--")]
    if not coins:
        coins = DEFAULT_COINS
    coins = list(dict.fromkeys(coins))  # dedupe, preserve order

    print(f"Hyperliquid Orderbook Spread & Depth"
          f" — {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}")
    print(f"Checking {len(coins)} coins  |  skip threshold: >{SPREAD_LIMIT_BPS} bps spread\n")

    results = []
    for coin in coins:
        r = analyze_coin(coin)
        results.append(r)
        if not as_json and "error" not in r:
            # stream output so user sees progress
            ok = "✓" if r["tradeable"] else "✗"
            print(f"  {ok}  {coin:<10}  {r['spread_bps']:.2f} bps", flush=True)
        time.sleep(0.08)  # gentle rate limit ~12 req/s

    if as_json:
        print(json.dumps(results, indent=2))
    else:
        print("\nDetailed table:")
        print_table(results)


if __name__ == "__main__":
    main()
