"""
DeFiLlama API client for token prices on Base.
Free tier: 500 requests/minute (no API key needed).
Auto-filters spam tokens - only returns prices for tokens with real liquidity.
"""

from typing import Dict, List, Optional
import httpx


class DeFiLlamaService:
    """Client for DeFiLlama Coins API."""

    def __init__(self):
        self.base_url = "https://coins.llama.fi"
        self.chain = "base"  # Hardcoded for Base chain
        self.timeout = 15.0

    async def get_token_prices(
        self,
        token_addresses: List[str]
    ) -> Dict[str, Dict[str, any]]:
        """
        Get current prices for multiple tokens on Base.

        Args:
            token_addresses: List of token contract addresses

        Returns:
            Dict mapping token address (lowercase) to:
              - price_usd: Current USD price
              - decimals: Token decimals
              - symbol: Token symbol
              - confidence: Price confidence (0-1)

        Example:
            {
                "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": {
                    "price_usd": 1.0,
                    "decimals": 6,
                    "symbol": "USDC",
                    "confidence": 0.99
                }
            }

        Note:
            - Automatically filters spam: tokens without real liquidity won't have prices
            - Returns empty dict for unrecognized tokens
            - Batch size: up to 100 tokens per request
        """
        if not token_addresses:
            return {}

        # Build coin identifiers: "base:0x..."
        coins = [f"{self.chain}:{addr.lower()}" for addr in token_addresses]

        # DeFiLlama supports up to 100 coins per request
        if len(coins) > 100:
            coins = coins[:100]

        # Join with comma for batch request
        coins_param = ",".join(coins)
        url = f"{self.base_url}/prices/current/{coins_param}"

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(url)
                response.raise_for_status()
                data = response.json()

                result = {}
                coins_data = data.get("coins", {})

                for coin_id, coin_info in coins_data.items():
                    # Extract address from "base:0x..." format
                    if ":" in coin_id:
                        address = coin_id.split(":", 1)[1].lower()
                    else:
                        continue

                    result[address] = {
                        "price_usd": float(coin_info.get("price", 0)),
                        "decimals": int(coin_info.get("decimals", 18)),
                        "symbol": coin_info.get("symbol", "UNKNOWN"),
                        "confidence": float(coin_info.get("confidence", 0))
                    }

                return result

        except httpx.HTTPError as e:
            print(f"⚠️  DeFiLlama API error: {e}")
            return {}
        except Exception as e:
            print(f"⚠️  Error fetching prices from DeFiLlama: {e}")
            return {}


# Singleton instance
defillama_service = DeFiLlamaService()
