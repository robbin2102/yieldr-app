from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fomo_analysis.models import NormalizedTrade
from fomo_analysis.portfolio_accounting import (
    InventoryAdjustment,
    build_fifo_period_metrics,
    build_window_pnl_snapshot,
    rolling_trade_funding,
)


T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def trade(index, side, quantity, usd, token="token"):
    return NormalizedTrade(
        trader_id="trader", wallet="wallet", chain="base",
        transaction_id=f"tx-{index}", leg_index=0,
        timestamp=T0 + timedelta(days=index), side=side,
        token_address=token, token_symbol="TKN",
        token_amount=Decimal(str(quantity)),
        usd_notional=None if usd is None else Decimal(str(usd)),
        execution_price_usd=None, amount_source="test", evidence="test",
    )


def test_rolling_funding_reuses_sale_proceeds_instead_of_summing_buys():
    rows = [
        trade(0, "BUY", 10, 10),
        trade(1, "SELL", 10, 200),
        trade(2, "BUY", 10, 180),
        trade(3, "SELL", 10, 20),
        trade(4, "BUY", 10, 20),
    ]
    result = rolling_trade_funding(rows)
    assert result.gross_purchase_volume_usd == Decimal("210")
    assert result.minimum_trade_funding_required_usd == Decimal("10")
    assert result.capital_reuse_multiple == Decimal("21")


def test_orphan_sale_does_not_reduce_required_funding():
    rows = [trade(0, "SELL", 5, 100), trade(1, "BUY", 10, 50)]
    result = rolling_trade_funding(rows)
    assert result.excluded_sale_proceeds_usd == Decimal("100")
    assert result.minimum_trade_funding_required_usd == Decimal("50")


def test_window_rolling_funding_uses_opening_inventory_but_only_window_cash_flows():
    rows = [
        trade(0, "BUY", 10, 100),
        trade(2, "SELL", 10, 150),
        trade(3, "BUY", 10, 120),
    ]
    result = rolling_trade_funding(rows, window_start=T0 + timedelta(days=1))
    assert result.gross_purchase_volume_usd == Decimal("120")
    assert result.attributable_sale_proceeds_usd == Decimal("150")
    assert result.minimum_trade_funding_required_usd == Decimal("0")


def test_window_fifo_carries_basis_and_excludes_unknown_inventory_sale():
    rows = [
        trade(0, "BUY", 10, 100),
        trade(2, "SELL", 4, 80),
        trade(3, "SELL", 10, 120),
    ]
    result = build_window_pnl_snapshot(
        rows, T0 + timedelta(days=1),
        {("base", "token"): Decimal("30")},
        valuation_time=T0 + timedelta(days=4),
    )
    assert result["realized_pnl_usd"] == "52.0"
    assert result["sale_proceeds_excluded_for_unknown_inventory_usd"] == "48.0"
    assert result["open_positions"] == []


def test_window_unrealized_pnl_uses_remaining_fifo_cost():
    rows = [trade(0, "BUY", 10, 100), trade(2, "SELL", 4, 80)]
    result = build_window_pnl_snapshot(
        rows, T0 + timedelta(days=1),
        {("base", "token"): Decimal("30")},
        valuation_time=T0 + timedelta(days=3),
    )
    assert result["realized_pnl_usd"] == "40"
    assert result["open_verified_cost_basis_usd"] == "60"
    assert result["open_verified_current_value_usd"] == "180"
    assert result["unrealized_pnl_on_priced_verified_inventory_usd"] == "120"
    assert result["realized_plus_unrealized_pnl_usd"] == "160"
    assert result["opening_verified_cost_basis_usd"] == "100"
    assert result["opening_fifo_inventory"][0]["verified_quantity"] == "10"
    assert result["realized_sales"][0]["fifo_cost_basis_usd"] == "40"


def test_external_receipt_is_inventory_but_never_invented_as_trade_profit():
    rows = [trade(0, "BUY", 5, 50), trade(2, "SELL", 8, 160)]
    adjustments = [InventoryAdjustment(
        event_id="gift", chain="base", token_address="token",
        timestamp=T0 + timedelta(days=1), direction="IN",
        quantity=Decimal("5"),
    )]
    result = build_window_pnl_snapshot(
        rows, T0 + timedelta(days=1), {},
        valuation_time=T0 + timedelta(days=3),
        inventory_adjustments=adjustments,
    )
    assert result["realized_pnl_usd"] == "50.000"
    assert result["sale_proceeds_excluded_for_unknown_inventory_usd"] == "60.000"
    disposal = result["unattributed_inventory_disposals"][0]
    assert disposal["classification"] == "partially_attributed_inventory_disposal"
    assert disposal["inventory_provenance"] == ["unverified_external_transfer"]
    assert disposal["included_in_realized_trade_pnl"] is False


def test_sell_without_any_prior_buy_is_logged_as_unattributed_disposal():
    result = build_window_pnl_snapshot(
        [trade(1, "SELL", 5, 100)], T0, {}, valuation_time=T0 + timedelta(days=2)
    )
    assert result["realized_pnl_usd"] == "0"
    assert result["unattributed_inventory_disposal_count"] == 1
    disposal = result["unattributed_inventory_disposals"][0]
    assert disposal["classification"] == "unattributed_inventory_disposal"
    assert disposal["sale_proceeds_excluded_from_trade_pnl_usd"] == "100"
    assert disposal["inventory_provenance"] == [
        "no_prior_verified_buy_or_receipt_in_observation_window"
    ]


def test_period_pnl_subtracts_unrealized_gain_already_present_at_cutoff():
    snapshot = build_window_pnl_snapshot(
        [trade(0, "BUY", 10, 100), trade(2, "SELL", 4, 80)],
        T0 + timedelta(days=1),
        {("base", "token"): Decimal("30")},
        valuation_time=T0 + timedelta(days=3),
    )
    metrics = build_fifo_period_metrics(
        snapshot, {("base", "token"): Decimal("15")}
    )
    assert metrics["opening_unrealized_pnl_at_cutoff_usd"] == "50"
    assert metrics["period_unrealized_pnl_change_usd"] == "70"
    assert metrics["period_total_trade_pnl_usd"] == "110"
