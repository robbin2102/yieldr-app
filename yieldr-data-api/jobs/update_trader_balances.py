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


async def update_single_trader(db, wallet: str, semaphore: asyncio.Semaphore, stats: dict):
    """
    Update balances for a single trader with retry logic.

    Args:
        db: MongoDB database instance
        wallet: Wallet address to update
        semaphore: Asyncio semaphore for concurrency control
        stats: Shared stats dict for tracking progress
    """
    async with semaphore:
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

                    stats["updated"] += 1
                    return True  # Success

                except Exception as e:
                    error_msg = str(e)

                    # Check if it's a DNS error
                    if "nodename nor servname" in error_msg or "Name or service not known" in error_msg or "[Errno 8]" in error_msg:
                        stats["dns_errors"] += 1

                        if attempt < max_retries - 1:
                            # Retry with exponential backoff
                            if stats["dns_errors"] <= 3:  # Only print first 3 DNS errors
                                print(f"  ⚠ DNS error for {wallet[:12]}..., retrying in {retry_delay}s (attempt {attempt + 1}/{max_retries})")
                            await asyncio.sleep(retry_delay)
                            retry_delay *= 2  # Exponential backoff
                        else:
                            # Max retries reached
                            raise e
                    else:
                        # Not a DNS error, don't retry
                        raise e

        except Exception as e:
            stats["errors"] += 1
            if stats["errors"] <= 5:  # Only print first 5 errors
                print(f"  ⚠ Error updating {wallet}: {e}")
            return False


async def update_trader_balances():
    """
    Update token holdings for all tracked traders using concurrent batch processing.

    Fetches current token balances (ERC-20 + native ETH) and updates MongoDB.
    Uses asyncio.gather for concurrent processing with semaphore to limit concurrency.
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

        # Shared stats dictionary
        stats = {"updated": 0, "errors": 0, "dns_errors": 0}

        # Semaphore to limit concurrent requests (10 at a time for good balance)
        semaphore = asyncio.Semaphore(10)

        # Process in batches of 100 for progress logging
        batch_size = 100
        for batch_start in range(0, len(traders), batch_size):
            batch_end = min(batch_start + batch_size, len(traders))
            batch = traders[batch_start:batch_end]

            # Process batch concurrently
            tasks = [
                update_single_trader(db, trader["wallet_address"], semaphore, stats)
                for trader in batch
            ]
            await asyncio.gather(*tasks)

            # Log progress after each batch
            print(f"[{batch_end:4d}/{len(traders)}] Updated {stats['updated']} traders ({stats['errors']} errors, {stats['dns_errors']} DNS errors)")

        # Summary
        print("\n" + "=" * 80)
        print("BALANCE UPDATE COMPLETE")
        print(f"Finished at: {datetime.utcnow().isoformat()}")
        print("-" * 80)
        print(f"Total traders: {len(traders)}")
        print(f"Updated: {stats['updated']}")
        print(f"Failed: {stats['errors']}")
        print(f"DNS errors: {stats['dns_errors']} (retried with backoff)")
        print("-" * 80)
        success_rate = (stats['updated'] / len(traders) * 100) if len(traders) > 0 else 0
        print(f"Success rate: {success_rate:.1f}%")
        print("=" * 80)

        return stats['updated']

    except Exception as e:
        print(f"\n✗ Fatal error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(update_trader_balances())
