import asyncio
import logging
from datetime import datetime, timezone

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
        # No prior snapshot — all are "new"
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

    # New or changed positions
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

    # Closed positions
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


async def run_snapshot() -> None:
    logger.info('"Starting position snapshot"')
    db = get_db()
    now = datetime.now(timezone.utc)

    # Load active cohort
    cursor = db.hl_signals_traders.find({"cohort_status": "active"}, {"address": 1})
    addresses = [doc["address"] async for doc in cursor]

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

    # Detect changes per address
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

    logger.info(
        '"Snapshot complete", "positions": %d, "changes": %d, "errors": %d',
        len(all_positions),
        len(all_changes),
        errors,
    )

    # Run convergence engine immediately after snapshot
    await run_convergence(now)
