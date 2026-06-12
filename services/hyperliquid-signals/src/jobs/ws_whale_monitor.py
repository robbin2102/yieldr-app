"""Realtime whale-event monitor — WAKEUP/FLIP detection in ~1s via WebSocket.

Subscribes to `userFills` for every Q1 cohort address (~150 wallets) plus
`allMids`, all over a single Hyperliquid websocket connection. On each fill
for a tracked address, classifies it as WAKEUP/FLIP using an in-memory
position cache (seeded from the userFills snapshot at startup) and — if it
matches Rule 1 (WAKEUP + cohort crowded >=10:1) or Rule 2 (WHALE_FLIP) —
fires the alert immediately via rules.py, using the cached allMids price.

This is purely an additional, faster *first* detection path. The existing
snapshot job (SNAPSHOT_INTERVAL_S) keeps running unchanged and remains the
source of truth for cohort membership, coin_metrics (crowd ratios), and
whale-event detection as a fallback — `fire()`'s already-open check prevents
duplicate alerts if both paths fire for the same event.

Gated behind WS_MONITOR_ENABLED (default off) — needs testnet validation
before enabling on a live deployment.
"""
import asyncio
import logging
import time
from datetime import datetime, timedelta

from ..config import settings
from ..db import get_db
from .rules import evaluate_wakeup, evaluate_flip, evaluate_wakeup_ls_low, evaluate_wakeup_ls_low_short

logger = logging.getLogger(__name__)

# address -> {coin: {"side": "LONG"|"SHORT", "size_usd": float}}
_position_cache: dict[str, dict[str, dict]] = {}
_subscribed: set[str] = set()
_mid_prices: dict[str, float] = {}
_loop: asyncio.AbstractEventLoop | None = None

# Monotonic timestamp of the last allMids message — used to detect a dead
# websocket (allMids should arrive roughly every second while connected).
_last_mids_msg: float = 0.0

# How long allMids can go silent before we treat the connection as dead.
_STALE_AFTER_S = 30
# How often to check for staleness while a session is running.
_HEALTH_CHECK_INTERVAL_S = 15
# Reconnect backoff bounds.
_BACKOFF_INITIAL_S = 5
_BACKOFF_MAX_S = 60
# A session has to survive this long before backoff resets to the initial delay.
_BACKOFF_RESET_AFTER_S = 60


def _on_all_mids(msg: dict) -> None:
    global _last_mids_msg
    _last_mids_msg = time.monotonic()
    try:
        for coin, px in msg["data"]["mids"].items():
            _mid_prices[coin] = float(px)
    except (KeyError, TypeError, ValueError):
        pass


def _on_user_fills(address: str, msg: dict) -> None:
    """SDK callback — runs on the websocket thread. Hand off to the main loop."""
    if _loop is None:
        return
    try:
        data = msg["data"]
        fills = data.get("fills", [])
    except (KeyError, TypeError):
        return

    if data.get("isSnapshot"):
        _seed_position_cache(address, fills)
        return

    for f in fills:
        asyncio.run_coroutine_threadsafe(_handle_fill(address, f), _loop)


def _seed_position_cache(address: str, fills: list[dict]) -> None:
    """Initialize the cache from the userFills snapshot's most recent fill per
    coin, so the first live fill after startup has a baseline to diff against."""
    by_coin: dict[str, dict] = {}
    for f in fills:
        try:
            coin = f["coin"]
            px = float(f["px"])
            sz = float(f["sz"])
            start = float(f.get("startPosition", "0"))
            delta = sz if f.get("side") == "B" else -sz
            new_pos = start + delta
        except (KeyError, ValueError, TypeError):
            continue
        side = "LONG" if new_pos > 0 else ("SHORT" if new_pos < 0 else None)
        if side:
            by_coin[coin] = {"side": side, "size_usd": abs(new_pos) * px}
        else:
            by_coin.pop(coin, None)
    _position_cache[address] = by_coin


async def _is_dormant(db, address: str, coin: str, now: datetime) -> bool:
    cutoff = now - timedelta(days=settings.whale_dormant_days)
    doc = await db.hl_signals_position_changes.find_one({
        "address": address, "coin": coin, "ts": {"$gte": cutoff},
    })
    return doc is None


async def _handle_fill(address: str, f: dict) -> None:
    try:
        coin  = f["coin"]
        px    = float(f["px"])
        sz    = float(f["sz"])
        start = float(f.get("startPosition", "0"))
        fill_ts = datetime.utcfromtimestamp(f["time"] / 1000)
    except (KeyError, ValueError, TypeError):
        return

    delta = sz if f.get("side") == "B" else -sz
    new_pos = start + delta
    new_side = "LONG" if new_pos > 0 else ("SHORT" if new_pos < 0 else None)
    size_usd = abs(new_pos) * px

    prev = _position_cache.get(address, {}).get(coin)
    prev_side = prev["side"] if prev else None

    _position_cache.setdefault(address, {})[coin] = (
        {"side": new_side, "size_usd": size_usd} if new_side else None
    )
    if _position_cache[address].get(coin) is None:
        _position_cache[address].pop(coin, None)

    if new_side is None or size_usd < settings.whale_min_usd:
        return

    db = get_db()
    now = datetime.utcnow()

    if prev_side is None and abs(start) < 1e-12:
        if await _is_dormant(db, address, coin, now):
            await _on_wakeup(db, address, coin, new_side, size_usd, fill_ts, now)
        return

    if prev_side is not None and new_side != prev_side:
        await _on_flip(db, address, coin, new_side, size_usd, fill_ts, now)


