#!/usr/bin/env python3
"""
Update Trader Token Balances - Runs every 6 hours

Fetches current token holdings for all tracked whale traders using:
- Alchemy for token balances (ERC-20 + native ETH)
- DeFiLlama for token prices

Cost: ~1.8M Alchemy CUs/month (0.6% of 300M free tier)

Usage:
    python jobs/update_trader_balances.py

Cron schedule (every 6 hours, offset by 30min from discovery):
    30 */6 * * * cd /path/to/yieldr-data-api && python jobs/update_trader_balances.py >> logs/balances.log 2>&1
"""

import asyncio
import sys
from datetime import datetime
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from motor.motor_asyncio import AsyncIOMotorClient
from services.alchemy import alchemy_service, Chain
from config import get_settings

settings = get_settings()


async def update_trader_balances():
    """
    Update token holdings for all tracked traders.

    Fetches current token balances (ERC-20 + native ETH) and updates MongoDB.
    """
    print("=" * 80)
    print("TRADER BALANCE UPDATE JOB")
    print(f"Started at: {datetime.utcnow().isoformat()}")
    print("=" * 80)

    # Connect to MongoDB
    client = AsyncIOMotorClient(settings.mongodb_uri)
    db = client.yieldr

    try:
        # Get all active traders
        print(f"\n[{datetime.utcnow().isoformat()}] Loading traders...")

        traders = await db.top_traders.find(
            {"status": "active"},
            {"wallet_address": 1}
        ).to_list(3000)

        if not traders:
            print("✗ No active traders found. Exiting.")
            return

        print(f"✓ Found {len(traders)} active traders")

        # Update balances for each trader
        print(f"\n[{datetime.utcnow().isoformat()}] Updating token balances...\n")

        updated = 0
        errors = 0
        dns_errors = 0

        for idx, trader in enumerate(traders, start=1):
            wallet = trader["wallet_address"]

            try:
                # Fetch token balances with retry logic for DNS errors
                max_retries = 3
                retry_delay = 1.0  # Start with 1 second

                for attempt in range(max_retries):
                    try:
                        # Fetch token balances (Alchemy + DeFiLlama)
                        holdings = await alchemy_service.get_wallet_tokens_with_values(
                            wallet=wallet,
                            chain=Chain.BASE,
                            min_value_usd=0.1,  # $0.10 minimum
                            include_native=True,  # Include native ETH
                            limit=50
                        )

                        # Calculate total portfolio value
                        total_value = sum(h["value_usd"] for h in holdings)

                        # Update trader record in MongoDB
                        await db.top_traders.update_one(
                            {"wallet_address": wallet},
                            {
                                "$set": {
                                    "holdings": holdings,
                                    "total_value_usd": round(total_value, 2),
                                    "total_positions": len(holdings),
                                    "holdings_updated_at": datetime.utcnow()
                                }
                            }
                        )

                        updated += 1
                        break  # Success - exit retry loop

                    except Exception as e:
                        error_msg = str(e)

                        # Check if it's a DNS error
                        if "nodename nor servname" in error_msg or "Name or service not known" in error_msg or "[Errno 8]" in error_msg:
                            dns_errors += 1

                            if attempt < max_retries - 1:
                                # Retry with exponential backoff
                                if dns_errors <= 3:  # Only print first 3 DNS errors
                                    print(f"  ⚠ DNS error for {wallet[:12]}..., retrying in {retry_delay}s (attempt {attempt + 1}/{max_retries})")
                                await asyncio.sleep(retry_delay)
                                retry_delay *= 2  # Exponential backoff
                            else:
                                # Max retries reached
                                raise e
                        else:
                            # Not a DNS error, don't retry
                            raise e

                # Log progress every 100 wallets
                if idx % 100 == 0 or idx == len(traders):
                    print(f"[{idx:4d}/{len(traders)}] Updated {updated} traders ({errors} errors, {dns_errors} DNS errors)")

                # Rate limit: Slower to avoid DNS overload
                # 0.5s = ~2 wallets/sec (much safer than 0.1s = 10/sec)
                await asyncio.sleep(0.5)

            except Exception as e:
                errors += 1
                if errors <= 5:  # Only print first 5 errors
                    print(f"  ⚠ Error updating {wallet}: {e}")
                continue

        # Summary
        print("\n" + "=" * 80)
        print("BALANCE UPDATE COMPLETE")
        print(f"Finished at: {datetime.utcnow().isoformat()}")
        print("-" * 80)
        print(f"Total traders: {len(traders)}")
        print(f"Updated: {updated}")
        print(f"Failed: {errors}")
        print(f"DNS errors: {dns_errors} (retried with backoff)")
        print("-" * 80)
        success_rate = (updated / len(traders) * 100) if len(traders) > 0 else 0
        print(f"Success rate: {success_rate:.1f}%")
        print("=" * 80)

        return updated

    except Exception as e:
        print(f"\n✗ Fatal error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(update_trader_balances())
