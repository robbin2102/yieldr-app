import asyncio
import gc
import logging
import resource
import sys
from datetime import datetime, timedelta

import aiohttp
from pymongo import UpdateOne

from ..db import get_db
from ..config import settings
from ..lib.hyperliquid import fetch_positions
from .convergence import run_convergence

logger = logging.getLogger(__name__)

# How many traders to hold in memory at once.
# 50 keeps peak usage well under 100 MB even with large cohorts.
BATCH_SIZE = 50


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


def _slim(pos: dict | None) -> dict | None:
    """Slim position dict for storage in change records — avoids storing full copies."""
    if pos is None:
        return None
    return {k: pos.get(k) for k in ("coin", "side", "size_usd", "leverage", "entry_px")}


async def _detect_changes(
    db,
    address: str,
    current_positions: list[dict],
    snapshot_ts: datetime,
    change_threshold_pct: float,
    leverage_threshold: float,
) -> list[dict]:
    changes = []

    prev_docs = await db.hl_signals_positions.find(
        {"address": address},
        sort=[("snapshot_ts", -1)],
        limit=1,
    ).to_list(1)

    if not prev_docs:
        return [
            {
                "address": address,
                "coin": pos["coin"],
                "change_type": "NEW_POSITION",
                "previous_state": None,
                "new_state": _slim(pos),
                "ts": snapshot_ts,
            }
            for pos in current_positions
        ]

    prev_snapshot_ts = prev_docs[0]["snapshot_ts"]
    prev_cursor = db.hl_signals_positions.find(
        {"address": address, "snapshot_ts": prev_snapshot_ts},
        {"_id": 0},
    )
    # Skip the "no open positions" sentinel doc (coin=None) — it only marks
    # that the address was checked at that snapshot, not a real position.
    prev_positions = {doc["coin"]: doc async for doc in prev_cursor if doc["coin"] is not None}
    current_map = {p["coin"]: p for p in current_positions}

    for coin, cur in current_map.items():
        if coin not in prev_positions:
            changes.append({
                "address": address, "coin": coin, "change_type": "NEW_POSITION",
                "previous_state": None, "new_state": _slim(cur), "ts": snapshot_ts,
            })
            continue

        prev = prev_positions[coin]

        if cur["side"] != prev["side"]:
            changes.append({
                "address": address, "coin": coin, "change_type": "FLIP",
                "previous_state": _slim(prev), "new_state": _slim(cur), "ts": snapshot_ts,
            })
            continue

        if prev["size_usd"] > 0:
            size_change_pct = abs(cur["size_usd"] - prev["size_usd"]) / prev["size_usd"] * 100
            if size_change_pct > change_threshold_pct:
                changes.append({
                    "address": address, "coin": coin, "change_type": "SIZE_CHANGE",
                    "previous_state": _slim(prev), "new_state": _slim(cur), "ts": snapshot_ts,
                })

        if abs(cur["leverage"] - prev.get("leverage", 0)) > leverage_threshold:
            changes.append({
                "address": address, "coin": coin, "change_type": "LEVERAGE_CHANGE",
                "previous_state": _slim(prev), "new_state": _slim(cur), "ts": snapshot_ts,
            })

    for coin in prev_positions:
        if coin not in current_map:
            changes.append({
                "address": address, "coin": coin, "change_type": "CLOSED",
                "previous_state": _slim(prev_positions[coin]), "new_state": None,
                "ts": snapshot_ts,
            })

    return changes


