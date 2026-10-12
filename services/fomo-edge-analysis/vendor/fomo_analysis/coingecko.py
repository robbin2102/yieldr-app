"""CoinGecko Onchain client and credit-aware request planning."""

from __future__ import annotations

import math
import time
from threading import Lock
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterable

import requests

from fomo_analysis.models import Candle


COINGECKO_NETWORKS = {"base": "base", "bnb": "bsc", "solana": "solana"}
# CoinGecko's credit plan and per-request address tier are independent. The
# current Pro-key account returns a hard 30-address limit, so 30 is the safe
# maximum across paid tiers unless explicit tier discovery is added later.
MAX_MULTI_TOKENS = 30
PUBLIC_MAX_MULTI_TOKENS = 30
MAX_OHLCV_CANDLES = 1000


class CoinGeckoError(RuntimeError):
    pass


@dataclass(frozen=True)
class CoinGeckoMetric:
    endpoint: str
    status_code: int
    elapsed_seconds: float
    credit_used: int


@dataclass(frozen=True)
class TokenRange:
    chain: str
    token_address: str
    start: datetime
    end: datetime


def estimate_ohlcv_calls(
    ranges: Iterable[TokenRange], interval_minutes: int = 5
) -> int:
    """Upper-bound calls assuming continuous candles and 1000 rows per response."""
    total = 0
    for item in ranges:
        intervals = max(1, math.ceil((item.end - item.start).total_seconds() / (interval_minutes * 60)))
        total += math.ceil(intervals / MAX_OHLCV_CANDLES)
    return total


def metadata_batch_count(addresses_by_chain: dict[str, list[str]]) -> int:
    return sum(
        math.ceil(len(addresses) / MAX_MULTI_TOKENS)
        for chain, addresses in addresses_by_chain.items()
        if chain in COINGECKO_NETWORKS and addresses
    )


