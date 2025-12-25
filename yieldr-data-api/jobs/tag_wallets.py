#!/usr/bin/env python3
"""
Wallet Tagging Job - Classify traders vs non-traders

Tags wallets as:
- cex: Known exchange wallet
- treasury: Project treasury/team wallet
- whale_lp: Whale LP provider
- contract: Smart contract
- trader: Real retail trader ✅

Run: After balance updates (every 6h, offset by 45min)

Usage:
    python jobs/tag_wallets.py

Cron schedule:
    45 */6 * * * cd /path/to/yieldr-data-api && python jobs/tag_wallets.py >> logs/tagging.log 2>&1
"""

import asyncio
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from motor.motor_asyncio import AsyncIOMotorClient
from utils.cex_wallets import is_cex_wallet
from config import get_settings

settings = get_settings()


async def tag_wallets():
    """
    Tag all traders as CEX/treasury/LP/contract/trader.

    Tagging rules:
    1. Known CEX wallet → tag: cex
    2. Single position > $10M → tag: treasury
    3. Single position > $1M → tag: treasury
    4. ≤2 positions + >$50M → tag: whale_lp
    5. >$500M total value → tag: contract (likely error)
    6. Otherwise → tag: trader ✅
    """
    print("=" * 80)
    print("WALLET TAGGING JOB")
    print(f"Started at: {datetime.utcnow().isoformat()}")
    print("=" * 80)

    client = AsyncIOMotorClient(settings.mongodb_uri)
    db = client.yieldr

    try:
        # Load all traders with balances
        print(f"\n[{datetime.utcnow().isoformat()}] Loading traders...")

        traders = await db.top_traders.find({
            "holdings_updated_at": {"$exists": True}
        }).to_list(5000)

        if not traders:
            print("✗ No traders with balances found. Exiting.")
            return

        print(f"✓ Found {len(traders)} traders to tag")

        # Tag each trader
        print(f"\n[{datetime.utcnow().isoformat()}] Tagging wallets...\n")

        stats = {"cex": 0, "treasury": 0, "whale_lp": 0, "contract": 0, "trader": 0}

        for trader in traders:
            wallet = trader["wallet_address"].lower()
            holdings = trader.get("holdings", [])
            total_value = trader.get("total_value_usd", 0)
            total_positions = len(holdings)

            tag = None
            reason = None

            # Rule 1: Known CEX wallet
            is_cex, exchange = is_cex_wallet(wallet)
            if is_cex:
                tag = "cex"
                reason = f"Known {exchange} wallet"

            # Rule 2: Single position > $10M = likely treasury
            elif total_positions == 1 and total_value > 10_000_000:
                tag = "treasury"
                reason = f"Single position worth ${total_value:,.0f}"

            # Rule 3: Single position > $1M with >90% of holdings = treasury
            elif total_positions == 1 and total_value > 1_000_000:
                tag = "treasury"
                reason = f"Single token holder, ${total_value:,.0f}"

            # Rule 4: Very few positions + very high value = LP/whale
            elif total_positions <= 2 and total_value > 50_000_000:
                tag = "whale_lp"
                reason = f"{total_positions} positions, ${total_value:,.0f} value"

            # Rule 5: Unrealistic value (>$500M) = likely error or contract
            elif total_value > 500_000_000:
                tag = "contract"
                reason = f"Unrealistic value ${total_value:,.0f}"

            # Otherwise: Real trader
            else:
                tag = "trader"
                reason = None

            stats[tag] = stats.get(tag, 0) + 1

            # Update database
            await db.top_traders.update_one(
                {"wallet_address": wallet},
                {
                    "$set": {
                        "tag": tag,
                        "tag_reason": reason,
                        "is_trader": tag == "trader",
                        "tagged_at": datetime.utcnow()
                    }
                }
            )

        # Summary
        print("\n" + "=" * 80)
        print("TAGGING COMPLETE")
        print(f"Finished at: {datetime.utcnow().isoformat()}")
        print("-" * 80)
        print(f"CEX wallets:     {stats.get('cex', 0):4d}")
        print(f"Treasury:        {stats.get('treasury', 0):4d}")
        print(f"Whale/LP:        {stats.get('whale_lp', 0):4d}")
        print(f"Contracts:       {stats.get('contract', 0):4d}")
        print(f"Real traders:    {stats.get('trader', 0):4d} ✅")
        print("-" * 80)
        print(f"Total processed: {sum(stats.values())}")
        print("=" * 80)

        return stats

    except Exception as e:
        print(f"\n✗ Fatal error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(tag_wallets())
