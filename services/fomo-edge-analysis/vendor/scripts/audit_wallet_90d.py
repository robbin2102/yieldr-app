"""Extract recent Fomo settlement trades for arbitrary EVM and Solana wallets."""

from __future__ import annotations

import argparse
import csv
import gzip
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from scripts.extract_fomo_trades import classify, exact_amount
from scripts.fetch_wallet_transfers import unique_transfers
from scripts.parse_solana_trades import WSOL_MINT, parse_transaction, trade_legs
from scripts.rpc_utils import OUTPUT_DIR, RpcClient, load_config, load_solana_config
from scripts.solana_metadata import fetch_metadata


def iso_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def transfer_amount(
    transfer: dict[str, Any] | None,
    rpc: RpcClient,
    decimals_cache: dict[str, int],
) -> str | None:
    if not transfer:
        return None
    amount = exact_amount(transfer)
    if amount is not None:
        return amount
    raw_contract = transfer.get("rawContract") or {}
    raw_value = raw_contract.get("value")
    address = str(raw_contract.get("address") or "").lower()
    if not raw_value or not address:
        return None
    if address not in decimals_cache:
        encoded = rpc.call("eth_call", [{"to": address, "data": "0x313ce567"}, "latest"])
        if not encoded or encoded == "0x":
            return None
        decimals_cache[address] = int(encoded, 16)
    value = Decimal(int(raw_value, 16)) / (Decimal(10) ** decimals_cache[address])
    return format(value, "f")


def fetch_evm_direction(
    rpc: RpcClient, wallet: str, direction: str, cutoff: datetime
) -> list[dict[str, Any]]:
    transfers: list[dict[str, Any]] = []
    page_key: str | None = None
    while True:
        query: dict[str, Any] = {
            "fromBlock": "0x0", "toBlock": "latest", direction: wallet,
            "category": ["erc20"], "excludeZeroValue": False,
            "withMetadata": True, "maxCount": "0x3e8", "order": "desc",
        }
        if page_key:
            query["pageKey"] = page_key
        result = rpc.call("alchemy_getAssetTransfers", [query])
        page = result.get("transfers", [])
        transfers.extend(
            item for item in page
            if iso_time(item["metadata"]["blockTimestamp"]) >= cutoff
        )
        page_key = result.get("pageKey")
        if not page_key or not page:
            break
        oldest = min(iso_time(item["metadata"]["blockTimestamp"]) for item in page)
        if oldest < cutoff:
            break
    return transfers


def evm_trades(chain: str, rpc: RpcClient, wallet: str, cutoff: datetime) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    outgoing = fetch_evm_direction(rpc, wallet, "fromAddress", cutoff)
    incoming = fetch_evm_direction(rpc, wallet, "toAddress", cutoff)
    transfers = unique_transfers(outgoing + incoming)
    by_hash: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for transfer in transfers:
        by_hash[transfer["hash"]].append(transfer)

    records = []
    decimals_cache: dict[str, int] = {}
    for transfer in transfers:
        category = classify(transfer, wallet)
        if category not in {"TOKEN_CREDIT_FROM_SETTLEMENT", "TOKEN_DEBIT_TO_SETTLEMENT"}:
            continue
        tx_items = by_hash[transfer["hash"]]
        quote = next(
            (item for item in tx_items if classify(item, wallet) == "STABLECOIN_PAYMENT"),
            None,
        )
        raw_contract = transfer.get("rawContract") or {}
        records.append({
            "timestamp": transfer["metadata"]["blockTimestamp"],
            "chain": chain,
            "side": "BUY" if category == "TOKEN_CREDIT_FROM_SETTLEMENT" else "SELL",
            "token_symbol": transfer.get("asset"),
            "token_address_or_mint": raw_contract.get("address"),
            "token_amount": transfer_amount(transfer, rpc, decimals_cache),
            "quote_symbol": quote.get("asset") if quote else None,
            "quote_amount": transfer_amount(quote, rpc, decimals_cache),
            "transaction_id": transfer["hash"],
            "relayed": None,
            "fomo_evidence": category,
        })
    return records, transfers


def fetch_solana(rpc: RpcClient, wallet: str, cutoff: datetime) -> list[dict[str, Any]]:
    transactions: list[dict[str, Any]] = []
    pagination_token: str | None = None
    while True:
        query: dict[str, Any] = {
            "transactionDetails": "full", "sortOrder": "desc", "limit": 100,
            "encoding": "jsonParsed", "maxSupportedTransactionVersion": 1,
            "filters": {"status": "succeeded", "tokenAccounts": "balanceChanged"},
        }
        if pagination_token:
            query["paginationToken"] = pagination_token
        result = rpc.call("getTransactionsForAddress", [wallet, query])
        page = result.get("data", [])
        transactions.extend(
            item for item in page
            if item.get("blockTime") and datetime.fromtimestamp(item["blockTime"], tz=timezone.utc) >= cutoff
        )
        pagination_token = result.get("paginationToken")
        if not pagination_token or not page:
            break
        times = [item["blockTime"] for item in page if item.get("blockTime")]
        if times and datetime.fromtimestamp(min(times), tz=timezone.utc) < cutoff:
            break
    return transactions


