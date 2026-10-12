from datetime import datetime, timezone

import pytest

from scripts.reconcile_solana_fomo import candidate_error, expected_page_amount


def test_buy_display_amount_uses_empirical_factor() -> None:
    trade = {"side": "BUY", "quote_amount": "5000"}
    assert expected_page_amount(trade) == pytest.approx(4977.9)


def test_candidate_requires_side_time_and_amount() -> None:
    snapshot = datetime(2026, 9, 6, 14, 27, tzinfo=timezone.utc)
    trade = {
        "side": "SELL",
        "quote_amount": "16523.827488",
        "timestamp": "2026-09-06T13:28:30+00:00",
    }
    page = {
        "side": "Sell",
        "relative_time": "58m",
        "usd_amount": "$16,597.44",
    }
    assert candidate_error(trade, page, snapshot) is not None

    wrong_side = dict(page, side="Buy")
    assert candidate_error(trade, wrong_side, snapshot) is None
