"""Plain-language capital, FIFO P&L, and current-position accounting.

Gross purchases describe activity.  They are deliberately not called capital:
the same dollars can be reused many times.  The rolling funding calculation
credits sale proceeds only to the extent that the sold quantity came from a
verified Fomo purchase in the observed ledger.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Iterable, Mapping

from fomo_analysis.models import NormalizedTrade


ZERO = Decimal("0")


@dataclass(frozen=True)
class RollingFundingSummary:
    gross_purchase_volume_usd: Decimal
    attributable_sale_proceeds_usd: Decimal
    excluded_sale_proceeds_usd: Decimal
    ending_net_trade_cash_invested_usd: Decimal
    minimum_trade_funding_required_usd: Decimal

    @property
    def capital_reuse_multiple(self) -> Decimal | None:
        if self.minimum_trade_funding_required_usd <= 0:
            return None
        return self.gross_purchase_volume_usd / self.minimum_trade_funding_required_usd

    def as_document(self) -> dict[str, object]:
        return {
            "minimum_incremental_trade_funding_usd": format(
                self.minimum_trade_funding_required_usd, "f"
            ),
            "rolling_capital_deployed_usd": format(
                self.minimum_trade_funding_required_usd, "f"
            ),
            "attributable_sale_proceeds_usd": format(self.attributable_sale_proceeds_usd, "f"),
            "excluded_sale_proceeds_usd": format(self.excluded_sale_proceeds_usd, "f"),
            "ending_net_trade_cash_invested_usd": format(self.ending_net_trade_cash_invested_usd, "f"),
            "capital_reuse_multiple": (
                None if self.capital_reuse_multiple is None
                else format(self.capital_reuse_multiple, "f")
            ),
            "method": "peak cumulative verified-buy cash deficit inside the window after attributable sale proceeds; pre-window trades establish opening inventory only",
            "starting_portfolio_capital_is_not_inferred": True,
            "internal_diagnostic_purchase_volume_usd": format(
                self.gross_purchase_volume_usd, "f"
            ),
        }


def rolling_trade_funding(
    trades: Iterable[NormalizedTrade], *, window_start: datetime | None = None
) -> RollingFundingSummary:
    """Estimate incremental reusable cash needed inside an observation window.

    Pre-window trades establish token inventory but do not enter window cash
    flows. This prevents a 24-hour metric from silently reporting 90-day volume.
    """
    quantities: dict[tuple[str, str], Decimal] = {}
    gross_buys = attributable_sales = excluded_sales = ZERO
    net_cash_invested = peak_deficit = ZERO

    for trade in sorted(trades, key=lambda row: (row.timestamp, row.trade_id)):
        if trade.usd_notional is None:
            continue
        key = (trade.chain, trade.token_address)
        available = quantities.get(key, ZERO)
        inside_window = window_start is None or trade.timestamp >= window_start
        if trade.side == "BUY":
            quantities[key] = available + trade.token_amount
            if not inside_window:
                continue
            gross_buys += trade.usd_notional
            net_cash_invested += trade.usd_notional
            peak_deficit = max(peak_deficit, net_cash_invested)
            continue

        attributable_quantity = min(available, trade.token_amount)
        attributable_fraction = (
            attributable_quantity / trade.token_amount if trade.token_amount else ZERO
        )
        attributable = trade.usd_notional * attributable_fraction
        excluded = trade.usd_notional - attributable
        quantities[key] = max(ZERO, available - attributable_quantity)
        if not inside_window:
            continue
        attributable_sales += attributable
        excluded_sales += excluded
        net_cash_invested -= attributable

    return RollingFundingSummary(
        gross_purchase_volume_usd=gross_buys,
        attributable_sale_proceeds_usd=attributable_sales,
        excluded_sale_proceeds_usd=excluded_sales,
        ending_net_trade_cash_invested_usd=net_cash_invested,
        minimum_trade_funding_required_usd=peak_deficit,
    )


@dataclass
class _KnownLot:
    quantity: Decimal
    cost_usd: Decimal | None
    provenance: str = "verified_fomo_purchase"


@dataclass(frozen=True)
class InventoryAdjustment:
    event_id: str
    chain: str
    token_address: str
    timestamp: datetime
    direction: str
    quantity: Decimal
    classification: str = "unverified_external_transfer"


def build_window_pnl_snapshot(
    trades: Iterable[NormalizedTrade],
    window_start: datetime,
    current_prices_usd: Mapping[tuple[str, str], Decimal],
    *,
    valuation_time: datetime,
    inventory_adjustments: Iterable[InventoryAdjustment] = (),
) -> dict[str, object]:
    """Calculate window realized P&L and current unrealized P&L using FIFO.

    Purchases before ``window_start`` establish carried FIFO basis. Sales that
    exceed verified-purchase inventory are reported but excluded from P&L.
    Current valuation includes only remaining verified-purchase lots; wallet
    balances and external receipts are reconciled separately.
    """
    lots: dict[tuple[str, str], list[_KnownLot]] = {}
    realized = ZERO
    realized_cost = ZERO
    realized_proceeds = ZERO
    excluded_proceeds = ZERO
    priced_sales = 0
    opening_inventory: list[dict[str, str]] | None = None
    realized_sales: list[dict[str, str]] = []

    def inventory_checkpoint() -> list[dict[str, str]]:
        rows = []
        for (chain, token), token_lots in sorted(lots.items()):
            known_quantity = sum(
                (lot.quantity for lot in token_lots if lot.cost_usd is not None), ZERO
            )
            unknown_quantity = sum(
                (lot.quantity for lot in token_lots if lot.cost_usd is None), ZERO
            )
            known_cost = sum(
                (lot.cost_usd for lot in token_lots if lot.cost_usd is not None), ZERO
            )
            if known_quantity > 0 or unknown_quantity > 0:
                rows.append({
                    "chain": chain,
                    "token_address": token,
                    "verified_quantity": format(known_quantity, "f"),
                    "verified_original_cost_basis_usd": format(known_cost, "f"),
                    "external_or_unknown_cost_quantity": format(unknown_quantity, "f"),
                })
        return rows

    trade_rows = list(trades)
    trade_by_id = {row.trade_id: row for row in trade_rows}
    events = [(row.timestamp, 1, row.trade_id, "trade", row) for row in trade_rows]
    events.extend(
        (row.timestamp, 0, row.event_id, "adjustment", row)
        for row in inventory_adjustments
    )
    external_receipt_count = external_transfer_out_count = 0
    for event_time, _, _, event_kind, event in sorted(events):
        if opening_inventory is None and event_time >= window_start:
            opening_inventory = inventory_checkpoint()
        if event_kind == "adjustment":
            key = (event.chain, event.token_address)
            token_lots = lots.setdefault(key, [])
            if event.direction == "IN":
                token_lots.append(_KnownLot(event.quantity, None, event.classification))
                external_receipt_count += 1
            elif event.direction == "OUT":
                remaining = event.quantity
                while remaining > 0 and token_lots:
                    lot = token_lots[0]
                    taken = min(remaining, lot.quantity)
                    if lot.cost_usd is not None:
                        lot.cost_usd -= lot.cost_usd * taken / lot.quantity
                    lot.quantity -= taken
                    remaining -= taken
                    if lot.quantity == 0:
                        token_lots.pop(0)
                external_transfer_out_count += 1
            continue
        trade = event
        key = (trade.chain, trade.token_address)
        token_lots = lots.setdefault(key, [])
        if trade.side == "BUY":
            if trade.usd_notional is None or trade.token_amount <= 0:
                continue
            token_lots.append(_KnownLot(trade.token_amount, trade.usd_notional))
            continue
        if trade.usd_notional is None or trade.token_amount <= 0:
            continue

        remaining = trade.token_amount
        consumed_cost = ZERO
        known_consumed_quantity = unknown_consumed_quantity = ZERO
        unknown_provenance: set[str] = set()
        while remaining > 0 and token_lots:
            lot = token_lots[0]
            taken = min(remaining, lot.quantity)
            cost = (
                None if lot.cost_usd is None
                else lot.cost_usd * taken / lot.quantity
            )
            lot.quantity -= taken
            if lot.cost_usd is not None and cost is not None:
                lot.cost_usd -= cost
            remaining -= taken
            if cost is not None:
                consumed_cost += cost
                known_consumed_quantity += taken
            else:
                unknown_consumed_quantity += taken
                unknown_provenance.add(lot.provenance)
            if lot.quantity == 0:
                token_lots.pop(0)
        inventory_shortfall_quantity = remaining
        if inventory_shortfall_quantity > 0:
            unknown_provenance.add("no_prior_verified_buy_or_receipt_in_observation_window")
        known_fraction = known_consumed_quantity / trade.token_amount
        proceeds = trade.usd_notional * known_fraction
        if trade.timestamp >= window_start:
            priced_sales += 1
            realized_cost += consumed_cost
            realized_proceeds += proceeds
            realized += proceeds - consumed_cost
            excluded_proceeds += trade.usd_notional - proceeds
            realized_sales.append({
                "trade_id": trade.trade_id,
                "timestamp": trade.timestamp.isoformat(),
                "chain": trade.chain,
                "token_address": trade.token_address,
                "sold_quantity": format(trade.token_amount, "f"),
                "verified_fifo_quantity_sold": format(known_consumed_quantity, "f"),
                "unknown_cost_quantity_sold": format(
                    trade.token_amount - known_consumed_quantity, "f"
                ),
                "verified_sale_proceeds_usd": format(proceeds, "f"),
                "excluded_unknown_cost_sale_proceeds_usd": format(
                    trade.usd_notional - proceeds, "f"
                ),
                "fifo_cost_basis_usd": format(consumed_cost, "f"),
                "realized_pnl_usd": format(proceeds - consumed_cost, "f"),
                "inventory_attribution": (
                    "verified_fomo_purchase"
                    if trade.token_amount == known_consumed_quantity
                    else "unattributed_inventory_disposal"
                    if known_consumed_quantity == 0
                    else "partially_attributed_inventory_disposal"
                ),
                "unknown_inventory_provenance": sorted(unknown_provenance),
                "inventory_shortfall_quantity": format(inventory_shortfall_quantity, "f"),
            })

    if opening_inventory is None:
        opening_inventory = inventory_checkpoint()

    positions = []
    known_basis = current_value = unknown_inventory_value = ZERO
    missing_price_basis = ZERO
    for (chain, token), token_lots in sorted(lots.items()):
        known_quantity = sum(
            (lot.quantity for lot in token_lots if lot.cost_usd is not None), ZERO
        )
        unknown_quantity = sum(
            (lot.quantity for lot in token_lots if lot.cost_usd is None), ZERO
        )
        quantity = known_quantity + unknown_quantity
        cost = sum(
            (lot.cost_usd for lot in token_lots if lot.cost_usd is not None), ZERO
        )
        if quantity <= 0:
            continue
        price = current_prices_usd.get((chain, token))
        value = known_quantity * price if price is not None else None
        unknown_value = unknown_quantity * price if price is not None else None
        known_basis += cost
        if value is None:
            missing_price_basis += cost
        else:
            current_value += value
            unknown_inventory_value += unknown_value or ZERO
        positions.append({
            "chain": chain,
            "token_address": token,
            "verified_purchase_quantity": format(known_quantity, "f"),
            "external_or_unknown_cost_quantity": format(unknown_quantity, "f"),
            "remaining_cost_basis_usd": format(cost, "f"),
            "current_price_usd": None if price is None else format(price, "f"),
            "current_value_usd": None if value is None else format(value, "f"),
            "external_or_unknown_cost_current_value_usd": (
                None if unknown_value is None else format(unknown_value, "f")
            ),
            "unrealized_pnl_usd": None if value is None else format(value - cost, "f"),
        })

    priced_basis = known_basis - missing_price_basis
    unrealized = current_value - priced_basis
    unattributed_disposals = [
        {
            "event_id": row["trade_id"],
            "trade_id": row["trade_id"],
            "timestamp": row["timestamp"],
            "chain": row["chain"],
            "token_address": row["token_address"],
            "token_symbol": trade_by_id[row["trade_id"]].token_symbol,
            "sold_quantity": row["sold_quantity"],
            "unknown_cost_quantity_sold": row["unknown_cost_quantity_sold"],
            "sale_proceeds_excluded_from_trade_pnl_usd": row[
                "excluded_unknown_cost_sale_proceeds_usd"
            ],
            "classification": row["inventory_attribution"],
            "inventory_provenance": row["unknown_inventory_provenance"],
            "user_label": "Sold on Fomo; no verified Fomo buy cost was found",
            "included_in_realized_trade_pnl": False,
        }
        for row in realized_sales
        if Decimal(row["unknown_cost_quantity_sold"]) > 0
    ]
    return {
        "window_start": window_start.isoformat(),
        "valuation_time": valuation_time.isoformat(),
        "accounting_method": "FIFO verified Fomo purchases only",
        "realized_pnl_usd": format(realized, "f"),
        "realized_sale_proceeds_usd": format(realized_proceeds, "f"),
        "realized_cost_basis_usd": format(realized_cost, "f"),
        "sale_proceeds_excluded_for_unknown_inventory_usd": format(excluded_proceeds, "f"),
        "priced_sale_count": priced_sales,
        "opening_fifo_inventory": opening_inventory,
        "opening_verified_cost_basis_usd": format(sum(
            (Decimal(row["verified_original_cost_basis_usd"]) for row in opening_inventory),
            ZERO,
        ), "f"),
        "opening_unknown_cost_token_count": sum(
            Decimal(row["external_or_unknown_cost_quantity"]) > 0
            for row in opening_inventory
        ),
        "realized_sales": realized_sales,
        "unattributed_inventory_disposals": unattributed_disposals,
        "unattributed_inventory_disposal_count": len(unattributed_disposals),
        "open_verified_cost_basis_usd": format(known_basis, "f"),
        "open_verified_current_value_usd": format(current_value, "f"),
        "open_cost_basis_missing_current_price_usd": format(missing_price_basis, "f"),
        "unrealized_pnl_on_priced_verified_inventory_usd": format(unrealized, "f"),
        "realized_plus_unrealized_pnl_usd": format(realized + unrealized, "f"),
        "external_or_unknown_cost_current_value_usd": format(unknown_inventory_value, "f"),
        "external_receipt_count": external_receipt_count,
        "external_transfer_out_count": external_transfer_out_count,
        "open_positions": positions,
    }


def build_fifo_period_metrics(
    snapshot: Mapping[str, object],
    cutoff_prices_usd: Mapping[tuple[str, str], Decimal],
) -> dict[str, object]:
    """Convert lifetime FIFO basis into true window mark-to-market P&L."""
    opening_value = opening_basis_priced = opening_basis_unpriced = ZERO
    priced_positions = 0
    for row in snapshot.get("opening_fifo_inventory", []):  # type: ignore[union-attr]
        chain = str(row["chain"])
        token = str(row["token_address"])
        quantity = Decimal(str(row["verified_quantity"]))
        basis = Decimal(str(row["verified_original_cost_basis_usd"]))
        if quantity <= 0 and basis <= 0:
            continue
        price = cutoff_prices_usd.get((chain, token))
        if price is None:
            opening_basis_unpriced += basis
            continue
        opening_value += quantity * price
        opening_basis_priced += basis
        priced_positions += 1
    opening_unrealized = opening_value - opening_basis_priced
    realized = Decimal(str(snapshot["realized_pnl_usd"]))
    ending_unrealized = Decimal(
        str(snapshot["unrealized_pnl_on_priced_verified_inventory_usd"])
    )
    return {
        "realized_trade_pnl_usd": format(realized, "f"),
        "ending_unrealized_pnl_on_original_fifo_basis_usd": format(
            ending_unrealized, "f"
        ),
        "opening_unrealized_pnl_at_cutoff_usd": format(opening_unrealized, "f"),
        "period_unrealized_pnl_change_usd": format(
            ending_unrealized - opening_unrealized, "f"
        ),
        "period_total_trade_pnl_usd": format(
            realized + ending_unrealized - opening_unrealized, "f"
        ),
        "opening_verified_fifo_value_usd": format(opening_value, "f"),
        "opening_verified_fifo_basis_priced_usd": format(opening_basis_priced, "f"),
        "opening_verified_fifo_basis_missing_cutoff_price_usd": format(
            opening_basis_unpriced, "f"
        ),
        "opening_priced_position_count": priced_positions,
        "accounting_method": "realized FIFO P&L plus change in unrealized FIFO P&L during the window",
    }
