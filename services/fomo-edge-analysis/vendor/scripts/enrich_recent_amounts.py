"""Add atomic USD amounts to a small, recent cross-chain trade sample."""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from decimal import Decimal
from pathlib import Path
from typing import Any

from scripts.inspect_transactions import TRANSFER_TOPIC, topic_address
from scripts.rpc_utils import RpcClient, load_config


FEE_RATE = Decimal("0.00442")
SETTLEMENT = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"
ROBINHOOD_USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
STABLECOINS = {
    "base": {
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6,
        "0xd9aa3212271cbb9b8b14a35eeced92e7c73f9c4a": 6,
    },
    "bnb": {
        "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": 18,
        "0x55d398326f99059ff775485246999027b3197955": 18,
    },
}
RELAY_METADATA_TOPIC = "0x095e66fa4dd6a6f7b43fb8444a7bd0edb870508c7abf639bc216efb0bcff9779"
SOLANA_SYMBOL_ALIASES = {
    "8RVBk8vxLiUHueLUW1f4izFVqN3nWippLhkohKg6EGkS": "KNOTS",
    "4ytoC4JhuZsqyLC9jTYGxLvwGu4vELA9w4xWc4qRgHik": "BAG",
}


def log_index(log: dict[str, Any]) -> int:
    return int(log["logIndex"], 16)


def decode_dynamic_json(data: str) -> dict[str, Any] | None:
    try:
        raw = bytes.fromhex(data[2:])
        offset = int.from_bytes(raw[:32])
        length = int.from_bytes(raw[offset : offset + 32])
        return json.loads(raw[offset + 32 : offset + 32 + length].decode())
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def transfer(log: dict[str, Any]) -> dict[str, Any] | None:
    topics = log.get("topics", [])
    if len(topics) < 3 or topics[0].lower() != TRANSFER_TOPIC:
        return None
    data=log.get("data") or "0x0"
    raw_amount=0 if data=="0x" else int(data,16)
    return {
        "index": log_index(log), "token": log["address"].lower(),
        "from": topic_address(topics[1]), "to": topic_address(topics[2]),
        "raw_amount": raw_amount,
    }


def wallet_leg_index(receipt: dict[str, Any], trade: dict[str, Any], wallet: str) -> int:
    token = trade["token_address_or_mint"].lower()
    matches = []
    for log in receipt.get("logs", []):
        item = transfer(log)
        if item and item["token"] == token and wallet in (item["from"], item["to"]):
            matches.append(item["index"])
    return matches[-1] if matches else 0


def relay_usd(receipt: dict[str, Any], trade: dict[str, Any], wallet: str) -> tuple[Decimal | None, str | None, dict[str, Any] | None]:
    target = wallet_leg_index(receipt, trade, wallet)
    events = []
    for log in receipt.get("logs", []):
        topics = log.get("topics", [])
        if topics and topics[0].lower() == RELAY_METADATA_TOPIC:
            payload = decode_dynamic_json(log["data"])
            if payload and payload.get("Source") == "relay-fomo":
                events.append((abs(log_index(log) - target), payload))
    if not events:
        return None, None, None
    payload = min(events, key=lambda item: item[0])[1]
    key = "AmountInUSD" if trade["side"] == "BUY" else "AmountOutUSD"
    value = payload.get(key)
    return (Decimal(str(value)), f"fomo_relay_event.{key}", payload) if value is not None else (None, None, payload)


def robinhood_usdg(receipt: dict[str, Any], trade: dict[str, Any], wallet: str) -> tuple[Decimal | None, str | None, None]:
    target = wallet_leg_index(receipt, trade, wallet)
    candidates = []
    for log in receipt.get("logs", []):
        item = transfer(log)
        if item and item["token"] == ROBINHOOD_USDG and item["to"] == SETTLEMENT:
            candidates.append((abs(item["index"] - target), item["raw_amount"]))
    if not candidates:
        return None, None, None
    raw = min(candidates, key=lambda item: item[0])[1]
    return Decimal(raw) / Decimal(10**6), "receipt.USDG_to_settlement", None


def settlement_stablecoin(
    receipt: dict[str, Any], trade: dict[str, Any], wallet: str
) -> tuple[Decimal | None, str | None, None]:
    """Find the stablecoin settlement leg nearest the target token movement."""
    supported = STABLECOINS.get(trade["chain"], {})
    target = wallet_leg_index(receipt, trade, wallet)
    candidates = []
    for log in receipt.get("logs", []):
        item = transfer(log)
        if not item or item["token"] not in supported:
            continue
        relevant = (
            item["to"] == SETTLEMENT
            if trade["side"] == "BUY"
            else item["from"] == SETTLEMENT
        )
        if relevant:
            candidates.append((abs(item["index"] - target), item))
    if not candidates:
        return None, None, None
    item = min(candidates, key=lambda row: row[0])[1]
    decimals = supported[item["token"]]
    return (
        Decimal(item["raw_amount"]) / (Decimal(10) ** decimals),
        "receipt.nearest_settlement_stablecoin_transfer",
        None,
    )


