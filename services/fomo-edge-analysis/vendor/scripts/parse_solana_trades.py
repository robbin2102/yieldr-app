"""Parse Fomo Solana trades from wallet-owned token balance deltas."""

from __future__ import annotations

import csv
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from scripts.rpc_utils import OUTPUT_DIR, save_json


USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
WSOL_MINT = "So11111111111111111111111111111111111111112"
QUOTE_MINTS = {USDC_MINT, USDT_MINT, WSOL_MINT}
FOMO_MARKER = "jitodontfront1111111111111111111TradeonFomo"
QUOTE_SYMBOLS = {USDC_MINT: "USDC", USDT_MINT: "USDT", WSOL_MINT: "WSOL"}


def aggregate_owner_balances(
    balances: list[dict[str, Any]], owner: str
) -> dict[str, dict[str, Any]]:
    totals: dict[str, dict[str, Any]] = {}
    for balance in balances:
        if balance.get("owner") != owner:
            continue
        mint = balance["mint"]
        amount = balance["uiTokenAmount"]
        item = totals.setdefault(
            mint,
            {
                "raw_amount": 0,
                "decimals": int(amount["decimals"]),
                "program_id": balance.get("programId"),
            },
        )
        item["raw_amount"] += int(amount["amount"])
    return totals


def wallet_token_deltas(transaction: dict[str, Any], wallet: str) -> list[dict[str, Any]]:
    meta = transaction["meta"]
    before = aggregate_owner_balances(meta.get("preTokenBalances") or [], wallet)
    after = aggregate_owner_balances(meta.get("postTokenBalances") or [], wallet)
    deltas = []
    for mint in sorted(set(before) | set(after)):
        details = after.get(mint) or before[mint]
        raw_delta = after.get(mint, {}).get("raw_amount", 0) - before.get(mint, {}).get(
            "raw_amount", 0
        )
        if raw_delta == 0:
            continue
        decimals = details["decimals"]
        ui_delta = Decimal(raw_delta) / (Decimal(10) ** decimals)
        deltas.append(
            {
                "mint": mint,
                "raw_delta": str(raw_delta),
                "decimals": decimals,
                "ui_delta": format(ui_delta, "f"),
                "program_id": details.get("program_id"),
            }
        )
    return deltas


def account_keys(transaction: dict[str, Any]) -> list[dict[str, Any]]:
    return transaction["transaction"]["message"].get("accountKeys", [])


def wallet_lamport_delta(transaction: dict[str, Any], wallet: str) -> int | None:
    for index, account in enumerate(account_keys(transaction)):
        if account.get("pubkey") == wallet:
            return transaction["meta"]["postBalances"][index] - transaction["meta"][
                "preBalances"
            ][index]
    return None


def log_facts(transaction: dict[str, Any]) -> tuple[list[str], list[str]]:
    logs = transaction["meta"].get("logMessages") or []
    instructions = []
    programs = []
    for line in logs:
        instruction = re.match(r"Program log: Instruction: (.+)$", line)
        if instruction:
            instructions.append(instruction.group(1))
        program = re.match(r"Program ([1-9A-HJ-NP-Za-km-z]+) invoke", line)
        if program:
            programs.append(program.group(1))
    return list(dict.fromkeys(instructions)), list(dict.fromkeys(programs))


def parse_transaction(transaction: dict[str, Any], wallet: str) -> dict[str, Any]:
    keys = account_keys(transaction)
    signer_keys = [account["pubkey"] for account in keys if account.get("signer")]
    instructions, programs = log_facts(transaction)
    deltas = wallet_token_deltas(transaction, wallet)
    signature = transaction["transaction"]["signatures"][0]
    return {
        "signature": signature,
        "slot": transaction["slot"],
        "timestamp": datetime.fromtimestamp(
            transaction["blockTime"], tz=timezone.utc
        ).isoformat(),
        "version": transaction.get("version"),
        "fee_lamports": transaction["meta"]["fee"],
        "fee_payer": keys[0]["pubkey"],
        "wallet_is_signer": wallet in signer_keys,
        "wallet_is_fee_payer": keys[0]["pubkey"] == wallet,
        "relayed": wallet in signer_keys and keys[0]["pubkey"] != wallet,
        "signers": signer_keys,
        "wallet_lamport_delta": wallet_lamport_delta(transaction, wallet),
        "wallet_token_deltas": deltas,
        "instruction_names": instructions,
        "program_ids": programs,
        "fomo_marker_present": any(account.get("pubkey") == FOMO_MARKER for account in keys),
    }


