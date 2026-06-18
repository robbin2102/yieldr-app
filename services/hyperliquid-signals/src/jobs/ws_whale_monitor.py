"""Realtime whale-event monitor — WAKEUP/FLIP detection in ~1s via WebSocket.

Subscribes to `userFills` for every Q1 cohort address (~150 wallets) plus
`allMids`. On each fill for a tracked address, classifies it as WAKEUP/FLIP
using an in-memory position cache (seeded from the userFills snapshot at
startup) and — if it matches Rule 1 (WAKEUP + cohort crowded >=10:1) or
Rule 2 (WHALE_FLIP) — fires the alert immediately via rules.py, using the
cached allMids price.

This is purely an additional, faster *first* detection path. The existing
snapshot job (SNAPSHOT_INTERVAL_S) keeps running unchanged and remains the
source of truth for cohort membership, coin_metrics (crowd ratios), and
whale-event detection as a fallback — `fire()`'s already-open check prevents
duplicate alerts if both paths fire for the same event.

Hyperliquid enforces "Cannot track more than 30 total users" *per websocket
connection* (confirmed empirically via scripts/test_ws_sharding.py — two
simultaneous connections from the same process/IP, 25 addresses each, both
received all userFills snapshots and live allMids with no throttling). With
~150-160 Q1 addresses, a single connection would blow past that limit, so
addresses are sharded across multiple connections, each subscribing its own
allMids + userFills set. Shard assignment is a stable hash of the address so
membership changes never move an address to a different shard.

Gated behind WS_MONITOR_ENABLED (default off) — needs testnet validation
before enabling on a live deployment.
"""
import asyncio
import hashlib
import logging
import math
import time
from datetime import datetime, timedelta

from ..config import settings
from ..db import get_db
from .rules import evaluate_wakeup, evaluate_flip, evaluate_wakeup_ls_low, evaluate_wakeup_ls_low_short

logger = logging.getLogger(__name__)

# address -> {coin: {"side": "LONG"|"SHORT", "size_usd": float}}
_position_cache: dict[str, dict[str, dict]] = {}
_mid_prices: dict[str, float] = {}
_loop: asyncio.AbstractEventLoop | None = None

# Target number of addresses per websocket connection — comfortably under
# the confirmed-working 25/connection (and the "30 total users" limit).
# Kept well below that ceiling because stable-hash assignment across a
# small number of shards has real variance: with ~150 addresses over 8
# shards (target 20), an unlucky shard can land 8-10 addresses above the
# mean, putting it close to the hard limit. A lower target buys margin.
SHARD_TARGET_SIZE = 15

# shard index -> set of subscribed addresses
_subscribed: dict[int, set[str]] = {}
# shard index -> monotonic timestamp of the last allMids message on that shard
_last_mids_msg: dict[int, float] = {}

# Status surfaced via /api/bot/health for the Agent dashboard.
_status: dict = {
    "num_shards": 0,
    "shards": {},
}


def get_status() -> dict:
    shards: dict[int, dict] = _status.get("shards", {})
    connected_ats = [s["last_connected_at"] for s in shards.values() if s.get("last_connected_at")]
    disconnected_ats = [s["last_disconnected_at"] for s in shards.values() if s.get("last_disconnected_at")]
    reconnect_reasons: dict[str, int] = {}
    for s in shards.values():
        for reason, count in s.get("reconnect_reasons", {}).items():
            reconnect_reasons[reason] = reconnect_reasons.get(reason, 0) + count
    return {
        "connected": bool(shards) and all(s.get("connected") for s in shards.values()),
        "last_connected_at": max(connected_ats) if connected_ats else None,
        "last_disconnected_at": max(disconnected_ats) if disconnected_ats else None,
        "reconnect_count": sum(s.get("reconnect_count", 0) for s in shards.values()),
        "reconnect_reasons": reconnect_reasons,
        "num_shards": _status.get("num_shards", 0),
        "total_subscribed": sum(len(addrs) for addrs in _subscribed.values()),
        "shards": {str(k): dict(v) for k, v in shards.items()},
    }


# How long allMids can go silent before we treat the connection as dead.
_STALE_AFTER_S = 30
# How often to check for staleness while a session is running.
_HEALTH_CHECK_INTERVAL_S = 15
# Reconnect backoff bounds.
_BACKOFF_INITIAL_S = 5
_BACKOFF_MAX_S = 60
# A session has to survive this long before backoff resets to the initial delay.
_BACKOFF_RESET_AFTER_S = 60

# Gap between starting consecutive shards (initial startup and resize restarts).
# Without this, all shards' Info() construction + WS handshake + userFills
# subscribe land in the same instant, which can burst past Hyperliquid's
# rate limit for the whole process/IP — including unrelated REST calls like
# the snapshotter's fetch_positions, causing collateral 429s there too.
_SHARD_STARTUP_STAGGER_S = 1.0


