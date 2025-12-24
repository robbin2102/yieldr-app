"""
QuickNode API client for Base blockchain interactions.
Uses Token API v2 for wallet token balance queries.
"""

from typing import Dict, Any, List, Optional
import httpx
from config import get_settings

settings = get_settings()


class QuickNodeClient:
    """Client for QuickNode Base RPC with Token API v2 support."""

    def __init__(self):
        self.endpoint = settings.quicknode_endpoint
        self.headers = {"Content-Type": "application/json"}

    async def qn_getWalletTokenBalance(
        self,
        wallet: str,
        contracts: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Get ERC-20 token balances for a wallet using QuickNode Token API v2.

        Args:
            wallet: Wallet address (checksum format recommended)
            contracts: Optional list of token contract addresses to filter

        Returns:
            Dict with 'result' containing:
              - owner: wallet address
              - totalItems: number of tokens
              - assets: list of token balance objects
              - pageKey: pagination key (if any)

        Raises:
            httpx.HTTPError: If the API request fails
        """
        payload = {
            "id": 1,
            "jsonrpc": "2.0",
            "method": "qn_getWalletTokenBalance",
            "params": {
                "wallet": wallet,
                "contracts": contracts or []
            }
        }

        async with httpx.AsyncClient() as client:
            response = await client.post(
                self.endpoint,
                json=payload,
                headers=self.headers,
                timeout=30.0
            )
            response.raise_for_status()
            data = response.json()

            # Handle QuickNode error responses
            if "error" in data:
                raise ValueError(f"QuickNode API error: {data['error']}")

            return data.get("result", {})
