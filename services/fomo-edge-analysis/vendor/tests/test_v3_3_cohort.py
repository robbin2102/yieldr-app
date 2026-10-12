from datetime import datetime, timezone
from decimal import Decimal

from fomo_analysis.models import Candle, NormalizedTrade
from scripts.run_v3_3_cohort import _price_trades_from_candles


def test_missing_trade_notional_uses_nearest_five_minute_candle() -> None:
    at = datetime(2026, 1, 1, 12, 3, tzinfo=timezone.utc)
    trade = NormalizedTrade(
        "trader", "wallet", "base", "tx", 0, at, "BUY", "token", "TOK",
        Decimal("10"), None, None, None, "transfer",
    )
    candle = Candle(
        "base", "token", datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc),
        "5m", Decimal("1.9"), Decimal("2.1"), Decimal("1.8"), Decimal("2"),
        1, "coingecko", "observed",
    )
    rows, coverage = _price_trades_from_candles([trade], [candle])
    assert rows[0].execution_price_usd == Decimal("2")
    assert rows[0].usd_notional == Decimal("20")
    assert rows[0].amount_source == "mongodb_5m_candle_close_estimate"
    assert coverage["ohlc_estimated_trade_legs"] == 1


def test_atomic_trade_notional_is_never_replaced() -> None:
    at = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
    trade = NormalizedTrade(
        "trader", "wallet", "base", "tx", 0, at, "SELL", "token", "TOK",
        Decimal("10"), Decimal("15"), Decimal("1.5"), "atomic", "transfer",
    )
    rows, coverage = _price_trades_from_candles([trade], [])
    assert rows[0] == trade
    assert coverage["atomic_or_quote_priced_trade_legs"] == 1
