"""Normalize saved extraction artifacts into stable analytics records."""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from fomo_analysis.models import NormalizedTrade, decimal_or_none


def parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Trade timestamp must include a timezone")
    return parsed


def _match_key(row: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        row["chain"], row["transaction_id"], row["side"],
        (row.get("token_address_or_mint") or "").lower(),
    )


def load_normalized_trades(
    audit_path: Path,
    priced_path: Path | None = None,
) -> tuple[dict[str, Any], list[NormalizedTrade]]:
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    priced: dict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    if priced_path and priced_path.exists():
        payload = json.loads(priced_path.read_text(encoding="utf-8"))
        for row in payload.get("trades", []):
            priced[_match_key(row)].append(row)

    trader_id = f"evm:{audit['evm_wallet'].lower()}|solana:{audit['solana_wallet']}"
    transaction_leg_counter: dict[tuple[str, str], int] = defaultdict(int)
    records: list[NormalizedTrade] = []
    for row in sorted(audit["trades"], key=lambda item: item["timestamp"]):
        key = _match_key(row)
        transaction_key = (row["chain"], row["transaction_id"])
        leg_index = transaction_leg_counter[transaction_key]
        transaction_leg_counter[transaction_key] += 1
        enriched = priced[key].pop(0) if priced.get(key) else row
        token_amount = decimal_or_none(row.get("token_amount"))
        if token_amount is None or token_amount <= 0:
            continue
        usd_notional = decimal_or_none(enriched.get("atomic_usd"))
        if usd_notional is None and row.get("quote_symbol") in {"USDC", "USDT"}:
            usd_notional = decimal_or_none(row.get("quote_amount"))
        execution_price = usd_notional / token_amount if usd_notional is not None else None
        wallet = audit["solana_wallet"] if row["chain"] == "solana" else audit["evm_wallet"].lower()
        token_address = row["token_address_or_mint"]
        if row["chain"] != "solana":
            token_address = token_address.lower()
        records.append(NormalizedTrade(
            trader_id=trader_id,
            wallet=wallet,
            chain=row["chain"],
            transaction_id=row["transaction_id"],
            leg_index=leg_index,
            timestamp=parse_timestamp(row["timestamp"]),
            side=row["side"].upper(),
            token_address=token_address,
            token_symbol=row.get("token_symbol"),
            token_amount=token_amount,
            usd_notional=usd_notional,
            execution_price_usd=execution_price,
            amount_source=enriched.get("amount_source") or (f"wallet_{row.get('quote_symbol')}_delta" if usd_notional is not None else None),
            evidence=row.get("fomo_evidence", "unknown"),
        ))
    return audit, records
