"""Realized purchase-to-disposal accounting for Yieldr V3.3."""

from __future__ import annotations

from collections import defaultdict, deque
from decimal import Decimal
from typing import Any, Iterable

from fomo_analysis.action_analysis import EconomicAction


MODEL_VERSION = "3.3.0"
ZERO = Decimal("0")


def _text(value: Decimal | None) -> str | None:
    return None if value is None else format(value, "f")


def attribute_realized_action_economics(
    actions: Iterable[EconomicAction],
) -> dict[str, dict[str, Any]]:
    """Attribute each disposal to acquisition actions using FIFO quantities.

    Completed acquisition outcomes are the primary V3.3 validation unit. Partial
    realization remains visible but is never treated as a completed observation.
    """
    ordered = sorted(actions, key=lambda row: (row.timestamp, row.action_id))
    lots: dict[str, dict[str, Any]] = {}
    open_lots: dict[tuple[str, str, str], deque[str]] = defaultdict(deque)
    sell_results: dict[str, dict[str, Any]] = {}

    for action in ordered:
        key = (action.trader_id, action.chain, action.token_address)
        if action.side == "BUY":
            unit_cost = (
                action.usd_notional / action.token_amount
                if action.usd_notional is not None and action.token_amount > ZERO
                else None
            )
            lots[action.action_id] = {
                "action_id": action.action_id,
                "acquired_quantity": action.token_amount,
                "remaining_quantity": action.token_amount,
                "acquisition_cost_usd": action.usd_notional,
                "unit_cost_usd": unit_cost,
                "disposed_quantity": ZERO,
                "disposed_cost_basis_usd": ZERO,
                "allocated_sale_proceeds_usd": ZERO,
                "disposal_action_ids": [],
                "last_disposed_at": None,
                "accounting_complete": action.usd_notional is not None,
            }
            open_lots[key].append(action.action_id)
            continue

        if action.side != "SELL":
            continue
        quantity_left = action.token_amount
        sale_unit_price = (
            action.usd_notional / action.token_amount
            if action.usd_notional is not None and action.token_amount > ZERO
            else None
        )
        allocated_cost = ZERO
        allocated_proceeds = ZERO
        allocated_quantity = ZERO
        source_lots: list[dict[str, str]] = []
        while quantity_left > ZERO and open_lots[key]:
            lot_id = open_lots[key][0]
            lot = lots[lot_id]
            quantity = min(quantity_left, lot["remaining_quantity"])
            cost = lot["unit_cost_usd"] * quantity if lot["unit_cost_usd"] is not None else None
            proceeds = sale_unit_price * quantity if sale_unit_price is not None else None
            lot["disposed_quantity"] += quantity
            lot["remaining_quantity"] -= quantity
            lot["last_disposed_at"] = action.timestamp
            lot["disposal_action_ids"].append(action.action_id)
            if cost is None or proceeds is None:
                lot["accounting_complete"] = False
            else:
                lot["disposed_cost_basis_usd"] += cost
                lot["allocated_sale_proceeds_usd"] += proceeds
                allocated_cost += cost
                allocated_proceeds += proceeds
            allocated_quantity += quantity
            source_lots.append({"acquisition_action_id": lot_id, "quantity": _text(quantity)})
            quantity_left -= quantity
            if lot["remaining_quantity"] <= Decimal("1e-18"):
                lot["remaining_quantity"] = ZERO
                open_lots[key].popleft()
        if allocated_quantity == ZERO and quantity_left > ZERO:
            realization_status = "unavailable_opening_inventory_cost_basis"
        elif quantity_left > ZERO:
            realization_status = "partially_attributed_opening_inventory_gap"
        elif action.usd_notional is None or any(
            not lots[row["acquisition_action_id"]]["accounting_complete"]
            for row in source_lots
        ):
            realization_status = "unavailable_unknown_cost_or_proceeds"
        else:
            realization_status = "realized"
        sell_results[action.action_id] = {
            "outcome_unit": "disposal_action",
            "realization_status": realization_status,
            "disposed_quantity": _text(allocated_quantity),
            "unmatched_disposal_quantity": _text(quantity_left),
            "realized_cost_basis_usd": _text(allocated_cost) if allocated_quantity else None,
            "sale_proceeds_usd": _text(allocated_proceeds) if allocated_quantity else None,
            "realized_pnl_usd": _text(allocated_proceeds - allocated_cost) if allocated_quantity else None,
            "realized_return_pct": _text(
                (allocated_proceeds / allocated_cost - Decimal(1)) * Decimal(100)
                if allocated_cost > ZERO else None
            ),
            "source_acquisition_lots": source_lots,
            "accounting_method": "fifo_purchase_to_disposal",
        }

    output = dict(sell_results)
    for action_id, lot in lots.items():
        cost = lot["disposed_cost_basis_usd"]
        proceeds = lot["allocated_sale_proceeds_usd"]
        completed = lot["remaining_quantity"] == ZERO
        if not lot["accounting_complete"]:
            status = "unavailable_unknown_cost_or_proceeds"
        elif completed:
            status = "completed"
        elif lot["disposed_quantity"] > ZERO:
            status = "partially_realized"
        else:
            status = "open_pending_disposal"
        output[action_id] = {
            "outcome_unit": "acquisition_action",
            "realization_status": status,
            "is_completed_observation": completed and lot["accounting_complete"],
            "acquired_quantity": _text(lot["acquired_quantity"]),
            "disposed_quantity": _text(lot["disposed_quantity"]),
            "remaining_quantity": _text(lot["remaining_quantity"]),
            "acquisition_cost_usd": _text(lot["acquisition_cost_usd"]),
            "realized_cost_basis_usd": _text(cost),
            "allocated_sale_proceeds_usd": _text(proceeds),
            "realized_pnl_usd": _text(proceeds - cost) if cost > ZERO else None,
            "realized_return_pct": _text(
                (proceeds / cost - Decimal(1)) * Decimal(100) if cost > ZERO else None
            ),
            "completed_at": lot["last_disposed_at"].isoformat() if completed and lot["last_disposed_at"] else None,
            "disposal_action_ids": lot["disposal_action_ids"],
            "accounting_method": "fifo_purchase_to_disposal",
        }
    return output


def attach_realized_economics(
    action_rows: Iterable[dict[str, Any]],
    economics: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Attach primary realized economics while retaining OHLC timing diagnostics."""
    output = []
    for row in action_rows:
        timing = {
            "horizon_minutes": row.get("outcome_horizon_minutes"),
            "price_return_pct": row.get("forward_price_return_60m_pct"),
            "evaluation_status": row.get("evaluation_status"),
            "favorable_for_action": row.get("favorable_outcome"),
            "role": "supporting_timing_diagnostic_not_economic_edge_target",
        }
        result = dict(row)
        result["realized_economic_outcome"] = economics.get(row["action_id"], {
            "realization_status": "not_applicable",
            "outcome_unit": "inventory_event",
        })
        result["timing_diagnostic_1h"] = timing
        result["primary_outcome_target"] = (
            "completed_acquisition_realized_return"
            if row.get("side") == "BUY"
            else "actual_disposal_realized_pnl"
            if row.get("side") == "SELL"
            else None
        )
        output.append(result)
    return output