class CoinGeckoOnchainClient:
    def __init__(
        self,
        api_key: str | None,
        plan: str = "demo",
        timeout: float = 30.0,
        min_interval_seconds: float = 0.0,
    ) -> None:
        if plan not in {"demo", "pro", "public"}:
            raise ValueError("CoinGecko plan must be demo, pro, or public")
        if plan in {"demo", "pro"} and not api_key:
            raise ValueError(f"CoinGecko {plan} mode requires an API key")
        self.plan = plan
        self.timeout = timeout
        self.min_interval_seconds = min_interval_seconds
        self._last_request_started_at: float | None = None
        self._rate_lock = Lock()
        self.metrics: list[CoinGeckoMetric] = []
        self.max_multi_tokens = MAX_MULTI_TOKENS
        if plan == "public":
            self.base_url = "https://api.geckoterminal.com/api/v2"
            self.headers: dict[str, str] = {}
        elif plan == "demo":
            self.base_url = "https://api.coingecko.com/api/v3/onchain"
            self.headers = {"x-cg-demo-api-key": api_key or ""}
        else:
            self.base_url = "https://pro-api.coingecko.com/api/v3/onchain"
            self.headers = {"x-cg-pro-api-key": api_key or ""}

    def all_networks(self, max_pages: int = 20) -> list[dict[str, Any]]:
        networks: list[dict[str, Any]] = []
        for page in range(1, max_pages + 1):
            body = self._get("networks", {"page": page})
            networks.extend(body.get("data", []))
            if not body.get("links", {}).get("next"):
                break
        return networks

    def simple_prices_by_network_id(
        self, network_id: str, addresses: Iterable[str]
    ) -> dict[str, Any]:
        values = list(dict.fromkeys(addresses))
        if not values:
            return {}
        return self._get(
            f"simple/networks/{network_id}/token_price/{','.join(values)}"
        )

    def token_ohlcv_by_network_id(
        self,
        network_id: str,
        chain: str,
        token_address: str,
        *,
        aggregate: int,
        limit: int,
        before_timestamp: int | None = None,
    ) -> list[Candle]:
        params: dict[str, Any] = {
            "aggregate": aggregate,
            "limit": limit,
            "currency": "usd",
            "include_empty_intervals": "false",
        }
        if before_timestamp is not None:
            params["before_timestamp"] = before_timestamp
        body = self._get(
            f"networks/{network_id}/tokens/{token_address}/ohlcv/minute", params,
        )
        rows = body.get("data", {}).get("attributes", {}).get("ohlcv_list", [])
        return [
            Candle(
                chain=chain,
                token_address=token_address,
                open_time=datetime.fromtimestamp(row[0], tz=timezone.utc),
                interval=f"{aggregate}m",
                open=Decimal(str(row[1])),
                high=Decimal(str(row[2])),
                low=Decimal(str(row[3])),
                close=Decimal(str(row[4])),
                sample_count=1,
                source="coingecko_onchain",
                quality="provider_native",
            )
            for row in rows
        ]

    def _get(self, endpoint: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        for attempt in range(5):
            with self._rate_lock:
                if (
                    self._last_request_started_at is not None
                    and self.min_interval_seconds
                ):
                    wait = self.min_interval_seconds - (
                        time.perf_counter() - self._last_request_started_at
                    )
                    if wait > 0:
                        time.sleep(wait)
                started = time.perf_counter()
                self._last_request_started_at = started
            try:
                response = requests.get(
                    f"{self.base_url}/{endpoint}", headers=self.headers,
                    params=params, timeout=self.timeout,
                )
            except requests.RequestException as exc:
                finished = time.perf_counter()
                self.metrics.append(CoinGeckoMetric(endpoint, 0, finished - started, 0))
                if attempt < 4:
                    time.sleep(2**attempt)
                    continue
                raise CoinGeckoError("CoinGecko Onchain request failed") from exc
            elapsed = time.perf_counter() - started
            credit = 1 if response.status_code == 200 and self.plan != "public" else 0
            self.metrics.append(CoinGeckoMetric(endpoint, response.status_code, elapsed, credit))
            try:
                body = response.json()
            except ValueError:
                body = {}
            if response.status_code == 429 and attempt < 4:
                retry_after = float(getattr(response, "headers", {}).get("Retry-After", 2**attempt))
                time.sleep(max(retry_after, 2**attempt))
                continue
            if response.status_code >= 400:
                detail = body.get("status", {}).get("error_message") or body.get("error") or "request rejected"
                raise CoinGeckoError(f"CoinGecko Onchain returned HTTP {response.status_code}: {detail}")
            return body
        raise CoinGeckoError("CoinGecko Onchain request exhausted retries")

    def tokens_multi(self, chain: str, addresses: Iterable[str]) -> list[dict[str, Any]]:
        network = COINGECKO_NETWORKS[chain]
        return self.tokens_multi_by_network_id(network, addresses)

    def tokens_multi_by_network_id(
        self, network_id: str, addresses: Iterable[str]
    ) -> list[dict[str, Any]]:
        return self.tokens_multi_response_by_network_id(network_id, addresses).get(
            "data", []
        )

    def tokens_multi_response_by_network_id(
        self, network_id: str, addresses: Iterable[str]
    ) -> dict[str, Any]:
        values = list(dict.fromkeys(addresses))
        if not values:
            return {"data": [], "included": []}
        if len(values) > self.max_multi_tokens:
            raise ValueError(
                "CoinGecko tokens/multi accepts at most "
                f"{self.max_multi_tokens} addresses for the {self.plan} plan"
            )
        return self._get(
            f"networks/{network_id}/tokens/multi/{','.join(values)}",
            {"include": "top_pools", "include_inactive_source": "true"},
        )

    def token_ohlcv_page(
        self,
        chain: str,
        token_address: str,
        before_timestamp: int,
        limit: int = MAX_OHLCV_CANDLES,
    ) -> list[Candle]:
        if limit < 1 or limit > MAX_OHLCV_CANDLES:
            raise ValueError("CoinGecko OHLCV limit must be between 1 and 1000")
        network = COINGECKO_NETWORKS[chain]
        body = self._get(
            f"networks/{network}/tokens/{token_address}/ohlcv/minute",
            {
                "aggregate": 5, "before_timestamp": before_timestamp,
                "limit": limit, "currency": "usd", "include_empty_intervals": "false",
            },
        )
        rows = body.get("data", {}).get("attributes", {}).get("ohlcv_list", [])
        return [
            Candle(
                chain=chain, token_address=token_address,
                open_time=datetime.fromtimestamp(row[0], tz=timezone.utc),
                interval="5m", open=Decimal(str(row[1])), high=Decimal(str(row[2])),
                low=Decimal(str(row[3])), close=Decimal(str(row[4])), sample_count=1,
                source="coingecko_onchain", quality="provider_native",
            )
            for row in rows
        ]
    def top_pools(self, chain: str, token_address: str) -> list[dict[str, Any]]:
        network = COINGECKO_NETWORKS[chain]
        return self.top_pools_by_network_id(network, token_address)

    def top_pools_by_network_id(
        self, network_id: str, token_address: str
    ) -> list[dict[str, Any]]:
        body = self._get(
            f"networks/{network_id}/tokens/{token_address}/pools", {"page": 1}
        )
        return body.get("data", [])

    def pool_ohlcv_page(
        self,
        chain: str,
        pool_address: str,
        token_address: str,
        before_timestamp: int,
        limit: int = MAX_OHLCV_CANDLES,
    ) -> list[Candle]:
        network = COINGECKO_NETWORKS[chain]
        return self.pool_ohlcv_by_network_id(
            network,
            chain,
            pool_address,
            token_address,
            aggregate=5,
            limit=limit,
            before_timestamp=before_timestamp,
        )

    def pool_ohlcv_by_network_id(
        self,
        network_id: str,
        chain: str,
        pool_address: str,
        token_address: str,
        *,
        aggregate: int,
        limit: int,
        before_timestamp: int | None = None,
        include_empty_intervals: bool = False,
    ) -> list[Candle]:
        if limit < 1 or limit > MAX_OHLCV_CANDLES:
            raise ValueError("CoinGecko OHLCV limit must be between 1 and 1000")
        params: dict[str, Any] = {
            "aggregate": aggregate,
            "limit": limit,
            "currency": "usd",
            "token": token_address,
            "include_empty_intervals": str(include_empty_intervals).lower(),
        }
        if before_timestamp is not None:
            params["before_timestamp"] = before_timestamp
        body = self._get(
            f"networks/{network_id}/pools/{pool_address}/ohlcv/minute", params,
        )
        rows = body.get("data", {}).get("attributes", {}).get("ohlcv_list", [])
        return [
            Candle(
                chain=chain,
                token_address=token_address,
                open_time=datetime.fromtimestamp(row[0], tz=timezone.utc),
                interval=f"{aggregate}m",
                open=Decimal(str(row[1])),
                high=Decimal(str(row[2])),
                low=Decimal(str(row[3])),
                close=Decimal(str(row[4])),
                sample_count=1,
                source="geckoterminal_pool",
                quality="provider_native",
            )
            for row in rows
        ]


def discover_network(
    networks: Iterable[dict[str, Any]], aliases: Iterable[str]
) -> dict[str, str] | None:
    wanted = {value.strip().lower() for value in aliases}
    fallback = None
    for network in networks:
        attributes = network.get("attributes", {})
        values = {
            str(network.get("id", "")).lower(),
            str(attributes.get("name", "")).lower(),
            str(attributes.get("coingecko_asset_platform_id", "")).lower(),
        }
        match = {
            "id": str(network.get("id")),
            "name": str(attributes.get("name")),
            "asset_platform_id": str(
                attributes.get("coingecko_asset_platform_id") or ""
            ),
        }
        if wanted & values:
            return match
        if fallback is None and any(
            alias in value for alias in wanted for value in values
        ):
            fallback = match
    return fallback


def select_best_pool_for_token(
    pools: Iterable[dict[str, Any]], network_id: str, token_address: str
) -> dict[str, str] | None:
    """Select the highest-liquidity pool and identify the token's pool side."""
    token_id = f"{network_id}_{token_address}".lower()
    candidates: list[tuple[Decimal, dict[str, str]]] = []
    for pool in pools:
        relationships = pool.get("relationships", {})
        base_id = str(relationships.get("base_token", {}).get("data", {}).get("id", "")).lower()
        quote_id = str(relationships.get("quote_token", {}).get("data", {}).get("id", "")).lower()
        if token_id == base_id:
            side = "base"
        elif token_id == quote_id:
            side = "quote"
        else:
            continue
        attributes = pool.get("attributes", {})
        pool_address = str(attributes.get("address") or "")
        if not pool_address:
            prefix = f"{network_id}_"
            pool_id = str(pool.get("id", ""))
            pool_address = pool_id[len(prefix):] if pool_id.startswith(prefix) else pool_id
        try:
            liquidity = Decimal(str(attributes.get("reserve_in_usd") or 0))
        except ArithmeticError:
            liquidity = Decimal(0)
        candidates.append(
            (
                liquidity,
                {
                    "pool_address": pool_address,
                    "pool_name": str(attributes.get("name") or ""),
                    "token_side": side,
                    "reserve_in_usd": str(attributes.get("reserve_in_usd") or "0"),
                },
            )
        )
    return max(candidates, key=lambda item: item[0])[1] if candidates else None
