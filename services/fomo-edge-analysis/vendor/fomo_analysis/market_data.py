"""Credit-aware planning for the five-minute feature-analysis price index."""

from __future__ import annotations

import hashlib
import math
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Iterator

from fomo_analysis.models import NormalizedTrade
from fomo_analysis.positions import reconstruct_positions


FIVE_MINUTES = timedelta(minutes=5)
MAX_CANDLES_PER_JOB = 1000


def exclusive_before_timestamp(end: datetime) -> int:
    """Include the final requested candle without admitting the next 5m candle."""
    return int((end.astimezone(timezone.utc) + timedelta(seconds=1)).timestamp())


def batches(values: Iterable[str], size: int = 50) -> Iterator[list[str]]:
    """Yield stable, de-duplicated batches without wasting provider slots."""
    if size < 1:
        raise ValueError("Batch size must be positive")
    unique = list(dict.fromkeys(values))
    for start in range(0, len(unique), size):
        yield unique[start : start + size]


@dataclass(frozen=True)
class MarketWindow:
    chain: str
    token_address: str
    start: datetime
    end: datetime
    reason: str = "position_episode"


@dataclass(frozen=True)
class MarketDataJob:
    chain: str
    network_id: str
    token_address: str
    pool_address: str
    start: datetime
    end: datetime
    reason: str = "position_episode"
    interval: str = "5m"
    provider: str = "geckoterminal_pool"

    @property
    def expected_candles(self) -> int:
        return int((self.end - self.start) / FIVE_MINUTES) + 1

    @property
    def priority(self) -> int:
        if "position_episode" in self.reason:
            return 10
        if "open_position_event" in self.reason:
            return 20
        return 30

    @property
    def dedupe_key(self) -> str:
        raw = "|".join(
            (
                self.provider,
                self.chain,
                self.network_id,
                self.token_address,
                self.pool_address,
                self.interval,
                self.start.isoformat(),
                self.end.isoformat(),
            )
        )
        return hashlib.sha256(raw.encode()).hexdigest()

    def as_document(self) -> dict[str, Any]:
        value = asdict(self)
        value["dedupe_key"] = self.dedupe_key
        value["expected_candles"] = self.expected_candles
        value["priority"] = self.priority
        return value


def _floor_five_minutes(value: datetime) -> datetime:
    value = value.astimezone(timezone.utc)
    return value.replace(minute=value.minute - value.minute % 5, second=0, microsecond=0)


def merge_windows(
    windows: Iterable[MarketWindow], merge_gap: timedelta = FIVE_MINUTES
) -> list[MarketWindow]:
    grouped: dict[tuple[str, str], list[MarketWindow]] = {}
    for window in windows:
        grouped.setdefault((window.chain, window.token_address), []).append(window)
    merged: list[MarketWindow] = []
    for (chain, token_address), values in sorted(grouped.items()):
        ordered = sorted(values, key=lambda item: item.start)
        current_start = ordered[0].start
        current_end = ordered[0].end
        reasons = {ordered[0].reason}
        for item in ordered[1:]:
            if item.start <= current_end + merge_gap:
                current_end = max(current_end, item.end)
                reasons.add(item.reason)
                continue
            merged.append(MarketWindow(chain, token_address, current_start, current_end, "+".join(sorted(reasons))))
            current_start, current_end, reasons = item.start, item.end, {item.reason}
        merged.append(MarketWindow(chain, token_address, current_start, current_end, "+".join(sorted(reasons))))
    return merged


