#!/usr/bin/env python3
"""
Historical Swap Backfilling - One-time job to fetch 30 days of swap history

Strategy: Query by TOKEN (100 calls/day × 30 days), filter by WALLET in-memory

This script:
1. Loads ~1,300 tracked trader wallets from MongoDB
2. For each trending token (100), fetches last 30 days of Transfer events in daily batches
3. Filters transfers by tracked wallets IN-MEMORY (no extra API cost)
4. Identifies buy/sell swaps and stores in MongoDB

Cost Efficiency:
- 89 tokens × 130 batches × 50 credits = ~578K credits (0.7% of 80M Starter tier) ✅
- Parallel processing: 10 concurrent tokens with 20 req/s rate limiting
- Estimated time: ~15-25 minutes (vs 60+ minutes sequential)

Usage:
    python jobs/backfill_swaps.py

Options:
    --days N        Number of days to backfill (default: 30)
    --batch-size N  Blocks per batch (default: 2000 = ~1 hour on Base)
    --parallel N    Number of concurrent tokens to process (default: 10)
"""

import asyncio
import argparse
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Any, Set

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from motor.motor_asyncio import AsyncIOMotorClient
from services.quicknode import quicknode_client
from config import get_settings
import httpx

settings = get_settings()


class RateLimiter:
    """Token bucket rate limiter for QuickNode API."""
    def __init__(self, rate: int = 20):  # 20 req/s (safe margin for Starter plan)
        self.rate = rate
        self.tokens = rate
        self.last_update = time.time()
        self.lock = asyncio.Lock()

    async def acquire(self):
        async with self.lock:
            now = time.time()
            elapsed = now - self.last_update
            self.tokens = min(self.rate, self.tokens + elapsed * self.rate)
            self.last_update = now

            if self.tokens < 1:
                wait_time = (1 - self.tokens) / self.rate
                await asyncio.sleep(wait_time)
                self.tokens = 0
            else:
                self.tokens -= 1

# ERC-20 Transfer event signature
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

# Known DEX router addresses on Base (for swap detection)
DEX_ROUTERS = {
    # Uniswap V3 Universal Router
    "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD".lower(): "uniswap_v3",
    # Aerodrome Router
    "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43".lower(): "aerodrome",
}


async def load_tracked_wallets(db) -> Set[str]:
    """
    Load all tracked REAL trader wallets from MongoDB (exclude CEX/treasury/whales).

    Returns:
        Set of lowercase wallet addresses for O(1) lookup
    """
    print(f"[{datetime.utcnow().isoformat()}] Loading tracked wallets...")

    traders = await db.top_traders.find(
        {"is_trader": True, "status": "active"},  # Only real traders
        {"wallet_address": 1}
    ).to_list(5000)

    tracked_wallets = {t["wallet_address"].lower() for t in traders}
    print(f"✓ Loaded {len(tracked_wallets)} real trader wallets")

    return tracked_wallets


async def load_trending_tokens(db) -> List[Dict[str, Any]]:
    """
    Load trending tokens from MongoDB.

    Returns:
        List of token data (address, symbol)
    """
    print(f"[{datetime.utcnow().isoformat()}] Loading trending tokens...")

    tokens = await db.trending_tokens.find(
        {},
        {"token_address": 1, "symbol": 1, "rank": 1}
    ).sort("rank", 1).to_list(100)

    print(f"✓ Loaded {len(tokens)} trending tokens")
    return tokens


async def get_token_decimals_and_symbol(
    db,
    token_address: str,
    default_symbol: str = "UNKNOWN"
) -> tuple:
    """
    Get token decimals and symbol (cached in trending_tokens).

    Args:
        db: MongoDB database
        token_address: Token contract address
        default_symbol: Fallback symbol

    Returns:
        Tuple of (decimals, symbol)
    """
    token = await db.trending_tokens.find_one(
        {"token_address": token_address},
        {"symbol": 1}
    )

    if token:
        return (18, token.get("symbol", default_symbol))  # Assume 18 decimals for ERC-20
    else:
        return (18, default_symbol)


