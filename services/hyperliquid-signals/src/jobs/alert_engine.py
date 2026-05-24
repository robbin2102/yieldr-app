"""Alert engine — evaluates trading rules after each snapshot and resolves expired alerts.

Three rules (from backtest results):
  WAKEUP_LS10   : Q1 whale WAKEUP fires while coin L:S ≥ 10  → hold 24h  (91.7% win @ 4h)
  LS10_CROSS    : L:S ratio crosses above 10 for the first time → hold 72h (73.1% win @ 72h)
  WHALE_EXIT_FADE: Q1 whale EXIT fires → fade their side      → hold 72h  (71.5% win @ 72h)
"""
import logging
from datetime import datetime, timedelta

from ..db import get_db

logger = logging.getLogger(__name__)

STRATEGY_HOLD: dict[str, int] = {
    "WAKEUP_LS10": 24,
    "LS10_CROSS": 72,
    "WHALE_EXIT_FADE": 72,
}


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
        entry_px = alert["entry_px"]
        raw = (exit_px - entry_px) / entry_px if entry_px > 0 else 0.0
        ret = raw if alert["side"] == "LONG" else -raw
        await db.hl_signals_trade_alerts.update_one(
            {"_id": alert["_id"]},
            {"$set": {
                "status": "WIN" if ret > 0 else "LOSS",
                "exit_px": exit_px,
                "return_pct": round(ret * 100, 3),
            }},
        )
        resolved += 1
    return resolved


async def run_alert_engine(snapshot_ts: datetime) -> None:
    db = get_db()
    now = snapshot_ts

    resolved = await _resolve_expired(db, now)
    if resolved:
        logger.info('"Resolved %d expired trade alerts"', resolved)

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
    exits   = [w for w in whale_docs if w["event_type"] == "EXIT"]

    # ── Rule 1: WAKEUP + L:S ≥ 10 ────────────────────────────────────────
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
        await _fire(db, "WAKEUP_LS10", coin, w["side"], px, now, {
            "ls_ratio": round(ls, 2),
            "whale_size_usd": w.get("size_usd", 0),
            "whale_address": w.get("address", ""),
        })

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

    # ── Rule 3: Whale EXIT fade ──────────────────────────────────────────
    for w in exits:
        coin = w["coin"]
        fade_side = "SHORT" if w["side"] == "LONG" else "LONG"
        px = await _current_price(db, coin)
        if not px:
            continue
        await _fire(db, "WHALE_EXIT_FADE", coin, fade_side, px, now, {
            "whale_size_usd": w.get("size_usd", 0),
            "whale_address": w.get("address", ""),
            "exited_side": w["side"],
        })

    logger.info('"Alert engine complete"')
