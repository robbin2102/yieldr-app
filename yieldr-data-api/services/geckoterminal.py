"""
GeckoTerminal API client for token prices and trending pools on Base.
Provides token price lookups and trending pool discovery.
"""

from typing import Dict, Any, List
import httpx


class GeckoTerminalClient:
    """Client for GeckoTerminal API (Base network)."""

    def __init__(self):
        self.base_url = "https://api.geckoterminal.com/api/v2"
        self.network = "base"

    async def get_token_prices_batch(
        self,
        token_addresses: List[str]
    ) -> Dict[str, Dict[str, Any]]:
        """
        Get current prices for multiple tokens on Base.

        Args:
            token_addresses: List of token contract addresses (up to 30 per request)

        Returns:
            Dict mapping token address (lowercase) to:
              - price_usd: Current USD price
              - price_change_24h: 24h price change percentage (if available)

        Example:
            {
                "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": {
                    "price_usd": 1.0,
                    "price_change_24h": 0.01
                }
            }
        """
        if not token_addresses:
            return {}

        # GeckoTerminal supports up to 30 addresses per request
        addresses = ",".join([addr.lower() for addr in token_addresses[:30]])
        url = f"{self.base_url}/simple/networks/{self.network}/token_price/{addresses}"

        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=15.0)
            response.raise_for_status()
            data = response.json()

            result = {}
            for addr, price_data in data.get("data", {}).get("attributes", {}).get("token_prices", {}).items():
                # price_data is just a string like "1.0" or null
                if price_data:
                    result[addr.lower()] = {
                        "price_usd": float(price_data),
                        "price_change_24h": 0.0  # Not available in simple price endpoint
                    }

            return result

    async def get_trending_pools(self, limit: int = 20) -> List[Dict[str, Any]]:
        """
        Get trending pools on Base network.

        Args:
            limit: Number of pools to return (max 100)

        Returns:
            List of pool objects with token addresses and metadata

        Note:
            Used in Part 2 for discovering trending tokens
        """
        url = f"{self.base_url}/networks/{self.network}/trending_pools"
        params = {"page": 1}

        async with httpx.AsyncClient() as client:
            response = await client.get(url, params=params, timeout=15.0)
            response.raise_for_status()
            data = response.json()

            pools = []
            for item in data.get("data", [])[:limit]:
                attrs = item.get("attributes", {})
                pools.append({
                    "pool_address": attrs.get("address"),
                    "name": attrs.get("name"),
                    "base_token_address": attrs.get("base_token_price_usd"),  # Will be corrected in Part 2
                    "volume_24h": float(attrs.get("volume_usd", {}).get("h24", 0)),
                    "price_change_24h": float(attrs.get("price_change_percentage", {}).get("h24", 0))
                })

            return pools
