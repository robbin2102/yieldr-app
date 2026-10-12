"""Reconcile direct Solana swaps to Fomo page rows without trusting token symbols."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime
from typing import Any

from scripts.compare_fomo_page import age_bounds
from scripts.rpc_utils import OUTPUT_DIR, save_json


MAX_AMOUNT_ERROR = 0.05
# Confirmed Fomo fee supplied by the user. The factor reconciles the gross page
# amount with the wallet's net quote-token flow in opposite directions by side.
DISPLAY_FACTOR = 0.99558


def usd_number(value: str) -> float:
    return float(re.sub(r"[$,]", "", value))


def expected_page_amount(trade: dict[str, Any]) -> float:
    quote = float(trade["quote_amount"])
    return quote * DISPLAY_FACTOR if trade["side"] == "BUY" else quote / DISPLAY_FACTOR


def time_compatible(
    trade: dict[str, Any], page: dict[str, str], snapshot: datetime
) -> bool:
    lower, upper = age_bounds(page["relative_time"])
    timestamp = datetime.fromisoformat(trade["timestamp"])
    age = (snapshot - timestamp).total_seconds()
    return lower <= age <= upper


def candidate_error(
    trade: dict[str, Any], page: dict[str, str], snapshot: datetime
) -> float | None:
    if trade["side"].title() != page["side"]:
        return None
    if not time_compatible(trade, page, snapshot):
        return None
    displayed = usd_number(page["usd_amount"])
    error = abs(expected_page_amount(trade) - displayed) / max(displayed, 1)
    return error if error <= MAX_AMOUNT_ERROR else None


def greedy_pair(
    trades: list[tuple[int, dict[str, Any]]],
    rows: list[tuple[int, dict[str, str]]],
    snapshot: datetime,
) -> list[tuple[int, int, float]]:
    candidates = []
    for trade_index, trade in trades:
        for row_index, row in rows:
            error = candidate_error(trade, row, snapshot)
            if error is not None:
                candidates.append((error, trade_index, row_index))
    candidates.sort()
    used_trades: set[int] = set()
    used_rows: set[int] = set()
    matches = []
    for error, trade_index, row_index in candidates:
        if trade_index in used_trades or row_index in used_rows:
            continue
        used_trades.add(trade_index)
        used_rows.add(row_index)
        matches.append((trade_index, row_index, error))
    return matches


def infer_symbols(
    trades: list[dict[str, Any]], rows: list[dict[str, str]], snapshot: datetime
) -> dict[str, dict[str, Any]]:
    by_mint: dict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    by_symbol: dict[str, list[tuple[int, dict[str, str]]]] = defaultdict(list)
    for index, trade in enumerate(trades):
        by_mint[trade["token_mint"]].append((index, trade))
    for index, row in enumerate(rows):
        by_symbol[row["token"]].append((index, row))

    candidates = []
    for mint, mint_trades in by_mint.items():
        for symbol, symbol_rows in by_symbol.items():
            matches = greedy_pair(mint_trades, symbol_rows, snapshot)
            if matches:
                mean_error = sum(item[2] for item in matches) / len(matches)
                candidates.append((-len(matches), mean_error, mint, symbol, matches))

    # Symbols on the page are unique assets in this sample. Assign strongest
    # multi-transaction histories first, which also resolves same-amount rows.
    candidates.sort()
    used_mints: set[str] = set()
    used_symbols: set[str] = set()
    inferred = {}
    for negative_count, mean_error, mint, symbol, matches in candidates:
        if mint in used_mints or symbol in used_symbols:
            continue
        used_mints.add(mint)
        used_symbols.add(symbol)
        inferred[mint] = {
            "symbol": symbol,
            "matched_trade_count": -negative_count,
            "mean_amount_error_percent": round(mean_error * 100, 4),
            "matches": matches,
        }
    return inferred


def main() -> None:
    page_comparison = json.loads(
        (OUTPUT_DIR / "fomo_page_comparison.json").read_text(encoding="utf-8")
    )
    trade_data = json.loads((OUTPUT_DIR / "solana_trades.json").read_text(encoding="utf-8"))
    snapshot = datetime.fromisoformat(page_comparison["summary"]["snapshot_time"])
    page_rows = [
        item["page"] for item in page_comparison["comparisons"] if not item["matched"]
    ]
    trades = trade_data["trades"]
    inferred = infer_symbols(trades, page_rows, snapshot)

    reconciled = []
    used_page_rows: set[int] = set()
    for trade_index, trade in enumerate(trades):
        symbol_info = inferred.get(trade["token_mint"])
        match = None
        if symbol_info:
            possible_rows = [
                (index, row)
                for index, row in enumerate(page_rows)
                if index not in used_page_rows and row["token"] == symbol_info["symbol"]
            ]
            pairs = greedy_pair([(trade_index, trade)], possible_rows, snapshot)
            if pairs:
                _, page_index, error = pairs[0]
                used_page_rows.add(page_index)
                match = {
                    "match_method": "side_time_fee_adjusted_amount",
                    "page_row": page_rows[page_index],
                    "expected_page_amount": round(expected_page_amount(trade), 6),
                    "amount_error_percent": round(error * 100, 4),
                }
        # Exact onchain metadata can identify a trade even when Fomo's displayed
        # value differs too much for the normal fee-adjusted amount check.
        if match is None and trade.get("token_symbol"):
            metadata_candidates = [
                (index, row)
                for index, row in enumerate(page_rows)
                if index not in used_page_rows
                and row["token"].casefold() == trade["token_symbol"].casefold()
                and row["side"] == trade["side"].title()
                and time_compatible(trade, row, snapshot)
            ]
            if len(metadata_candidates) == 1:
                page_index, row = metadata_candidates[0]
                used_page_rows.add(page_index)
                displayed = usd_number(row["usd_amount"])
                error = abs(expected_page_amount(trade) - displayed) / max(displayed, 1)
                match = {
                    "match_method": "onchain_metadata_side_time",
                    "page_row": row,
                    "expected_page_amount": round(expected_page_amount(trade), 6),
                    "amount_error_percent": round(error * 100, 4),
                }
        item = dict(trade)
        item["inferred_symbol"] = symbol_info["symbol"] if symbol_info else None
        item["fomo_page_match"] = match
        reconciled.append(item)

    matched = sum(item["fomo_page_match"] is not None for item in reconciled)
    result = {
        "wallet": trade_data["wallet"],
        "summary": {
            "direct_swap_count": len(trades),
            "matched_to_page_count": matched,
            "direct_swaps_not_on_page_count": len(trades) - matched,
            "page_rows_still_unexplained_count": len(page_rows) - len(used_page_rows),
            "amount_tolerance_percent": MAX_AMOUNT_ERROR * 100,
            "fomo_fee_percent": 0.442,
        },
        "mint_symbols_inferred_from_page": {
            mint: {key: value for key, value in info.items() if key != "matches"}
            for mint, info in inferred.items()
        },
        "trades": reconciled,
        "unexplained_page_rows": [
            row for index, row in enumerate(page_rows) if index not in used_page_rows
        ],
    }
    path = save_json("solana_fomo_reconciliation.json", result)
    print(json.dumps(result["summary"], indent=2))
    print(f"saved {path.relative_to(path.parent.parent)}")


if __name__ == "__main__":
    main()