async def _detect_whale_events(
    db,
    address: str,
    current_positions: list[dict],
    snapshot_ts: datetime,
) -> list[dict]:
    """Detect whale events for a Q1 trader. Caller is responsible for quartile check."""
    events = []
    dormant_cutoff = snapshot_ts - timedelta(days=settings.whale_dormant_days)

    current_map = {p["coin"]: p for p in current_positions}

    prev_pos_doc = await db.hl_signals_positions.find_one(
        {"address": address, "snapshot_ts": {"$lt": snapshot_ts}},
        sort=[("snapshot_ts", -1)],
    )
    prev_map: dict[str, dict] = {}
    if prev_pos_doc:
        prev_ts = prev_pos_doc["snapshot_ts"]
        cursor = db.hl_signals_positions.find(
            {"address": address, "snapshot_ts": prev_ts}, {"_id": 0}
        )
        # Skip the "no open positions" sentinel doc (coin=None) — without it,
        # an address that closed all positions would never get a doc written
        # at that snapshot_ts, so prev_pos_doc would keep resolving to the
        # last snapshot where it *did* have positions and EXIT would re-fire
        # every snapshot forever.
        prev_map = {doc["coin"]: doc async for doc in cursor if doc["coin"] is not None}

    # Batch-check dormancy for all new coins in one query
    new_coins = [coin for coin in current_map if coin not in prev_map
                 and current_map[coin]["size_usd"] >= settings.whale_min_usd]
    dormant_coins: set[str] = set()
    if new_coins:
        # Use position_changes (30-day TTL) instead of positions (1-day TTL).
        # Positions older than 1 day are gone, so querying them always returns empty,
        # making every new coin look dormant and generating false WAKEUP events.
        recent_pipeline = [
            {"$match": {
                "address": address,
                "coin": {"$in": new_coins},
                "ts": {"$gte": dormant_cutoff},
            }},
            {"$group": {"_id": "$coin"}},
        ]
        recent_docs = await db.hl_signals_position_changes.aggregate(recent_pipeline).to_list(
            len(new_coins) + 5
        )
        recent_seen = {d["_id"] for d in recent_docs}
        dormant_coins = set(new_coins) - recent_seen

    for coin, cur in current_map.items():
        if cur["size_usd"] < settings.whale_min_usd:
            continue

        if coin not in prev_map:
            event_type = "WAKEUP" if coin in dormant_coins else "SCALEUP"
            events.append({
                "address": address, "coin": coin, "event_type": event_type,
                "side": cur["side"], "size_usd": cur["size_usd"], "ts": snapshot_ts,
                "metadata": {"prev_size_usd": 0, "new_size_usd": cur["size_usd"]},
            })
            continue

        prev = prev_map[coin]

        if cur["side"] != prev["side"]:
            events.append({
                "address": address, "coin": coin, "event_type": "FLIP",
                "side": cur["side"], "size_usd": cur["size_usd"], "ts": snapshot_ts,
                "metadata": {"prev_side": prev["side"], "prev_size_usd": prev["size_usd"]},
            })
            continue

        if prev["size_usd"] > 0:
            ratio = (cur["size_usd"] - prev["size_usd"]) / prev["size_usd"]
            if ratio >= settings.whale_scaleup_threshold:
                events.append({
                    "address": address, "coin": coin, "event_type": "SCALEUP",
                    "side": cur["side"], "size_usd": cur["size_usd"], "ts": snapshot_ts,
                    "metadata": {"prev_size_usd": prev["size_usd"], "ratio": ratio},
                })

        if cur["leverage"] - prev.get("leverage", 0) >= settings.leverage_change_threshold:
            events.append({
                "address": address, "coin": coin, "event_type": "LEVERAGE_PUSH",
                "side": cur["side"], "size_usd": cur["size_usd"], "ts": snapshot_ts,
                "metadata": {"prev_leverage": prev.get("leverage", 0), "new_leverage": cur["leverage"]},
            })

    for coin, prev in prev_map.items():
        if coin not in current_map and prev["size_usd"] >= settings.whale_min_usd:
            events.append({
                "address": address, "coin": coin, "event_type": "EXIT",
                "side": prev["side"], "size_usd": prev["size_usd"], "ts": snapshot_ts,
                "metadata": {"prev_size_usd": prev["size_usd"]},
            })

    return events


