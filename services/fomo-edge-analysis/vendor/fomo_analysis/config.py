"""Secret-safe analytics configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class AnalyticsConfig:
    mongodb_uri: str | None
    mongodb_database: str
    alchemy_api_key: str
    coingecko_api_key: str | None
    coingecko_api_plan: str
    fomoscan_api_key: str | None


def api_key_from_rpc_url(rpc_url: str) -> str:
    """Extract the shared Alchemy key without ever logging the full RPC URL."""
    path = urlparse(rpc_url).path.rstrip("/")
    if "/v2/" not in path:
        raise RuntimeError("Alchemy RPC URL does not contain a /v2/ API key path")
    api_key = path.rsplit("/", 1)[-1]
    if not api_key:
        raise RuntimeError("Alchemy RPC URL has an empty API key")
    return api_key


def load_analytics_config(require_mongodb: bool = False) -> AnalyticsConfig:
    load_dotenv(PROJECT_ROOT / ".env")
    rpc_url = os.getenv("ALCHEMY_BASE_RPC_URL", "")
    if not rpc_url:
        raise RuntimeError("Missing required environment variable: ALCHEMY_BASE_RPC_URL")
    mongodb_uri = os.getenv("MONGODB_URI")
    if require_mongodb and not mongodb_uri:
        raise RuntimeError("Missing required environment variable: MONGODB_URI")
    return AnalyticsConfig(
        mongodb_uri=mongodb_uri,
        mongodb_database=os.getenv("MONGODB_DATABASE", "yieldr"),
        alchemy_api_key=api_key_from_rpc_url(rpc_url),
        coingecko_api_key=os.getenv("COINGECKO_API_KEY"),
        coingecko_api_plan=os.getenv("COINGECKO_API_PLAN", "demo").lower(),
        fomoscan_api_key=os.getenv("FOMOSCAN_API_KEY"),
    )
