#!/usr/bin/env python3
"""
Check MongoDB Data - Quick stats viewer

Usage:
    python check_mongo_data.py
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from motor.motor_asyncio import AsyncIOMotorClient
from config import get_settings

settings = get_settings()


async def check_data():
    client = AsyncIOMotorClient(settings.mongodb_uri)
    db = client.yieldr

    print("=" * 70)
    print("MONGODB COLLECTION STATS")
    print("=" * 70)

    # Count documents in each collection
    trending_count = await db.trending_tokens.count_documents({})
    traders_count = await db.top_traders.count_documents({})
    swaps_count = await db.trader_swaps.count_documents({})

    print(f"\ntrending_tokens:  {trending_count:,} documents")
    print(f"top_traders:      {traders_count:,} documents")
    print(f"trader_swaps:     {swaps_count:,} documents")

    # Check traders with updated balances
    traders_with_balances = await db.top_traders.count_documents({
        "holdings_updated_at": {"$exists": True}
    })
    print(f"\nTraders with updated balances: {traders_with_balances}/{traders_count}")

    # Get top 10 traders by value
    print("\n" + "=" * 70)
    print("TOP 10 TRADERS BY PORTFOLIO VALUE")
    print("=" * 70)

    top_traders = await db.top_traders.find(
        {"total_value_usd": {"$exists": True}},
        {"wallet_address": 1, "total_value_usd": 1, "total_positions": 1}
    ).sort("total_value_usd", -1).limit(10).to_list(10)

    for idx, trader in enumerate(top_traders, start=1):
        wallet = trader['wallet_address']
        value = trader.get('total_value_usd', 0)
        positions = trader.get('total_positions', 0)
        print(f"{idx:2d}. {wallet[:10]}... ${value:>12,.2f} ({positions} positions)")

    # Sample a trader with balances
    print("\n" + "=" * 70)
    print("SAMPLE TRADER PORTFOLIO")
    print("=" * 70)

    sample = await db.top_traders.find_one(
        {
            "holdings_updated_at": {"$exists": True},
            "total_value_usd": {"$gte": 1000, "$lte": 1_000_000}
        },
        {"wallet_address": 1, "total_value_usd": 1, "total_positions": 1, "holdings": 1}
    )

    if sample:
        print(f"\nWallet: {sample['wallet_address']}")
        print(f"Total Value: ${sample.get('total_value_usd', 0):,.2f}")
        print(f"Total Positions: {sample.get('total_positions', 0)}")
        print(f"\nTop Holdings:")
        for holding in sample.get('holdings', [])[:5]:  # Show first 5
            symbol = holding.get('symbol', 'UNKNOWN')
            balance = holding.get('balance', 0)
            value = holding.get('value_usd', 0)
            print(f"  • {symbol:8s} {balance:>12,.4f}  ${value:>10,.2f}")

    # Portfolio value distribution
    print("\n" + "=" * 70)
    print("PORTFOLIO VALUE DISTRIBUTION")
    print("=" * 70)

    ranges = [
        (0, 100, "< $100"),
        (100, 1000, "$100 - $1K"),
        (1000, 10000, "$1K - $10K"),
        (10000, 100000, "$10K - $100K"),
        (100000, 1000000, "$100K - $1M"),
        (1000000, 10000000, "$1M - $10M"),
        (10000000, float('inf'), "> $10M")
    ]

    for min_val, max_val, label in ranges:
        count = await db.top_traders.count_documents({
            "total_value_usd": {"$gte": min_val, "$lt": max_val}
        })
        bar = "█" * min(count // 10, 50)
        print(f"{label:15s} {count:4d} {bar}")

    # Sample trending token
    print("\n" + "=" * 70)
    print("SAMPLE TRENDING TOKENS (Top 5)")
    print("=" * 70)

    tokens = await db.trending_tokens.find(
        {},
        {"symbol": 1, "rank": 1, "volume_24h_usd": 1, "price_change_24h_pct": 1, "trader_count": 1}
    ).sort("rank", 1).limit(5).to_list(5)

    for token in tokens:
        symbol = token.get('symbol', 'UNKNOWN')
        rank = token.get('rank', 0)
        volume = token.get('volume_24h_usd', 0)
        change = token.get('price_change_24h_pct', 0)
        traders = token.get('trader_count', 0)
        change_emoji = "📈" if change > 0 else "📉"
        print(f"#{rank:2d}  {symbol:10s}  Vol: ${volume:>12,.0f}  {change_emoji} {change:>6.2f}%  ({traders} whales)")

    client.close()
    print("\n" + "=" * 70)


if __name__ == "__main__":
    asyncio.run(check_data())
