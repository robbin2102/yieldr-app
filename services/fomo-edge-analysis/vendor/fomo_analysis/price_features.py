"""Five-minute OHLC joins for V3 entry and position-path features."""

from __future__ import annotations

from bisect import bisect_right
from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Iterable

from fomo_analysis.models import Candle, NormalizedTrade
from fomo_analysis.positions import PositionEpisode


HORIZONS = (5, 15, 30, 60, 240)
HUNDRED = Decimal("100")


def _percent_change(start: Decimal, end: Decimal) -> Decimal | None:
    if start <= 0:
        return None
    return (end / start - 1) * HUNDRED


def _text(value: Decimal | None) -> str | None:
    return None if value is None else format(value, "f")


class CandleSeries:
    def __init__(self, candles: Iterable[Candle]) -> None:
        self.candles = sorted(candles, key=lambda row: row.open_time)
        self.times = [row.open_time for row in self.candles]

    def at_or_before(
        self, timestamp: datetime, tolerance: timedelta = timedelta(minutes=10)
    ) -> Candle | None:
        position = bisect_right(self.times, timestamp) - 1
        if position < 0:
            return None
        candle = self.candles[position]
        return candle if timestamp - candle.open_time <= tolerance else None

    def between(self, start: datetime, end: datetime) -> list[Candle]:
        left = bisect_right(self.times, start - timedelta(microseconds=1))
        right = bisect_right(self.times, end)
        return self.candles[left:right]


def build_entry_price_features(
    trades: Iterable[NormalizedTrade], candles: Iterable[Candle]
) -> list[dict[str, Any]]:
    series_by_token: dict[tuple[str, str], CandleSeries] = {}
    grouped: dict[tuple[str, str], list[Candle]] = defaultdict(list)
    for candle in candles:
        grouped[(candle.chain, candle.token_address)].append(candle)
    for key, rows in grouped.items():
        series_by_token[key] = CandleSeries(rows)

    output = []
    for trade in trades:
        if trade.side != "BUY":
            continue
        series = series_by_token.get((trade.chain, trade.token_address))
        entry_candle = series.at_or_before(trade.timestamp) if series else None
        entry_market_price = entry_candle.close if entry_candle else None
        execution_basis = trade.execution_price_usd or entry_market_price
        values: dict[str, Any] = {
            "trade_id": trade.trade_id,
            "trader_id": trade.trader_id,
            "chain": trade.chain,
            "token_address": trade.token_address,
            "timestamp": trade.timestamp,
            "entry_market_price_usd": _text(entry_market_price),
            "entry_basis_price_usd": _text(execution_basis),
            "entry_basis_source": (
                "execution_price" if trade.execution_price_usd else "candle_close"
                if entry_market_price is not None else None
            ),
        }
        available = 0
        for minutes in HORIZONS:
            prior = series.at_or_before(trade.timestamp - timedelta(minutes=minutes)) if series else None
            forward = series.at_or_before(trade.timestamp + timedelta(minutes=minutes)) if series else None
            pre_return = (
                _percent_change(prior.close, entry_market_price)
                if prior and entry_market_price is not None
                else None
            )
            forward_return = (
                _percent_change(execution_basis, forward.close)
                if forward and execution_basis is not None
                else None
            )
            values[f"pre_return_{minutes}m_pct"] = _text(pre_return)
            values[f"forward_return_{minutes}m_pct"] = _text(forward_return)
            available += pre_return is not None
            available += forward_return is not None

        for minutes in (15, 60, 240):
            prior_path = series.between(
                trade.timestamp - timedelta(minutes=minutes), trade.timestamp
            ) if series else []
            recent_high = max((row.high for row in prior_path), default=None)
            recent_low = min((row.low for row in prior_path), default=None)
            values[f"drawdown_from_high_{minutes}m_pct"] = _text(
                _percent_change(recent_high, entry_market_price)
                if recent_high and entry_market_price is not None else None
            )
            values[f"distance_from_low_{minutes}m_pct"] = _text(
                _percent_change(recent_low, entry_market_price)
                if recent_low and entry_market_price is not None else None
            )

        forward_path = series.between(
            trade.timestamp, trade.timestamp + timedelta(hours=4)
        ) if series else []
        max_high = max((row.high for row in forward_path), default=None)
        min_low = min((row.low for row in forward_path), default=None)
        mfe = _percent_change(execution_basis, max_high) if execution_basis and max_high else None
        mae = _percent_change(execution_basis, min_low) if execution_basis and min_low else None
        values["mfe_4h_pct"] = _text(mfe)
        values["mae_4h_pct"] = _text(mae)
        values["mfe_mae_ratio"] = _text(
            mfe / abs(mae) if mfe is not None and mae not in (None, 0) else None
        )
        drawdown_60 = values.get("drawdown_from_high_60m_pct")
        values["near_rolling_high_60m"] = (
            drawdown_60 is not None and Decimal(drawdown_60) >= Decimal("-3")
        )
        return_15 = values.get("pre_return_15m_pct")
        return_60 = values.get("pre_return_60m_pct")
        values["momentum_acceleration_pct"] = _text(
            Decimal(return_15) - Decimal(return_60) / Decimal(4)
            if return_15 is not None and return_60 is not None else None
        )
        earlier = series.between(
            trade.timestamp - timedelta(minutes=60),
            trade.timestamp - timedelta(minutes=15),
        ) if series else []
        recent = series.between(
            trade.timestamp - timedelta(minutes=15), trade.timestamp
        ) if series else []
        prior_high = max((row.high for row in earlier), default=None)
        recent_high = max((row.high for row in recent), default=None)
        values["breakout_retest_60m"] = bool(
            prior_high
            and recent_high
            and entry_market_price
            and recent_high >= prior_high
            and Decimal("-5")
            <= (_percent_change(prior_high, entry_market_price) or Decimal("-999"))
            <= Decimal("2")
        )
        values["price_feature_values_available"] = available + sum(
            values[key] is not None
            for key in values
            if key.startswith(("drawdown_", "distance_", "mfe_", "mae_"))
        )
        output.append(values)
    return output


