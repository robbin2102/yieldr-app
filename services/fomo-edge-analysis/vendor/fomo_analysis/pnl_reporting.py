"""Build an auditable dual-view P&L summary for V3.3 reports."""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from decimal import Decimal
from typing import Any, Iterable


ZERO = Decimal("0")


def _decimal(value: Any) -> Decimal:
    return ZERO if value in (None, "") else Decimal(str(value))


def relative_time_is_inside_days(label: str, days: int) -> bool:
    """Conservatively include UI-relative rows strictly inside a day window."""
    match = re.fullmatch(r"(\d+)(m|h|d|w|mo)", str(label).strip())
    if not match:
        return False
    count, unit = int(match.group(1)), match.group(2)
    if unit in {"m", "h"}:
        return True
    if unit == "d":
        return count < days
    return False


def map_unattributed_ui_sells(
    reconciliation: dict[str, Any], window_days: int
) -> list[dict[str, Any]]:
    """Map sells visible in Fomo UI that lack a normalized onchain trade match.

    These are evidence of displayed proceeds, not proof of an external transfer or
    zero economic cost basis. The zero-basis amount is retained only to explain a
    possible Fomo UI accounting convention.
    """
    rows = []
    for source in reconciliation.get("unmatched_ui", []):
        if source.get("side") != "SELL" or not relative_time_is_inside_days(
            str(source.get("relative_time", "")), window_days
        ):
            continue
        identity = "|".join(
            str(source.get(key, ""))
            for key in ("ui_index", "token_symbol", "relative_time", "amount_usd")
        )
        proceeds = _decimal(source.get("amount_usd"))
        rows.append({
            "event_id": hashlib.sha256(identity.encode()).hexdigest(),
            "token_symbol": source.get("token_symbol"),
            "side": "SELL",
            "relative_time": source.get("relative_time"),
            "displayed_sale_proceeds_usd": format(proceeds, "f"),
            "evidence_status": "fomo_ui_only_unmatched_sell",
            "economic_classification": "unattributed_inventory_disposal",
            "possible_source": "external_or_custodial_inventory_without_verified_fomo_buy",
            "verified_acquisition_cost_usd": None,
            "verified_realized_pnl_usd": None,
            "zero_basis_ui_bridge_usd": format(proceeds, "f"),
            "included_in_verified_trade_pnl": False,
            "onchain_transaction_id": None,
            "warning": "Displayed proceeds are not economically proven profit.",
        })
    return rows


def _group_unattributed(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"sell_count": 0, "displayed_sale_proceeds_usd": ZERO}
    )
    for row in rows:
        item = grouped[str(row.get("token_symbol") or "UNKNOWN")]
        item["sell_count"] += 1
        item["displayed_sale_proceeds_usd"] += _decimal(
            row["displayed_sale_proceeds_usd"]
        )
    return [
        {
            "token_symbol": symbol,
            "sell_count": values["sell_count"],
            "displayed_sale_proceeds_usd": format(
                values["displayed_sale_proceeds_usd"], "f"
            ),
        }
        for symbol, values in sorted(
            grouped.items(),
            key=lambda item: item[1]["displayed_sale_proceeds_usd"],
            reverse=True,
        )
    ]


def build_v3_3_pnl_reporting(
    portfolio_snapshot: dict[str, Any],
    *,
    ui_reconciliation: dict[str, Any] | None = None,
    position_stories: Iterable[dict[str, Any]] = (),
) -> dict[str, Any]:
    """Combine verified FIFO economics with onchain-derived disposal warnings."""
    window_days = int(portfolio_snapshot["window_days"])
    pnl = portfolio_snapshot["pnl_window"]
    period = pnl.get("period_metrics") or {}
    realized = _decimal(period.get("realized_trade_pnl_usd", pnl["realized_pnl_usd"]))
    unrealized = _decimal(
        period.get(
            "period_unrealized_pnl_change_usd",
            pnl["unrealized_pnl_on_priced_verified_inventory_usd"],
        )
    )
    verified_total = _decimal(
        period.get("period_total_trade_pnl_usd", realized + unrealized)
    )
    unattributed = list(pnl.get("unattributed_inventory_disposals") or [])
    unattributed_proceeds = sum(
        (
            _decimal(row.get("sale_proceeds_excluded_from_trade_pnl_usd"))
            for row in unattributed
        ),
        ZERO,
    )
    fomo_reference_payload = portfolio_snapshot.get("fomo_ui_reference") or {}
    fomo_reference_raw = fomo_reference_payload.get(
        "pnl_usd", fomo_reference_payload.get("pnl_window_usd")
    )
    fomo_reference = _decimal(fomo_reference_raw)
    ui_only = map_unattributed_ui_sells(ui_reconciliation or {}, window_days)
    ui_only_proceeds = sum(
        (_decimal(row["zero_basis_ui_bridge_usd"]) for row in ui_only), ZERO
    )
    stories = list(position_stories)
    closed = [
        {
            "position_id": row.get("position_id"),
            "chain": row.get("chain"),
            "token_address": row.get("token_address"),
            "token_symbol": row.get("token_symbol"),
            "economics": row.get("economics"),
        }
        for row in stories
        if row.get("position_state") == "closed"
    ]
    actual = portfolio_snapshot.get("actual_wallet_portfolio") or {}
    return {
        "window_days": window_days,
        "valuation_time": portfolio_snapshot.get("valuation_time"),
        "accounting_policy": {
            "verified_trade_pnl": "FIFO purchases with verified Fomo buy legs only",
            "unattributed_disposals": "Detected from onchain sell legs whose FIFO quantity lacks a verified Fomo buy cost; always kept outside trade P&L",
        },
        "verified_trade_pnl": {
            "realized_pnl_usd": format(realized, "f"),
            "unrealized_pnl_usd": format(unrealized, "f"),
            "total_trade_pnl_usd": format(verified_total, "f"),
        },
        "unattributed_disposals": {
            "event_count": len(unattributed),
            "sale_proceeds_excluded_from_trade_pnl_usd": format(unattributed_proceeds, "f"),
            "by_token": _group_onchain_unattributed(unattributed),
            "events": unattributed,
            "classification_status": "onchain_observed_unknown_cost_inventory_disposal",
            "user_label": "Sold on Fomo; no verified Fomo buy cost was found",
            "included_in_verified_trade_pnl": False,
        },
        "pnl_intervals": _interval_summaries(portfolio_snapshot),
        "development_ui_reconciliation": {
            "available": bool(ui_reconciliation),
            "ui_only_unmatched_sell_count": len(ui_only),
            "ui_only_unmatched_sell_proceeds_usd": format(ui_only_proceeds, "f"),
            "fomo_ui_reference_pnl_usd": (
                None if fomo_reference_raw in (None, "") else format(fomo_reference, "f")
            ),
            "excluded_from_production_pnl": True,
        },
        "open_positions": {
            "position_count": actual.get("position_count"),
            "material_position_count": actual.get("material_open_position_count"),
            "priced_wallet_value_usd": actual.get("priced_token_value_usd"),
            "material_positions": actual.get("material_open_positions", []),
            "fifo_positions": pnl.get("open_positions", []),
        },
        "closed_positions": {
            "position_count": len(closed),
            "positions": closed,
        },
        "other_unknown_cost_inventory": {
            "onchain_sale_proceeds_excluded_from_verified_pnl_usd": pnl.get(
                "sale_proceeds_excluded_for_unknown_inventory_usd"
            ),
            "current_unknown_cost_inventory_value_usd": pnl.get(
                "external_or_unknown_cost_current_value_usd"
            ),
            "warning": "Not added to the UI bridge because it may overlap UI rows or represent non-Fomo inventory.",
        },
    }


