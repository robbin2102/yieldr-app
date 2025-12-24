"""
Spot wallet scanning endpoint.
Analyzes a wallet's token holdings on Base using Alchemy + DeFiLlama.
"""

from typing import Dict, Any
from fastapi import APIRouter, Depends, HTTPException, Query
from services.alchemy import alchemy_service
from core.utils import normalize_address
from api.dependencies import verify_api_key

router = APIRouter()


@router.get(
    "/scan/{wallet}",
    summary="Scan wallet token holdings",
    description="Get ERC-20 token holdings with USD values (auto-filtered for spam)"
)
async def scan_wallet(
    wallet: str,
    min_value: float = Query(default=10.0, description="Minimum USD value to include"),
    limit: int = Query(default=50, ge=1, le=100, description="Max tokens to return"),
    _api_key: str = Depends(verify_api_key)
) -> Dict[str, Any]:
    """
    Scan a wallet's spot token holdings on Base.

    **Spam Filtering:**
    - Automatically filters dust balances (balance <= 1)
    - Only includes tokens with DeFiLlama prices (real liquidity)
    - Filters out low-confidence prices (< 0.5)
    - Applies minimum USD value filter

    **Args:**
    - wallet: Ethereum wallet address
    - min_value: Minimum USD value to include (default: $10)
    - limit: Max tokens to return (default: 50, max: 100)

    **Returns:**
    ```json
    {
        "wallet": "0x...",
        "totalTokens": 5,
        "totalValueUSD": 1234.56,
        "tokens": [
            {
                "tokenAddress": "0x833...",
                "symbol": "USDC",
                "decimals": 6,
                "balance": 1000.0,
                "price_usd": 1.0,
                "value_usd": 1000.0
            }
        ]
    }
    ```
    """
    try:
        # Normalize wallet address
        wallet_normalized = normalize_address(wallet)
        print(f"🔍 Scanning wallet: {wallet_normalized}")

        # Get tokens with values from Alchemy + DeFiLlama
        # This automatically:
        # - Fetches all ERC-20 balances from Alchemy
        # - Filters out dust (balance <= 1)
        # - Gets prices from DeFiLlama (spam tokens won't have prices)
        # - Filters by confidence (>= 0.5)
        # - Applies min_value filter
        # - Sorts by value descending
        tokens = await alchemy_service.get_wallet_tokens_with_values(
            wallet=wallet_normalized,
            min_value_usd=min_value,
            limit=limit
        )

        # Calculate total value
        total_value_usd = sum(token["value_usd"] for token in tokens)

        print(f"✅ Scan complete: {len(tokens)} tokens, ${total_value_usd:.2f} total value")

        return {
            "wallet": wallet_normalized,
            "totalTokens": len(tokens),
            "totalValueUSD": round(total_value_usd, 2),
            "tokens": tokens
        }

    except Exception as e:
        print(f"❌ Error scanning wallet: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Failed to scan wallet: {str(e)}"
        )
