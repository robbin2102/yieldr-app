"""Shared trade-alert rule definitions and firing logic.

Used by both the snapshot-driven alert engine (alert_engine.py) and the
realtime WS whale monitor (ws_whale_monitor.py) so both paths fire identical
alerts for identical inputs.

Rules (from backtest results):
  WAKEUP_LS10    : Q1 whale WAKEUP while the cohort is ≥10:1 crowded on either
                   side (L:S ≥ 10 or S:L ≥ 10) → hold 24h
  WAKEUP_LS10_4H : same trigger → hold 4h  (backtest edge peaks at 4h)
  WHALE_FLIP     : Q1 whale reverses own position → follow flip direction → hold 4h

The WAKEUP_LS* rules are symmetric: they fire whether the cohort is
long-crowded (L:S ≥ threshold) or short-crowded (S:L ≥ threshold). The alert's
side always follows the waking whale's own side, so the strategy name and hold
time are the same regardless of which side the cohort is crowded on.

Signal-only (not in BOT_STRATEGIES by default — tracked for live data, not
auto-executed):
  WAKEUP_LS_LOW_24H : Q1 whale WAKEUP while the cohort is only mildly
                      long-crowded (1 <= L:S < 2) → hold 24h
                      (backtest: 78.9% win / +4.62% net, n=19)
  WHALE_SCALEUP_4H  : Q1 whale scales up an existing position by
                      >= WHALE_SCALEUP_THRESHOLD → follow direction → hold 4h
                      (backtest: 58.8% win / +0.53% net, n=114)
"""
import asyncio
import logging
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

STRATEGY_HOLD: dict[str, int] = {
    "WAKEUP_LS10":       24,
    "WAKEUP_LS10_4H":    4,
    "WHALE_FLIP":        4,
    "WAKEUP_LS_LOW_24H": 24,
    "WHALE_SCALEUP_4H":  4,
}

WAKEUP_LS10_VARIANTS = ("WAKEUP_LS10", "WAKEUP_LS10_4H")


async def already_open(db, strategy: str, coin: str) -> bool:
    return bool(await db.hl_signals_trade_alerts.find_one(
        {"strategy": strategy, "coin": coin, "status": "OPEN"}
    ))


async def fire(db, strategy: str, coin: str, side: str, entry_px: float,
               now: datetime, detail: dict, signal_ts: datetime | None = None) -> dict | None:
    """Insert a new trade alert. Returns the inserted doc (with _id), or None if skipped."""
    if await already_open(db, strategy, coin):
        return None
    hold_h = STRATEGY_HOLD[strategy]
    signal_ts = signal_ts or now
    doc = {
        "strategy":     strategy,
        "coin":         coin,
        "side":         side,
        "entry_px":     entry_px,
        "fired_at":     now,
        "signal_ts":    signal_ts,
        "hold_hours":   hold_h,
        "hold_until":   now + timedelta(hours=hold_h),
        "status":       "OPEN",
        "exit_px":      None,
        "return_pct":   None,
        "trigger_detail": detail,
    }
    result = await db.hl_signals_trade_alerts.insert_one(doc)
    doc["_id"] = result.inserted_id
    latency_ms = (now - signal_ts).total_seconds() * 1000
    logger.info('"alert fired" strategy="%s" coin="%s" side="%s" px=%.5g latency_ms=%.0f',
                strategy, coin, side, entry_px, latency_ms)
    return doc


def crowd_ratio(long_usd: float, short_usd: float) -> tuple[float | None, str | None]:
    """Returns (ratio, crowd_side) if the cohort is >=10:1 crowded on either side, else (None, None)."""
    if short_usd > 0 and long_usd / short_usd >= 10:
        return long_usd / short_usd, "long"
    if long_usd > 0 and short_usd / long_usd >= 10:
        return short_usd / long_usd, "short"
    return None, None


async def evaluate_wakeup(db, coin: str, whale_side: str, whale_size_usd: float,
                           whale_address: str, coin_metrics: dict | None,
                           px: float, now: datetime, signal_ts: datetime | None = None) -> None:
    """Rule 1: WAKEUP + cohort crowded >=10:1 on either side (symmetric)."""
    if not coin_metrics:
        return
    ratio, crowd_side = crowd_ratio(coin_metrics.get("long_usd", 0), coin_metrics.get("short_usd", 0))
    if ratio is None:
        return
    detail = {
        "crowd_side":     crowd_side,
        "crowd_ratio":    round(ratio, 2),
        "whale_size_usd": whale_size_usd,
        "whale_address":  whale_address,
    }
    for variant in WAKEUP_LS10_VARIANTS:
        fired = await fire(db, variant, coin, whale_side, px, now, detail, signal_ts)
        if fired:
            asyncio.create_task(bot_execute(fired))


async def evaluate_flip(db, coin: str, whale_side: str, whale_size_usd: float,
                         whale_address: str, px: float, now: datetime,
                         signal_ts: datetime | None = None) -> None:
    """Rule 2: Whale FLIP — follow the flip direction."""
    fired = await fire(db, "WHALE_FLIP", coin, whale_side, px, now, {
        "whale_size_usd": whale_size_usd,
        "whale_address":  whale_address,
        "previous_side":  "SHORT" if whale_side == "LONG" else "LONG",
    }, signal_ts)
    if fired:
        asyncio.create_task(bot_execute(fired))


def ls_in_band(long_usd: float, short_usd: float, lo: float, hi: float) -> bool:
    """True if long_usd/short_usd is in [lo, hi)."""
    if short_usd <= 0:
        return False
    ratio = long_usd / short_usd
    return lo <= ratio < hi


async def evaluate_wakeup_ls_low(db, coin: str, whale_side: str, whale_size_usd: float,
                                  whale_address: str, coin_metrics: dict | None,
                                  px: float, now: datetime, signal_ts: datetime | None = None) -> None:
    """Signal-only: WAKEUP while the cohort is only mildly long-crowded
    (1 <= L:S < 2) → hold 24h."""
    if not coin_metrics:
        return
    long_usd  = coin_metrics.get("long_usd", 0)
    short_usd = coin_metrics.get("short_usd", 0)
    if not ls_in_band(long_usd, short_usd, 1, 2):
        return
    detail = {
        "ls_ratio":       round(long_usd / short_usd, 2),
        "whale_size_usd": whale_size_usd,
        "whale_address":  whale_address,
    }
    fired = await fire(db, "WAKEUP_LS_LOW_24H", coin, whale_side, px, now, detail, signal_ts)
    if fired:
        asyncio.create_task(bot_execute(fired))


async def evaluate_scaleup(db, coin: str, whale_side: str, whale_size_usd: float,
                            whale_address: str, px: float, now: datetime,
                            signal_ts: datetime | None = None) -> None:
    """Signal-only: Q1 whale SCALEUP — follow direction → hold 4h."""
    fired = await fire(db, "WHALE_SCALEUP_4H", coin, whale_side, px, now, {
        "whale_size_usd": whale_size_usd,
        "whale_address":  whale_address,
    }, signal_ts)
    if fired:
        asyncio.create_task(bot_execute(fired))


async def bot_execute(alert: dict) -> None:
    """Thin wrapper — catches all exceptions so bot errors never crash the caller."""
    try:
        from .execution_bot import bot_execute as _bot_execute
        await _bot_execute(alert)
    except Exception:
        logger.exception("BOT: unhandled error in bot_execute")