def detect_swap_type(
    from_addr: str,
    to_addr: str,
    tracked_wallets: Set[str]
) -> tuple:
    """
    Detect if transfer is a buy or sell for tracked wallet.

    Logic:
    - If tracked wallet is SENDER (from) → SELL
    - If tracked wallet is RECEIVER (to) → BUY
    - If both involved → assume primary action is from sender (SELL)

    Args:
        from_addr: Transfer sender
        to_addr: Transfer receiver
        tracked_wallets: Set of tracked wallet addresses

    Returns:
        Tuple of (wallet_address, swap_type) or (None, None) if not relevant
    """
    from_tracked = from_addr in tracked_wallets
    to_tracked = to_addr in tracked_wallets

    if from_tracked and to_tracked:
        # Both tracked - rare case, default to sell
        return (from_addr, "sell")
    elif from_tracked:
        # Tracked wallet is sender → SELL
        return (from_addr, "sell")
    elif to_tracked:
        # Tracked wallet is receiver → BUY
        return (to_addr, "buy")
    else:
        # Neither tracked
        return (None, None)


async def fetch_logs_with_retry(
    token_address: str,
    from_block: int,
    to_block: int,
    batch_size: int,
    rate_limiter: RateLimiter,
    max_retries: int = 3
) -> List[Dict[str, Any]]:
    """
    Fetch logs with automatic retry and smaller batches on 413 errors.

    Args:
        token_address: Token contract address
        from_block: Start block
        to_block: End block
        batch_size: Initial batch size
        rate_limiter: Rate limiter instance
        max_retries: Max retry attempts

    Returns:
        List of log entries
    """
    current_batch_size = batch_size

    for attempt in range(max_retries):
        try:
            await rate_limiter.acquire()

            logs = await quicknode_client.get_transfer_logs(
                token_address=token_address,
                from_block=hex(from_block),
                to_block=hex(to_block)
            )
            return logs

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 413:
                # Response too large - reduce batch size and retry
                current_batch_size = max(500, current_batch_size // 2)

                if current_batch_size < batch_size:
                    # Split range into smaller chunks
                    mid_block = (from_block + to_block) // 2

                    # Recursively fetch both halves
                    logs1 = await fetch_logs_with_retry(
                        token_address, from_block, mid_block,
                        current_batch_size, rate_limiter, max_retries - 1
                    )
                    logs2 = await fetch_logs_with_retry(
                        token_address, mid_block + 1, to_block,
                        current_batch_size, rate_limiter, max_retries - 1
                    )

                    return logs1 + logs2
                else:
                    raise
            else:
                raise
        except Exception as e:
            if attempt < max_retries - 1:
                await asyncio.sleep(1 * (attempt + 1))  # Exponential backoff
            else:
                raise

    return []


async def backfill_token_swaps(
    db,
    token: Dict[str, Any],
    from_block: int,
    to_block: int,
    tracked_wallets: Set[str],
    batch_size: int,
    rate_limiter: RateLimiter,
    global_stats: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Backfill swaps for a single token across a block range.

    Args:
        db: MongoDB database
        token: Token data (address, symbol)
        from_block: Starting block number
        to_block: Ending block number
        tracked_wallets: Set of tracked wallet addresses
        batch_size: Number of blocks per API call

    Returns:
        Dict with stats (swaps_found, batches_processed, etc.)
    """
    token_address = token["token_address"]
    symbol = token.get("symbol", "UNKNOWN")

    stats = {
        "token_address": token_address,
        "symbol": symbol,
        "swaps_found": 0,
        "transfers_scanned": 0,
        "batches_processed": 0,
        "errors": 0
    }

    # Calculate total batches for this token
    total_batches = (to_block - from_block + batch_size - 1) // batch_size

    # Process in batches
    current_block = from_block
    all_swaps = []

    while current_block < to_block:
        batch_end = min(current_block + batch_size, to_block)

        try:
            # Get ALL transfers for this token in this batch with retry logic
            logs = await fetch_logs_with_retry(
                token_address=token_address,
                from_block=current_block,
                to_block=batch_end,
                batch_size=batch_size,
                rate_limiter=rate_limiter
            )

            # Increment global API call counter
            global_stats["api_calls"] += 1

            stats["transfers_scanned"] += len(logs)
            stats["batches_processed"] += 1

            # Progress logging every 100 batches
            if stats["batches_processed"] % 100 == 0:
                progress_pct = (stats["batches_processed"] / total_batches * 100)
                print(f"    {symbol}: {stats['batches_processed']}/{total_batches} batches ({progress_pct:.1f}%), {stats['swaps_found']} swaps found")

            # Filter by tracked wallets IN-MEMORY (free!)
            for log in logs:
                # Decode from/to from topics
                if len(log.get("topics", [])) < 3:
                    continue

                from_addr = "0x" + log["topics"][1][-40:].lower()
                to_addr = "0x" + log["topics"][2][-40:].lower()

                # Check if either address is tracked
                wallet, swap_type = detect_swap_type(from_addr, to_addr, tracked_wallets)

                if not wallet:
                    continue

                # Decode amount from data field
                amount_hex = log.get("data", "0x")
                amount_raw = int(amount_hex, 16) if amount_hex != "0x" else 0

                # Get decimals
                decimals, _ = await get_token_decimals_and_symbol(db, token_address, symbol)
                amount = amount_raw / (10 ** decimals)

                # Store swap data
                swap = {
                    "wallet_address": wallet,
                    "chain": "base",
                    "token_address": token_address,
                    "token_symbol": symbol,
                    "type": swap_type,
                    "amount_raw": str(amount_raw),
                    "amount": amount,
                    "value_usd": None,  # Will be computed later
                    "from_address": from_addr,
                    "to_address": to_addr,
                    "dex": DEX_ROUTERS.get(to_addr if swap_type == "buy" else from_addr),
                    "tx_hash": log["transactionHash"],
                    "block_number": int(log["blockNumber"], 16),
                    "log_index": int(log["logIndex"], 16),
                    "timestamp": datetime.utcnow(),  # Approximation
                    "indexed_at": datetime.utcnow(),
                    "processed": False
                }

                all_swaps.append(swap)
                stats["swaps_found"] += 1

        except Exception as e:
            print(f"  ⚠ Error processing blocks {current_block}-{batch_end}: {e}")
            stats["errors"] += 1

        current_block = batch_end + 1

    # Store all swaps for this token (skip duplicates)
    if all_swaps:
        stored_count = 0
        for swap in all_swaps:
            result = await db.trader_swaps.update_one(
                {"tx_hash": swap["tx_hash"], "log_index": swap["log_index"]},
                {"$setOnInsert": swap},
                upsert=True
            )
            if result.upserted_id:
                stored_count += 1

        stats["swaps_stored"] = stored_count
        stats["swaps_duplicate"] = len(all_swaps) - stored_count

    return stats


async def backfill_swaps(days: int = 30, batch_size: int = 2000, parallel: int = 10):
    """
    Main backfill logic - fetches historical swaps for all trending tokens.

    Args:
        days: Number of days to backfill
        batch_size: Blocks per batch (default: 2000 = ~1 hour on Base)
        parallel: Number of concurrent tokens to process (default: 10)
    """
    print("=" * 80)
    print("HISTORICAL SWAP BACKFILLING")
    print(f"Started at: {datetime.utcnow().isoformat()}")
    print(f"Backfilling: {days} days of swap history")
    print(f"Parallel processing: {parallel} concurrent tokens")
    print("=" * 80)

    # Initialize rate limiter and semaphore
    rate_limiter = RateLimiter(rate=20)  # 20 req/s for safety
    semaphore = asyncio.Semaphore(parallel)

    # Connect to MongoDB
    client = AsyncIOMotorClient(settings.mongodb_uri)
    db = client.yieldr

    try:
        # Step 1: Load tracked wallets into memory
        tracked_wallets = await load_tracked_wallets(db)

        if not tracked_wallets:
            print("✗ No tracked wallets found. Exiting.")
            return

        # Step 2: Load trending tokens
        trending_tokens = await load_trending_tokens(db)

        if not trending_tokens:
            print("✗ No trending tokens found. Exiting.")
            return

        # Step 3: Calculate block range for backfilling
        latest_block = await quicknode_client.get_block_number()

        # Base block time: ~2 seconds
        # blocks_per_day = 24 * 60 * 60 / 2 = 43,200 blocks/day
        blocks_to_backfill = days * 43200
        from_block = latest_block - blocks_to_backfill
        to_block = latest_block

        print(f"\nBlock range:")
        print(f"  From: {from_block:,} (~ {days} days ago)")
        print(f"  To:   {to_block:,} (current)")
        print(f"  Total blocks: {blocks_to_backfill:,}")
        print(f"  Batch size: {batch_size:,} blocks (~{batch_size / 1800:.1f} hours)\n")

        # Step 4: Backfill each token (parallel processing)
        total_stats = {
            "tokens_processed": 0,
            "total_swaps_found": 0,
            "total_swaps_stored": 0,
            "total_transfers_scanned": 0,
            "total_errors": 0
        }

        # Global stats for real-time progress tracking
        global_stats = {
            "api_calls": 0,
            "tokens_completed": 0
        }

        async def progress_reporter():
            """Background task to print progress every 30 seconds."""
            while global_stats["tokens_completed"] < len(trending_tokens):
                await asyncio.sleep(30)
                calls = global_stats["api_calls"]
                completed = global_stats["tokens_completed"]
                print(f"\n📊 Progress: {completed}/{len(trending_tokens)} tokens completed, {calls:,} API calls made\n")

        # Start progress reporter in background
        reporter_task = asyncio.create_task(progress_reporter())

        async def process_token(idx: int, token: Dict[str, Any]):
            """Process a single token with semaphore."""
            async with semaphore:
                symbol = token.get("symbol", "UNKNOWN")
                print(f"\n[{idx:3d}/{len(trending_tokens)}] Processing {symbol}...")

                stats = await backfill_token_swaps(
                    db=db,
                    token=token,
                    from_block=from_block,
                    to_block=to_block,
                    tracked_wallets=tracked_wallets,
                    batch_size=batch_size,
                    rate_limiter=rate_limiter,
                    global_stats=global_stats
                )

                # Update backfill status in trending_tokens
                await db.trending_tokens.update_one(
                    {"token_address": token["token_address"]},
                    {"$set": {"backfill_completed_at": datetime.utcnow()}}
                )

                global_stats["tokens_completed"] += 1

                print(f"  ✓ {symbol}: {stats['swaps_found']} swaps found, {stats.get('swaps_stored', 0)} stored ({stats['batches_processed']} batches, {global_stats['api_calls']:,} total API calls)")

                return stats

        # Process all tokens concurrently
        tasks = [process_token(idx, token) for idx, token in enumerate(trending_tokens, start=1)]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Cancel progress reporter
        reporter_task.cancel()
        try:
            await reporter_task
        except asyncio.CancelledError:
            pass

        # Aggregate results
        for result in results:
            if isinstance(result, dict):
                total_stats["tokens_processed"] += 1
                total_stats["total_swaps_found"] += result["swaps_found"]
                total_stats["total_swaps_stored"] += result.get("swaps_stored", 0)
                total_stats["total_transfers_scanned"] += result["transfers_scanned"]
                total_stats["total_errors"] += result["errors"]
            else:
                # Exception occurred
                total_stats["total_errors"] += 1
                print(f"  ⚠ Token processing failed: {result}")

        # Step 5: Update backfill status for traders
        print(f"\n[{datetime.utcnow().isoformat()}] Updating trader backfill status...")

        # Mark all traders with swaps as backfilled
        wallets_with_swaps = await db.trader_swaps.distinct("wallet_address")
        for wallet in wallets_with_swaps:
            await db.top_traders.update_one(
                {"wallet_address": wallet},
                {"$set": {"backfill_status": "completed", "backfilled_at": datetime.utcnow()}}
            )

        print(f"✓ Updated {len(wallets_with_swaps)} traders")

        # Summary
        print("\n" + "=" * 80)
        print("BACKFILLING COMPLETE")
        print(f"Finished at: {datetime.utcnow().isoformat()}")
        print("-" * 80)
        print(f"Tokens processed:      {total_stats['tokens_processed']}")
        print(f"API calls made:        {global_stats['api_calls']:,}")
        print(f"Transfers scanned:     {total_stats['total_transfers_scanned']:,}")
        print(f"Swaps found:           {total_stats['total_swaps_found']:,}")
        print(f"Swaps stored:          {total_stats['total_swaps_stored']:,}")
        print(f"Duplicates skipped:    {total_stats['total_swaps_found'] - total_stats['total_swaps_stored']:,}")
        print(f"Errors:                {total_stats['total_errors']}")
        print(f"Traders with swaps:    {len(wallets_with_swaps)}")
        print("-" * 80)
        credits_used = global_stats['api_calls'] * 50
        print(f"QuickNode credits:     ~{credits_used:,} ({credits_used / 80_000_000 * 100:.2f}% of 80M Starter tier)")
        print("=" * 80)

    except Exception as e:
        print(f"\n✗ Fatal error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill historical swap data with parallel processing")
    parser.add_argument("--days", type=int, default=30, help="Number of days to backfill (default: 30)")
    parser.add_argument("--batch-size", type=int, default=2000, help="Blocks per batch (default: 2000 = ~1 hour)")
    parser.add_argument("--parallel", type=int, default=10, help="Number of concurrent tokens (default: 10)")

    args = parser.parse_args()

    asyncio.run(backfill_swaps(days=args.days, batch_size=args.batch_size, parallel=args.parallel))
