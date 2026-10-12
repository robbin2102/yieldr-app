"""First-pass trader features that do not fabricate missing market data."""

from __future__ import annotations

from collections import Counter
from decimal import Decimal
from statistics import median
from typing import Any, Iterable

from fomo_analysis.models import NormalizedTrade
from fomo_analysis.positions import PositionEpisode, ReconstructionResult


def _string(value: Decimal | None) -> str | None:
    return None if value is None else format(value, "f")


def build_behavior_features(
    trades: Iterable[NormalizedTrade], result: ReconstructionResult
) -> dict[str, Any]:
    rows = list(trades)
    notionals = [row.usd_notional for row in rows if row.usd_notional is not None]
    closed = [episode for episode in result.episodes if episode.closed_at]
    durations = [(item.closed_at - item.opened_at).total_seconds() for item in closed if item.closed_at]
    token_episode_counts = Counter((item.chain, item.token_address) for item in result.episodes)
    return {
        "trade_count": len(rows),
        "buy_count": sum(row.side == "BUY" for row in rows),
        "sell_count": sum(row.side == "SELL" for row in rows),
        "priced_trade_count": len(notionals),
        "priced_trade_percent": round(100 * len(notionals) / len(rows), 2) if rows else 0.0,
        "median_trade_notional_usd": _string(median(notionals)) if notionals else None,
        "position_episode_count": len(result.episodes),
        "closed_episode_count": len(closed),
        "open_episode_count": len(result.episodes) - len(closed),
        "orphan_sell_count": len(result.orphan_sells),
        "median_hold_minutes": round(median(durations) / 60, 4) if durations else None,
        "reentry_token_count": sum(count > 1 for count in token_episode_counts.values()),
        "chain_trade_counts": dict(sorted(Counter(row.chain for row in rows).items())),
        "limitations": [
            "Entry/exit skill and MFE/MAE require 5-minute market-price coverage.",
            "EVM USD notionals currently cover only receipt-enriched trades.",
            "Orphan sells can represent positions opened before the 90-day window.",
        ],
    }


def episode_documents(episodes: Iterable[PositionEpisode]) -> list[dict[str, Any]]:
    return [episode.as_document() for episode in episodes]

