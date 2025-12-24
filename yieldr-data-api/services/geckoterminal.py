"""
GeckoTerminal API client for trending pools on Base.
Used in Part 2 for discovering trending tokens.
"""

from typing import Dict, Any, List
import httpx


class GeckoTerminalClient:
    """Client for GeckoTerminal API (Base network)."""

    def __init__(self):
        self.base_url = "https://api.geckoterminal.com/api/v2"
        self.network = "base"
        self.timeout = 15.0

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

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(url, params=params)
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


# Singleton instance
geckoterminal_service = GeckoTerminalClient()