def solana_trades(rpc: RpcClient, wallet: str, cutoff: datetime) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    transactions = fetch_solana(rpc, wallet, cutoff)
    parsed = [parse_transaction(transaction, wallet) for transaction in transactions]
    legs = [leg for item in parsed for leg in trade_legs(item) if leg["fomo_marker_present"]]
    mints = sorted({leg["token_mint"] for leg in legs if leg["token_mint"] != WSOL_MINT})
    metadata = fetch_metadata(mints, rpc=rpc) if mints else {}
    records = []
    for leg in legs:
        details = ({"symbol": "SOL", "name": "Solana"}
                   if leg["token_mint"] == WSOL_MINT
                   else metadata.get(leg["token_mint"], {}))
        records.append({
            "timestamp": leg["timestamp"], "chain": "solana", "side": leg["side"],
            "token_symbol": details.get("symbol"),
            "token_address_or_mint": leg["token_mint"], "token_amount": leg["token_amount"],
            "quote_symbol": {"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT", "So11111111111111111111111111111111111111112": "WSOL"}.get(leg["quote_mint"]),
            "quote_amount": leg["quote_amount"], "transaction_id": leg["signature"],
            "relayed": leg["relayed"], "fomo_evidence": "FOMO_MARKER_AND_WALLET_DELTAS",
        })
    return records, transactions


def write_outputs(directory: Path, payload: dict[str, Any]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "trades.json").write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    fields = ["timestamp", "chain", "side", "token_symbol", "token_address_or_mint", "token_amount", "quote_symbol", "quote_amount", "transaction_id", "relayed", "fomo_evidence"]
    with (directory / "trades.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows({key: row.get(key) for key in fields} for row in payload["trades"])


def build_wallet_audit(
    evm_wallet: str,
    solana_wallet: str,
    days: int = 90,
) -> tuple[dict[str, Any], dict[str, Any]]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    chains, _ = load_config()
    solana_config, _ = load_solana_config()
    trades: list[dict[str, Any]] = []
    raw_counts: dict[str, int] = {}
    rpc_metrics: dict[str, dict[str, float | int]] = {}
    raw_data: dict[str, Any] = {}
    wallet = evm_wallet.lower()
    for chain in ("base", "robinhood", "bnb"):
        rpc = RpcClient(chains[chain], timeout=90)
        chain_trades, transfers = evm_trades(chain, rpc, wallet, cutoff)
        trades.extend(chain_trades)
        raw_counts[chain] = len(transfers)
        raw_data[chain] = transfers
        rpc_metrics[chain] = {"requests": rpc.request_count, "seconds": round(rpc.elapsed_seconds, 3)}
    solana_rpc = RpcClient(solana_config, timeout=90)
    sol_trades, transactions = solana_trades(solana_rpc, solana_wallet, cutoff)
    trades.extend(sol_trades)
    raw_counts["solana"] = len(transactions)
    raw_data["solana"] = transactions
    rpc_metrics["solana"] = {"requests": solana_rpc.request_count, "seconds": round(solana_rpc.elapsed_seconds, 3)}
    trades.sort(key=lambda row: row["timestamp"], reverse=True)
    counts: dict[str, dict[str, int]] = {}
    for chain in ("base", "robinhood", "bnb", "solana"):
        selected = [row for row in trades if row["chain"] == chain]
        counts[chain] = {"buys": sum(row["side"] == "BUY" for row in selected), "sells": sum(row["side"] == "SELL" for row in selected), "total": len(selected)}
    payload = {"generated_at": datetime.now(timezone.utc).isoformat(), "cutoff": cutoff.isoformat(), "evm_wallet": wallet, "solana_wallet": solana_wallet, "counts": counts, "raw_counts": raw_counts, "rpc_metrics": rpc_metrics, "trades": trades}
    return payload, raw_data


def write_raw_output(
    directory: Path, raw_data: dict[str, Any], raw_format: str = "json"
) -> None:
    if raw_format == "none":
        return
    serialized = json.dumps(raw_data, indent=2, sort_keys=True) + "\n"
    if raw_format == "gzip":
        with gzip.open(directory / "raw.json.gz", "wt", encoding="utf-8") as handle:
            handle.write(serialized)
        return
    (directory / "raw.json").write_text(serialized, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evm-wallet", required=True)
    parser.add_argument("--solana-wallet", required=True)
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument(
        "--raw-format", choices=("json", "gzip", "none"), default="json"
    )
    args = parser.parse_args()
    payload, raw_data = build_wallet_audit(
        args.evm_wallet, args.solana_wallet, args.days
    )
    wallet = args.evm_wallet.lower()
    slug = f"{wallet[2:10]}_{args.solana_wallet[:8]}_{args.days}d"
    directory = OUTPUT_DIR / "wallet_audits" / slug
    write_outputs(directory, payload)
    write_raw_output(directory, raw_data, args.raw_format)
    print(json.dumps({"directory": str(directory.relative_to(OUTPUT_DIR.parent)), "counts": payload["counts"], "raw_counts": payload["raw_counts"], "rpc_metrics": payload["rpc_metrics"], "trade_count": len(payload["trades"])}, indent=2))


if __name__ == "__main__":
    main()
