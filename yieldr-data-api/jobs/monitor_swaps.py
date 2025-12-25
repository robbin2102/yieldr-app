#!/usr/bin/env python3
"""
Real-Time Swap Monitor - Polls every 15 minutes

Strategy: Query by TOKEN (100 calls), filter by WALLET in-memory (free)

This script:
1. Loads ~2K tracked trader wallets from MongoDB
2. Fetches last 15 min of Transfer events for each trending token (~100 tokens)
3. Filters transfers by tracked wallets IN-MEMORY (no extra API cost)
4. Identifies buy/sell swaps and stores in MongoDB
5. Cleans up swaps older than 30 days

Cost Efficiency:
- 100 tokens × 96 polls/day (15 min) × 50 credits = 480K credits/day
- ~14.4M credits/month (18% of 80M free tier) ✅

Usage:
    python jobs/monitor_swaps.py

Cron schedule (every 15 min):
    */15 * * * * cd /path/to/yieldr-data-api && python jobs/monitor_swaps.py >> logs/swaps.log 2>&1
"""

import asyncio
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Any, Set

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from motor.motor_asyncio import AsyncIOMotorClient
from services.quicknode import quicknode_client
from services.defillama import defillama_service
from config import get_settings

settings = get_settings()

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
    Load all tracked trader wallets from MongoDB.

    Returns:
        Set of lowercase wallet addresses for O(1) lookup
    """
    print(f"[{datetime.utcnow().isoformat()}] Loading tracked wallets...")

    traders = await db.top_traders.find(
        {"status": "active"},
        {"wallet_address": 1}
    ).to_list(5000)

    tracked_wallets = {t["wallet_address"].lower() for t in traders}
    print(f"✓ Loaded {len(tracked_wallets)} tracked wallets")

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


async def monitor_swaps():
    """Main swap monitoring logic."""
    print("=" * 80)
    print("SWAP MONITOR - Poll by TOKEN, Filter by WALLET")
    print(f"Started at: {datetime.utcnow().isoformat()}")
    print("=" * 80)

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

        # Step 3: Get block range (last ~15 min = ~450 blocks on Base)
        # Base block time: ~2 seconds
        latest_block = await quicknode_client.get_block_number()
        from_block = hex(latest_block - 450)  # ~15 min of blocks
        to_block = "latest"

        print(f"\nBlock range: {from_block} ({latest_block - 450}) → {to_block} ({latest_block})")
        print(f"Scanning ~450 blocks (~15 min)\n")

        # Step 4: Fetch transfers for each token, filter by tracked wallets
        all_swaps = []
        total_transfers = 0

        for idx, token in enumerate(trending_tokens, start=1):
            token_address = token["token_address"]
            symbol = token.get("symbol", "UNKNOWN")

            try:
                # Get ALL transfers for this token (1 API call per token)
                logs = await quicknode_client.get_transfer_logs(
                    token_address=token_address,
                    from_block=from_block,
                    to_block=to_block
                )

                total_transfers += len(logs)

                # Filter by tracked wallets IN-MEMORY (free!)
                token_swaps = 0

                for log in logs:
                    # Decode from/to from topics
                    # Topics: [signature, indexed from (padded), indexed to (padded)]
                    if len(log.get("topics", [])) < 3:
                        continue

                    from_addr = "0x" + log["topics"][1][-40:].lower()  # Last 40 chars (20 bytes)
                    to_addr = "0x" + log["topics"][2][-40:].lower()

                    # Check if either address is tracked
                    wallet, swap_type = detect_swap_type(from_addr, to_addr, tracked_wallets)

                    if not wallet:
                        continue

                    # Decode amount from data field
                    amount_hex = log.get("data", "0x")
                    amount_raw = int(amount_hex, 16) if amount_hex != "0x" else 0

                    # Get decimals (assume 18 for now, can enhance later)
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
                        "timestamp": datetime.utcnow(),  # Approximation (can fetch block timestamp if needed)
                        "indexed_at": datetime.utcnow(),
                        "processed": False
                    }

                    all_swaps.append(swap)
                    token_swaps += 1

                if token_swaps > 0:
                    print(f"[{idx:3d}/{len(trending_tokens)}] {symbol:10s} → {len(logs):4d} transfers, {token_swaps:2d} swaps ✓")

            except Exception as e:
                print(f"[{idx:3d}/{len(trending_tokens)}] {symbol:10s} → Error: {e}")
                continue

            # Small delay to avoid rate limits
            await asyncio.sleep(0.1)

        # Step 5: Store swaps (skip duplicates)
        print(f"\n[{datetime.utcnow().isoformat()}] Storing swaps...")
        print(f"Total transfers scanned: {total_transfers}")
        print(f"Relevant swaps found: {len(all_swaps)}")

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

            print(f"✓ Stored {stored_count} new swaps (skipped {len(all_swaps) - stored_count} duplicates)")

            # Update last_swap_indexed timestamp for traders
            unique_wallets = {swap["wallet_address"] for swap in all_swaps}
            for wallet in unique_wallets:
                await db.top_traders.update_one(
                    {"wallet_address": wallet},
                    {"$set": {"last_swap_indexed": datetime.utcnow()}}
                )
        else:
            print("✓ No new swaps found")

        # Step 6: Cleanup old swaps (>30 days)
        cutoff = datetime.utcnow() - timedelta(days=30)
        result = await db.trader_swaps.delete_many({"timestamp": {"$lt": cutoff}})

        if result.deleted_count > 0:
            print(f"✓ Cleaned up {result.deleted_count} swaps older than 30 days")

        # Summary
        print("\n" + "=" * 80)
        print("MONITORING COMPLETE")
        print(f"Finished at: {datetime.utcnow().isoformat()}")
        print("-" * 80)
        print(f"Tokens scanned: {len(trending_tokens)}")
        print(f"Total transfers: {total_transfers}")
        print(f"Relevant swaps: {len(all_swaps)}")
        print(f"API calls: ~{len(trending_tokens)} (query by TOKEN strategy)")
        print("=" * 80)

    except Exception as e:
        print(f"\n✗ Fatal error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(monitor_swaps())
