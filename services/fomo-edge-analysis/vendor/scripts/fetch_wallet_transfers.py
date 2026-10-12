"""Fetch complete ERC-20 transfer history for the configured wallet."""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from scripts.rpc_utils import RpcClient, load_config, save_json


def fetch_direction(
    rpc: RpcClient, target_wallet: str, direction: str
) -> list[dict[str, Any]]:
    transfers: list[dict[str, Any]] = []
    page_key: str | None = None
    while True:
        query: dict[str, Any] = {
            "fromBlock": "0x0",
            "toBlock": "latest",
            direction: target_wallet,
            "category": ["erc20"],
            "excludeZeroValue": False,
            "withMetadata": True,
            "maxCount": "0x3e8",
            "order": "asc",
        }
        if page_key:
            query["pageKey"] = page_key
        result = rpc.call("alchemy_getAssetTransfers", [query])
        transfers.extend(result["transfers"])
        page_key = result.get("pageKey")
        if not page_key:
            return transfers


def unique_transfers(transfers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for transfer in transfers:
        identity = transfer.get("uniqueId") or "|".join(
            str(transfer.get(key)) for key in ("hash", "from", "to", "asset", "value")
        )
        by_id[identity] = transfer
    return list(by_id.values())


def candidate_transactions(
    transfers: list[dict[str, Any]], target_wallet: str
) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for transfer in transfers:
        grouped[transfer["hash"]].append(transfer)

    candidates = []
    for tx_hash, items in grouped.items():
        outgoing = [item for item in items if item.get("from", "").lower() == target_wallet]
        incoming = [item for item in items if item.get("to", "").lower() == target_wallet]
        if outgoing and incoming:
            candidates.append(
                {
                    "hash": tx_hash,
                    "block_num": items[0].get("blockNum"),
                    "timestamp": (items[0].get("metadata") or {}).get("blockTimestamp"),
                    "outgoing": outgoing,
                    "incoming": incoming,
                }
            )
    return candidates


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("chain", choices=("base", "robinhood", "bnb"))
    args = parser.parse_args()

    chains, target_wallet = load_config()
    rpc = RpcClient(chains[args.chain])
    outgoing = fetch_direction(rpc, target_wallet, "fromAddress")
    incoming = fetch_direction(rpc, target_wallet, "toAddress")
    combined = unique_transfers(outgoing + incoming)
    candidates = candidate_transactions(combined, target_wallet)

    raw_path = save_json(
        f"experiment3_{args.chain}_erc20_transfers.json",
        {
            "chain": args.chain,
            "target_wallet": target_wallet,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "outgoing_query_count": len(outgoing),
            "incoming_query_count": len(incoming),
            "unique_transfer_count": len(combined),
            "transfers": combined,
        },
    )
    candidate_path = save_json(
        f"experiment3_{args.chain}_swap_candidates.json",
        {
            "chain": args.chain,
            "target_wallet": target_wallet,
            "candidate_count": len(candidates),
            "candidates": candidates,
        },
    )
    print(
        f"{args.chain}: {len(combined)} unique ERC-20 transfers; "
        f"{len(candidates)} two-way transaction candidates"
    )
    print(f"saved {raw_path.relative_to(raw_path.parent.parent)}")
    print(f"saved {candidate_path.relative_to(candidate_path.parent.parent)}")


if __name__ == "__main__":
    main()
