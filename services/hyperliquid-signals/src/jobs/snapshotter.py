import asyncio
import logging
from datetime import datetime, timedelta, timezone

import aiohttp

from ..db import get_db
from ..config import settings
from ..lib.hyperliquid import fetch_positions
from .convergence import run_convergence

logger = logging.getLogger(__name__)


def _parse_position(raw: dict, address: str, snapshot_ts: datetime) -> dict | None:
    pos = raw.get("position", {})
    szi = float(pos.get("szi", "0"))
    if szi == 0:
        return None
    lev = pos.get("leverage", {})
    leverage = float(lev.get("value", "0")) if isinstance(lev, dict) else 0.0
    return {
        "address": address,
        "coin": pos.get("coin", ""),
        "side": "LONG" if szi > 0 else "SHORT",
        "szi": szi,
        "size_usd": abs(float(pos.get("positionValue", "0"))),
        "entry_px": float(pos.get("entryPx", "0") or "0"),
        "leverage": leverage,
        "unrealized_pnl": float(pos.get("unrealizedPnl", "0")),
        "snapshot_ts": snapshot_ts,
    }


async def _detect_changes(
    db,
    address: str,
    current_positions: list[dict],
    snapshot_ts: datetime,
    change_threshold_pct: float,
    leverage_threshold: float,
) -> list[dict]:
    changes = []

    prev_cursor = db.hl_signals_positions.find(
        {"address": address},
        sort=[("snapshot_ts", -1)],
        limit=1,
    )
    prev_docs = await prev_cursor.to_list(1)

    if not prev_docs:
        for pos in current_positions:
            changes.append(
                {
                    "address": address,
                    "coin": pos["coin"],
                    "change_type": "NEW_POSITION",
                    "previous_state": None,
                    "new_state": pos,
                    "ts": snapshot_ts,
                }
            )
        return changes

    prev_snapshot_ts = prev_docs[0]["snapshot_ts"]
    prev_cursor = db.hl_signals_positions.find(
        {"address": address, "snapshot_ts": prev_snapshot_ts}
    )
    prev_positions = {doc["coin"]: doc async for doc in prev_cursor}
    current_map = {p["coin"]: p for p in current_positions}

    for coin, cur in current_map.items():
        if coin not in prev_positions:
            changes.append(
                {
                    "address": address,
                    "coin": coin,
                    "change_type": "NEW_POSITION",
                    "previous_state": None,
                    "new_state": cur,
                    "ts": snapshot_ts,
                }
            )
            continue

        prev = prev_positions[coin]

        if cur["side"] != prev["side"]:
            changes.append(
                {
                    "address": address,
                    "coin": coin,
                    "change_type": "FLIP",
                    "previous_state": prev,
                    "new_state": cur,
                    "ts": snapshot_ts,
                }
            )
            continue

        if prev["size_usd"] > 0:
            size_change_pct = abs(cur["size_usd"] - prev["size_usd"]) / prev["size_usd"] * 100
            if size_change_pct > change_threshold_pct:
                changes.append(
                    {
                        "address": address,
                        "coin": coin,
                        "change_type": "SIZE_CHANGE",
                        "previous_state": prev,
                        "new_state": cur,
                        "ts": snapshot_ts,
                    }
                )

        lev_diff = abs(cur["leverage"] - prev.get("leverage", 0))
        if lev_diff > leverage_threshold:
            changes.append(
                {
                    "address": address,
                    "coin": coin,
                    "change_type": "LEVERAGE_CHANGE",
                    "previous_state": prev,
                    "new_state": cur,
                    "ts": snapshot_ts,
                }
            )

    for coin in prev_positions:
        if coin not in current_map:
            changes.append(
                {
                    "address": address,
                    "coin": coin,
                    "change_type": "CLOSED",
                    "previous_state": prev_positions[coin],
                    "new_state": None,
                    "ts": snapshot_ts,
                }
            )

    return changes


