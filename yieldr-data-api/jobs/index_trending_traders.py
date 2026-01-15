#!/usr/bin/env python3
"""
12-Hour Cron Job: Index Trending Tokens + Top Traders

This script runs every 12 hours to:
1. Fetch top 100 trending tokens from GeckoTerminal (Base only)
2. For each trending token:
   - Fetch top 10 profitable traders (30-day basis)
   - Fetch top 10 whale holders
   - Merge and deduplicate
3. Store in MongoDB collections: trending_tokens, top_traders

Usage:
    python jobs/index_trending_traders.py

Cron schedule (every 12h):
    0 */12 * * * cd /path/to/yieldr-data-api && python jobs/index_trending_traders.py >> logs/trending.log 2>&1
"""

import asyncio
import sys
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from motor.motor_asyncio import AsyncIOMotorClient
from services.geckoterminal import geckoterminal_client
from services.moralis import moralis_client
from config import get_settings

settings = get_settings()


async def fetch_trending_tokens(limit: int = 100) -> List[Dict[str, Any]]:
    """
    Fetch top trending tokens from GeckoTerminal on Base.

    Args:
        limit: Number of trending tokens to fetch (default: 100)

    Returns:
        List of trending token data
    """
    print(f"[{datetime.utcnow().isoformat()}] Fetching top {limit} trending tokens on Base...")

    try:
        pools = await geckoterminal_client.get_trending_pools(
            chain="base",
            page=1
        )

        trending_tokens = []
        for idx, pool in enumerate(pools[:limit], start=1):
            try:
                # Extract pool attributes
                attrs = pool.get("attributes", {})

                # Extract base token info from relationships
                base_token_rel = pool.get("relationships", {}).get("base_token", {}).get("data", {})
                token_address = base_token_rel.get("id", "").split("_")[-1] if base_token_rel.get("id") else None

                if not token_address:
                    continue

                # Get token symbol and name from attributes (GeckoTerminal format)
                name = attrs.get("name", "Unknown Pool")
                # Symbol is usually in the pool name, extract the first part
                symbol = name.split("/")[0].strip() if "/" in name else "UNKNOWN"

                token_data = {
                    "token_address": token_address.lower(),
                    "chain": "base",
                    "symbol": symbol,
                    "name": name,
                    "price_usd": float(attrs.get("base_token_price_usd", 0) or 0),
                    "volume_24h_usd": float(attrs.get("volume_usd", {}).get("h24", 0) or 0),
                    "price_change_24h_pct": float(attrs.get("price_change_percentage", {}).get("h24", 0) or 0),
                    "pool_address": pool.get("id", "").split("_")[-1].lower() if pool.get("id") else "",
                    "dex": pool.get("relationships", {}).get("dex", {}).get("data", {}).get("id", "unknown").split("_")[-1] if pool.get("relationships", {}).get("dex", {}).get("data", {}).get("id") else "unknown",
                    "rank": idx,
                    "indexed_at": datetime.utcnow(),
                    "trader_count": 0  # Will be updated after trader discovery
                }

                trending_tokens.append(token_data)
            except Exception as e:
                print(f"  ⚠ Error parsing pool {idx}: {e}")
                continue

        print(f"✓ Fetched {len(trending_tokens)} trending tokens")
        return trending_tokens

    except Exception as e:
        print(f"✗ Error fetching trending tokens: {e}")
        return []


async def discover_top_traders(
    token_address: str,
    token_symbol: str
) -> Dict[str, Any]:
    """
    Discover top 20 whale traders for a specific token.

    Note: Moralis profitable-wallets endpoint doesn't work on Base (only Ethereum mainnet).
    We only use whale holders discovery.

    Args:
        token_address: Token contract address
        token_symbol: Token symbol (for logging)

    Returns:
        Dict with:
          - traders: List of unique trader wallet addresses with metadata
          - count: Number of unique traders
    """
    traders_map = {}  # wallet_address -> trader data

    # Fetch top 20 whale holders (increased from 10 to get more traders)
    try:
        whales = await moralis_client.get_top_token_holders(
            token_address=token_address,
            limit=20  # Changed from 10 to 20
        )

        for whale in whales:
            wallet = whale["wallet_address"]

            traders_map[wallet] = {
                "wallet_address": wallet,
                "token_address": token_address,
                "symbol": token_symbol,
                "is_profitable": False,  # Can't determine on Base
                "is_whale": True,
                "pnl_usd": None,
                "avg_buy_price_usd": None,
                "avg_sell_price_usd": None,
                "total_bought": None,
                "total_sold": None,
                "total_holdings": float(whale["balance_formatted"]),
                "holding_percentage": whale["percentage_relative_to_total_supply"]
            }

    except Exception as e:
        print(f"  ⚠ Error fetching whale holders for {token_symbol}: {e}")

    return {
        "traders": list(traders_map.values()),
        "count": len(traders_map)
    }


