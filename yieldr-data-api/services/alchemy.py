"""
Alchemy API client for token balances (multi-chain).
Free tier: 300M compute units/month.
alchemy_getTokenBalances = 20 CUs, eth_getBalance = ~10 CUs.
"""

from enum import Enum
from typing import Dict, List, Any
import httpx
from config import get_settings
from services.defillama import defillama_service

settings = get_settings()


class Chain(str, Enum):
    """Supported blockchain networks."""
    BASE = "base"
    ETHEREUM = "ethereum"


# Chain-specific configuration
CHAIN_CONFIG = {
    Chain.BASE: {
        "defillama_prefix": "base",
        "native_symbol": "ETH",
        "weth_address": "0x4200000000000000000000000000000000000006",  # Wrapped ETH on Base
    },
    Chain.ETHEREUM: {
        "defillama_prefix": "ethereum",
        "native_symbol": "ETH",
        "weth_address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",  # WETH on Mainnet
    },
}


class AlchemyService:
    """Client for Alchemy API (multi-chain support)."""

    def __init__(self):
        self.timeout = 30.0

    def _get_endpoint(self, chain: Chain) -> str:
        """Get Alchemy endpoint URL for the specified chain."""
        if chain == Chain.BASE:
            return settings.alchemy_base_url
        elif chain == Chain.ETHEREUM:
            # If ETH URL is set, use it; otherwise derive from Base URL
            if settings.alchemy_eth_url:
                return settings.alchemy_eth_url
            else:
                # Derive from Base URL by replacing 'base-mainnet' with 'eth-mainnet'
                return settings.alchemy_base_url.replace("base-mainnet", "eth-mainnet")
        else:
            raise ValueError(f"Unsupported chain: {chain}")

    async def _rpc_call(self, chain: Chain, method: str, params: List[Any]) -> Any:
        """Make JSON-RPC call to Alchemy."""
        endpoint = self._get_endpoint(chain)
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                endpoint,
                json=payload,
                headers={"Content-Type": "application/json"}
            )
            response.raise_for_status()
            data = response.json()

            if "error" in data:
                raise Exception(f"Alchemy Error: {data['error']}")

            return data.get("result")

    async def get_native_balance(self, wallet: str, chain: Chain = Chain.BASE) -> Dict:
        """
        Get native ETH balance with USD value.

        Cost: ~10 CUs per call

        Args:
            wallet: Wallet address
            chain: Blockchain to query (BASE or ETHEREUM)

        Returns:
            Dict with balance, price, and value info
        """
        config = CHAIN_CONFIG[chain]

        # Get balance in wei
        result = await self._rpc_call(chain, "eth_getBalance", [wallet, "latest"])
        balance_wei = int(result, 16)
        balance = balance_wei / 10**18

        # Get ETH price via WETH address
        weth = config["weth_address"]
        prices = await defillama_service.get_token_prices(
            [weth],
            chain=config["defillama_prefix"]
        )
        price_usd = prices.get(weth, {}).get("price_usd", 0)

        return {
            "tokenAddress": "native",
            "symbol": config["native_symbol"],
            "decimals": 18,
            "balance": round(balance, 8),
            "price_usd": round(price_usd, 2),
            "value_usd": round(balance * price_usd, 2),
            "is_native": True
        }

    async def get_wallet_token_balances(self, wallet: str, chain: Chain = Chain.BASE) -> List[Dict]:
        """
        Get ALL ERC-20 token balances for a wallet.

        Cost: 20 CUs per call

        Args:
            wallet: Wallet address
            chain: Blockchain to query (BASE or ETHEREUM)

        Returns:
            List of {contractAddress, tokenBalance (hex)}
        """
        result = await self._rpc_call(
            chain,
            "alchemy_getTokenBalances",
            [wallet, "erc20"]
        )
        return result.get("tokenBalances", []) if isinstance(result, dict) else []

    async def get_wallet_tokens_with_values(
        self,
        wallet: str,
        chain: Chain = Chain.BASE,
        min_value_usd: float = 0.1,
        include_native: bool = True,
        limit: int = 50
    ) -> List[Dict]:
        """
        Get all tokens + native balance with USD values, filtered and sorted.

        Spam tokens auto-filtered: DeFiLlama only returns prices
        for tokens with real trading activity/liquidity.

        Args:
            wallet: Wallet address
            chain: Blockchain to query (BASE or ETHEREUM)
            min_value_usd: Minimum USD value to include (default: $0.10)
            include_native: Include native ETH balance (default: True)
            limit: Max tokens to return

        Returns:
            List of tokens sorted by value descending
        """
        config = CHAIN_CONFIG[chain]
        tokens = []

        # Step 1: Get native balance (ETH)
        if include_native:
            try:
                native = await self.get_native_balance(wallet, chain)
                if native["value_usd"] >= min_value_usd:
                    tokens.append(native)
            except Exception as e:
                print(f"⚠️  Failed to get native balance: {e}")

        # Step 2: Get all ERC-20 balances from Alchemy
        balances = await self.get_wallet_token_balances(wallet, chain)

        if not balances:
            # Sort and return (might just have native ETH)
            tokens.sort(key=lambda x: x["value_usd"], reverse=True)
            return tokens[:limit]

        # Step 3: Filter out dust (balance <= 1 often = NFT airdrop spam)
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
            # Sort and return (might just have native ETH)
            tokens.sort(key=lambda x: x["value_usd"], reverse=True)
            return tokens[:limit]

        # Step 4: Get prices from DeFiLlama (auto-filters spam!)
        addresses = [t["address"] for t in valid_tokens]
        prices = await defillama_service.get_token_prices(
            addresses,
            chain=config["defillama_prefix"]
        )

        # Step 5: Calculate values, filter by min_value
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

            tokens.append({
                "tokenAddress": address,
                "symbol": symbol,
                "decimals": decimals,
                "balance": round(balance, 6),
                "price_usd": round(price_usd, 8),
                "value_usd": round(value_usd, 2),
                "is_native": False
            })

        # Sort by value descending
        tokens.sort(key=lambda x: x["value_usd"], reverse=True)

        return tokens[:limit]


# Singleton instance
alchemy_service = AlchemyService()
