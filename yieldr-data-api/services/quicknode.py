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

    async def get_block_number(self) -> int:
        """
        Get the latest block number on Base.

        Returns:
            Current block number (integer)

        Cost: ~10 credits
        """
        result = await self._rpc_call("eth_blockNumber", [])
        return int(result, 16)

    async def get_transfer_logs(
        self,
        token_address: str,
        from_block: str,
        to_block: str = "latest"
    ) -> List[Dict[str, Any]]:
        """
        Get ERC-20 Transfer events for a specific token.

        This is used to detect swaps by monitoring token transfers.
        Query by TOKEN (not wallet) to minimize API credits.

        Args:
            token_address: Token contract address (checksummed or lowercase)
            from_block: Starting block (hex string like "0x1a2b3c")
            to_block: Ending block (hex string or "latest")

        Returns:
            List of log objects:
              - address: Token address
              - topics: [Transfer signature, from, to]
              - data: Amount (hex)
              - blockNumber: Block number (hex)
              - transactionHash: Tx hash
              - logIndex: Log index (hex)

        Cost: ~50 credits per call

        API: eth_getLogs
        """
        # ERC-20 Transfer event signature
        TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

        logs = await self._rpc_call("eth_getLogs", [{
            "fromBlock": from_block,
            "toBlock": to_block,
            "address": token_address,
            "topics": [TRANSFER_TOPIC]
        }])

        return logs or []


# Singleton instance
quicknode_client = QuickNodeClient()