async def main():
    """Main indexing job."""
    print("=" * 80)
    print("TRENDING TOKENS & TOP TRADERS INDEXING JOB")
    print(f"Started at: {datetime.utcnow().isoformat()}")
    print("=" * 80)

    # Connect to MongoDB
    client = AsyncIOMotorClient(settings.mongodb_uri)
    db = client.yieldr

    try:
        # Step 1: Fetch trending tokens
        trending_tokens = await fetch_trending_tokens(limit=100)

        if not trending_tokens:
            print("✗ No trending tokens found. Exiting.")
            return

        # Step 2: Discover top traders for each token
        print(f"\n[{datetime.utcnow().isoformat()}] Discovering top traders...")

        all_traders = {}  # wallet_address -> trader data (with all tokens)
        total_trader_count = 0

        for idx, token in enumerate(trending_tokens, start=1):
            token_address = token["token_address"]
            token_symbol = token["symbol"]

            print(f"\n[{idx}/{len(trending_tokens)}] Processing {token_symbol} ({token_address})...")

            # Discover traders for this token
            result = await discover_top_traders(token_address, token_symbol)
            traders = result["traders"]
            count = result["count"]

            print(f"  ✓ Found {count} whale traders")

            # Update token's trader_count
            token["trader_count"] = count

            # Aggregate traders across all tokens
            for trader in traders:
                wallet = trader["wallet_address"]

                if wallet not in all_traders:
                    all_traders[wallet] = {
                        "wallet_address": wallet,
                        "chain": "base",
                        "tokens": [],
                        "status": "active",
                        "indexed_at": datetime.utcnow(),
                        "last_swap_indexed": None,
                        "backfill_status": "pending"
                    }

                # Add token metadata to this trader
                all_traders[wallet]["tokens"].append({
                    "token_address": trader["token_address"],
                    "symbol": trader["symbol"],
                    "is_profitable": trader["is_profitable"],
                    "is_whale": trader["is_whale"],
                    "pnl_usd": trader["pnl_usd"],
                    "avg_buy_price_usd": trader["avg_buy_price_usd"],
                    "avg_sell_price_usd": trader["avg_sell_price_usd"],
                    "total_bought": trader["total_bought"],
                    "total_sold": trader["total_sold"],
                    "total_holdings": trader["total_holdings"],
                    "holding_percentage": trader["holding_percentage"]
                })

            # Small delay to avoid rate limits
            await asyncio.sleep(0.2)

        total_trader_count = len(all_traders)

        # Step 3: Store trending_tokens in MongoDB
        print(f"\n[{datetime.utcnow().isoformat()}] Storing {len(trending_tokens)} trending tokens...")

        for token in trending_tokens:
            await db.trending_tokens.update_one(
                {"token_address": token["token_address"], "chain": token["chain"]},
                {"$set": token},
                upsert=True
            )

        print(f"✓ Stored {len(trending_tokens)} trending tokens")

        # Step 4: Store top_traders in MongoDB
        print(f"\n[{datetime.utcnow().isoformat()}] Storing {total_trader_count} unique traders...")

        for wallet, trader in all_traders.items():
            # Only update tokens array and indexed_at, preserve performance metrics
            await db.top_traders.update_one(
                {"wallet_address": wallet},
                {
                    "$set": {
                        "tokens": trader["tokens"],
                        "indexed_at": trader["indexed_at"]
                    },
                    "$setOnInsert": {
                        "chain": trader["chain"],
                        "status": trader["status"],
                        "last_swap_indexed": trader["last_swap_indexed"],
                        "backfill_status": trader["backfill_status"],
                        "performance": {},  # Will be computed from swaps
                        "asset_performance": []
                    }
                },
                upsert=True
            )

        print(f"✓ Stored {total_trader_count} traders")

        # Step 5: Summary
        print("\n" + "=" * 80)
        print("INDEXING COMPLETE")
        print(f"Finished at: {datetime.utcnow().isoformat()}")
        print("-" * 80)
        print(f"Trending Tokens: {len(trending_tokens)}")
        print(f"Unique Traders:  {total_trader_count}")
        print(f"Avg Traders/Token: {total_trader_count / len(trending_tokens):.1f}")
        print("=" * 80)

    except Exception as e:
        print(f"\n✗ Fatal error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(main())
