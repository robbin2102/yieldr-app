"""V3.2 economic-action classification and one-hour outcome measurement."""

from __future__ import annotations

import hashlib
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from statistics import median
from statistics import median
from typing import Any, Iterable

from fomo_analysis.models import Candle, NormalizedTrade
from fomo_analysis.positions import ReconstructionResult
from fomo_analysis.price_features import CandleSeries


MODEL_VERSION = "3.2.0"
PRIMARY_HORIZON_MINUTES = 60
MAX_CANDLE_GAP_MINUTES = 10
UNCHANGED_EPSILON_PCT = Decimal("0.01")


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _action_id(parts: Iterable[str]) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


@dataclass(frozen=True)
class EconomicAction:
    action_id: str
    trader_id: str
    wallet: str
    chain: str
    token_address: str
    token_symbol: str | None
    transaction_id: str
    timestamp: datetime
    action_type: str
    side: str
    token_amount: Decimal
    usd_notional: Decimal | None
    execution_price_usd: Decimal | None
    episode_id: str | None
    source_trade_ids: tuple[str, ...]
    acquisition_provenance: str | None = None
    cost_basis_status: str | None = None

    def as_document(self) -> dict[str, Any]:
        return {
            **self.__dict__,
            "timestamp": _iso(self.timestamp),
            "token_amount": format(self.token_amount, "f"),
            "usd_notional": (
                None if self.usd_notional is None else format(self.usd_notional, "f")
            ),
            "execution_price_usd": (
                None
                if self.execution_price_usd is None
                else format(self.execution_price_usd, "f")
            ),
            "source_trade_ids": list(self.source_trade_ids),
            "model_version": MODEL_VERSION,
        }


def classify_economic_actions(
    trades: Iterable[NormalizedTrade], reconstruction: ReconstructionResult
) -> list[EconomicAction]:
    """Collapse same-transaction routed legs and classify their economic meaning."""
    rows = sorted(trades, key=lambda row: (row.timestamp, row.trade_id))
    episode_by_trade: dict[str, Any] = {}
    episode_id_by_trade: dict[str, str] = {}
    for episode in reconstruction.episodes:
        episode_id = (
            f"{episode.trader_id}:{episode.chain}:{episode.token_address}:"
            f"{episode.episode_number}"
        )
        for trade_id in episode.trade_ids:
            episode_by_trade[trade_id] = episode
            episode_id_by_trade[trade_id] = episode_id

    grouped: dict[tuple[Any, ...], list[NormalizedTrade]] = defaultdict(list)
    for row in rows:
        grouped[
            (
                row.trader_id,
                row.chain,
                row.transaction_id,
                row.token_address,
                row.side,
                row.timestamp,
            )
        ].append(row)

    collapsed: list[dict[str, Any]] = []
    for key, legs in grouped.items():
        quantity = sum((row.token_amount for row in legs), Decimal(0))
        notionals = [row.usd_notional for row in legs if row.usd_notional is not None]
        notional = sum(notionals, Decimal(0)) if len(notionals) == len(legs) else None
        price = notional / quantity if notional is not None and quantity > 0 else None
        collapsed.append(
            {
                "key": key,
                "legs": legs,
                "quantity": quantity,
                "notional": notional,
                "price": price,
                "episode": next(
                    (episode_by_trade.get(row.trade_id) for row in legs if row.trade_id in episode_by_trade),
                    None,
                ),
                "episode_id": next(
                    (episode_id_by_trade.get(row.trade_id) for row in legs if row.trade_id in episode_id_by_trade),
                    None,
                ),
            }
        )

    collapsed.sort(key=lambda row: (row["key"][5], row["key"][2], row["key"][3]))
    buy_number: dict[str, int] = defaultdict(int)
    sell_number: dict[str, int] = defaultdict(int)
    actions: list[EconomicAction] = []
    for row in collapsed:
        trader_id, chain, transaction_id, token, side, at = row["key"]
        episode = row["episode"]
        episode_id = row["episode_id"]
        normalized_side = str(side).upper()
        if normalized_side == "BUY":
            buy_number[episode_id or transaction_id] += 1
            if buy_number[episode_id or transaction_id] == 1:
                action_type = (
                    "reentry" if episode and episode.episode_number > 1 else "opening_buy"
                )
            else:
                action_type = "addition"
            provenance = "verified_purchase"
            cost_status = "known" if row["notional"] is not None else "unknown"
        elif normalized_side == "SELL":
            sell_number[episode_id or transaction_id] += 1
            action_type = (
                "full_exit"
                if episode and episode.closed_at and at == episode.closed_at
                else "partial_sell"
            )
            provenance = None
            cost_status = None
        elif normalized_side in {"RECEIVE", "RECEIPT"}:
            action_type = "token_receipt"
            provenance = "unknown_acquisition_history"
            cost_status = "unknown"
        elif normalized_side in {"TRANSFER_OUT", "SEND"}:
            action_type = "token_transfer_out"
            provenance = None
            cost_status = None
        else:
            action_type = "other_inventory_event"
            provenance = None
            cost_status = None
        legs = row["legs"]
        source_ids = tuple(sorted(item.trade_id for item in legs))
        identity = _action_id(
            [MODEL_VERSION, trader_id, chain, transaction_id, token, normalized_side]
        )
        first = legs[0]
        actions.append(
            EconomicAction(
                action_id=identity,
                trader_id=trader_id,
                wallet=first.wallet,
                chain=chain,
                token_address=token,
                token_symbol=next((item.token_symbol for item in legs if item.token_symbol), None),
                transaction_id=transaction_id,
                timestamp=at,
                action_type=action_type,
                side=normalized_side,
                token_amount=row["quantity"],
                usd_notional=row["notional"],
                execution_price_usd=row["price"],
                episode_id=episode_id,
                source_trade_ids=source_ids,
                acquisition_provenance=provenance,
                cost_basis_status=cost_status,
            )
        )
    return actions