def amount_candidates(amount: Decimal | None) -> dict[str, str | None]:
    if amount is None:
        return {"atomic_usd": None, "minus_0_442_percent": None, "grossed_up_0_442_percent": None}
    return {
        "atomic_usd": format(amount, "f"),
        "minus_0_442_percent": format(amount * (Decimal(1) - FEE_RATE), ".6f"),
        "grossed_up_0_442_percent": format(amount / (Decimal(1) - FEE_RATE), ".6f"),
    }


def enrich_evm(trade: dict[str, Any], receipt: dict[str, Any], wallet: str) -> dict[str, Any]:
    if trade["chain"] == "robinhood":
        amount, source, relay = robinhood_usdg(receipt, trade, wallet)
    else:
        amount, source, relay = relay_usd(receipt, trade, wallet)
        if amount is None:
            amount, source, relay = settlement_stablecoin(
                receipt, trade, wallet
            )
    return {**trade, **amount_candidates(amount), "amount_source": source, "relay_payload": relay}


def enrich_solana(trade: dict[str, Any]) -> dict[str, Any]:
    amount = Decimal(trade["quote_amount"]) if trade.get("quote_symbol") in {"USDC", "USDT"} and trade.get("quote_amount") else None
    symbol = trade.get("token_symbol") or SOLANA_SYMBOL_ALIASES.get(trade["token_address_or_mint"])
    return {**trade, "token_symbol": symbol, **amount_candidates(amount), "amount_source": f"wallet_{trade.get('quote_symbol')}_delta" if amount is not None else None, "relay_payload": None}


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fields = ["timestamp", "chain", "side", "token_symbol", "token_amount", "atomic_usd", "minus_0_442_percent", "grossed_up_0_442_percent", "amount_source", "transaction_id"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows({field: row.get(field) for field in fields} for row in rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audit_json", type=Path)
    parser.add_argument("--per-chain", type=int, default=100)
    parser.add_argument("--batch-size", type=int, default=25)
    args = parser.parse_args()
    audit = json.loads(args.audit_json.read_text(encoding="utf-8"))
    selected = []
    for chain in ("base", "robinhood", "bnb", "solana"):
        selected.extend([row for row in audit["trades"] if row["chain"] == chain][: args.per_chain])
    selected.sort(key=lambda row: row["timestamp"], reverse=True)
    output_json = args.audit_json.parent / "recent_priced_trades.json"
    output_csv = args.audit_json.parent / "recent_priced_trades.csv"
    cached: dict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    if output_json.exists():
        previous = json.loads(output_json.read_text(encoding="utf-8"))
        for row in previous.get("trades", []):
            key = (
                row["chain"], row["transaction_id"], row["side"],
                (row.get("token_address_or_mint") or "").lower(),
            )
            cached[key].append(row)
    reused: dict[int, dict[str, Any]] = {}
    missing = []
    for row in selected:
        key = (
            row["chain"], row["transaction_id"], row["side"],
            (row.get("token_address_or_mint") or "").lower(),
        )
        if cached.get(key):
            reused[id(row)] = cached[key].pop(0)
        else:
            missing.append(row)
    chains, _ = load_config()
    wallet = audit["evm_wallet"]
    receipts: dict[tuple[str, str], dict[str, Any]] = {}
    http_batches = 0
    receipt_methods = 0
    by_chain: dict[str, list[str]] = defaultdict(list)
    for row in missing:
        if row["chain"] != "solana" and row["transaction_id"] not in by_chain[row["chain"]]:
            by_chain[row["chain"]].append(row["transaction_id"])
    for chain, hashes in by_chain.items():
        rpc = RpcClient(chains[chain], timeout=60)
        for start in range(0, len(hashes), args.batch_size):
            group = hashes[start : start + args.batch_size]
            values = rpc.batch_call("eth_getTransactionReceipt", [[tx_hash] for tx_hash in group])
            receipts.update({(chain, tx_hash): value for tx_hash, value in zip(group, values, strict=True)})
            http_batches += 1
            receipt_methods += len(group)
    enriched = [
        reused[id(row)] if id(row) in reused else (
            enrich_solana(row) if row["chain"] == "solana"
            else enrich_evm(row, receipts[(row["chain"], row["transaction_id"])], wallet)
        )
        for row in selected
    ]
    coverage = {chain: {"rows": sum(row["chain"] == chain for row in enriched), "priced": sum(row["chain"] == chain and row["atomic_usd"] is not None for row in enriched)} for chain in ("base", "robinhood", "bnb", "solana")}
    payload = {"wallets": {"evm": wallet, "solana": audit["solana_wallet"]}, "fee_test_percent": "0.442", "receipt_rpc_methods": receipt_methods, "receipt_http_batches": http_batches, "reused_cached_rows": len(reused), "coverage": coverage, "trades": enriched}
    output_json.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    write_csv(output_csv, enriched)
    print(json.dumps({"receipt_rpc_methods": receipt_methods, "receipt_http_batches": http_batches, "reused_cached_rows": len(reused), "coverage": coverage, "json": str(output_json), "csv": str(output_csv)}, indent=2))


if __name__ == "__main__":
    main()
