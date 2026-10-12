"""Normalize wallet movements belonging to the observed Fomo settlement paths."""

from __future__ import annotations

import argparse
import csv
import json
from decimal import Decimal
from pathlib import Path
from typing import Any

from scripts.rpc_utils import OUTPUT_DIR, PROJECT_ROOT, RpcClient, load_config, save_json


TOKEN_SETTLEMENT = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"
STABLECOIN_COLLECTOR = "0x4cd00e387622c35bddb9b4c962c136462338bc31"
ENTRYPOINT_V08 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108"
USER_OPERATION_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f"


def chunks(items: list[str], size: int = 10) -> list[list[str]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def fetch_by_hash(rpc: RpcClient, method: str, hashes: list[str]) -> dict[str, Any]:
    found: dict[str, Any] = {}
    for group in chunks(hashes):
        results = rpc.batch_call(method, [[tx_hash] for tx_hash in group])
        found.update(zip(group, results, strict=True))
    return found


def topic_address(topic: str) -> str:
    return "0x" + topic[-40:].lower()


def decode_user_operation(receipt: dict[str, Any], wallet: str) -> dict[str, Any] | None:
    for log in receipt.get("logs", []):
        topics = log.get("topics", [])
        if (
            log.get("address", "").lower() != ENTRYPOINT_V08
            or len(topics) != 4
            or topics[0].lower() != USER_OPERATION_EVENT
            or topic_address(topics[2]) != wallet
        ):
            continue
        words = [log["data"][2 + offset : 2 + offset + 64] for offset in range(0, 256, 64)]
        if len(words) != 4 or any(len(word) != 64 for word in words):
            raise RuntimeError("Malformed UserOperationEvent data")
        return {
            "user_op_hash": topics[1].lower(),
            "sender": topic_address(topics[2]),
            "paymaster": topic_address(topics[3]),
            "nonce": str(int(words[0], 16)),
            "success": bool(int(words[1], 16)),
            "actual_gas_cost": str(int(words[2], 16)),
            "actual_gas_used": str(int(words[3], 16)),
        }
    return None


def classify(transfer: dict[str, Any], wallet: str) -> str | None:
    from_address = transfer.get("from", "").lower()
    to_address = transfer.get("to", "").lower()
    if from_address == TOKEN_SETTLEMENT and to_address == wallet:
        return "TOKEN_CREDIT_FROM_SETTLEMENT"
    if from_address == wallet and to_address == TOKEN_SETTLEMENT:
        return "TOKEN_DEBIT_TO_SETTLEMENT"
    if from_address == wallet and to_address == STABLECOIN_COLLECTOR:
        return "STABLECOIN_PAYMENT"
    return None


def exact_amount(transfer: dict[str, Any]) -> str | None:
    raw = (transfer.get("rawContract") or {}).get("value")
    decimal_hex = (transfer.get("rawContract") or {}).get("decimal")
    if not raw or not decimal_hex:
        return None
    decimals = int(decimal_hex, 16)
    value = Decimal(int(raw, 16)) / (Decimal(10) ** decimals)
    return format(value, "f")


def extract(chain: str) -> list[dict[str, Any]]:
    chains, wallet = load_config()
    source_path = PROJECT_ROOT / "output" / f"experiment3_{chain}_erc20_transfers.json"
    source = json.loads(source_path.read_text(encoding="utf-8"))
    relevant = [item for item in source["transfers"] if classify(item, wallet)]
    hashes = sorted({item["hash"] for item in relevant})
    rpc = RpcClient(chains[chain], timeout=60)
    transactions = fetch_by_hash(rpc, "eth_getTransactionByHash", hashes)
    receipts = fetch_by_hash(rpc, "eth_getTransactionReceipt", hashes)

    records = []
    for transfer in sorted(relevant, key=lambda item: item["metadata"]["blockTimestamp"]):
        tx_hash = transfer["hash"]
        tx = transactions[tx_hash]
        receipt = receipts[tx_hash]
        user_op = decode_user_operation(receipt, wallet)
        raw_contract = transfer.get("rawContract") or {}
        record = {
            "chain": chain,
            "classification": classify(transfer, wallet),
            "timestamp": transfer["metadata"]["blockTimestamp"],
            "block_number": int(transfer["blockNum"], 16),
            "transaction_hash": tx_hash,
            "transfer_log_id": transfer.get("uniqueId"),
            "token_symbol": transfer.get("asset"),
            "token_address": raw_contract.get("address"),
            "token_decimals": int(raw_contract["decimal"], 16)
            if raw_contract.get("decimal")
            else None,
            "raw_amount": str(int(raw_contract["value"], 16))
            if raw_contract.get("value")
            else None,
            "amount": exact_amount(transfer),
            "from": transfer.get("from", "").lower(),
            "to": transfer.get("to", "").lower(),
            "outer_transaction_from": tx["from"].lower(),
            "outer_transaction_to": (tx.get("to") or "").lower(),
            "outer_transaction_type": int(tx.get("type", "0x0"), 16),
            "eip7702_authorization_count": len(tx.get("authorizationList") or []),
            "erc4337_user_operation": user_op,
        }
        records.append(record)
    return records


def write_csv(chain: str, records: list[dict[str, Any]]) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"fomo_trade_movements_{chain}.csv"
    fieldnames = [
        "chain",
        "classification",
        "timestamp",
        "block_number",
        "transaction_hash",
        "token_symbol",
        "token_address",
        "token_decimals",
        "raw_amount",
        "amount",
        "from",
        "to",
        "outer_transaction_from",
        "outer_transaction_to",
        "outer_transaction_type",
        "eip7702_authorization_count",
        "user_op_hash",
        "user_op_success",
        "user_op_nonce",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for record in records:
            user_op = record["erc4337_user_operation"] or {}
            row = {key: record.get(key) for key in fieldnames}
            row.update(
                {
                    "user_op_hash": user_op.get("user_op_hash"),
                    "user_op_success": user_op.get("success"),
                    "user_op_nonce": user_op.get("nonce"),
                }
            )
            writer.writerow(row)
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("chain", choices=("base", "robinhood", "bnb"))
    args = parser.parse_args()
    records = extract(args.chain)
    json_path = save_json(
        f"fomo_trade_movements_{args.chain}.json",
        {
            "chain": args.chain,
            "classification_note": (
                "Records are settlement-path token movements, not assumed atomic swaps."
            ),
            "records": records,
        },
    )
    csv_path = write_csv(args.chain, records)
    counts: dict[str, int] = {}
    for record in records:
        label = record["classification"]
        counts[label] = counts.get(label, 0) + 1
    print(f"{args.chain}: {len(records)} settlement-path movements {counts}")
    print(f"saved {json_path.relative_to(PROJECT_ROOT)}")
    print(f"saved {csv_path.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
