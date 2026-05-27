"""Alert engine — evaluates trading rules after each snapshot and resolves expired alerts.

Rules (from backtest results):
  WAKEUP_LS10            : Q1 whale WAKEUP while L:S ≥ 10 → hold 24h
  WAKEUP_LS10_4H         : same trigger → hold 4h          (backtest edge peaks at 4h)
  WAKEUP_LS10_WHALE_EXIT : same trigger → exit when the triggering whale closes
  LS10_CROSS             : L:S crosses above 10 first time → hold 72h
  WHALE_EXIT_FADE        : Q1 whale EXIT → fade their side  → hold 72h

The three WAKEUP_LS10* variants fire on the SAME condition simultaneously so their
exit rules can be compared head-to-head in live simulation.
"""
import logging
from datetime import datetime, timedelta

from ..db import get_db

logger = logging.getLogger(__name__)

# Fixed-timer holds in hours. WHALE_EXIT variant uses this only as a safety cap;
# it normally resolves early when the triggering whale closes the position.
STRATEGY_HOLD: dict[str, int] = {
    "WAKEUP_LS10": 24,
    "WAKEUP_LS10_4H": 4,
    "WAKEUP_LS10_WHALE_EXIT": 168,  # 7-day safety cap
    "LS10_CROSS": 72,
    "WHALE_FLIP": 4,
}

WAKEUP_VARIANTS = ("WAKEUP_LS10", "WAKEUP_LS10_4H", "WAKEUP_LS10_WHALE_EXIT")


async def _current_price(db, coin: str) -> float | None:
    doc = await db.hl_signals_prices.find_one({"coin": coin}, sort=[("ts", -1)])
    return float(doc["price"]) if doc else None


async def _already_open(db, strategy: str, coin: str) -> bool:
    return bool(await db.hl_signals_trade_alerts.find_one(
        {"strategy": strategy, "coin": coin, "status": "OPEN"}
    ))


async def _fire(db, strategy: str, coin: str, side: str, entry_px: float,
                now: datetime, detail: dict) -> None:
    if await _already_open(db, strategy, coin):
        return
    hold_h = STRATEGY_HOLD[strategy]
    await db.hl_signals_trade_alerts.insert_one({
        "strategy": strategy,
        "coin": coin,
        "side": side,
        "entry_px": entry_px,
        "fired_at": now,
        "hold_hours": hold_h,
        "hold_until": now + timedelta(hours=hold_h),
        "status": "OPEN",
        "exit_px": None,
        "return_pct": None,
        "trigger_detail": detail,
    })
    logger.info('"Trade alert fired", "strategy": "%s", "coin": "%s", "side": "%s", "px": %.5g',
                strategy, coin, side, entry_px)


async def _close_alert(db, alert: dict, exit_px: float, exit_reason: str) -> None:
    entry_px = alert["entry_px"]
    raw = (exit_px - entry_px) / entry_px if entry_px > 0 else 0.0
    ret = raw if alert["side"] == "LONG" else -raw
    await db.hl_signals_trade_alerts.update_one(
        {"_id": alert["_id"]},
        {"$set": {
            "status": "WIN" if ret > 0 else "LOSS",
            "exit_px": exit_px,
            "return_pct": round(ret * 100, 3),
            "exit_reason": exit_reason,
        }},
    )


async def _resolve_expired(db, now: datetime) -> int:
    expired = db.hl_signals_trade_alerts.find({
        "status": "OPEN",
        "hold_until": {"$lte": now},
    })
    resolved = 0
    async for alert in expired:
        exit_px = await _current_price(db, alert["coin"])
        if exit_px is None:
            continue
        reason = "max_hold" if alert["strategy"] == "WAKEUP_LS10_WHALE_EXIT" else "timer"
        await _close_alert(db, alert, exit_px, reason)
        resolved += 1
    return resolved


