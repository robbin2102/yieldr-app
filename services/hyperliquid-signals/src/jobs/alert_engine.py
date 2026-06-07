"""Alert engine — evaluates trading rules after each snapshot and resolves expired alerts.

Rules (from backtest results):
  WAKEUP_LS10    : Q1 whale WAKEUP while L:S ≥ 10 → hold 24h
  WAKEUP_LS10_4H : same trigger → hold 4h  (backtest edge peaks at 4h)
  WAKEUP_LS20    : Q1 whale WAKEUP while L:S ≥ 20 → hold 4h  (71.4%/+1.20%, n=63)
  WHALE_FLIP     : Q1 whale reverses own position → follow flip direction → hold 4h
"""
import asyncio
import logging
from datetime import datetime, timedelta

from ..db import get_db

logger = logging.getLogger(__name__)

STRATEGY_HOLD: dict[str, int] = {
    "WAKEUP_LS10":    24,
    "WAKEUP_LS10_4H": 4,
    "WAKEUP_LS20":    4,
    "WHALE_FLIP":     4,
}

WAKEUP_LS10_VARIANTS = ("WAKEUP_LS10", "WAKEUP_LS10_4H")


async def _current_price(db, coin: str) -> float | None:
    doc = await db.hl_signals_prices.find_one({"coin": coin}, sort=[("ts", -1)])
    return float(doc["price"]) if doc else None


async def _already_open(db, strategy: str, coin: str) -> bool:
    return bool(await db.hl_signals_trade_alerts.find_one(
        {"strategy": strategy, "coin": coin, "status": "OPEN"}
    ))


async def _fire(db, strategy: str, coin: str, side: str, entry_px: float,
                now: datetime, detail: dict) -> dict | None:
    """Insert a new trade alert. Returns the inserted doc (with _id), or None if skipped."""
    if await _already_open(db, strategy, coin):
        return None
    hold_h = STRATEGY_HOLD[strategy]
    doc = {
        "strategy":     strategy,
        "coin":         coin,
        "side":         side,
        "entry_px":     entry_px,
        "fired_at":     now,
        "hold_hours":   hold_h,
        "hold_until":   now + timedelta(hours=hold_h),
        "status":       "OPEN",
        "exit_px":      None,
        "return_pct":   None,
        "trigger_detail": detail,
    }
    result = await db.hl_signals_trade_alerts.insert_one(doc)
    doc["_id"] = result.inserted_id
    logger.info('"alert fired" strategy="%s" coin="%s" side="%s" px=%.5g',
                strategy, coin, side, entry_px)
    return doc


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

    # ── Rule 1: WAKEUP + L:S ≥ 10 ──────────────────────────────────────────────────
    for w in wakeups:
        coin = w["coin"]
        cm   = metrics.get(coin)
        if not cm:
            continue
        short_usd = cm.get("short_usd", 0)
        if short_usd <= 0:
            continue
        ls = cm["long_usd"] / short_usd
        if ls < 10:
            continue
        px = await _current_price(db, coin)
        if not px:
            continue
        detail = {
            "ls_ratio":        round(ls, 2),
            "whale_size_usd":  w.get("size_usd", 0),
            "whale_address":   w.get("address", ""),
        }
        for variant in WAKEUP_LS10_VARIANTS:
            fired = await _fire(db, variant, coin, w["side"], px, now, detail)
            if fired:
                asyncio.create_task(_bot_execute(fired))

        # Rule 1b: WAKEUP + L:S ≥ 20
        if ls >= 20:
            fired = await _fire(db, "WAKEUP_LS20", coin, w["side"], px, now, detail)
            if fired:
                asyncio.create_task(_bot_execute(fired))

    # ── Rule 2: Whale FLIP ────────────────────────────────────────────────────────
    for w in flips:
        coin = w["coin"]
        px   = await _current_price(db, coin)
        if not px:
            continue
        fired = await _fire(db, "WHALE_FLIP", coin, w["side"], px, now, {
            "whale_size_usd":  w.get("size_usd", 0),
            "whale_address":   w.get("address", ""),
            "previous_side":   "SHORT" if w["side"] == "LONG" else "LONG",
        })
        if fired:
            asyncio.create_task(_bot_execute(fired))

    logger.info('"alert engine complete"')


async def _bot_execute(alert: dict) -> None:
    """Thin wrapper — catches all exceptions so bot errors never crash the engine."""
    try:
        from .execution_bot import bot_execute
        await bot_execute(alert)
    except Exception:
        logger.exception("BOT: unhandled error in bot_execute")