def _outcome_state(raw_return: Decimal | None, *, pending: bool) -> str:
    if pending:
        return "pending"
    if raw_return is None:
        return "unavailable"
    if abs(raw_return) <= UNCHANGED_EPSILON_PCT:
        return "unchanged"
    return "positive" if raw_return > 0 else "negative"


def build_action_feature_rows(
    actions: Iterable[EconomicAction],
    candles: Iterable[Candle],
    entry_features: Iterable[dict[str, Any]],
    *,
    as_of: datetime | None = None,
) -> list[dict[str, Any]]:
    """Attach point-in-time facts and the frozen one-hour action outcome."""
    observed_at = (as_of or datetime.now(timezone.utc)).astimezone(timezone.utc)
    grouped: dict[tuple[str, str], list[Candle]] = defaultdict(list)
    for candle in candles:
        grouped[(candle.chain, candle.token_address)].append(candle)
    series = {key: CandleSeries(rows) for key, rows in grouped.items()}
    entry_by_trade = {
        row["trade_id"]: dict(row) for row in entry_features if row.get("trade_id")
    }
    output: list[dict[str, Any]] = []
    for action in actions:
        entry = next(
            (entry_by_trade.get(trade_id) for trade_id in action.source_trade_ids if trade_id in entry_by_trade),
            {},
        )
        action_series = series.get((action.chain, action.token_address))
        reference_candle = (
            action_series.at_or_before(
                action.timestamp, timedelta(minutes=MAX_CANDLE_GAP_MINUTES)
            )
            if action_series else None
        )
        reference = action.execution_price_usd or (
            reference_candle.close if reference_candle else None
        )
        deadline = action.timestamp + timedelta(minutes=PRIMARY_HORIZON_MINUTES)
        pending = observed_at < deadline
        future = (
            action_series.at_or_before(
                deadline, timedelta(minutes=MAX_CANDLE_GAP_MINUTES)
            )
            if action_series and not pending else None
        )
        raw_return = (
            (future.close / reference - Decimal(1)) * Decimal(100)
            if future and reference and reference > 0 else None
        )
        state = _outcome_state(raw_return, pending=pending)
        favorable = None
        if state in {"positive", "negative", "unchanged"}:
            favorable = (
                raw_return > UNCHANGED_EPSILON_PCT
                if action.side == "BUY"
                else raw_return < -UNCHANGED_EPSILON_PCT
                if action.side == "SELL"
                else None
            )
        output.append(
            {
                **entry,
                **action.as_document(),
                "action_type": action.action_type,
                "side": action.side,
                "episode_id": action.episode_id,
                "observed_at": _iso(action.timestamp),
                "available_at": _iso(action.timestamp),
                "primary_target": (
                    "price_higher_after_1h" if action.side == "BUY"
                    else "price_lower_after_1h" if action.side == "SELL"
                    else None
                ),
                "outcome_horizon_minutes": PRIMARY_HORIZON_MINUTES,
                "evaluation_deadline": _iso(deadline),
                "reference_price_usd": None if reference is None else format(reference, "f"),
                "reference_price_source": (
                    "execution_price" if action.execution_price_usd is not None
                    else "five_minute_candle_close" if reference_candle else None
                ),
                "outcome_price_usd": None if future is None else format(future.close, "f"),
                "forward_price_return_60m_pct": (
                    None if raw_return is None else float(raw_return)
                ),
                "favorable_outcome": favorable,
                "evaluation_status": state,
                "outcome_quality": (
                    "extreme_return_review"
                    if raw_return is not None and abs(raw_return) > Decimal("10000")
                    else "observed" if raw_return is not None else state
                ),
                "outcome_alignment": {
                    "interval": "5m",
                    "method": "last candle at or before target timestamp",
                    "maximum_gap_minutes": MAX_CANDLE_GAP_MINUTES,
                    "unchanged_epsilon_pct": float(UNCHANGED_EPSILON_PCT),
                    "missing_values_are_zero": False,
                },
            }
        )
    prior_buy_sizes: list[float] = []
    prior_trade_gaps: list[float] = []
    previous_at: datetime | None = None
    for row in sorted(output, key=lambda item: (item["observed_at"], item["action_id"])):
        at = datetime.fromisoformat(row["observed_at"])
        gap = (at - previous_at).total_seconds() / 60 if previous_at else None
        trailing_size_median = median(prior_buy_sizes) if prior_buy_sizes else None
        trailing_gap_median = median(prior_trade_gaps) if prior_trade_gaps else None
        size = row.get("usd_notional")
        numeric_size = float(size) if size is not None else None
        if row.get("side") == "BUY":
            row["trailing_trader_median_size_usd"] = trailing_size_median
            row["relative_size_vs_trader_median"] = (
                numeric_size / trailing_size_median
                if numeric_size is not None and trailing_size_median else None
            )
            row["trader_median_trade_gap_minutes"] = trailing_gap_median
            if numeric_size is not None:
                prior_buy_sizes.append(numeric_size)
        if gap is not None:
            prior_trade_gaps.append(gap)
        previous_at = at
    prior_buy_sizes: list[float] = []
    prior_gaps: list[float] = []
    for row in output:
        if row.get("side") != "BUY":
            continue
        size = float(row["usd_notional"]) if row.get("usd_notional") is not None else None
        trailing_size_median = median(prior_buy_sizes) if prior_buy_sizes else None
        row["trailing_trader_median_size_usd"] = trailing_size_median
        row["relative_size_vs_trader_median"] = (
            size / trailing_size_median
            if size is not None and trailing_size_median else None
        )
        gap = row.get("time_since_previous_trade_minutes")
        trailing_gap_median = median(prior_gaps) if prior_gaps else None
        row["trader_median_trade_gap_minutes"] = trailing_gap_median
        row["baseline_provenance"] = {
            "method": "Purged full-history medians; uses observations strictly before this action.",
            "size_observation_count": len(prior_buy_sizes),
            "gap_observation_count": len(prior_gaps),
        }
        if size is not None:
            prior_buy_sizes.append(size)
        if gap is not None:
            prior_gaps.append(float(gap))
    return output