def _rss_mb() -> float:
    """Current RSS in MB from /proc/self/status; fallback to ru_maxrss historical peak."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024  # kB -> MB
    except Exception:
        pass
    # Fallback: ru_maxrss units differ by platform — KB on Linux, bytes on macOS.
    ru_maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
    return ru_maxrss / divisor


async def run_snapshot() -> None:
    logger.info('"Starting position snapshot", "rss_mb": %.1f', _rss_mb())
    db = get_db()
    now = datetime.utcnow()

    cursor = db.hl_signals_traders.find(
        {"cohort_status": "active"},
        {"address": 1, "skill_quartile": 1},
    )
    traders = [doc async for doc in cursor]
    addresses = [doc["address"] for doc in traders]
    skill_map = {doc["address"]: doc.get("skill_quartile", 4) for doc in traders}
    del traders  # free before the heavy work begins

    if not addresses:
        logger.warning('"No active traders in cohort, skipping snapshot"')
        return

    logger.info('"Fetching positions", "traders": %d, "batch_size": %d', len(addresses), BATCH_SIZE)

    semaphore = asyncio.Semaphore(settings.snapshot_concurrency)
    # Limit concurrent MongoDB operations: each _detect_changes call opens 2 cursors.
    # 50 concurrent × 2 cursors = 100 pool connections — saturates the 20-connection
    # pool and queues everything in memory. Cap at 10 to stay well within the pool.
    db_sem = asyncio.Semaphore(10)
    total_positions = 0
    total_changes = 0
    total_whale_events = 0
    errors = 0

    async with aiohttp.ClientSession() as session:
        for batch_start in range(0, len(addresses), BATCH_SIZE):
            batch_addrs = addresses[batch_start : batch_start + BATCH_SIZE]

            # ── 1. Fetch positions for this batch (concurrent, bounded by semaphore) ──
            fetch_results = await asyncio.gather(
                *[fetch_positions(session, addr, semaphore) for addr in batch_addrs]
            )

            # ── 2. Parse ──────────────────────────────────────────────────────────────
            batch_positions: list[dict] = []
            addr_positions: dict[str, list[dict]] = {}
            for addr, raw_pos in zip(batch_addrs, fetch_results):
                if raw_pos is None:
                    errors += 1
                    continue
                parsed = [p for r in raw_pos if (p := _parse_position(r, addr, now))]
                if parsed:
                    batch_positions.extend(parsed)
                    addr_positions[addr] = parsed
                else:
                    # Sentinel doc so prev-snapshot lookups for this address
                    # see "checked, zero open positions" instead of skipping
                    # back to the last snapshot that had real positions.
                    batch_positions.append({
                        "address": addr, "coin": None, "snapshot_ts": now,
                        "side": None, "size_usd": 0,
                    })

            del fetch_results  # HTTP response payloads no longer needed

            # ── 3. Write positions ────────────────────────────────────────────────────
            if batch_positions:
                await db.hl_signals_positions.insert_many(batch_positions, ordered=False)
                total_positions += len(batch_positions)
            del batch_positions

            # ── 4. Detect position changes (capped at 10 concurrent DB ops) ─────────
            async def _detect_changes_bounded(addr):
                async with db_sem:
                    return await _detect_changes(
                        db, addr, addr_positions.get(addr, []), now,
                        settings.position_change_threshold_pct,
                        settings.leverage_change_threshold,
                    )

            change_lists = await asyncio.gather(*[_detect_changes_bounded(a) for a in batch_addrs])
            batch_changes = [c for cs in change_lists for c in cs]
            del change_lists
            if batch_changes:
                await db.hl_signals_position_changes.insert_many(batch_changes, ordered=False)
                total_changes += len(batch_changes)
            del batch_changes

            # ── 5. Detect whale events for Q1 traders only ───────────────────────────
            q1_addrs = [a for a in batch_addrs if skill_map.get(a, 4) == 1]
            if q1_addrs:
                async def _whale_bounded(addr):
                    async with db_sem:
                        return await _detect_whale_events(db, addr, addr_positions.get(addr, []), now)

                whale_lists = await asyncio.gather(*[_whale_bounded(a) for a in q1_addrs])
                batch_whale = [e for es in whale_lists for e in es]
                del whale_lists
                if batch_whale:
                    await db.hl_signals_whale_events.insert_many(batch_whale, ordered=False)
                    total_whale_events += len(batch_whale)
                del batch_whale

            del addr_positions
            gc.collect()  # return cyclic-ref memory promptly between batches

    logger.info(
        '"Snapshot complete", "positions": %d, "changes": %d, "whale_events": %d, "errors": %d, "rss_mb": %.1f',
        total_positions, total_changes, total_whale_events, errors, _rss_mb(),
    )

    # ── Aggregate active position counts/sizes into trader docs ──────────────
    pos_pipeline = [
        {"$match": {"snapshot_ts": now, "coin": {"$ne": None}}},
        {"$group": {
            "_id": "$address",
            "active_positions_count": {"$sum": 1},
            "active_positions_usd": {"$sum": "$size_usd"},
        }},
    ]
    pos_stats = await db.hl_signals_positions.aggregate(pos_pipeline).to_list(10_000)
    if pos_stats:
        bulk_ops = [
            UpdateOne(
                {"address": doc["_id"]},
                {"$set": {
                    "active_positions_count": doc["active_positions_count"],
                    "active_positions_usd": doc["active_positions_usd"],
                }},
            )
            for doc in pos_stats
        ]
        await db.hl_signals_traders.bulk_write(bulk_ops, ordered=False)
        active_addrs = {doc["_id"] for doc in pos_stats}
        await db.hl_signals_traders.update_many(
            {"address": {"$nin": list(active_addrs)}, "cohort_status": "active"},
            {"$set": {"active_positions_count": 0, "active_positions_usd": 0.0}},
        )

    await run_convergence(now)

    from .alert_engine import run_alert_engine
    await run_alert_engine(now)
