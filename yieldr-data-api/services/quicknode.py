"""
QuickNode API client for Base blockchain interactions.
Used in Part 2 for eth_getLogs (event indexing).
"""

from typing import Dict, Any, List
import httpx
from config import get_settings

settings = get_settings()


class QuickNodeClient:
    """Client for QuickNode Base RPC."""

    def __init__(self):
        self.endpoint = settings.quicknode_endpoint
        self.headers = {"Content-Type": "application/json"}
        self.timeout = 30.0

    async def _rpc_call(self, method: str, params: List[Any]) -> Any:
        """
        Make a JSON-RPC call to QuickNode.

        Args:
            method: RPC method name
            params: Method parameters

        Returns:
            Result from RPC call

        Raises:
            ValueError: If QuickNode returns an error
            httpx.HTTPError: If the request fails
        """
        if not self.endpoint:
            raise ValueError("QuickNode endpoint not configured. Set QUICKNODE_BASE_RPC_URL in .env.local")

        payload = {
            "id": 1,
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                self.endpoint,
                json=payload,
                headers=self.headers
            )
            response.raise_for_status()
            data = response.json()

            # Handle QuickNode error responses
            if "error" in data:
                raise ValueError(f"QuickNode API error: {data['error']}")

            return data.get("result")

    # Part 2: Event indexing methods will be added here
    # async def eth_getLogs(...) -> List[Dict]:
    #     """Get event logs for token swaps."""
    #     pass
