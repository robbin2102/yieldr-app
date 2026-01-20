"""
Trending Tokens API Endpoints

GET /api/v1/trending/tokens - Get current trending tokens on Base
"""

from typing import Dict, Any, List, Optional
from fastapi import APIRouter, Depends, Query
from motor.motor_asyncio import AsyncIOMotorDatabase
from api.dependencies import verify_api_key
from db.mongodb import get_database

router = APIRouter()


@router.get("/tokens")
async def get_trending_tokens(
    limit: int = Query(default=100, ge=1, le=100, description="Max tokens to return"),
    min_volume: float = Query(default=0, ge=0, description="Minimum 24h volume in USD"),
    _api_key: str = Depends(verify_api_key)
) -> Dict[str, Any]:
    """
    Get current trending tokens on Base.

    Returns tokens sorted by rank (from GeckoTerminal trending pools).

    Args:
        limit: Maximum number of tokens to return (1-100)
        min_volume: Minimum 24h volume in USD (optional filter)

    Returns:
        {
            "chain": "base",
            "totalTokens": 100,
            "tokens": [
                {
                    "tokenAddress": "0x...",
                    "symbol": "TOKEN",
                    "name": "Token Name",
                    "priceUSD": 1.23,
                    "volume24hUSD": 1000000,
                    "priceChange24hPct": 15.5,
                    "poolAddress": "0x...",
                    "dex": "aerodrome",
                    "rank": 1,
                    "traderCount": 18,
                    "indexedAt": "2025-12-24T10:00:00Z"
                },
                ...
            ]
        }
    """
    db = get_database()

    # Build query filter
    query_filter = {}
    if min_volume > 0:
        query_filter["volume_24h_usd"] = {"$gte": min_volume}

    # Fetch tokens from MongoDB
    tokens = await db.trending_tokens.find(
        query_filter
    ).sort("rank", 1).limit(limit).to_list(limit)

    # Format response
    formatted_tokens = []
    for token in tokens:
        formatted_tokens.append({
            "tokenAddress": token["token_address"],
            "symbol": token["symbol"],
            "name": token["name"],
            "priceUSD": token.get("price_usd"),
            "volume24hUSD": token["volume_24h_usd"],
            "priceChange24hPct": token["price_change_24h_pct"],
            "poolAddress": token["pool_address"],
            "dex": token["dex"],
            "rank": token["rank"],
            "traderCount": token.get("trader_count", 0),
            "indexedAt": token["indexed_at"].isoformat() if token.get("indexed_at") else None
        })

    return {
        "chain": "base",
        "totalTokens": len(formatted_tokens),
        "tokens": formatted_tokens
    }


@router.get("/tokens/{token_address}")
async def get_token_details(
    token_address: str,
    _api_key: str = Depends(verify_api_key)
) -> Dict[str, Any]:
    """
    Get details for a specific trending token.

    Args:
        token_address: Token contract address

    Returns:
        Token details including trader count and stats
    """
    db = get_database()

    token = await db.trending_tokens.find_one({
        "token_address": token_address.lower()
    })

    if not token:
        return {"error": "Token not found"}

    return {
        "tokenAddress": token["token_address"],
        "symbol": token["symbol"],
        "name": token["name"],
        "chain": token["chain"],
        "priceUSD": token.get("price_usd"),
        "volume24hUSD": token["volume_24h_usd"],
        "priceChange24hPct": token["price_change_24h_pct"],
        "poolAddress": token["pool_address"],
        "dex": token["dex"],
        "rank": token["rank"],
        "traderCount": token.get("trader_count", 0),
        "indexedAt": token["indexed_at"].isoformat() if token.get("indexed_at") else None
    }
