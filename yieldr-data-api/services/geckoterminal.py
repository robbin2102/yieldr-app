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

    async def get_trending_pools(
        self,
        chain: str = "base",
        page: int = 1,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get trending pools on specified network.

        Args:
            chain: Network name (base, ethereum, etc.)
            page: Page number (default: 1)
            limit: Max pools to return (default: 100)

        Returns:
            List of pool objects with complete data structure

        API: https://api.geckoterminal.com/api/v2/networks/{network}/trending_pools
        """
        url = f"{self.base_url}/networks/{chain}/trending_pools"
        params = {"page": page}

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()

            # Return full pool data (will be parsed in the job)
            pools = data.get("data", [])[:limit]
            return pools


# Singleton instance
geckoterminal_client = GeckoTerminalClient()
