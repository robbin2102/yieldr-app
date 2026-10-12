"""Identify wallet token movements that are not verified Fomo trade legs."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterable

from fomo_analysis.portfolio_accounting import InventoryAdjustment
from scripts.extract_fomo_trades import classify
from scripts.parse_solana_trades import parse_transaction


FOMO_INTERNAL_FUNDING_INSTRUCTIONS = {"DepositToken", "WithdrawToken"}


def _evm_amount(row: dict[str, Any]) -> Decimal | None:
    raw = row.get("rawContract") or {}
    value = raw.get("value")
    decimals = raw.get("decimal")
    if not value or decimals is None:
        return None
    return Decimal(int(value, 16)) / (Decimal(10) ** int(decimals, 16))


def extract_evm_external_flows(
    chain: str, transfers: Iterable[dict[str, Any]], wallet: str
) -> list[InventoryAdjustment]:
    """Return direct wallet flows, excluding every transaction with a Fomo leg."""
    wallet = wallet.lower()
    rows = list(transfers)
    fomo_hashes = {
        row["hash"] for row in rows if classify(row, wallet) is not None
    }
    adjustments = []
    for row in rows:
        if row.get("hash") in fomo_hashes:
            continue
        sender = str(row.get("from") or "").lower()
        recipient = str(row.get("to") or "").lower()
        if wallet not in {sender, recipient}:
            continue
        quantity = _evm_amount(row)
        token = str((row.get("rawContract") or {}).get("address") or "").lower()
        timestamp = (row.get("metadata") or {}).get("blockTimestamp")
        if not token or not timestamp or quantity is None or quantity <= 0:
            continue
        adjustments.append(InventoryAdjustment(
            event_id=f"{chain}:{row.get('uniqueId') or row['hash']}",
            chain=chain,
            token_address=token,
            timestamp=datetime.fromisoformat(timestamp.replace("Z", "+00:00")),
            direction="IN" if recipient == wallet else "OUT",
            quantity=quantity,
            classification="unverified_external_token_transfer",
        ))
    return adjustments


def extract_solana_external_flows(
    transactions: Iterable[dict[str, Any]], wallet: str
) -> list[InventoryAdjustment]:
    """Return owner-balance deltas from non-Fomo Solana transactions."""
    adjustments = []
    for transaction in transactions:
        parsed = parse_transaction(transaction, wallet)
        if parsed["fomo_marker_present"]:
            continue
        if FOMO_INTERNAL_FUNDING_INSTRUCTIONS & set(parsed["instruction_names"]):
            continue
        timestamp = datetime.fromtimestamp(transaction["blockTime"], tz=timezone.utc)
        for index, delta in enumerate(parsed["wallet_token_deltas"]):
            quantity = Decimal(delta["ui_delta"])
            if quantity == 0:
                continue
            adjustments.append(InventoryAdjustment(
                event_id=f"solana:{parsed['signature']}:{index}",
                chain="solana",
                token_address=delta["mint"],
                timestamp=timestamp,
                direction="IN" if quantity > 0 else "OUT",
                quantity=abs(quantity),
                classification="unverified_external_token_balance_change",
            ))
    return adjustments


def extract_solana_fomo_internal_funding(
    transactions: Iterable[dict[str, Any]], wallet: str
) -> list[InventoryAdjustment]:
    """Keep Fomo deposits/withdrawals visible without calling them external flows."""
    adjustments = []
    for transaction in transactions:
        parsed = parse_transaction(transaction, wallet)
        instructions = FOMO_INTERNAL_FUNDING_INSTRUCTIONS & set(parsed["instruction_names"])
        if not instructions:
            continue
        timestamp = datetime.fromtimestamp(transaction["blockTime"], tz=timezone.utc)
        for index, delta in enumerate(parsed["wallet_token_deltas"]):
            quantity = Decimal(delta["ui_delta"])
            if quantity == 0:
                continue
            adjustments.append(InventoryAdjustment(
                event_id=f"solana:{parsed['signature']}:{index}", chain="solana",
                token_address=delta["mint"], timestamp=timestamp,
                direction="IN" if quantity > 0 else "OUT", quantity=abs(quantity),
                classification="fomo_internal_funding_" + "_".join(sorted(instructions)).lower(),
            ))
    return adjustments


def extract_external_flows(
    raw: dict[str, Any], evm_wallet: str, solana_wallet: str
) -> list[InventoryAdjustment]:
    rows = []
    for chain in ("base", "robinhood", "bnb"):
        rows.extend(extract_evm_external_flows(chain, raw.get(chain, []), evm_wallet))
    rows.extend(extract_solana_external_flows(raw.get("solana", []), solana_wallet))
    return sorted(rows, key=lambda row: (row.timestamp, row.event_id))


def wallet_token_deltas_after(
    raw: dict[str, Any], evm_wallet: str, solana_wallet: str, cutoff: datetime
) -> dict[tuple[str, str], Decimal]:
    """Aggregate every wallet token balance change after a cutoff.

    This includes Fomo trades and external transfers and is therefore suitable
    for reversing today's balance into a historical opening balance.
    """
    result: dict[tuple[str, str], Decimal] = {}
    wallet = evm_wallet.lower()
    for chain in ("base", "robinhood", "bnb"):
        for row in raw.get(chain, []):
            timestamp = datetime.fromisoformat(
                row["metadata"]["blockTimestamp"].replace("Z", "+00:00")
            )
            if timestamp < cutoff:
                continue
            quantity = _evm_amount(row)
            token = str((row.get("rawContract") or {}).get("address") or "").lower()
            if not token or quantity is None:
                continue
            delta = Decimal("0")
            if str(row.get("to") or "").lower() == wallet:
                delta += quantity
            if str(row.get("from") or "").lower() == wallet:
                delta -= quantity
            key = (chain, token)
            result[key] = result.get(key, Decimal("0")) + delta
    for transaction in raw.get("solana", []):
        timestamp = datetime.fromtimestamp(transaction["blockTime"], tz=timezone.utc)
        if timestamp < cutoff:
            continue
        parsed = parse_transaction(transaction, solana_wallet)
        for delta in parsed["wallet_token_deltas"]:
            key = ("solana", delta["mint"])
            result[key] = result.get(key, Decimal("0")) + Decimal(delta["ui_delta"])
    return result