async def _on_wakeup(db, address: str, coin: str, side: str, size_usd: float,
                      fill_ts: datetime, now: datetime) -> None:
    await db.hl_signals_whale_events.insert_one({
        "address": address, "coin": coin, "event_type": "WAKEUP",
        "side": side, "size_usd": size_usd, "ts": fill_ts,
        "metadata": {"prev_size_usd": 0, "new_size_usd": size_usd, "source": "ws"},
    })
    px = _mid_prices.get(coin)
    if px is None:
        return
    cm = await db.hl_signals_coin_metrics.find_one(
        {"coin": coin}, sort=[("snapshot_ts", -1)], projection={"_id": 0}
    )
    await evaluate_wakeup(db, coin, side, size_usd, address, cm, px, now, signal_ts=fill_ts)
    await evaluate_wakeup_ls_low(db, coin, side, size_usd, address, cm, px, now, signal_ts=fill_ts)
    await evaluate_wakeup_ls_low_short(db, coin, side, size_usd, address, cm, px, now, signal_ts=fill_ts)


async def _on_flip(db, address: str, coin: str, side: str, size_usd: float,
                    fill_ts: datetime, now: datetime) -> None:
    await db.hl_signals_whale_events.insert_one({
        "address": address, "coin": coin, "event_type": "FLIP",
        "side": side, "size_usd": size_usd, "ts": fill_ts,
        "metadata": {"prev_side": "SHORT" if side == "LONG" else "LONG", "source": "ws"},
    })
    px = _mid_prices.get(coin)
    if px is None:
        return
    await evaluate_flip(db, coin, side, size_usd, address, px, now, signal_ts=fill_ts)


async def _sync_subscriptions(info) -> None:
    db = get_db()
    cursor = db.hl_signals_traders.find(
        {"cohort_status": "active", "skill_quartile": 1}, {"address": 1}
    )
    addrs = {doc["address"] async for doc in cursor}

    new = addrs - _subscribed
    for addr in new:
        try:
            info.subscribe({"type": "userFills", "user": addr},
                            lambda msg, a=addr: _on_user_fills(a, msg))
            _subscribed.add(addr)
        except Exception:
            logger.exception("WS monitor: subscribe failed for %s", addr)

    if new:
        logger.info('"WS monitor subscriptions synced", "q1_count": %d, "added": %d, "total_subscribed": %d',
                     len(addrs), len(new), len(_subscribed))


async def _run_session(info) -> None:
    """Run one websocket session until it goes stale or errors out."""
    global _last_mids_msg
    _last_mids_msg = time.monotonic()
    info.subscribe({"type": "allMids"}, _on_all_mids)

    # Fresh connection — drop any previous subscription bookkeeping so
    # _sync_subscriptions re-subscribes every Q1 address on this socket.
    _subscribed.clear()
    await _sync_subscriptions(info)

    last_sync = time.monotonic()
    while True:
        await asyncio.sleep(_HEALTH_CHECK_INTERVAL_S)

        idle = time.monotonic() - _last_mids_msg
        if idle > _STALE_AFTER_S:
            raise ConnectionError(f"WS monitor: allMids stale for {idle:.0f}s — reconnecting")

        if time.monotonic() - last_sync >= settings.ws_monitor_refresh_s:
            try:
                await _sync_subscriptions(info)
            except Exception:
                logger.exception("WS monitor: subscription sync failed")
            last_sync = time.monotonic()


async def run_ws_monitor() -> None:
    """Background task — call only when settings.ws_monitor_enabled is True.

    Reconnects with exponential backoff if the websocket dies or goes stale
    (no allMids messages for _STALE_AFTER_S). Each new session resubscribes
    allMids + userFills for all Q1 addresses from scratch.
    """
    global _loop
    from hyperliquid.info import Info
    from ..lib.hl_exchange import api_url

    _loop = asyncio.get_running_loop()
    logger.info('"WS whale monitor starting"')

    backoff = _BACKOFF_INITIAL_S
    while True:
        started = time.monotonic()
        try:
            info = Info(api_url(), skip_ws=False)
            await _run_session(info)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("WS monitor: session ended, reconnecting")

        if time.monotonic() - started >= _BACKOFF_RESET_AFTER_S:
            backoff = _BACKOFF_INITIAL_S
        else:
            backoff = min(backoff * 2, _BACKOFF_MAX_S)

        logger.info('"WS monitor reconnecting in %ds"', backoff)
        await asyncio.sleep(backoff)
