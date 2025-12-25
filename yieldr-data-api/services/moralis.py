"""
Moralis API client for wallet profitability and top trader discovery.
Provides token profitability analysis and trending wallet detection.
"""

from typing import Dict, Any, List, Optional
import httpx
from config import get_settings

settings = get_settings()


class MoralisClient:
    """Client for Moralis Deep Index API."""

    def __init__(self):
        self.base_url = settings.moralis_base_url
        self.api_key = settings.moralis_api_key
        self.headers = {
            "accept": "application/json",
            "X-API-Key": self.api_key
        }
        self.chain = "base"

    async def get_wallet_profitability(
        self,
        wallet_address: str,
        token_address: str
    ) -> Dict[str, Any]:
        """
        Get profitability data for a specific wallet's trades on a token.

        Args:
            wallet_address: The trader's wallet address
            token_address: The token contract address

        Returns:
            Dict containing:
              - avg_buy_price_usd: Average buy price
              - avg_sell_price_usd: Average sell price
              - realized_profit_usd: Total realized profit in USD
              - realized_profit_percentage: Realized profit percentage
              - total_usd_invested: Total amount invested
              - count_of_trades: Number of trades

        Raises:
            httpx.HTTPError: If the API request fails
        """
        url = f"{self.base_url}/wallets/{wallet_address}/profitability"
        params = {
            "chain": self.chain,
            "token_address": token_address
        }

        async with httpx.AsyncClient() as client:
            response = await client.get(
                url,
                params=params,
                headers=self.headers,
                timeout=20.0
            )
            response.raise_for_status()
            data = response.json()

            # Extract profitability data using exact field names
            result = data.get("result", {})
            return {
                "avg_buy_price_usd": float(result.get("avg_buy_price_usd", 0) or 0),
                "avg_sell_price_usd": float(result.get("avg_sell_price_usd", 0) or 0),
                "realized_profit_usd": float(result.get("realized_profit_usd", 0) or 0),
                "realized_profit_percentage": float(result.get("realized_profit_percentage", 0) or 0),
                "total_usd_invested": float(result.get("total_usd_invested", 0) or 0),
                "count_of_trades": int(result.get("count_of_trades", 0) or 0)
            }

    # Note: get_top_profitable_wallets endpoint removed
    # Moralis /erc20/{token}/top-profitable-wallets only works on Ethereum mainnet, not Base
    # Returns 404 on Base chain - use only whale holders discovery instead

    async def get_top_token_holders(
        self,
        token_address: str,
        limit: int = 20
    ) -> List[Dict[str, Any]]:
        """
        Get top token holders (whales) for a specific token.

        Args:
            token_address: The token contract address
            limit: Number of holders to return (default: 20, max: 100)

        Returns:
            List of holder objects with:
              - wallet_address
              - balance (token amount)
              - balance_formatted (human-readable)
              - usd_value
              - percentage_relative_to_total_supply

        API: https://docs.moralis.com/web3-data-api/evm/reference/get-token-holders
        """
        url = f"{self.base_url}/erc20/{token_address}/owners"
        params = {
            "chain": self.chain,
            "order": "DESC",  # Descending order by balance
            "limit": limit
        }

        async with httpx.AsyncClient() as client:
            response = await client.get(
                url,
                params=params,
                headers=self.headers,
                timeout=30.0
            )
            response.raise_for_status()
            data = response.json()

            holders = []
            for item in data.get("result", []):
                holders.append({
                    "wallet_address": item.get("owner_address", "").lower(),
                    "balance": item.get("balance", "0"),
                    "balance_formatted": item.get("balance_formatted", "0"),
                    "usd_value": float(item.get("usd_value", 0) or 0),
                    "percentage_relative_to_total_supply": float(
                        item.get("percentage_relative_to_total_supply", 0) or 0
                    )
                })

            return holders


# Singleton instance
moralis_client = MoralisClient()
