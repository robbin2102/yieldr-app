#!/usr/bin/env python3
"""
Performance Computation Job - Runs every 1 hour

Computes and updates performance metrics for all tracked traders based on:
- Recent swap history (30 days)
- Current holdings (from latest token scan)

Updates top_traders collection with:
- Performance metrics (PnL, ROI, win rate)
- Asset performance breakdown
- Risk metrics

Usage:
    python jobs/compute_performance.py

Cron schedule (every hour):
    0 * * * * cd /path/to/yieldr-data-api && python jobs/compute_performance.py >> logs/performance.log 2>&1
"""

import asyncio
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Any

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from motor.motor_asyncio import AsyncIOMotorClient
from utils.performance import compute_trader_performance, compute_asset_performance
from config import get_settings

settings = get_settings()


async def compute_all_trader_performance():
    """Main performance computation job."""
    print("=" * 80)
    print("TRADER PERFORMANCE COMPUTATION JOB")
    print(f"Started at: {datetime.utcnow().isoformat()}")
    print("=" * 80)

    # Connect to MongoDB
    client = AsyncIOMotorClient(settings.mongodb_uri)
    db = client.yieldr

    try:
        # Step 1: Load all active traders
        print(f"\n[{datetime.utcnow().isoformat()}] Loading active traders...")

        traders = await db.top_traders.find(
            {"status": "active"}
        ).to_list(5000)

        print(f"✓ Found {len(traders)} active traders")

        if not traders:
            print("✗ No active traders found. Exiting.")
            return

        # Step 2: Compute performance for each trader
        print(f"\n[{datetime.utcnow().isoformat()}] Computing performance metrics...\n")

        updated_count = 0
        error_count = 0

        for idx, trader in enumerate(traders, start=1):
            wallet = trader["wallet_address"]

            try:
                # Fetch swap history (last 30 days)
                cutoff = datetime.utcnow() - timedelta(days=30)

                swaps = await db.trader_swaps.find({
                    "wallet_address": wallet,
                    "timestamp": {"$gte": cutoff}
                }).sort("timestamp", -1).to_list(1000)

                # Compute current holdings value (simplified: sum from tokens array)
                current_holdings = {}
                for token in trader.get("tokens", []):
                    token_addr = token["token_address"]
                    holdings_value = 0.0

                    # Use total_holdings × current price (if available)
                    if token.get("total_holdings") and token.get("pnl_usd"):
                        # Estimate value from holdings
                        holdings_value = token.get("total_holdings", 0) * 1.0  # Placeholder

                    current_holdings[token_addr] = holdings_value

                # Compute performance metrics
                performance = compute_trader_performance(swaps, current_holdings)

                # Compute asset performance
                asset_performance = compute_asset_performance(swaps)

                # Update trader in MongoDB
                await db.top_traders.update_one(
                    {"wallet_address": wallet},
                    {
                        "$set": {
                            "performance": performance,
                            "asset_performance": asset_performance,
                            "performance_computed_at": datetime.utcnow()
                        }
                    }
                )

                updated_count += 1

                # Log progress every 100 traders
                if idx % 100 == 0 or idx == len(traders):
                    print(f"[{idx:4d}/{len(traders)}] Processed {updated_count} traders ({error_count} errors)")

            except Exception as e:
                error_count += 1
                if error_count <= 5:  # Only print first 5 errors
                    print(f"  ⚠ Error computing performance for {wallet}: {e}")

            # Small delay to avoid overloading
            if idx % 100 == 0:
                await asyncio.sleep(0.5)

        # Summary
        print("\n" + "=" * 80)
        print("PERFORMANCE COMPUTATION COMPLETE")
        print(f"Finished at: {datetime.utcnow().isoformat()}")
        print("-" * 80)
        print(f"Total traders: {len(traders)}")
        print(f"Updated: {updated_count}")
        print(f"Errors: {error_count}")
        print("=" * 80)

    except Exception as e:
        print(f"\n✗ Fatal error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(compute_all_trader_performance())