class _WSReconnect(ConnectionError):
    """Raised for the two cases we detect ourselves (vs. exceptions the SDK/
    websocket-client throws at us) — tagged with `reason` so _run_shard can
    record *why* each reconnect happened instead of guessing from message
    text, which is what let the 130-reconnects-in-2h question go
    unanswerable last time."""
    def __init__(self, msg: str, reason: str):
        super().__init__(msg)
        self.reason = reason


def _shard_for(address: str, num_shards: int) -> int:
    """Stable hash-based shard assignment, so an address never moves shards
    when the cohort membership changes (avoids resubscribe/unsubscribe)."""
    return int(hashlib.sha256(address.encode()).hexdigest(), 16) % num_shards


def _on_all_mids(shard: int, msg: dict) -> None:
    _last_mids_msg[shard] = time.monotonic()
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


async def _sync_subscriptions(shard: int, num_shards: int, info) -> None:
    db = get_db()
    cursor = db.hl_signals_traders.find(
        {"cohort_status": "active", "skill_quartile": 1}, {"address": 1}
    )
    addrs = {doc["address"] async for doc in cursor if _shard_for(doc["address"], num_shards) == shard}

    subscribed = _subscribed.setdefault(shard, set())
    new = addrs - subscribed
    for addr in new:
        try:
            info.subscribe({"type": "userFills", "user": addr},
                            lambda msg, a=addr: _on_user_fills(a, msg))
            subscribed.add(addr)
        except Exception as e:
            # subscribe() only raises once the socket is already open — it
            # calls ws.send() directly — so a failure here means the
            # connection itself just died mid-loop, not that this one
            # address is special. Every other address still left in this
            # loop would fail the same way. Treat it as connection-dead and
            # let _run_shard reconnect immediately, instead of limping along
            # on a broken socket until the next allMids staleness timeout
            # (up to _STALE_AFTER_S later) notices.
            raise _WSReconnect(
                f"WS monitor shard {shard}: subscribe failed for {addr}, connection likely dead",
                reason="subscribe_failed",
            ) from e

    if new:
        logger.info('"WS monitor subscriptions synced", "shard": %d, "shard_addrs": %d, '
                     '"added": %d, "shard_subscribed": %d',
                     shard, len(addrs), len(new), len(subscribed))


async def _run_session(shard: int, num_shards: int, info) -> None:
    """Run one shard's websocket session until it goes stale or errors out."""
    _last_mids_msg[shard] = time.monotonic()
    info.subscribe({"type": "allMids"}, lambda msg: _on_all_mids(shard, msg))

    # Fresh connection — drop any previous subscription bookkeeping so
    # _sync_subscriptions re-subscribes every address in this shard.
    _subscribed[shard] = set()
    await _sync_subscriptions(shard, num_shards, info)

    shard_status = _status["shards"][shard]
    shard_status["connected"] = True
    shard_status["last_connected_at"] = datetime.utcnow().isoformat()

    last_sync = time.monotonic()
    while True:
        await asyncio.sleep(_HEALTH_CHECK_INTERVAL_S)

        idle = time.monotonic() - _last_mids_msg[shard]
        if idle > _STALE_AFTER_S:
            raise _WSReconnect(
                f"WS monitor shard {shard}: allMids stale for {idle:.0f}s — reconnecting",
                reason="stale",
            )

        if time.monotonic() - last_sync >= settings.ws_monitor_refresh_s:
            # Let ConnectionError propagate so _run_shard reconnects right
            # away instead of leaving the rest of this shard's addresses
            # subscribed to a dead socket until the staleness check fires.
            await _sync_subscriptions(shard, num_shards, info)
            last_sync = time.monotonic()


