"""
Spot wallet scanning endpoint.
Analyzes a wallet's token holdings and profitability on Base.
"""

from typing import Dict, Any, List
from fastapi import APIRouter, Depends, HTTPException
from services.quicknode import QuickNodeClient
from services.geckoterminal import GeckoTerminalClient
from services.moralis import MoralisClient
from core.utils import safe_float, normalize_address
from api.dependencies import verify_api_key

router = APIRouter()


@router.get(
    "/scan/{wallet}",
    summary="Scan wallet token holdings",
    description="Get all ERC-20 token holdings with current prices and profitability metrics"
)
async def scan_wallet(
    wallet: str,
    _api_key: str = Depends(verify_api_key)
) -> Dict[str, Any]:
    """
    Scan a wallet's spot token holdings on Base.

    Returns:
        - wallet: Wallet address (normalized)
        - totalTokens: Number of tokens held
        - totalValueUSD: Total portfolio value in USD
        - tokens: List of token holdings with profitability data

    Each token includes:
        - address: Token contract address
        - symbol: Token symbol
        - balance: Raw balance
        - decimals: Token decimals
        - balanceFormatted: Human-readable balance
        - priceUSD: Current USD price
        - valueUSD: Total value (balance * price)
        - profitability: Moralis profitability metrics (if available)
    """
    try:
        # Normalize wallet address
        wallet_normalized = normalize_address(wallet)

        # Initialize service clients
        quicknode = QuickNodeClient()
        geckoterminal = GeckoTerminalClient()
        moralis = MoralisClient()

        # Step 1: Get all token balances from QuickNode
        print(f"🔍 Scanning wallet: {wallet_normalized}")
        balance_data = await quicknode.qn_getWalletTokenBalance(wallet_normalized)

        assets = balance_data.get("assets", [])
        if not assets:
            return {
                "wallet": wallet_normalized,
                "totalTokens": 0,
                "totalValueUSD": 0.0,
                "tokens": []
            }

        # Filter tokens with balance > 0
        tokens_with_balance = [
            asset for asset in assets
            if safe_float(asset.get("amount", 0)) > 0
        ]

        print(f"📊 Found {len(tokens_with_balance)} tokens with balance > 0")

        if not tokens_with_balance:
            return {
                "wallet": wallet_normalized,
                "totalTokens": 0,
                "totalValueUSD": 0.0,
                "tokens": []
            }

        # Step 2: Get current prices from GeckoTerminal
        token_addresses = [asset.get("address") for asset in tokens_with_balance]
        prices = await geckoterminal.get_token_prices_batch(token_addresses)

        # Step 3: Build enriched token list
        tokens = []
        total_value_usd = 0.0

        for asset in tokens_with_balance:
            token_address = normalize_address(asset.get("address", ""))
            symbol = asset.get("symbol", "UNKNOWN")
            decimals = int(asset.get("decimals", 18))
            balance_raw = safe_float(asset.get("amount", 0))

            # Calculate formatted balance
            balance_formatted = balance_raw / (10 ** decimals)

            # Get price data
            price_data = prices.get(token_address, {})
            price_usd = safe_float(price_data.get("price_usd", 0))
            value_usd = balance_formatted * price_usd

            # Step 4: Get profitability data from Moralis (if price is available)
            profitability = None
            if price_usd > 0:
                try:
                    profitability = await moralis.get_wallet_profitability(
                        wallet_normalized,
                        token_address
                    )
                except Exception as e:
                    print(f"⚠️  Failed to get profitability for {symbol}: {e}")
                    # Continue without profitability data

            tokens.append({
                "address": token_address,
                "symbol": symbol,
                "balance": balance_raw,
                "decimals": decimals,
                "balanceFormatted": balance_formatted,
                "priceUSD": price_usd,
                "valueUSD": value_usd,
                "profitability": profitability
            })

            total_value_usd += value_usd

        # Sort tokens by value (highest first)
        tokens.sort(key=lambda x: x["valueUSD"], reverse=True)

        print(f"✅ Scan complete: {len(tokens)} tokens, ${total_value_usd:.2f} total value")

        return {
            "wallet": wallet_normalized,
            "totalTokens": len(tokens),
            "totalValueUSD": total_value_usd,
            "tokens": tokens
        }

    except ValueError as e:
        # Handle QuickNode API errors
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"❌ Error scanning wallet: {e}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")