def _group_onchain_unattributed(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str, str], dict[str, Any]] = defaultdict(
        lambda: {"sell_count": 0, "sale_proceeds_excluded_from_trade_pnl_usd": ZERO}
    )
    for row in rows:
        key = (
            str(row.get("chain") or "unknown"),
            str(row.get("token_address") or "unknown"),
            str(row.get("token_symbol") or "UNKNOWN"),
        )
        item = grouped[key]
        item["sell_count"] += 1
        item["sale_proceeds_excluded_from_trade_pnl_usd"] += _decimal(
            row.get("sale_proceeds_excluded_from_trade_pnl_usd")
        )
    return [
        {
            "chain": key[0],
            "token_address": key[1],
            "token_symbol": key[2],
            "sell_count": values["sell_count"],
            "sale_proceeds_excluded_from_trade_pnl_usd": format(
                values["sale_proceeds_excluded_from_trade_pnl_usd"], "f"
            ),
        }
        for key, values in sorted(
            grouped.items(),
            key=lambda item: item[1]["sale_proceeds_excluded_from_trade_pnl_usd"],
            reverse=True,
        )
    ]


def _interval_summaries(snapshot: dict[str, Any]) -> dict[str, Any]:
    rows = snapshot.get("pnl_intervals") or {
        f"{snapshot['window_days']}d": snapshot["pnl_window"]
    }
    result = {}
    for source_label, pnl in rows.items():
        label = "24h" if source_label == "1d" else source_label
        period = pnl.get("period_metrics") or {}
        realized = _decimal(period.get("realized_trade_pnl_usd", pnl.get("realized_pnl_usd")))
        unrealized = _decimal(
            period.get(
                "period_unrealized_pnl_change_usd",
                pnl.get("unrealized_pnl_on_priced_verified_inventory_usd"),
            )
        )
        total = _decimal(period.get("period_total_trade_pnl_usd", realized + unrealized))
        result[label] = {
            "realized_trade_pnl_usd": format(realized, "f"),
            "unrealized_pnl_change_usd": format(unrealized, "f"),
            "total_trade_pnl_usd": format(total, "f"),
            "opening_unrealized_pnl_usd": period.get(
                "opening_unrealized_pnl_at_cutoff_usd"
            ),
            "unattributed_inventory_disposal_count": int(
                pnl.get("unattributed_inventory_disposal_count") or 0
            ),
            "unattributed_sale_proceeds_excluded_from_pnl_usd": pnl.get(
                "sale_proceeds_excluded_for_unknown_inventory_usd", "0"
            ),
            "minimum_incremental_trade_funding_usd": (
                (pnl.get("rolling_capital") or {}).get(
                    "minimum_incremental_trade_funding_usd",
                    (pnl.get("rolling_capital") or {}).get("rolling_capital_deployed_usd"),
                )
            ),
            "capital_deployed_at_cutoff_usd": period.get(
                "capital_deployed_at_cutoff_usd"
            ),
            "period_return_on_cutoff_capital_pct": period.get(
                "period_return_on_cutoff_capital_pct"
            ),
            "capital_denominator_status": period.get("capital_denominator_status"),
            "gross_purchase_activity_usd": (
                (pnl.get("rolling_capital") or {}).get("internal_diagnostic_purchase_volume_usd")
            ),
        }
    return result
