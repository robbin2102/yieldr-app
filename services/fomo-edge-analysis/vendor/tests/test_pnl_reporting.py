from fomo_analysis.pnl_reporting import (
    build_v3_3_pnl_reporting,
    map_unattributed_ui_sells,
    relative_time_is_inside_days,
)


def test_relative_window_excludes_boundary_and_week_labels():
    assert relative_time_is_inside_days("6d", 7)
    assert not relative_time_is_inside_days("7d", 7)
    assert not relative_time_is_inside_days("1w", 7)


def test_unmatched_sells_are_not_verified_trade_pnl():
    rows = map_unattributed_ui_sells(
        {"unmatched_ui": [
            {"ui_index": 1, "token_symbol": "FWA", "side": "SELL", "amount_usd": "10", "relative_time": "2d"},
            {"ui_index": 2, "token_symbol": "FWA", "side": "BUY", "amount_usd": "20", "relative_time": "2d"},
        ]},
        7,
    )
    assert len(rows) == 1
    assert rows[0]["zero_basis_ui_bridge_usd"] == "10"
    assert rows[0]["included_in_verified_trade_pnl"] is False


def test_dual_view_preserves_verified_pnl_and_builds_provisional_bridge():
    snapshot = {
        "window_days": 7,
        "valuation_time": "2026-01-08T00:00:00+00:00",
        "fomo_ui_reference": {"pnl_window_usd": "148"},
        "pnl_window": {
            "realized_pnl_usd": "70",
            "unrealized_pnl_on_priced_verified_inventory_usd": "50",
            "sale_proceeds_excluded_for_unknown_inventory_usd": "4",
            "unattributed_inventory_disposals": [{
                "trade_id": "tx", "chain": "base", "token_address": "token",
                "token_symbol": "FWA", "sale_proceeds_excluded_from_trade_pnl_usd": "4",
            }],
            "external_or_unknown_cost_current_value_usd": "2",
            "open_positions": [],
        },
        "actual_wallet_portfolio": {"position_count": 1, "material_open_positions": []},
    }
    result = build_v3_3_pnl_reporting(
        snapshot,
        ui_reconciliation={"unmatched_ui": [
            {"ui_index": 1, "token_symbol": "FWA", "side": "SELL", "amount_usd": "30", "relative_time": "2d"},
        ]},
    )
    assert result["verified_trade_pnl"]["total_trade_pnl_usd"] == "120"
    assert result["unattributed_disposals"]["sale_proceeds_excluded_from_trade_pnl_usd"] == "4"
    assert result["unattributed_disposals"]["included_in_verified_trade_pnl"] is False
    assert result["development_ui_reconciliation"]["ui_only_unmatched_sell_proceeds_usd"] == "30"
    assert result["development_ui_reconciliation"]["excluded_from_production_pnl"] is True