def trade_legs(parsed: dict[str, Any]) -> list[dict[str, Any]]:
    quote_deltas = [
        delta for delta in parsed["wallet_token_deltas"] if delta["mint"] in QUOTE_MINTS
    ]
    token_deltas = [
        delta for delta in parsed["wallet_token_deltas"] if delta["mint"] not in QUOTE_MINTS
    ]
    # Fomo settles a USDC -> native SOL purchase directly into the wallet's
    # system account. It therefore has no SPL target-token balance row. Model
    # that lamport movement as WSOL-equivalent inventory while retaining the
    # native-balance evidence explicitly.
    if len(quote_deltas) == 1 and not token_deltas:
        lamports = parsed.get("wallet_lamport_delta")
        quote_raw = int(quote_deltas[0]["raw_delta"])
        if lamports and ((quote_raw < 0 < lamports) or (quote_raw > 0 > lamports)):
            token_deltas = [{
                "mint": WSOL_MINT,
                "raw_delta": str(lamports),
                "ui_delta": format(Decimal(lamports) / Decimal(1_000_000_000), "f"),
                "program_id": "native_system_account",
                "native_lamport_balance": True,
            }]
    if len(quote_deltas) != 1 or not token_deltas:
        return []
    quote = quote_deltas[0]
    quote_raw = int(quote["raw_delta"])
    legs = []
    for token in token_deltas:
        token_raw = int(token["raw_delta"])
        if quote_raw < 0 < token_raw:
            side = "BUY"
        elif quote_raw > 0 > token_raw:
            side = "SELL"
        else:
            continue
        legs.append(
            {
                "side": side,
                "token_mint": token["mint"],
                "token_raw_delta": token["raw_delta"],
                "token_amount": format(abs(Decimal(token["ui_delta"])), "f"),
                "quote_mint": quote["mint"],
                "quote_raw_delta": quote["raw_delta"],
                "quote_amount": format(abs(Decimal(quote["ui_delta"])), "f"),
                "native_lamport_balance": bool(token.get("native_lamport_balance")),
                **{key: value for key, value in parsed.items() if key != "wallet_token_deltas"},
            }
        )
    return legs


def write_csv(records: list[dict[str, Any]]) -> Path:
    path = OUTPUT_DIR / "solana_trades.csv"
    fieldnames = [
        "timestamp",
        "side",
        "token_symbol",
        "token_name",
        "token_mint",
        "token_amount",
        "quote_symbol",
        "quote_mint",
        "quote_amount",
        "signature",
        "fee_payer",
        "relayed",
        "wallet_is_signer",
        "fee_lamports",
        "fomo_marker_present",
        "instruction_names",
        "program_ids",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for record in records:
            row = {key: record.get(key) for key in fieldnames}
            row["instruction_names"] = "|".join(record["instruction_names"])
            row["program_ids"] = "|".join(record["program_ids"])
            writer.writerow(row)
    return path


def add_token_metadata(records: list[dict[str, Any]]) -> None:
    """Add cached symbols without making parsing depend on a metadata service."""
    path = OUTPUT_DIR / "solana_token_metadata.json"
    metadata = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    for record in records:
        details = metadata.get(record["token_mint"], {})
        record["token_symbol"] = details.get("symbol")
        record["token_name"] = details.get("name")
        record["quote_symbol"] = QUOTE_SYMBOLS.get(record["quote_mint"])


def main() -> None:
    raw = json.loads((OUTPUT_DIR / "solana_raw_transactions.json").read_text(encoding="utf-8"))
    wallet = raw["wallet"]
    parsed = [parse_transaction(transaction, wallet) for transaction in raw["transactions"]]
    trades = [leg for transaction in parsed for leg in trade_legs(transaction)]
    add_token_metadata(trades)
    summary = {
        "raw_transaction_count": len(parsed),
        "trade_count": len(trades),
        "buy_count": sum(record["side"] == "BUY" for record in trades),
        "sell_count": sum(record["side"] == "SELL" for record in trades),
        "relayed_trade_count": sum(record["relayed"] for record in trades),
        "fomo_marker_trade_count": sum(record["fomo_marker_present"] for record in trades),
        "single_delta_transaction_count": sum(
            len(record["wallet_token_deltas"]) == 1 for record in parsed
        ),
    }
    save_json(
        "solana_parsed_transactions.json",
        {"wallet": wallet, "summary": summary, "transactions": parsed},
    )
    save_json(
        "solana_trades.json",
        {"wallet": wallet, "summary": summary, "trades": trades},
    )
    csv_path = write_csv(trades)
    print(json.dumps(summary, indent=2))
    print(f"saved {csv_path.relative_to(csv_path.parent.parent)}")


if __name__ == "__main__":
    main()