def build_episode_price_features(
    episodes: Iterable[PositionEpisode], candles: Iterable[Candle]
) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], list[Candle]] = defaultdict(list)
    for candle in candles:
        grouped[(candle.chain, candle.token_address)].append(candle)
    series_by_token = {key: CandleSeries(rows) for key, rows in grouped.items()}
    output = []
    for episode in episodes:
        if not episode.closed_at:
            continue
        series = series_by_token.get((episode.chain, episode.token_address))
        path = series.between(episode.opened_at, episode.closed_at) if series else []
        expected = max(
            1,
            int((episode.closed_at - episode.opened_at) / timedelta(minutes=5)) + 1,
        )
        entry_price = (
            episode.buy_notional_usd / episode.bought_quantity
            if episode.priced_buy_count == episode.buy_count and episode.bought_quantity > 0
            else None
        )
        exit_price = (
            episode.sell_notional_usd / episode.sold_quantity
            if episode.priced_sell_count == episode.sell_count and episode.sold_quantity > 0
            else None
        )
        realized_return = (
            _percent_change(entry_price, exit_price)
            if entry_price is not None and exit_price is not None else None
        )
        max_high = max((row.high for row in path), default=None)
        min_low = min((row.low for row in path), default=None)
        mfe = _percent_change(entry_price, max_high) if entry_price and max_high else None
        mae = _percent_change(entry_price, min_low) if entry_price and min_low else None
        peak_captured = (
            realized_return / mfe * HUNDRED
            if realized_return is not None and mfe is not None and mfe > 0 else None
        )
        output.append(
            {
                "episode_id": f"{episode.trader_id}:{episode.chain}:{episode.token_address}:{episode.episode_number}",
                "trader_id": episode.trader_id,
                "chain": episode.chain,
                "token_address": episode.token_address,
                "opened_at": episode.opened_at,
                "closed_at": episode.closed_at,
                "realized_return_pct": _text(realized_return),
                "entry_price_usd": _text(entry_price),
                "exit_price_usd": _text(exit_price),
                "mfe_pct": _text(mfe),
                "mae_pct": _text(mae),
                "mfe_mae_ratio": _text(
                    mfe / abs(mae) if mfe is not None and mae not in (None, 0) else None
                ),
                "peak_captured_pct": _text(peak_captured),
                "giveback_from_mfe_pct": _text(
                    mfe - realized_return
                    if mfe is not None and realized_return is not None else None
                ),
                "observed_candles": len(path),
                "expected_candles": expected,
                "path_coverage_percent": round(100 * len(path) / expected, 2),
                "price_path_status": (
                    "complete" if len(path) >= expected else "partial" if path else "missing"
                ),
            }
        )
    return output
