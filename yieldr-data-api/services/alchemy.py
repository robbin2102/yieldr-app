"""
Alchemy API client for token balances on Base.
Free tier: 300M compute units/month.
alchemy_getTokenBalances = 20 CUs per call.
"""

from typing import Dict, List, Any
import httpx
from config import get_settings
from services.defillama import defillama_service

settings = get_settings()


class AlchemyService:
    """Client for Alchemy API on Base."""

    def __init__(self):
        self.endpoint = settings.alchemy_base_url
        self.timeout = 30.0

    async def _rpc_call(self, method: str, params: List[Any]) -> Dict:
        """Make JSON-RPC call to Alchemy."""
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                self.endpoint,
                json=payload,
                headers={"Content-Type": "application/json"}
            )
            response.raise_for_status()
            data = response.json()

            if "error" in data:
                raise Exception(f"Alchemy Error: {data['error']}")

            return data.get("result", {})

    async def get_wallet_token_balances(self, wallet: str) -> List[Dict]:
        """
        Get ALL ERC-20 token balances for a wallet.

        Cost: 20 CUs per call

        Args:
            wallet: Wallet address

        Returns:
            List of {contractAddress, tokenBalance (hex)}
        """
        result = await self._rpc_call(
            "alchemy_getTokenBalances",
            [wallet, "erc20"]
        )
        return result.get("tokenBalances", [])

    async def get_wallet_tokens_with_values(
        self,
        wallet: str,
        min_value_usd: float = 10.0,
        limit: int = 50
    ) -> List[Dict]:
        """
        Get wallet tokens with USD values, filtered and sorted.

        Spam tokens auto-filtered: DeFiLlama only returns prices
        for tokens with real trading activity/liquidity.

        Args:
            wallet: Wallet address
            min_value_usd: Minimum USD value to include
            limit: Max tokens to return

        Returns:
            List of tokens sorted by value descending
        """
        # Step 1: Get all balances from Alchemy
        balances = await self.get_wallet_token_balances(wallet)

        if not balances:
            return []

        # Step 2: Filter out dust (balance <= 1 often = NFT airdrop spam)
        valid_tokens = []
        for token in balances:
            address = token["contractAddress"].lower()
            balance_hex = token["tokenBalance"]
            balance_raw = int(balance_hex, 16)

            # Skip zero and dust
            if balance_raw <= 1:
                continue

            valid_tokens.append({
                "address": address,
                "balance_raw": balance_raw
            })

        if not valid_tokens:
            return []

        # Step 3: Get prices from DeFiLlama (auto-filters spam!)
        addresses = [t["address"] for t in valid_tokens]
        prices = await defillama_service.get_token_prices(addresses)

        # Step 4: Calculate values, filter by min_value
        result = []
        for token in valid_tokens:
            address = token["address"]
            balance_raw = token["balance_raw"]

            price_info = prices.get(address)

            # No price = spam token (DeFiLlama doesn't track it)
            if not price_info or price_info.get("price_usd", 0) == 0:
                continue

            # Low confidence = possibly manipulated
            if price_info.get("confidence", 0) < 0.5:
                continue

            decimals = price_info.get("decimals", 18)
            price_usd = price_info.get("price_usd", 0)
            symbol = price_info.get("symbol", "UNKNOWN")

            # Calculate actual balance
            balance = balance_raw / (10 ** decimals)
            value_usd = balance * price_usd

            # Filter by minimum value
            if value_usd < min_value_usd:
                continue

            result.append({
                "tokenAddress": address,
                "symbol": symbol,
                "decimals": decimals,
                "balance": round(balance, 6),
                "price_usd": round(price_usd, 8),
                "value_usd": round(value_usd, 2),
            })

        # Sort by value descending
        result.sort(key=lambda x: x["value_usd"], reverse=True)

        return result[:limit]


# Singleton instance
alchemy_service = AlchemyService()