async def _resolve_whale_exits(db, now: datetime) -> int:
    """Close WAKEUP_LS10_WHALE_EXIT alerts when the triggering whale closes/flips
    the position on that coin (detected via position_changes since fire time)."""
    cursor = db.hl_signals_trade_alerts.find({
        "strategy": "WAKEUP_LS10_WHALE_EXIT",
        "status": "OPEN",
    })
    resolved = 0
    async for alert in cursor:
        whale = (alert.get("trigger_detail") or {}).get("whale_address")
        if not whale:
            continue
        closed = await db.hl_signals_position_changes.find_one({
            "address": whale,
            "coin": alert["coin"],
            "change_type": {"$in": ["CLOSED", "FLIP"]},
            "ts": {"$gt": alert["fired_at"]},
        })
        if not closed:
            continue
        exit_px = await _current_price(db, alert["coin"])
        if exit_px is None:
            continue
        await _close_alert(db, alert, exit_px, "whale_exit")
        resolved += 1
    return resolved


async def run_alert_engine(snapshot_ts: datetime) -> None:
    db = get_db()
    now = snapshot_ts

    resolved = await _resolve_expired(db, now)
    resolved += await _resolve_whale_exits(db, now)
    if resolved:
        logger.info('"Resolved %d trade alerts"', resolved)

    # Latest coin_metrics snapshot
    latest_doc = await db.hl_signals_coin_metrics.find_one(sort=[("snapshot_ts", -1)])
    if not latest_doc:
        return
    latest_ts = latest_doc["snapshot_ts"]
    cursor = db.hl_signals_coin_metrics.find({"snapshot_ts": latest_ts}, {"_id": 0})
    metrics: dict[str, dict] = {doc["coin"]: doc async for doc in cursor}

    # Whale events from last 10 min
    since = now - timedelta(minutes=10)
    whale_docs = await db.hl_signals_whale_events.find(
        {"ts": {"$gte": since}}, {"_id": 0}
    ).to_list(500)
    wakeups = [w for w in whale_docs if w["event_type"] == "WAKEUP"]
    flips   = [w for w in whale_docs if w["event_type"] == "FLIP"]

    # ── Rule 1: WAKEUP + L:S ≥ 10 (fires 3 exit-variants for comparison) ──
    for w in wakeups:
        coin = w["coin"]
        cm = metrics.get(coin)
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
            "ls_ratio": round(ls, 2),
            "whale_size_usd": w.get("size_usd", 0),
            "whale_address": w.get("address", ""),
        }
        for variant in WAKEUP_VARIANTS:
            await _fire(db, variant, coin, w["side"], px, now, detail)

    # ── Rule 2: L:S crosses above 10 ────────────────────────────────────
    for coin, cm in metrics.items():
        short_usd = cm.get("short_usd", 0)
        if short_usd <= 0:
            continue
        ls = cm["long_usd"] / short_usd
        if ls < 10:
            continue
        prev = await db.hl_signals_coin_metrics.find_one(
            {"coin": coin, "snapshot_ts": {"$lt": latest_ts}},
            sort=[("snapshot_ts", -1)],
        )
        if not prev:
            continue
        prev_s = prev.get("short_usd", 0)
        prev_ls = prev["long_usd"] / prev_s if prev_s > 0 else float("inf")
        if prev_ls >= 10:
            continue  # not a fresh cross
        px = await _current_price(db, coin)
        if not px:
            continue
        await _fire(db, "LS10_CROSS", coin, "LONG", px, now, {
            "ls_ratio": round(ls, 2),
            "prev_ls_ratio": round(prev_ls, 2),
        })

    # ── Rule 3: Whale FLIP — follow the flip direction ───────────────────────
    for w in flips:
        coin = w["coin"]
        px = await _current_price(db, coin)
        if not px:
            continue
        await _fire(db, "WHALE_FLIP", coin, w["side"], px, now, {
            "whale_size_usd": w.get("size_usd", 0),
            "whale_address": w.get("address", ""),
            "previous_side": "SHORT" if w["side"] == "LONG" else "LONG",
        })

    logger.info('"Alert engine complete"')
