"""Minimal, secret-safe JSON-RPC helpers."""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = PROJECT_ROOT / "output"


@dataclass(frozen=True)
class ChainConfig:
    name: str
    rpc_url: str


def load_config() -> tuple[dict[str, ChainConfig], str]:
    """Load both RPC endpoints and the target wallet without logging secrets."""
    load_dotenv(PROJECT_ROOT / ".env")
    variable_names = {
        "base": "ALCHEMY_BASE_RPC_URL",
        "robinhood": "ALCHEMY_HOOD_RPC_URL",
        "bnb": "ALCHEMY_BNB_RPC_URL",
    }
    missing = [name for name in variable_names.values() if not os.getenv(name)]
    target_wallet = os.getenv("TARGET_WALLET", "")
    if not target_wallet:
        missing.append("TARGET_WALLET")
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")

    chains = {
        name: ChainConfig(name=name, rpc_url=os.environ[variable])
        for name, variable in variable_names.items()
    }
    return chains, target_wallet.lower()


def load_solana_config() -> tuple[ChainConfig, str]:
    """Load the Solana endpoint and mapped wallet without logging the endpoint."""
    load_dotenv(PROJECT_ROOT / ".env")
    rpc_url = os.getenv("ALCHEMY_SOLANA_RPC_URL", "")
    wallet = os.getenv("TARGET_SOLANA_WALLET", "")
    missing = []
    if not rpc_url:
        missing.append("ALCHEMY_SOLANA_RPC_URL")
    if not wallet:
        missing.append("TARGET_SOLANA_WALLET")
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")
    return ChainConfig(name="solana", rpc_url=rpc_url), wallet


class RpcClient:
    def __init__(self, config: ChainConfig, timeout: float = 30.0) -> None:
        self.name = config.name
        self._rpc_url = config.rpc_url
        self._timeout = timeout
        self._next_id = 1
        self.request_count = 0
        self.elapsed_seconds = 0.0

    def call(self, method: str, params: Any = None) -> Any:
        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id,
            "method": method,
            "params": [] if params is None else params,
        }
        self._next_id += 1
        for attempt in range(6):
            started = time.perf_counter()
            try:
                response = requests.post(self._rpc_url, json=payload, timeout=self._timeout)
                self.request_count += 1
                self.elapsed_seconds += time.perf_counter() - started
                if (response.status_code == 429 or response.status_code >= 500) and attempt < 5:
                    time.sleep(2**attempt)
                    continue
                response.raise_for_status()
                body = response.json()
                break
            except requests.RequestException:
                self.request_count += 1
                self.elapsed_seconds += time.perf_counter() - started
                if attempt < 5:
                    time.sleep(2**attempt)
                    continue
                raise RuntimeError(f"{self.name} RPC request failed") from None
            except ValueError:
                raise RuntimeError(f"{self.name} RPC returned invalid JSON") from None
        else:
            raise RuntimeError(f"{self.name} RPC request exhausted retries")
        if "error" in body:
            error = body["error"]
            raise RuntimeError(
                f"{self.name} RPC {method} failed: "
                f"code={error.get('code')} message={error.get('message')}"
            )
        return body.get("result")

    def batch_call(self, method: str, params_list: list[list[Any]]) -> list[Any]:
        """Run an ordered JSON-RPC batch without exposing the endpoint."""
        payload = []
        ids = []
        for params in params_list:
            request_id = self._next_id
            self._next_id += 1
            ids.append(request_id)
            payload.append(
                {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
            )
        for attempt in range(6):
            started = time.perf_counter()
            try:
                response = requests.post(self._rpc_url, json=payload, timeout=self._timeout)
                self.request_count += 1
                self.elapsed_seconds += time.perf_counter() - started
                if (response.status_code == 429 or response.status_code >= 500) and attempt < 5:
                    time.sleep(2**attempt)
                    continue
                response.raise_for_status()
                body = response.json()
            except requests.RequestException:
                self.request_count += 1
                self.elapsed_seconds += time.perf_counter() - started
                if attempt < 5:
                    time.sleep(2**attempt)
                    continue
                raise RuntimeError(f"{self.name} RPC batch request failed") from None
            except ValueError:
                raise RuntimeError(f"{self.name} RPC batch returned invalid JSON") from None
            if not isinstance(body, list):
                raise RuntimeError(f"{self.name} RPC batch returned an unexpected response")
            rate_limited = any(
                item.get("error", {}).get("code") == 429 for item in body
            )
            if rate_limited and attempt < 5:
                time.sleep(2**attempt)
                continue
            by_id = {item["id"]: item for item in body}
            ordered = []
            for request_id in ids:
                item = by_id.get(request_id, {})
                if "error" in item:
                    error = item["error"]
                    raise RuntimeError(
                        f"{self.name} RPC {method} failed: "
                        f"code={error.get('code')} message={error.get('message')}"
                    )
                ordered.append(item.get("result"))
            return ordered
        raise RuntimeError(f"{self.name} RPC batch exhausted retries")


def hex_int(value: str) -> int:
    return int(value, 16)


def save_json(filename: str, data: Any) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / filename
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path
