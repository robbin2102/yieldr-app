"""Inventory-aware position episode reconstruction."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Iterable

from fomo_analysis.models import NormalizedTrade


ZERO = Decimal("0")


@dataclass
class PositionEpisode:
    trader_id: str
    chain: str
    token_address: str
    token_symbol: str | None
    episode_number: int
    opened_at: datetime
    closed_at: datetime | None = None
    bought_quantity: Decimal = ZERO
    sold_quantity: Decimal = ZERO
    buy_notional_usd: Decimal = ZERO
    sell_notional_usd: Decimal = ZERO
    priced_buy_count: int = 0
    priced_sell_count: int = 0
    buy_count: int = 0
    sell_count: int = 0
    trade_ids: list[str] = field(default_factory=list)

    @property
    def remaining_quantity(self) -> Decimal:
        return max(ZERO, self.bought_quantity - self.sold_quantity)

    @property
    def realized_pnl_usd(self) -> Decimal | None:
        if (
            not self.closed_at
            or self.priced_buy_count != self.buy_count
            or self.priced_sell_count != self.sell_count
        ):
            return None
        return self.sell_notional_usd - self.buy_notional_usd

    def as_document(self) -> dict[str, Any]:
        value = asdict(self)
        value["episode_id"] = f"{self.trader_id}:{self.chain}:{self.token_address}:{self.episode_number}"
        value["remaining_quantity"] = format(self.remaining_quantity, "f")
        value["realized_pnl_usd"] = None if self.realized_pnl_usd is None else format(self.realized_pnl_usd, "f")
        for key in ("bought_quantity", "sold_quantity", "buy_notional_usd", "sell_notional_usd"):
            value[key] = format(value[key], "f")
        return value


@dataclass(frozen=True)
class ReconstructionResult:
    episodes: list[PositionEpisode]
    orphan_sells: list[NormalizedTrade]


def reconstruct_positions(
    trades: Iterable[NormalizedTrade],
    dust_fraction: Decimal = Decimal("0.000001"),
) -> ReconstructionResult:
    active: dict[tuple[str, str, str], PositionEpisode] = {}
    episode_counts: dict[tuple[str, str, str], int] = {}
    episodes: list[PositionEpisode] = []
    orphan_sells: list[NormalizedTrade] = []

    for trade in sorted(trades, key=lambda item: (item.timestamp, item.trade_id)):
        key = (trade.trader_id, trade.chain, trade.token_address)
        episode = active.get(key)
        if trade.side == "BUY":
            if episode is None:
                number = episode_counts.get(key, 0) + 1
                episode_counts[key] = number
                episode = PositionEpisode(
                    trader_id=trade.trader_id, chain=trade.chain,
                    token_address=trade.token_address, token_symbol=trade.token_symbol,
                    episode_number=number, opened_at=trade.timestamp,
                )
                episodes.append(episode)
                active[key] = episode
            episode.bought_quantity += trade.token_amount
            episode.buy_count += 1
            if trade.usd_notional is not None:
                episode.buy_notional_usd += trade.usd_notional
                episode.priced_buy_count += 1
            episode.trade_ids.append(trade.trade_id)
            continue

        if episode is None:
            orphan_sells.append(trade)
            continue
        sell_quantity = min(trade.token_amount, episode.remaining_quantity)
        episode.sold_quantity += sell_quantity
        episode.sell_count += 1
        if trade.usd_notional is not None:
            ratio = sell_quantity / trade.token_amount
            episode.sell_notional_usd += trade.usd_notional * ratio
            episode.priced_sell_count += 1
        episode.trade_ids.append(trade.trade_id)
        dust = max(Decimal("1e-18"), episode.bought_quantity * dust_fraction)
        if episode.remaining_quantity <= dust:
            episode.closed_at = trade.timestamp
            active.pop(key)

    return ReconstructionResult(episodes=episodes, orphan_sells=orphan_sells)
