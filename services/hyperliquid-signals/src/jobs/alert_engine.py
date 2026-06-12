"""Alert engine — evaluates trading rules after each snapshot and resolves expired alerts.

Rule definitions and firing logic live in rules.py (shared with the realtime
WS whale monitor). This module scans the last 10 minutes of whale_events
recorded by the snapshot job and evaluates them against the latest
coin_metrics snapshot.
"""
import logging
from datetime import datetime, timedelta

from ..db import get_db
from .rules import evaluate_wakeup, evaluate_flip

logger = logging.getLogger(__name__)


async def _current_price(db, coin: str) -> float | None:
    doc = await db.hl_signals_prices.find_one({"coin": coin}, sort=[("ts", -1)])
    return float(doc["price"]) if doc else None


async def _close_alert(db, alert: dict, exit_px: float, exit_reason: str) -> None:
    entry_px = alert["entry_px"]
    raw = (exit_px - entry_px) / entry_px if entry_px > 0 else 0.0
    ret = raw if alert["side"] == "LONG" else -raw
    await db.hl_signals_trade_alerts.update_one(
        {"_id": alert["_id"]},
        {"$set": {
            "status":      "WIN" if ret > 0 else "LOSS",
            "exit_px":     exit_px,
            "return_pct":  round(ret * 100, 3),
            "exit_reason": exit_reason,
        }},
    )


async def _resolve_expired(db, now: datetime) -> int:
    expired = db.hl_signals_trade_alerts.find({
        "status": "OPEN", "hold_until": {"$lte": now},
    })
    resolved = 0
    async for alert in expired:
        exit_px = await _current_price(db, alert["coin"])
        if exit_px is None:
            continue
        await _close_alert(db, alert, exit_px, "timer")
        resolved += 1
    return resolved


async def run_alert_engine(snapshot_ts: datetime) -> None:
    db = get_db()
    now = snapshot_ts

    resolved = await _resolve_expired(db, now)
    if resolved:
        logger.info('"resolved %d trade alerts"', resolved)

    # Latest coin_metrics snapshot
    latest_doc = await db.hl_signals_coin_metrics.find_one(sort=[("snapshot_ts", -1)])
    if not latest_doc:
        return
    latest_ts = latest_doc["snapshot_ts"]
    metrics: dict[str, dict] = {
        doc["coin"]: doc
        async for doc in db.hl_signals_coin_metrics.find({"snapshot_ts": latest_ts}, {"_id": 0})
    }

    # Whale events from last 10 min
    since = now - timedelta(minutes=10)
    whale_docs = await db.hl_signals_whale_events.find(
        {"ts": {"$gte": since}}, {"_id": 0}
    ).to_list(500)
    wakeups = [w for w in whale_docs if w["event_type"] == "WAKEUP"]
    flips   = [w for w in whale_docs if w["event_type"] == "FLIP"]

    # ── Rule 1: WAKEUP + cohort crowded ≥10:1 on either side (symmetric) ───────────
    for w in wakeups:
        coin = w["coin"]
        px = await _current_price(db, coin)
        if not px:
            continue
        await evaluate_wakeup(
            db, coin, w["side"], w.get("size_usd", 0), w.get("address", ""),
            metrics.get(coin), px, now, signal_ts=w["ts"],
        )

    # ── Rule 2: Whale FLIP ────────────────────────────────────────────────────────
    for w in flips:
        coin = w["coin"]
        px = await _current_price(db, coin)
        if not px:
            continue
        await evaluate_flip(
            db, coin, w["side"], w.get("size_usd", 0), w.get("address", ""),
            px, now, signal_ts=w["ts"],
        )

    logger.info('"alert engine complete"')
