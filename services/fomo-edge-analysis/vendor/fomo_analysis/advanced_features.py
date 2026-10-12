"""Tier-1 V3 trader state, economics, payoff, and capital features."""

from __future__ import annotations

from bisect import bisect_left
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from math import ceil, sqrt
from statistics import mean, median
from typing import Any, Iterable

from fomo_analysis.models import NormalizedTrade
from fomo_analysis.positions import PositionEpisode, ReconstructionResult


HUNDRED = Decimal("100")


def _float(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _economic_return(row: dict[str, Any]) -> float | None:
    """Prefer swap-derived position ROI over optional candle-path fields."""
    value=row.get("roi_pct")
    return _float(value if value is not None else row.get("realized_return_pct"))


def _time(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)


def _ratio(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator in (None, 0):
        return None
    return numerator / denominator


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def _session(hour: int) -> str:
    return "asia" if hour < 8 else "europe" if hour < 16 else "us"


def _correlation(pairs: list[tuple[float, float]]) -> float | None:
    if len(pairs) < 2:
        return None
    left_mean = mean(item[0] for item in pairs)
    right_mean = mean(item[1] for item in pairs)
    numerator = sum((left - left_mean) * (right - right_mean) for left, right in pairs)
    left_scale = sqrt(sum((left - left_mean) ** 2 for left, _ in pairs))
    right_scale = sqrt(sum((right - right_mean) ** 2 for _, right in pairs))
    return numerator / (left_scale * right_scale) if left_scale and right_scale else None


def build_episode_feature_rows(
    trades: Iterable[NormalizedTrade],
    episodes: Iterable[PositionEpisode],
    price_features: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    trades_by_id = {trade.trade_id: trade for trade in trades}
    prices = {row["episode_id"]: row for row in price_features}
    prior_by_token: dict[tuple[str, str], dict[str, Any]] = {}
    output = []
    for episode in sorted(episodes, key=lambda row: (row.opened_at, row.episode_number)):
        episode_id = f"{episode.trader_id}:{episode.chain}:{episode.token_address}:{episode.episode_number}"
        legs = sorted(
            (trades_by_id[item] for item in episode.trade_ids),
            key=lambda row: (row.timestamp, row.trade_id),
        )
        buys = [row for row in legs if row.side == "BUY"]
        sells = [row for row in legs if row.side == "SELL"]
        first_price = next((row.execution_price_usd for row in buys if row.execution_price_usd), None)
        add_to_winner = sum(
            bool(first_price and row.execution_price_usd and row.execution_price_usd > first_price)
            for row in buys[1:]
        )
        add_to_loser = sum(
            bool(first_price and row.execution_price_usd and row.execution_price_usd < first_price)
            for row in buys[1:]
        )
        price = dict(prices.get(episode_id, {}))
        realized_pnl = float(episode.realized_pnl_usd) if episode.realized_pnl_usd is not None else None
        capital = (
            float(episode.buy_notional_usd)
            if episode.priced_buy_count == episode.buy_count and episode.buy_count else None
        )
        bought_quantity = float(episode.bought_quantity)
        remaining_quantity = float(episode.remaining_quantity)
        remaining_fraction = (
            max(0.0, min(1.0, remaining_quantity / bought_quantity))
            if bought_quantity else 0.0
        )
        previous = prior_by_token.get((episode.chain, episode.token_address))
        entry_price = _float(price.get("entry_price_usd"))
        prior_exit_price = _float(previous.get("exit_price_usd")) if previous else None
        row = {
            **price,
            "episode_id": episode_id,
            "episode_opened_at": episode.opened_at,
            "episode_closed_at": episode.closed_at,
            "trader_id": episode.trader_id,
            "chain": episode.chain,
            "token_address": episode.token_address,
            "token_symbol": episode.token_symbol,
            "episode_number": episode.episode_number,
            "repeat_token": episode.episode_number > 1,
            "opened_at": episode.opened_at,
            "closed_at": episode.closed_at,
            "buy_count": episode.buy_count,
            "sell_count": episode.sell_count,
            "scale_in_count": max(0, episode.buy_count - 1),
            "scale_out_count": max(0, episode.sell_count - 1),
            "add_to_winner_count": add_to_winner,
            "add_to_loser_count": add_to_loser,
            "exit_style": (
                "open" if not episode.closed_at else
                "scaled_out" if episode.sell_count > 1 else "all_at_once"
            ),
            "first_sell_at": sells[0].timestamp if sells else None,
            "time_to_first_sell_minutes": (
                (sells[0].timestamp - episode.opened_at).total_seconds() / 60
                if sells else None
            ),
            "time_to_full_exit_minutes": (
                (episode.closed_at - episode.opened_at).total_seconds() / 60
                if episode.closed_at else None
            ),
            "capital_deployed_usd": capital,
            "remaining_cost_basis_usd": (
                capital * remaining_fraction if capital is not None else None
            ),
            "remaining_quantity_fraction": remaining_fraction,
            "realized_pnl_usd": realized_pnl,
            "roi_pct": _ratio(realized_pnl, capital) * 100
            if realized_pnl is not None and capital else None,
            "time_since_prior_exit_minutes": (
                (episode.opened_at - previous["closed_at"]).total_seconds() / 60
                if previous and previous.get("closed_at") else None
            ),
            "price_move_since_prior_exit_pct": (
                (entry_price / prior_exit_price - 1) * 100
                if entry_price is not None and prior_exit_price else None
            ),
        }
        mfe = _float(row.get("mfe_pct"))
        realized_return = _economic_return(row)
        row["round_trip"] = bool(
            mfe is not None and mfe >= 20 and realized_return is not None and realized_return <= 5
        )
        output.append(row)
        if episode.closed_at:
            prior_by_token[(episode.chain, episode.token_address)] = row
    return output


def build_entry_state_rows(
    trades: Iterable[NormalizedTrade],
    reconstruction: ReconstructionResult,
    entry_price_features: Iterable[dict[str, Any]],
    episode_rows: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    trades = sorted(trades, key=lambda row: (row.timestamp, row.trade_id))
    trades_by_id = {row.trade_id: row for row in trades}
    buys = [row for row in trades if row.side == "BUY"]
    feature_by_trade = {row["trade_id"]: dict(row) for row in entry_price_features}
    episode_by_trade = {}
    entry_leg_number_by_trade = {}
    for episode in reconstruction.episodes:
        for trade_id in episode.trade_ids:
            episode_by_trade[trade_id] = episode
        episode_buys = sorted(
            (
                trades_by_id[trade_id] for trade_id in episode.trade_ids
                if trades_by_id[trade_id].side == "BUY"
            ),
            key=lambda row: (row.timestamp, row.trade_id),
        )
        for index, trade in enumerate(episode_buys, start=1):
            entry_leg_number_by_trade[trade.trade_id] = index
    episode_feature_by_id = {row["episode_id"]: row for row in episode_rows}
    priced_sizes = [float(row.usd_notional) for row in buys if row.usd_notional is not None]
    trader_median_size = median(priced_sizes) if priced_sizes else None
    gaps = [
        (trades[index].timestamp - trades[index - 1].timestamp).total_seconds() / 60
        for index in range(1, len(trades))
    ]
    trader_median_gap = median(gaps) if gaps else None
    closed = sorted(
        (row for row in episode_rows if row.get("closed_at") and _economic_return(row) is not None),
        key=lambda row: _time(row["closed_at"]),
    )
    closed_times = [_time(row["closed_at"]) for row in closed]
    previous_entry_sizes: list[float] = []
    output = []
    trade_times = [row.timestamp for row in trades]
    portfolio_at_entry = {}
    quantity_by_token: defaultdict[tuple[str, str], Decimal] = defaultdict(Decimal)
    cost_by_token: defaultdict[tuple[str, str], float] = defaultdict(float)
    for item in trades:
        key = (item.chain, item.token_address)
        if item.side == "BUY":
            quantity_by_token[key] += item.token_amount
            if item.usd_notional is not None:
                cost_by_token[key] += float(item.usd_notional)
            active_costs = sorted(
                (value for value in cost_by_token.values() if value > 0), reverse=True
            )
            total_cost = sum(active_costs)
            portfolio_at_entry[item.trade_id] = {
                "concurrent_position_count": len(active_costs),
                "concurrent_capital_at_risk_usd": total_cost,
                "capital_concentration_top_1": _ratio(sum(active_costs[:1]), total_cost),
                "capital_concentration_top_3": _ratio(sum(active_costs[:3]), total_cost),
            }
        else:
            prior_quantity = quantity_by_token[key]
            if prior_quantity > 0:
                fraction = min(Decimal(1), item.token_amount / prior_quantity)
                cost_by_token[key] *= float(Decimal(1) - fraction)
                quantity_by_token[key] = max(Decimal(0), prior_quantity - item.token_amount)
                if quantity_by_token[key] == 0:
                    cost_by_token[key] = 0.0
    timing_by_trade_id = {}
    session_start = None
    session_trade_number = 0
    day_counts: Counter[Any] = Counter()
    for index, item in enumerate(trades):
        gap = (
            (item.timestamp - trades[index - 1].timestamp).total_seconds() / 60
            if index else None
        )
        if session_start is None or gap is None or gap > 120:
            session_start = item.timestamp
            session_trade_number = 1
        else:
            session_trade_number += 1
        day_counts[item.timestamp.date()] += 1
        timing_by_trade_id[item.trade_id] = {
            "time_since_previous_trade_minutes": gap,
            "trade_number_in_session": session_trade_number,
            "trade_number_in_day": day_counts[item.timestamp.date()],
            "session_age_minutes": (item.timestamp - session_start).total_seconds() / 60,
        }
    for trade in buys:
        feature = feature_by_trade.get(trade.trade_id, {})
        episode = episode_by_trade[trade.trade_id]
        episode_id = f"{episode.trader_id}:{episode.chain}:{episode.token_address}:{episode.episode_number}"
        episode_feature = episode_feature_by_id.get(episode_id, {})
        prior_index = bisect_left(closed_times, trade.timestamp)
        prior_outcomes = [_economic_return(row) for row in closed[:prior_index]]
        prior_outcomes = [value for value in prior_outcomes if value is not None]
        wins = losses = 0
        for value in reversed(prior_outcomes):
            if value > 0 and losses == 0:
                wins += 1
            elif value <= 0 and wins == 0:
                losses += 1
            else:
                break
        timing = timing_by_trade_id[trade.trade_id]
        gap = timing["time_since_previous_trade_minutes"]
        prior_trade_count = bisect_left(trade_times, trade.timestamp)
        recent_counts = {}
        for hours in (1, 6, 24):
            cutoff = trade.timestamp - timedelta(hours=hours)
            recent_counts[hours] = prior_trade_count - bisect_left(trade_times, cutoff, 0, prior_trade_count)
        size = float(trade.usd_notional) if trade.usd_notional is not None else None
        recent_sizes = previous_entry_sizes[-20:]
        recent_median = median(recent_sizes) if recent_sizes else None
        token_key = (trade.chain, trade.token_address)
        is_first_buy = trade.timestamp == episode.opened_at
        allocated_pnl = None
        episode_pnl = _float(episode_feature.get("realized_pnl_usd"))
        episode_capital = _float(episode_feature.get("capital_deployed_usd"))
        if episode_pnl is not None and size is not None and episode_capital:
            allocated_pnl = episode_pnl * size / episode_capital
        row = {
            **feature,
            **portfolio_at_entry.get(trade.trade_id, {}),
            "trade_id": trade.trade_id,
            "trader_id": trade.trader_id,
            "chain": trade.chain,
            "token_address": trade.token_address,
            "token_symbol": trade.token_symbol,
            "timestamp": trade.timestamp,
            "absolute_size_usd": size,
            "relative_size_vs_trader_median": _ratio(size, trader_median_size),
            "relative_size_vs_recent_median": _ratio(size, recent_median),
            "size_change_vs_previous_entry_pct": (
                (size / previous_entry_sizes[-1] - 1) * 100
                if size is not None and previous_entry_sizes and previous_entry_sizes[-1] else None
            ),
            "hour_utc": trade.timestamp.hour,
            "session_bucket": _session(trade.timestamp.hour),
            "day_of_week": trade.timestamp.strftime("%A").lower(),
            "is_weekend": trade.timestamp.weekday() >= 5,
            "time_since_previous_trade_minutes": gap,
            "trade_number_in_session": timing["trade_number_in_session"],
            "trade_number_in_day": timing["trade_number_in_day"],
            "session_age_minutes": timing["session_age_minutes"],
            "trades_last_1h": recent_counts[1],
            "trades_last_6h": recent_counts[6],
            "trades_last_24h": recent_counts[24],
            "previous_trade_return_pct": prior_outcomes[-1] if prior_outcomes else None,
            "previous_3_trade_return_pct": mean(prior_outcomes[-3:]) if prior_outcomes else None,
            "consecutive_wins": wins,
            "consecutive_losses": losses,
            "repeat_token": episode.episode_number > 1,
            "entry_number_for_token": episode.episode_number,
            "entry_leg_number": entry_leg_number_by_trade[trade.trade_id],
            "time_since_prior_exit_minutes": episode_feature.get("time_since_prior_exit_minutes"),
            "price_move_since_prior_exit_pct": episode_feature.get("price_move_since_prior_exit_pct"),
            "episode_id": episode_id,
            "episode_realized_return_pct": _economic_return(episode_feature),
            "episode_realized_pnl_usd": episode_pnl,
            "allocated_realized_pnl_usd": allocated_pnl,
            "episode_closed_at": episode_feature.get("closed_at"),
            "episode_capital_deployed_usd": episode_capital,
            "episode_remaining_cost_basis_usd": episode_feature.get(
                "remaining_cost_basis_usd"
            ),
            "episode_remaining_quantity_fraction": episode_feature.get(
                "remaining_quantity_fraction"
            ),
            "trader_median_size_usd": trader_median_size,
            "trader_median_trade_gap_minutes": trader_median_gap,
        }
        previous_return = row["previous_trade_return_pct"]
        size_change = row["size_change_vs_previous_entry_pct"]
        gap_change = (
            (gap / trader_median_gap - 1) * 100
            if gap is not None and trader_median_gap else None
        )
        row.update({
            "post_loss_size_change_pct": size_change
            if previous_return is not None and previous_return <= 0 else None,
            "post_loss_frequency_gap_change_pct": gap_change
            if previous_return is not None and previous_return <= 0 else None,
            "post_win_size_change_pct": size_change
            if previous_return is not None and previous_return > 0 else None,
            "post_win_frequency_gap_change_pct": gap_change
            if previous_return is not None and previous_return > 0 else None,
        })
        output.append(row)
        if size is not None:
            previous_entry_sizes.append(size)
    return output


def build_trader_economics(
    trades: Iterable[NormalizedTrade], episode_rows: Iterable[dict[str, Any]]
) -> dict[str, Any]:
    trades = list(trades)
    rows = list(episode_rows)
    closed = [row for row in rows if row.get("closed_at")]
    priced = [row for row in closed if _float(row.get("realized_pnl_usd")) is not None]
    pnls = [_float(row["realized_pnl_usd"]) for row in priced]
    pnls = [value for value in pnls if value is not None]
    returns = [_economic_return(row) for row in priced]
    returns = [value for value in returns if value is not None]
    positives = [value for value in pnls if value > 0]
    negatives = [value for value in pnls if value < 0]
    ordered_pnl = sorted(
        priced, key=lambda row: _time(row["closed_at"])
    )
    equity = peak = drawdown = 0.0
    for row in ordered_pnl:
        equity += _float(row["realized_pnl_usd"]) or 0
        peak = max(peak, equity)
        drawdown = min(drawdown, equity - peak)
    gross_profit = sum(positives)
    top = sorted(positives, reverse=True)
    token_profit: defaultdict[tuple[str, str], float] = defaultdict(float)
    for row in priced:
        token_profit[(row["chain"], row["token_address"])] += max(
            0, _float(row["realized_pnl_usd"]) or 0
        )
    hhi = (
        sum((value / gross_profit) ** 2 for value in token_profit.values())
        if gross_profit else None
    )
    events = []
    for row in rows:
        capital = _float(row.get("capital_deployed_usd"))
        if capital is None:
            continue
        events.append((_time(row["opened_at"]), 1, capital))
        if row.get("closed_at"):
            events.append((_time(row["closed_at"]), -1, -capital))
    current_capital = peak_capital = 0.0
    current_positions = max_positions = 0
    for _, position_delta, capital_delta in sorted(events, key=lambda item: (item[0], item[1])):
        current_capital += capital_delta
        current_positions += position_delta
        peak_capital = max(peak_capital, current_capital)
        max_positions = max(max_positions, current_positions)
    # This is transaction volume, not distinct capital. A trader can recycle
    # the same dollars through many positions.
    gross_deployed = sum(_float(row.get("capital_deployed_usd")) or 0 for row in rows)
    from fomo_analysis.portfolio_accounting import rolling_trade_funding
    funding = rolling_trade_funding(trades)
    realized = sum(pnls)
    completed_deployed = sum(
        _float(row.get("capital_deployed_usd")) or 0 for row in priced
    )
    remaining_open_basis = sum(
        _float(row.get("remaining_cost_basis_usd")) or 0
        for row in rows if not row.get("closed_at")
    )
    active_days = {trade.timestamp.date() for trade in trades}
    active_weeks = {(d.isocalendar().year, d.isocalendar().week) for d in active_days}
    top_five_n = max(1, int(len(top) * 0.05 + 0.999)) if top else 0
    entry_sizes = [
        float(row.usd_notional) for row in trades
        if row.side == "BUY" and row.usd_notional is not None
    ]
    size_mean = mean(entry_sizes) if entry_sizes else None
    size_cv = (
        sqrt(mean((value - size_mean) ** 2 for value in entry_sizes)) / size_mean
        if size_mean else None
    )
    winner_sizes = [_float(row.get("capital_deployed_usd")) for row in priced if (_float(row.get("realized_pnl_usd")) or 0) > 0]
    loser_sizes = [_float(row.get("capital_deployed_usd")) for row in priced if (_float(row.get("realized_pnl_usd")) or 0) <= 0]
    winner_sizes = [value for value in winner_sizes if value is not None]
    loser_sizes = [value for value in loser_sizes if value is not None]
    upper_tail = sorted(returns, reverse=True)[:max(1, ceil(len(returns) * 0.1))] if returns else []
    return {
        "trade_count": len(trades),
        "position_episode_count": len(rows),
        "closed_episode_count": len(closed),
        "priced_closed_episode_count": len(priced),
        "independent_token_count": len({(row["chain"], row["token_address"]) for row in rows}),
        "active_day_count": len(active_days),
        "active_week_count": len(active_weeks),
        "realized_pnl_usd": realized,
        "gross_purchase_volume_usd": gross_deployed,
        "minimum_trade_funding_required_usd": float(
            funding.minimum_trade_funding_required_usd
        ),
        # This denominator is reconstructed only from verified trade cash flows.
        # It does not include custody cash, unpriced assets, or unknown-cost
        # opening inventory, so it must never be presented as starting wealth.
        "capital_denominator_status": "not_product_denominator_use_period_cutoff_snapshot",
        "starting_portfolio_capital_usd": None,
        "starting_portfolio_capital_status": (
            "unavailable_without_complete_cutoff_equity_and_custody"
        ),
        "rolling_capital_deployed_usd": None,
        "capital_reuse_multiple": (
            None if funding.capital_reuse_multiple is None
            else float(funding.capital_reuse_multiple)
        ),
        "average_completed_position_return_pct": mean(returns) if returns else None,
        "return_on_closed_cost_basis_pct": (
            _ratio(realized, completed_deployed) * 100
            if completed_deployed else None
        ),
        "realized_return_on_minimum_funding_pct": (
            _ratio(realized, float(funding.minimum_trade_funding_required_usd)) * 100
            if funding.minimum_trade_funding_required_usd else None
        ),
        "realized_return_on_rolling_capital_pct": None,
        "realized_yield_on_deployed_capital_pct": None,
        "remaining_open_cost_basis_usd": remaining_open_basis,
        "unrealized_pnl_usd": None,
        "completed_only": {
            "realized_pnl_usd": realized,
            "closed_position_cost_basis_usd": completed_deployed,
            "return_on_closed_cost_basis_pct": (
                _ratio(realized, completed_deployed) * 100
                if completed_deployed else None
            ),
            "average_completed_position_return_pct": mean(returns) if returns else None,
            "gross_capital_deployed_usd": completed_deployed,
            "realized_yield_on_deployed_capital_pct": (
                _ratio(realized, completed_deployed) * 100
                if completed_deployed else None
            ),
            "episode_count": len(priced),
        },
        "valuation_timestamp": None,
        "valuation_status": "unavailable_without_current_price",
        "accounting_method": "whole_episode_cost_basis_and_realized_pnl",
        "fee_treatment": "uses_normalized_trade_notionals; fee inclusion follows source transaction accounting",
        "provenance": {
            "capital_deployed": "estimated" if gross_deployed else "unavailable",
            "realized_pnl": "estimated" if pnls else "unavailable",
            "unrealized_pnl": "unavailable",
            "source": "normalized onchain trade notionals and reconstructed position episodes",
        },
        "win_rate_percent": 100 * sum(value > 0 for value in returns) / len(returns) if returns else None,
        "median_trade_return_pct": median(returns) if returns else None,
        "expectancy_pct": mean(returns) if returns else None,
        "profit_factor": _ratio(gross_profit, abs(sum(negatives))),
        "average_win_pct": mean([value for value in returns if value > 0]) if any(value > 0 for value in returns) else None,
        "average_loss_pct": mean([value for value in returns if value <= 0]) if any(value <= 0 for value in returns) else None,
        "payoff_ratio": _ratio(
            mean([value for value in returns if value > 0]) if any(value > 0 for value in returns) else None,
            abs(mean([value for value in returns if value <= 0])) if any(value <= 0 for value in returns) else None,
        ),
        "return_p90_pct": _percentile(returns, 0.9),
        "upper_decile_return_contribution": _ratio(sum(upper_tail), sum(returns)) if returns and sum(returns) else None,
        "entry_size_coefficient_of_variation": size_cv,
        "winner_vs_loser_median_size_ratio": _ratio(
            median(winner_sizes) if winner_sizes else None,
            median(loser_sizes) if loser_sizes else None,
        ),
        "best_trade_profit_share": _ratio(top[0], gross_profit) if top else None,
        "top_3_profit_share": _ratio(sum(top[:3]), gross_profit) if top else None,
        "top_5_percent_profit_share": _ratio(sum(top[:top_five_n]), gross_profit) if top else None,
        "token_profit_hhi": hhi,
        "max_realized_drawdown_usd": drawdown,
        "loss_p10_pct": _percentile([value for value in returns if value < 0], 0.1),
        # Deprecated compatibility alias. New UI/API consumers must use
        # gross_purchase_volume_usd and minimum_trade_funding_required_usd.
        "gross_capital_deployed_usd": gross_deployed,
        "estimated_peak_capital_at_risk_usd": peak_capital,
        "capital_turnover": (
            None if funding.capital_reuse_multiple is None
            else float(funding.capital_reuse_multiple)
        ),
        "legacy_estimated_yield_on_peak_concurrent_capital_pct": None,
        "capital_basis_provenance": "period_cutoff_open_position_snapshot_required",
        "deprecated_metric_notice": (
            "gross_capital_deployed_usd is cumulative purchase volume, not capital"
        ),
        "max_concurrent_position_count": max_positions,
    }


def build_trader_state_summary(
    entry_rows: Iterable[dict[str, Any]], episode_rows: Iterable[dict[str, Any]]
) -> dict[str, Any]:
    entries = list(entry_rows)
    episodes = [row for row in episode_rows if row.get("closed_at")]
    size_outcomes = [
        (_float(row.get("relative_size_vs_trader_median")), _float(row.get("forward_return_240m_pct")))
        for row in entries
    ]
    size_outcomes = [(left, right) for left, right in size_outcomes if left is not None and right is not None]
    concurrency_outcomes = [
        (_float(row.get("concurrent_position_count")), _float(row.get("forward_return_240m_pct")))
        for row in entries
    ]
    concurrency_outcomes = [(left, right) for left, right in concurrency_outcomes if left is not None and right is not None]
    winner_holds = [
        _float(row.get("time_to_full_exit_minutes")) for row in episodes
        if (_economic_return(row) or 0) > 0
    ]
    loser_holds = [
        _float(row.get("time_to_full_exit_minutes")) for row in episodes
        if (_economic_return(row) or 0) <= 0
    ]
    winner_holds = [value for value in winner_holds if value is not None]
    loser_holds = [value for value in loser_holds if value is not None]
    return {
        "size_to_forward_return_correlation": _correlation(size_outcomes),
        "concurrency_to_forward_return_correlation": _correlation(concurrency_outcomes),
        "median_winner_hold_minutes": median(winner_holds) if winner_holds else None,
        "median_loser_hold_minutes": median(loser_holds) if loser_holds else None,
        "winner_vs_loser_hold_ratio": _ratio(
            median(winner_holds) if winner_holds else None,
            median(loser_holds) if loser_holds else None,
        ),
        "round_trip_rate_percent": (
            100 * sum(bool(row.get("round_trip")) for row in episodes) / len(episodes)
            if episodes else None
        ),
        "scaled_exit_rate_percent": (
            100 * sum(row.get("exit_style") == "scaled_out" for row in episodes) / len(episodes)
            if episodes else None
        ),
        "all_at_once_exit_rate_percent": (
            100 * sum(row.get("exit_style") == "all_at_once" for row in episodes) / len(episodes)
            if episodes else None
        ),
    }