async def _run_shard(shard: int, num_shards: int) -> None:
    """Reconnect loop for one shard's websocket connection."""
    from hyperliquid.info import Info
    from ..lib.hl_exchange import api_url

    shard_status = _status["shards"][shard]
    backoff = _BACKOFF_INITIAL_S
    info = None
    loop = asyncio.get_running_loop()
    try:
        while True:
            started = time.monotonic()
            try:
                # Info() makes blocking REST calls (spot_meta + meta) via the
                # `requests` library *before* opening the websocket, with no
                # timeout — on an HL/CloudFront blip these can hang or 504,
                # and since they're synchronous, running them on the event
                # loop directly would stall every other task in the process
                # (the bot job, snapshotter, API server) for as long as they
                # take. Bound them with a timeout and push them to a thread
                # so a slow/erroring HL response only delays this one shard.
                info = await loop.run_in_executor(
                    None, lambda: Info(api_url(), skip_ws=False, timeout=10)
                )
                await _run_session(shard, num_shards, info)
            except asyncio.CancelledError:
                raise
            except _WSReconnect as e:
                # Cases we detect ourselves — reason already tagged.
                reason = e.reason
                logger.warning('"WS monitor: shard %d session ended, reconnecting: %s"', shard, e)
            except Exception as e:
                msg = str(e)
                if "Expired" in msg or "opcode=8" in msg or "ConnectionClosed" in type(e).__name__:
                    reason = "hl_closed"
                    logger.warning('"WS monitor: shard %d connection expired, reconnecting"', shard)
                elif type(e).__name__ == "ServerError":
                    # HL-side 5xx (often CloudFront fronting an overloaded
                    # backend) on the pre-connect meta fetch — transient and
                    # expected, not a bug in our code. Backoff below handles it.
                    reason = "server_error"
                    logger.warning('"WS monitor: shard %d meta fetch failed (%s), reconnecting"', shard, e)
                else:
                    reason = "unknown"
                    logger.exception("WS monitor: shard %d session ended, reconnecting", shard)

            shard_status["connected"] = False
            shard_status["last_disconnected_at"] = datetime.utcnow().isoformat()
            shard_status["reconnect_count"] += 1
            reasons = shard_status.setdefault("reconnect_reasons", {})
            reasons[reason] = reasons.get(reason, 0) + 1

            if time.monotonic() - started >= _BACKOFF_RESET_AFTER_S:
                backoff = _BACKOFF_INITIAL_S
            else:
                backoff = min(backoff * 2, _BACKOFF_MAX_S)

            logger.info('"WS monitor shard %d reconnecting in %ds"', shard, backoff)
            await asyncio.sleep(backoff)
    except asyncio.CancelledError:
        # Stop the SDK's background websocket thread on shutdown — otherwise
        # it keeps running past interpreter exit and logs a spurious
        # "Exception ignored in thread shutdown" traceback.
        if info is not None:
            try:
                info.disconnect_websocket()
            except Exception:
                logger.exception("WS monitor: error closing websocket during shutdown (shard %d)", shard)
        raise


async def _count_shards_needed() -> tuple[int, int]:
    db = get_db()
    total = await db.hl_signals_traders.count_documents(
        {"cohort_status": "active", "skill_quartile": 1}
    )
    num_shards = max(1, math.ceil(total / SHARD_TARGET_SIZE)) if total else 1
    return num_shards, total


async def _watch_for_resize(num_shards: int) -> None:
    """Polls the Q1 cohort size and returns once it has grown/shrunk enough
    to need a different shard count, so run_ws_monitor can restart every
    connection with a freshly computed (and correctly hash-distributed)
    shard count. _sync_subscriptions alone can't fix this — it only adds new
    addresses to their pre-assigned shard, never adds shards."""
    while True:
        await asyncio.sleep(settings.ws_monitor_refresh_s)
        new_num_shards, total = await _count_shards_needed()
        if new_num_shards != num_shards:
            logger.info('"WS monitor: cohort size changed (total_addrs=%d), resharding %d -> %d connections"',
                         total, num_shards, new_num_shards)
            return


async def run_ws_monitor() -> None:
    """Background task — call only when settings.ws_monitor_enabled is True.

    Shards Q1 cohort addresses across multiple websocket connections
    (SHARD_TARGET_SIZE addresses each) to stay under Hyperliquid's
    "Cannot track more than 30 total users" per-connection limit. Each shard
    reconnects independently with its own exponential backoff if its
    websocket dies or goes stale (no allMids messages for _STALE_AFTER_S).

    The shard count is re-evaluated periodically (every ws_monitor_refresh_s)
    against the current cohort size — if it needs to change, every shard
    connection is torn down and restarted with the new count.
    """
    global _loop
    _loop = asyncio.get_running_loop()
    logger.info('"WS whale monitor starting"')

    while True:
        num_shards, total = await _count_shards_needed()

        _subscribed.clear()
        _status["num_shards"] = num_shards
        _status["shards"] = {
            i: {
                "connected": False,
                "last_connected_at": None,
                "last_disconnected_at": None,
                "reconnect_count": 0,
            }
            for i in range(num_shards)
        }

        logger.info('"WS monitor sharding", "total_addrs": %d, "num_shards": %d, "shard_target": %d',
                     total, num_shards, SHARD_TARGET_SIZE)

        shard_tasks: list[asyncio.Task] = []
        for i in range(num_shards):
            shard_tasks.append(asyncio.create_task(_run_shard(i, num_shards)))
            if i < num_shards - 1:
                await asyncio.sleep(_SHARD_STARTUP_STAGGER_S)
        resize_task = asyncio.create_task(_watch_for_resize(num_shards))
        try:
            await asyncio.wait([resize_task, *shard_tasks], return_when=asyncio.FIRST_COMPLETED)
        finally:
            pending = [*shard_tasks, resize_task]
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