async def _detect_whale_events(
    db,
    address: str,
    current_positions: list[dict],
    snapshot_ts: datetime,
    skill_quartile: int,
) -> list[dict]:
    """Detect whale events for Q1 traders only."""
    if skill_quartile != 1:
        return []

    events = []
    dormant_cutoff = snapshot_ts - timedelta(days=settings.whale_dormant_days)

    current_map = {p["coin"]: p for p in current_positions}

    # Get most recent prior snapshot for this trader
    prev_pos_doc = await db.hl_signals_positions.find_one(
        {"address": address, "snapshot_ts": {"$lt": snapshot_ts}},
        sort=[("snapshot_ts", -1)],
    )
    prev_map: dict[str, dict] = {}
    if prev_pos_doc:
        prev_ts = prev_pos_doc["snapshot_ts"]
        cursor = db.hl_signals_positions.find(
            {"address": address, "snapshot_ts": prev_ts}
        )
        prev_map = {doc["coin"]: doc async for doc in cursor}

    for coin, cur in current_map.items():
        if cur["size_usd"] < settings.whale_min_usd:
            continue

        if coin not in prev_map:
            # Check if dormant — no position in past N days
            had_recent = await db.hl_signals_positions.find_one(
                {
                    "address": address,
                    "coin": coin,
                    "snapshot_ts": {"$gte": dormant_cutoff, "$lt": snapshot_ts},
                }
            )
            event_type = "WAKEUP" if not had_recent else "WAKEUP"
            events.append(
                {
                    "address": address,
                    "coin": coin,
                    "event_type": event_type,
                    "side": cur["side"],
                    "size_usd": cur["size_usd"],
                    "ts": snapshot_ts,
                    "metadata": {"prev_size_usd": 0, "new_size_usd": cur["size_usd"]},
                }
            )
            continue

        prev = prev_map[coin]

        # FLIP — side change
        if cur["side"] != prev["side"]:
            events.append(
                {
                    "address": address,
                    "coin": coin,
                    "event_type": "FLIP",
                    "side": cur["side"],
                    "size_usd": cur["size_usd"],
                    "ts": snapshot_ts,
                    "metadata": {
                        "prev_side": prev["side"],
                        "prev_size_usd": prev["size_usd"],
                        "new_size_usd": cur["size_usd"],
                    },
                }
            )
            continue

        # SCALEUP — significant size increase
        if prev["size_usd"] > 0:
            ratio = (cur["size_usd"] - prev["size_usd"]) / prev["size_usd"]
            if ratio >= settings.whale_scaleup_threshold:
                events.append(
                    {
                        "address": address,
                        "coin": coin,
                        "event_type": "SCALEUP",
                        "side": cur["side"],
                        "size_usd": cur["size_usd"],
                        "ts": snapshot_ts,
                        "metadata": {
                            "prev_size_usd": prev["size_usd"],
                            "new_size_usd": cur["size_usd"],
                            "ratio": ratio,
                        },
                    }
                )

        # LEVERAGE_PUSH
        lev_diff = cur["leverage"] - prev.get("leverage", 0)
        if lev_diff >= settings.leverage_change_threshold:
            events.append(
                {
                    "address": address,
                    "coin": coin,
                    "event_type": "LEVERAGE_PUSH",
                    "side": cur["side"],
                    "size_usd": cur["size_usd"],
                    "ts": snapshot_ts,
                    "metadata": {
                        "prev_leverage": prev.get("leverage", 0),
                        "new_leverage": cur["leverage"],
                    },
                }
            )

    # EXIT events — positions in prev but not in current
    for coin, prev in prev_map.items():
        if coin not in current_map and prev["size_usd"] >= settings.whale_min_usd:
            events.append(
                {
                    "address": address,
                    "coin": coin,
                    "event_type": "EXIT",
                    "side": prev["side"],
                    "size_usd": prev["size_usd"],
                    "ts": snapshot_ts,
                    "metadata": {"prev_size_usd": prev["size_usd"], "new_size_usd": 0},
                }
            )

    return events


async def run_snapshot() -> None:
    logger.info('"Starting position snapshot"')
    db = get_db()
    now = datetime.now(timezone.utc)

    # Load active cohort with skill quartile
    cursor = db.hl_signals_traders.find(
        {"cohort_status": "active"},
        {"address": 1, "skill_quartile": 1},
    )
    traders = [doc async for doc in cursor]
    addresses = [doc["address"] for doc in traders]
    skill_map = {doc["address"]: doc.get("skill_quartile", 4) for doc in traders}

    if not addresses:
        logger.warning('"No active traders in cohort, skipping snapshot"')
        return

    logger.info('"Fetching positions for %d traders"', len(addresses))

    semaphore = asyncio.Semaphore(settings.snapshot_concurrency)
    async with aiohttp.ClientSession() as session:
        tasks = [fetch_positions(session, addr, semaphore) for addr in addresses]
        results = await asyncio.gather(*tasks)

    all_positions: list[dict] = []
    errors = 0
    for addr, raw_positions in zip(addresses, results):
        if raw_positions is None:
            errors += 1
            continue
        for raw in raw_positions:
            parsed = _parse_position(raw, addr, now)
            if parsed:
                all_positions.append(parsed)

    if all_positions:
        await db.hl_signals_positions.insert_many(all_positions)

    # Detect position changes per address
    all_changes: list[dict] = []
    addr_positions: dict[str, list[dict]] = {}
    for pos in all_positions:
        addr_positions.setdefault(pos["address"], []).append(pos)

    change_tasks = [
        _detect_changes(
            db,
            addr,
            addr_positions.get(addr, []),
            now,
            settings.position_change_threshold_pct,
            settings.leverage_change_threshold,
        )
        for addr in addresses
    ]
    change_results = await asyncio.gather(*change_tasks)
    for changes in change_results:
        all_changes.extend(changes)

    if all_changes:
        await db.hl_signals_position_changes.insert_many(all_changes)

    # Detect whale events for Q1 traders
    whale_tasks = [
        _detect_whale_events(
            db,
            addr,
            addr_positions.get(addr, []),
            now,
            skill_map.get(addr, 4),
        )
        for addr in addresses
    ]
    whale_results = await asyncio.gather(*whale_tasks)
    all_whale_events: list[dict] = []
    for events in whale_results:
        all_whale_events.extend(events)

    if all_whale_events:
        await db.hl_signals_whale_events.insert_many(all_whale_events)
        logger.info('"Whale events detected", "count": %d', len(all_whale_events))

    logger.info(
        '"Snapshot complete", "positions": %d, "changes": %d, "whale_events": %d, "errors": %d',
        len(all_positions),
        len(all_changes),
        len(all_whale_events),
        errors,
    )

    # Run convergence engine immediately after snapshot
    await run_convergence(now)
