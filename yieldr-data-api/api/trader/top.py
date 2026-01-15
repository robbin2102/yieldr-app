"""
Top Traders API Endpoints

GET /api/v1/trader/top - Get top traders leaderboard
GET /api/v1/trader/{wallet}/profile - Get trader profile with performance metrics
GET /api/v1/trader/{wallet}/swaps - Get trader's recent swap history
"""

from typing import Dict, Any, List, Optional
from fastapi import APIRouter, Depends, Query, Path
from api.dependencies import verify_api_key
from db.mongodb import get_database
from datetime import datetime, timedelta

router = APIRouter()


@router.get("/top")
async def get_top_traders(
    token_address: Optional[str] = Query(default=None, description="Filter by specific token"),
    limit: int = Query(default=20, ge=1, le=100, description="Max traders to return"),
    min_pnl: float = Query(default=0, description="Minimum 30d PnL in USD"),
    _api_key: str = Depends(verify_api_key)
) -> Dict[str, Any]:
    """
    Get top traders leaderboard.

    Can filter by specific token or show all top traders.

    Args:
        token_address: Optional token address to filter traders
        limit: Maximum number of traders to return
        min_pnl: Minimum 30-day PnL threshold

    Returns:
        {
            "totalTraders": 20,
            "token": "0x..." or null,
            "traders": [
                {
                    "walletAddress": "0x...",
                    "chain": "base",
                    "tokens": [...],
                    "performance": {...},
                    "totalTokens": 5,
                    "indexedAt": "2025-12-24T10:00:00Z"
                },
                ...
            ]
        }
    """
    db = get_database()

    # Build query filter
    query_filter = {"status": "active"}

    if token_address:
        # Filter traders who have this token in their tokens array
        query_filter["tokens.token_address"] = token_address.lower()

    # Fetch traders from MongoDB
    traders = await db.top_traders.find(query_filter).limit(limit).to_list(limit)

    # Format response
    formatted_traders = []
    for trader in traders:
        # Filter tokens if specific token requested
        tokens = trader.get("tokens", [])
        if token_address:
            tokens = [t for t in tokens if t["token_address"] == token_address.lower()]

        formatted_traders.append({
            "walletAddress": trader["wallet_address"],
            "chain": trader.get("chain", "base"),
            "tokens": tokens,
            "performance": trader.get("performance", {}),
            "assetPerformance": trader.get("asset_performance", []),
            "totalTokens": len(trader.get("tokens", [])),
            "indexedAt": trader["indexed_at"].isoformat() if trader.get("indexed_at") else None,
            "lastSwapIndexed": trader["last_swap_indexed"].isoformat() if trader.get("last_swap_indexed") else None
        })

    return {
        "totalTraders": len(formatted_traders),
        "token": token_address,
        "traders": formatted_traders
    }


@router.get("/{wallet}/profile")
async def get_trader_profile(
    wallet: str = Path(..., description="Trader wallet address"),
    _api_key: str = Depends(verify_api_key)
) -> Dict[str, Any]:
    """
    Get detailed profile for a specific trader.

    Includes:
    - Tokens traded
    - Performance metrics (PnL, ROI, win rate)
    - Asset performance breakdown
    - Risk metrics

    Args:
        wallet: Trader wallet address

    Returns:
        Trader profile with all performance data
    """
    db = get_database()

    trader = await db.top_traders.find_one({
        "wallet_address": wallet.lower()
    })

    if not trader:
        return {"error": "Trader not found"}

    return {
        "walletAddress": trader["wallet_address"],
        "chain": trader.get("chain", "base"),
        "status": trader.get("status", "active"),
        "tokens": trader.get("tokens", []),
        "performance": trader.get("performance", {}),
        "assetPerformance": trader.get("asset_performance", []),
        "totalTokens": len(trader.get("tokens", [])),
        "indexedAt": trader["indexed_at"].isoformat() if trader.get("indexed_at") else None,
        "lastSwapIndexed": trader["last_swap_indexed"].isoformat() if trader.get("last_swap_indexed") else None,
        "backfillStatus": trader.get("backfill_status", "pending")
    }


@router.get("/{wallet}/swaps")
async def get_trader_swaps(
    wallet: str = Path(..., description="Trader wallet address"),
    days: int = Query(default=7, ge=1, le=30, description="Number of days to look back"),
    limit: int = Query(default=50, ge=1, le=100, description="Max swaps to return"),
    _api_key: str = Depends(verify_api_key)
) -> Dict[str, Any]:
    """
    Get recent swap history for a trader.

    Args:
        wallet: Trader wallet address
        days: Number of days to look back (1-30)
        limit: Maximum number of swaps to return

    Returns:
        {
            "wallet": "0x...",
            "totalSwaps": 50,
            "days": 7,
            "swaps": [
                {
                    "tokenAddress": "0x...",
                    "tokenSymbol": "TOKEN",
                    "type": "buy",
                    "amount": 1000.0,
                    "valueUSD": 5000.0,
                    "dex": "uniswap_v3",
                    "txHash": "0x...",
                    "blockNumber": 12345,
                    "timestamp": "2025-12-24T10:30:00Z"
                },
                ...
            ]
        }
    """
    db = get_database()

    # Calculate cutoff time
    cutoff = datetime.utcnow() - timedelta(days=days)

    # Fetch swaps from MongoDB
    swaps = await db.trader_swaps.find({
        "wallet_address": wallet.lower(),
        "timestamp": {"$gte": cutoff}
    }).sort("timestamp", -1).limit(limit).to_list(limit)

    # Format response
    formatted_swaps = []
    for swap in swaps:
        formatted_swaps.append({
            "tokenAddress": swap["token_address"],
            "tokenSymbol": swap.get("token_symbol", "UNKNOWN"),
            "type": swap["type"],
            "amount": swap["amount"],
            "valueUSD": swap.get("value_usd"),
            "fromAddress": swap.get("from_address"),
            "toAddress": swap.get("to_address"),
            "dex": swap.get("dex"),
            "txHash": swap["tx_hash"],
            "blockNumber": swap["block_number"],
            "timestamp": swap["timestamp"].isoformat() if swap.get("timestamp") else None
        })

    return {
        "wallet": wallet.lower(),
        "totalSwaps": len(formatted_swaps),
        "days": days,
        "swaps": formatted_swaps
    }
