from datetime import datetime, timedelta, timezone
from dataclasses import replace
from decimal import Decimal

from fomo_analysis.models import NormalizedTrade
from fomo_analysis.positions import reconstruct_positions


NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def trade(side: str, quantity: str, usd: str, minute: int) -> NormalizedTrade:
    return NormalizedTrade(
        trader_id="trader", wallet="wallet", chain="base", transaction_id=f"tx{minute}",
        leg_index=0, timestamp=NOW + timedelta(minutes=minute), side=side,
        token_address="token", token_symbol="TOK", token_amount=Decimal(quantity),
        usd_notional=Decimal(usd), execution_price_usd=Decimal(usd) / Decimal(quantity),
        amount_source="test", evidence="test",
    )


def test_scale_in_partial_exit_and_close_form_one_episode() -> None:
    result = reconstruct_positions([
        trade("BUY", "10", "100", 0), trade("BUY", "10", "120", 1),
        trade("SELL", "5", "40", 2), trade("SELL", "15", "180", 3),
    ])
    assert len(result.episodes) == 1
    assert not result.orphan_sells
    episode = result.episodes[0]
    assert episode.closed_at == NOW + timedelta(minutes=3)
    assert episode.buy_count == 2
    assert episode.sell_count == 2
    assert episode.realized_pnl_usd == Decimal("0")


def test_sell_before_first_buy_is_reported_not_fabricated() -> None:
    result = reconstruct_positions([trade("SELL", "1", "5", 0)])
    assert not result.episodes
    assert len(result.orphan_sells) == 1


def test_same_token_positions_are_isolated_by_trader() -> None:
    first_buy = trade("BUY", "10", "100", 0)
    second_buy = replace(
        trade("BUY", "20", "200", 1),
        trader_id="other-trader",
        wallet="other-wallet",
    )
    first_sell = trade("SELL", "10", "110", 2)
    second_sell = replace(
        trade("SELL", "20", "220", 3),
        trader_id="other-trader",
        wallet="other-wallet",
    )

    result = reconstruct_positions(
        [first_buy, second_buy, first_sell, second_sell]
    )

    assert len(result.episodes) == 2
    assert {episode.trader_id for episode in result.episodes} == {
        "trader", "other-trader"
    }
    assert all(episode.closed_at is not None for episode in result.episodes)
