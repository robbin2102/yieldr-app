"""Explicit FIFO inventory provenance for transfers and unknown-cost receipts."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Iterable


ZERO = Decimal("0")


@dataclass(frozen=True)
class InventoryEvent:
    event_id: str
    trader_id: str
    chain: str
    token_address: str
    timestamp: datetime
    event_type: str
    quantity: Decimal
    usd_value: Decimal | None = None
    linked_wallet_verified: bool = False
    carried_cost_usd: Decimal | None = None
    original_acquired_at: datetime | None = None
    source_transaction_ids: tuple[str, ...] = ()


@dataclass
class InventoryLot:
    quantity: Decimal
    known_cost_usd: Decimal | None
    acquired_at: datetime
    original_acquired_at: datetime
    provenance: str
    source_event_id: str


@dataclass
class InventoryLedger:
    lots: list[InventoryLot] = field(default_factory=list)
    realized_known_cost_pnl_usd: Decimal = ZERO
    sale_proceeds_unknown_cost_usd: Decimal = ZERO
    excluded_unknown_cost_quantity_sold: Decimal = ZERO
    transfer_out_quantity: Decimal = ZERO
    warnings: list[str] = field(default_factory=list)

    @property
    def known_cost_quantity(self) -> Decimal:
        return sum((lot.quantity for lot in self.lots if lot.known_cost_usd is not None), ZERO)

    @property
    def unknown_cost_quantity(self) -> Decimal:
        return sum((lot.quantity for lot in self.lots if lot.known_cost_usd is None), ZERO)

    def as_document(self) -> dict[str, Any]:
        return {
            "allocation_method": "FIFO_fixed_before_evaluation",
            "known_cost_quantity": format(self.known_cost_quantity, "f"),
            "unknown_cost_quantity": format(self.unknown_cost_quantity, "f"),
            "realized_known_cost_pnl_usd": format(self.realized_known_cost_pnl_usd, "f"),
            "sale_proceeds_unknown_cost_usd": format(self.sale_proceeds_unknown_cost_usd, "f"),
            "excluded_unknown_cost_quantity_sold": format(self.excluded_unknown_cost_quantity_sold, "f"),
            "transfer_out_quantity": format(self.transfer_out_quantity, "f"),
            "warnings": self.warnings,
            "lots": [
                {
                    "quantity": format(lot.quantity, "f"),
                    "known_cost_usd": (
                        None if lot.known_cost_usd is None else format(lot.known_cost_usd, "f")
                    ),
                    "acquired_at": lot.acquired_at.isoformat(),
                    "original_acquired_at": lot.original_acquired_at.isoformat(),
                    "provenance": lot.provenance,
                    "source_event_id": lot.source_event_id,
                }
                for lot in self.lots
            ],
        }


def _consume_fifo(ledger: InventoryLedger, quantity: Decimal) -> list[tuple[InventoryLot, Decimal, Decimal | None]]:
    remaining = quantity
    consumed = []
    while remaining > 0 and ledger.lots:
        lot = ledger.lots[0]
        taken = min(remaining, lot.quantity)
        cost = (
            lot.known_cost_usd * taken / lot.quantity
            if lot.known_cost_usd is not None and lot.quantity else None
        )
        consumed.append((lot, taken, cost))
        lot.quantity -= taken
        if lot.known_cost_usd is not None and cost is not None:
            lot.known_cost_usd -= cost
        remaining -= taken
        if lot.quantity == 0:
            ledger.lots.pop(0)
    if remaining > 0:
        ledger.warnings.append(f"inventory_shortfall:{format(remaining, 'f')}")
    return consumed


def replay_inventory(events: Iterable[InventoryEvent]) -> InventoryLedger:
    """Replay inventory without treating transfers as trades or inventing cost."""
    ledger = InventoryLedger()
    for event in sorted(events, key=lambda row: (row.timestamp, row.event_id)):
        if event.quantity <= 0:
            continue
        if event.event_type == "verified_purchase":
            ledger.lots.append(InventoryLot(
                quantity=event.quantity,
                known_cost_usd=event.usd_value,
                acquired_at=event.timestamp,
                original_acquired_at=event.timestamp,
                provenance="verified_purchase",
                source_event_id=event.event_id,
            ))
        elif event.event_type == "linked_wallet_transfer_in":
            known = event.linked_wallet_verified and event.carried_cost_usd is not None
            ledger.lots.append(InventoryLot(
                quantity=event.quantity,
                known_cost_usd=event.carried_cost_usd if known else None,
                acquired_at=event.timestamp,
                original_acquired_at=event.original_acquired_at or event.timestamp,
                provenance=(
                    "verified_linked_wallet_cost_carried"
                    if known else "linked_wallet_cost_unavailable"
                ),
                source_event_id=event.event_id,
            ))
        elif event.event_type in {"unknown_receipt", "verified_reward_airdrop"}:
            ledger.lots.append(InventoryLot(
                quantity=event.quantity,
                known_cost_usd=(
                    event.carried_cost_usd
                    if event.event_type == "verified_reward_airdrop" else None
                ),
                acquired_at=event.timestamp,
                original_acquired_at=event.original_acquired_at or event.timestamp,
                provenance=event.event_type,
                source_event_id=event.event_id,
            ))
        elif event.event_type == "transfer_out":
            consumed = _consume_fifo(ledger, event.quantity)
            ledger.transfer_out_quantity += sum((quantity for _, quantity, _ in consumed), ZERO)
        elif event.event_type == "verified_sale":
            consumed = _consume_fifo(ledger, event.quantity)
            total_consumed = sum((quantity for _, quantity, _ in consumed), ZERO)
            for _, quantity, cost in consumed:
                proceeds = (
                    event.usd_value * quantity / total_consumed
                    if event.usd_value is not None and total_consumed else None
                )
                if cost is not None and proceeds is not None:
                    ledger.realized_known_cost_pnl_usd += proceeds - cost
                elif proceeds is not None:
                    ledger.sale_proceeds_unknown_cost_usd += proceeds
                    ledger.excluded_unknown_cost_quantity_sold += quantity
        else:
            ledger.warnings.append(f"unsupported_inventory_event:{event.event_type}")
    return ledger