def required_price_windows(
    trades: Iterable[NormalizedTrade],
    analysis_end: datetime,
    context: timedelta = timedelta(hours=4),
) -> list[MarketWindow]:
    """Cover V3 pre-entry context, full episode path, and post-exit context."""
    rows = list(trades)
    result = reconstruct_positions(rows)
    trades_by_id = {row.trade_id: row for row in rows}
    windows = []
    for episode in result.episodes:
        if episode.closed_at:
            windows.append(
                MarketWindow(
                    episode.chain,
                    episode.token_address,
                    _floor_five_minutes(episode.opened_at - context),
                    _floor_five_minutes(
                        min(analysis_end, episode.closed_at + context)
                    ),
                )
            )
            continue
        for trade_id in episode.trade_ids:
            trade = trades_by_id[trade_id]
            windows.append(
                MarketWindow(
                    trade.chain,
                    trade.token_address,
                    _floor_five_minutes(trade.timestamp - context),
                    _floor_five_minutes(
                        min(analysis_end, trade.timestamp + context)
                    ),
                    "open_position_event",
                )
            )
    for trade in result.orphan_sells:
        windows.append(
            MarketWindow(
                trade.chain,
                trade.token_address,
                _floor_five_minutes(trade.timestamp - context),
                _floor_five_minutes(min(analysis_end, trade.timestamp + context)),
                "orphan_sell_context",
            )
        )
    return merge_windows(windows)


def split_window(
    window: MarketWindow, max_candles: int = MAX_CANDLES_PER_JOB
) -> list[tuple[datetime, datetime]]:
    if max_candles < 1:
        raise ValueError("max_candles must be positive")
    chunks = []
    start = _floor_five_minutes(window.start)
    end = _floor_five_minutes(window.end)
    while start <= end:
        chunk_end = min(end, start + FIVE_MINUTES * (max_candles - 1))
        chunks.append((start, chunk_end))
        start = chunk_end + FIVE_MINUTES
    return chunks


def parse_token_batch_response(
    network_id: str, chain: str, body: dict[str, Any], observed_at: datetime
) -> list[dict[str, Any]]:
    """Extract token price/metadata and the included top pool from one batch call."""
    included = {item.get("id"): item for item in body.get("included", []) if item.get("type") == "pool"}
    prefix = f"{network_id}_"
    snapshots = []
    for item in body.get("data", []):
        attributes = item.get("attributes", {})
        token_id = str(item.get("id", ""))
        token_address = str(attributes.get("address") or (token_id[len(prefix):] if token_id.startswith(prefix) else token_id))
        top_pool_refs = item.get("relationships", {}).get("top_pools", {}).get("data", [])
        pool = included.get(top_pool_refs[0].get("id")) if top_pool_refs else None
        pool_attributes = (pool or {}).get("attributes", {})
        pool_relationships = (pool or {}).get("relationships", {})
        base_id = str(pool_relationships.get("base_token", {}).get("data", {}).get("id", "")).lower()
        token_side = "base" if token_id.lower() == base_id else "quote" if pool else None
        snapshots.append(
            {
                "token_id": f"{chain}:{token_address}",
                "chain": chain,
                "network_id": network_id,
                "token_address": token_address,
                "name": attributes.get("name"),
                "symbol": attributes.get("symbol"),
                "decimals": attributes.get("decimals"),
                "current_price_usd": attributes.get("price_usd"),
                "price_observed_at": observed_at,
                "price_source": "geckoterminal_tokens_multi",
                "pool_address": pool_attributes.get("address"),
                "pool_name": pool_attributes.get("name"),
                "pool_created_at": pool_attributes.get("pool_created_at"),
                "pool_reserve_usd": pool_attributes.get("reserve_in_usd"),
                "token_side": token_side,
                "market_data_status": "pool_resolved" if pool else "pool_missing",
            }
        )
    return snapshots


def missing_token_snapshots(
    network_id: str,
    chain: str,
    requested_addresses: Iterable[str],
    returned_snapshots: Iterable[dict[str, Any]],
    observed_at: datetime,
) -> list[dict[str, Any]]:
    returned = {row["token_address"] for row in returned_snapshots}
    return [
        {
            "token_id": f"{chain}:{address}",
            "chain": chain,
            "network_id": network_id,
            "token_address": address,
            "current_price_usd": None,
            "price_observed_at": observed_at,
            "price_source": "geckoterminal_tokens_multi",
            "pool_address": None,
            "market_data_status": "token_missing",
        }
        for address in requested_addresses
        if address not in returned
    ]


