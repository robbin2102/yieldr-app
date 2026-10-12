"""Resolve fungible-token names from Metaplex metadata accounts."""

from __future__ import annotations

import base64
import json
import struct
from typing import Any

from solders.pubkey import Pubkey

from scripts.rpc_utils import OUTPUT_DIR, RpcClient, load_solana_config, save_json


METADATA_PROGRAM = Pubkey.from_string("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")


def metadata_address(mint: str) -> str:
    mint_key = Pubkey.from_string(mint)
    address, _ = Pubkey.find_program_address(
        [b"metadata", bytes(METADATA_PROGRAM), bytes(mint_key)], METADATA_PROGRAM
    )
    return str(address)


def read_borsh_string(data: bytes, offset: int) -> tuple[str, int]:
    length = struct.unpack_from("<I", data, offset)[0]
    offset += 4
    value = data[offset : offset + length].decode("utf-8", errors="replace").rstrip("\x00")
    return value, offset + length


def decode_metadata(data: bytes) -> dict[str, str]:
    if len(data) < 65:
        raise ValueError("Metaplex metadata account is too short")
    offset = 65
    name, offset = read_borsh_string(data, offset)
    symbol, offset = read_borsh_string(data, offset)
    uri, _ = read_borsh_string(data, offset)
    return {"name": name, "symbol": symbol, "uri": uri}


def fetch_metadata(mints: list[str], rpc: RpcClient | None = None) -> dict[str, dict[str, Any]]:
    if rpc is None:
        config, _ = load_solana_config()
        rpc = RpcClient(config, timeout=60)
    results = {}
    for start in range(0, len(mints), 10):
        group = mints[start : start + 10]
        params = [
            [metadata_address(mint), {"encoding": "base64", "commitment": "confirmed"}]
            for mint in group
        ]
        responses = rpc.batch_call("getAccountInfo", params)
        for mint, response in zip(group, responses, strict=True):
            value = response.get("value") if response else None
            if not value:
                results[mint] = {"name": None, "symbol": None, "metadata_account": None}
                continue
            decoded = decode_metadata(base64.b64decode(value["data"][0]))
            results[mint] = {
                "name": decoded["name"],
                "symbol": decoded["symbol"],
                "uri": decoded["uri"],
                "metadata_account": metadata_address(mint),
            }
    return results


def main() -> None:
    trade_data = json.loads((OUTPUT_DIR / "solana_trades.json").read_text(encoding="utf-8"))
    mints = sorted({trade["token_mint"] for trade in trade_data["trades"]})
    results = fetch_metadata(mints)
    path = save_json("solana_token_metadata.json", results)
    resolved = sum(bool(item.get("symbol")) for item in results.values())
    print(f"resolved {resolved}/{len(mints)} traded Solana mint symbols")
    print(f"saved {path.relative_to(path.parent.parent)}")


if __name__ == "__main__":
    main()
