"""Compare pasted Fomo activity rows with extracted onchain settlement legs."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from scripts.rpc_utils import OUTPUT_DIR, save_json


ROW_TIME = re.compile(r"^(\d+)(m|h|d|w|mo)$")
TOKEN_SYMBOL_ALIASES = {
    # This BNB contract reports S5B, while Fomo displays its SPCXB market symbol.
    ("bnb", "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1"): "SPCXB",
}


def parse_rows(text: str) -> tuple[list[dict[str, str]], list[str]]:
    values = [
        line.strip()
        for line in text.splitlines()
        if line.strip() and line.strip() != "?"
    ]
    header = ["Token", "Action", "Amount", "MCap", "Time"]
    if all(item in values for item in header):
        start = next(
            index
            for index in range(len(values) - len(header) + 1)
            if values[index : index + len(header)] == header
        )
        values = values[start + len(header) :]
    elif values[:4] == ["Action", "Amount", "MCap", "Time"]:
        values = values[4:]
    rows = []
    position = 0
    while position + 4 < len(values):
        token, side, usd_amount, market_cap, relative_time = values[position : position + 5]
        if side not in {"Buy", "Sell"} or not ROW_TIME.match(relative_time):
            break
        rows.append(
            {
                "token": token,
                "side": side,
                "usd_amount": usd_amount,
                "market_cap": market_cap,
                "relative_time": relative_time,
            }
        )
        position += 5
    return rows, values[position:]


def age_bounds(label: str) -> tuple[float, float]:
    value_text, unit = ROW_TIME.match(label).groups()  # type: ignore[union-attr]
    value = int(value_text)
    if unit == "m":
        return max(0, value * 60 - 600), (value + 1) * 60 + 600
    if unit == "h":
        return max(0, value * 3600 - 900), (value + 1) * 3600 + 900
    if unit == "d":
        return max(0, value * 86400 - 7200), (value + 1) * 86400 + 7200
    if unit == "w":
        return max(0, value * 7 * 86400 - 43200), (value + 1) * 7 * 86400 + 43200
    return max(0, value * 30 * 86400 - 3 * 86400), (value + 1) * 30 * 86400 + 3 * 86400


def load_onchain_records() -> list[dict[str, Any]]:
    records = []
    for chain in ("base", "robinhood", "bnb"):
        path = OUTPUT_DIR / f"fomo_trade_movements_{chain}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        for record in data["records"]:
            if record["classification"] == "STABLECOIN_PAYMENT":
                continue
            record = dict(record)
            record["token_symbol"] = TOKEN_SYMBOL_ALIASES.get(
                (chain, (record.get("token_address") or "").lower()),
                record["token_symbol"],
            )
            record["side"] = (
                "Buy"
                if record["classification"] == "TOKEN_CREDIT_FROM_SETTLEMENT"
                else "Sell"
            )
            records.append(record)
    return records


def compare(
    page_rows: list[dict[str, str]], records: list[dict[str, Any]], snapshot: datetime
) -> list[dict[str, Any]]:
    used: set[tuple[str, str]] = set()
    comparisons = []
    for index, page_row in enumerate(page_rows, start=1):
        lower, upper = age_bounds(page_row["relative_time"])
        candidates = []
        for record in records:
            identity = (record["chain"], record["transfer_log_id"])
            if identity in used:
                continue
            timestamp = datetime.fromisoformat(record["timestamp"].replace("Z", "+00:00"))
            age = (snapshot - timestamp).total_seconds()
            if (
                record["token_symbol"] == page_row["token"]
                and record["side"] == page_row["side"]
                and lower <= age <= upper
            ):
                candidates.append((record, age))
        center = (lower + upper) / 2
        candidates.sort(key=lambda item: abs(item[1] - center))
        matched = candidates[0][0] if candidates else None
        result: dict[str, Any] = {"page_index": index, "page": page_row, "matched": bool(matched)}
        if matched:
            used.add((matched["chain"], matched["transfer_log_id"]))
            result["onchain"] = {
                "chain": matched["chain"],
                "timestamp": matched["timestamp"],
                "transaction_hash": matched["transaction_hash"],
                "token_address": matched["token_address"],
                "token_amount": matched["amount"],
                "classification": matched["classification"],
                "user_op_hash": (matched["erc4337_user_operation"] or {}).get("user_op_hash"),
            }
        comparisons.append(result)
    return comparisons


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("page_text", type=Path)
    args = parser.parse_args()
    page_rows, trailing = parse_rows(args.page_text.read_text(encoding="utf-8"))
    snapshot = datetime.fromtimestamp(args.page_text.stat().st_mtime, tz=timezone.utc)
    comparisons = compare(page_rows, load_onchain_records(), snapshot)
    matched = [item for item in comparisons if item["matched"]]
    unmatched = [item for item in comparisons if not item["matched"]]
    summary = {
        "snapshot_time": snapshot.isoformat(),
        "complete_page_rows": len(page_rows),
        "matched_rows": len(matched),
        "unmatched_rows": len(unmatched),
        "match_rate_percent": round(100 * len(matched) / len(page_rows), 2) if page_rows else 0,
        "matched_by_chain": dict(Counter(item["onchain"]["chain"] for item in matched)),
        "unmatched_by_token_and_side": [
            {"token": token, "side": side, "count": count}
            for (token, side), count in sorted(
                Counter((item["page"]["token"], item["page"]["side"]) for item in unmatched).items(),
                key=lambda item: (-item[1], item[0]),
            )
        ],
        "ignored_trailing_values": trailing,
    }
    path = save_json(
        "fomo_page_comparison.json",
        {"summary": summary, "comparisons": comparisons},
    )
    print(json.dumps(summary, indent=2))
    print(f"saved {path.relative_to(path.parent.parent)}")


if __name__ == "__main__":
    main()