def jobs_for_windows(
    windows: Iterable[MarketWindow],
    network_ids: dict[str, str],
    snapshots: Iterable[dict[str, Any]],
) -> tuple[list[MarketDataJob], list[MarketWindow]]:
    by_token = {(row["chain"], row["token_address"]): row for row in snapshots}
    jobs: list[MarketDataJob] = []
    unresolved = []
    for window in windows:
        snapshot = by_token.get((window.chain, window.token_address))
        if not snapshot:
            unresolved.append(window)
            continue
        selected = select_pool_candidate_for_window(
            snapshot.get("pool_candidates", []), window.end
        )
        if selected is None and snapshot.get("pool_address"):
            selected = snapshot
        if not selected or not selected.get("pool_address"):
            unresolved.append(window)
            continue
        pool_created_at = selected.get("pool_created_at")
        if isinstance(pool_created_at, datetime):
            created = pool_created_at
        elif isinstance(pool_created_at, str) and pool_created_at:
            created = datetime.fromisoformat(pool_created_at.replace("Z", "+00:00"))
        else:
            created = None
        if created and created > window.end:
            unresolved.append(window)
            continue
        for start, end in split_window(window):
            jobs.append(
                MarketDataJob(
                    chain=window.chain,
                    network_id=network_ids[window.chain],
                    token_address=window.token_address,
                    pool_address=selected["pool_address"],
                    start=start,
                    end=end,
                    reason=window.reason,
                )
            )
    jobs.sort(key=lambda item: (item.priority, -item.end.timestamp(), item.dedupe_key))
    return jobs, unresolved


def pool_candidates_from_response(
    network_id: str,
    token_address: str,
    pools: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    token_id = f"{network_id}_{token_address}".lower()
    output = []
    for pool in pools:
        relationships = pool.get("relationships", {})
        base_id = str(
            relationships.get("base_token", {}).get("data", {}).get("id", "")
        ).lower()
        quote_id = str(
            relationships.get("quote_token", {}).get("data", {}).get("id", "")
        ).lower()
        if token_id == base_id:
            side = "base"
        elif token_id == quote_id:
            side = "quote"
        else:
            continue
        attributes = pool.get("attributes", {})
        output.append(
            {
                "pool_address": attributes.get("address"),
                "pool_name": attributes.get("name"),
                "pool_created_at": attributes.get("pool_created_at"),
                "pool_reserve_usd": attributes.get("reserve_in_usd"),
                "token_side": side,
            }
        )
    return output


def select_pool_candidate_for_window(
    candidates: Iterable[dict[str, Any]], window_end: datetime
) -> dict[str, Any] | None:
    eligible = []
    for candidate in candidates:
        created = candidate.get("pool_created_at")
        if isinstance(created, str) and created:
            created = datetime.fromisoformat(created.replace("Z", "+00:00"))
        if isinstance(created, datetime) and created > window_end:
            continue
        reserve = safe_decimal(candidate.get("pool_reserve_usd")) or Decimal(0)
        eligible.append((reserve, candidate))
    return max(eligible, key=lambda item: item[0])[1] if eligible else None


def candle_coverage_status(
    job: MarketDataJob, candle_times: Iterable[datetime]
) -> dict[str, Any]:
    times = sorted(set(candle_times))
    observed = len(times)
    if not times:
        status = "provider_gap"
    elif times[0] <= job.start and times[-1] >= job.end:
        status = "complete"
    else:
        status = "partial"
    return {
        "status": status,
        "expected_candles": job.expected_candles,
        "observed_candles": observed,
        "earliest_at": times[0] if times else None,
        "latest_at": times[-1] if times else None,
        "coverage_percent": round(100 * observed / job.expected_candles, 2),
    }


def safe_decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def estimated_ohlcv_calls(windows: Iterable[MarketWindow]) -> int:
    return sum(math.ceil((int((item.end - item.start) / FIVE_MINUTES) + 1) / MAX_CANDLES_PER_JOB) for item in windows)
