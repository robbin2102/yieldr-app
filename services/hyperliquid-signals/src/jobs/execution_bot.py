"""Execution bot — strategy-driven order execution on Hyperliquid (testnet first)."""
import asyncio
import logging
import time
from datetime import datetime, timezone, timedelta

from bson import ObjectId

from ..config import settings
from ..db import get_db
from ..api.trade_alerts import STRATEGY_META

logger = logging.getLogger(__name__)


def _bot_strategies() -> set[str]:
    return {s.strip() for s in settings.bot_strategies.split(",") if s.strip()}


def _excluded_coins() -> set[str]:
    return {c.strip().upper() for c in settings.bot_excluded_coins.split(",") if c.strip()}


# ── Entry point (called from alert_engine after _fire) ─────────────────────────

async def bot_execute(alert: dict) -> None:
    strategy  = alert["strategy"]
    coin      = alert["coin"]
    side      = alert["side"]
    signal_px = float(alert.get("entry_px") or 0)
    alert_id  = str(alert.get("_id", ""))
    now       = datetime.now(timezone.utc)

    # Every alert that reaches here should produce either a bot_positions or
    # bot_skipped_signals row, or an explicit guard log below — this line
    # makes any "no record at all" case traceable to the exact guard hit.
    logger.info(
        "BOT: bot_execute entry strategy=%s coin=%s alert_id=%s "
        "bot_enabled=%s has_credentials=%s in_strategies=%s excluded=%s",
        strategy, coin, alert_id, settings.bot_enabled,
        bool(settings.hl_private_key and settings.hl_wallet_address),
        strategy in _bot_strategies(), coin in _excluded_coins(),
    )

    if not settings.bot_enabled:
        return
    if not settings.hl_private_key or not settings.hl_wallet_address:
        logger.warning("BOT: credentials missing, set HL_WALLET_ADDRESS + HL_PRIVATE_KEY")
        return

    if strategy not in _bot_strategies():
        return
    if coin in _excluded_coins():
        logger.info("BOT: %s excluded by BOT_EXCLUDED_COINS", coin)
        return

    db = get_db()
    if await _preflight(db, strategy, coin, side, signal_px, alert_id, now):
        return  # preflight logged the skip

    pos_id = await _create_pending(db, strategy, coin, side, signal_px, alert_id, now)
    try:
        await _run_entry(db, pos_id, strategy, coin, side, signal_px, now)
    except Exception as e:
        logger.exception("BOT: entry error %s %s", strategy, coin)
        await db.bot_positions.update_one(
            {"_id": pos_id},
            {"$set": {"status": "FAILED", "skip_reason": str(e),
                      "updated_at": datetime.now(timezone.utc)}},
        )


# ── Timer exit (scheduler calls every minute) ─────────────────────────────────

async def bot_close_expired(now: datetime | None = None) -> None:
    if not settings.bot_enabled:
        return
    now = now or datetime.now(timezone.utc)
    db = get_db()
    async for pos in db.bot_positions.find({"status": "OPEN", "hold_until": {"$lte": now}}):
        logger.info("BOT: timer exit %s %s", pos["strategy"], pos["coin"])
        await _close_position(db, pos, "timer", now)


# ── Manual exit (API calls these) ──────────────────────────────────────────

async def bot_manual_exit(position_id: str) -> dict:
    db = get_db()
    pos = await db.bot_positions.find_one(
        {"_id": ObjectId(position_id), "status": "OPEN"}
    )
    if not pos:
        return {"ok": False, "error": "not found or not OPEN"}
    await _close_position(db, pos, "manual", datetime.now(timezone.utc))
    return {"ok": True}


async def bot_manual_exit_all() -> dict:
    db = get_db()
    closed = 0
    now = datetime.now(timezone.utc)
    async for pos in db.bot_positions.find({"status": "OPEN"}):
        await _close_position(db, pos, "manual", now)
        closed += 1
    return {"ok": True, "closed": closed}


# ── Internal: preflight checks ───────────────────────────────────────────────

async def _preflight(db, strategy, coin, side, signal_px, alert_id, now) -> bool:
    """Returns True (skip) if any guard fails."""
    # Daily loss limit
    daily = await db.bot_daily_summary.find_one({"date": now.strftime("%Y-%m-%d")})
    if daily and daily.get("halted"):
        await _log_skip(db, strategy, coin, side, signal_px, alert_id, "daily_loss_limit", now)
        logger.warning("BOT: daily loss limit halted, skip %s %s", strategy, coin)
        return True

    # Capital cap
    rows = await db.bot_positions.aggregate([
        {"$match": {"status": "OPEN"}},
        {"$group": {"_id": None, "total": {"$sum": "$size_usdc"}}},
    ]).to_list(1)
    deployed = rows[0]["total"] if rows else 0.0
    if deployed + settings.bot_position_size_usdc > settings.bot_max_capital_usdc:
        await _log_skip(db, strategy, coin, side, signal_px, alert_id, "cap_exceeded", now)
        logger.info("BOT: cap exceeded (%.0f deployed), skip %s %s", deployed, strategy, coin)
        return True

    # Duplicate open position
    if await db.bot_positions.find_one({"strategy": strategy, "coin": coin, "status": "OPEN"}):
        await _log_skip(db, strategy, coin, side, signal_px, alert_id, "dupe", now)
        return True

    return False


# ── Internal: entry execution ────────────────────────────────────────────────

async def _run_entry(db, pos_id, strategy, coin, side, signal_px, now) -> None:
    from ..lib import hl_exchange as ex

    is_buy = side == "LONG"

    # Set leverage before any order (idempotent on HL side)
    try:
        await ex.set_leverage(coin, settings.bot_leverage)
    except Exception as e:
        logger.warning("BOT: set_leverage failed %s: %s — continuing", coin, e)

    # ── Spread + drift check loop ────────────────────────────────────────
    book = None
    for attempt in range(5):
        try:
            book = await ex.get_l2_book(coin)
        except Exception as e:
            logger.warning("BOT: L2 error %s: %s", coin, e)
            await asyncio.sleep(2)
            continue

        mid = book["mid"]

        # Drift check (run every attempt, not just on first)
        if signal_px > 0:
            drift = abs(mid - signal_px) / signal_px * 10_000
            if drift > settings.drift_limit_bps:
                await _mark_skipped(db, pos_id, "price_drifted", now,
                                    drift_bps=round(drift, 2), mid_at_check=mid)
                logger.info("BOT: drift %.1fbps, skip %s", drift, coin)
                return

        if book["spread_bps"] <= settings.spread_limit_bps:
            break

        logger.info("BOT: spread %.2fbps, wait 2s (%d/5)", book["spread_bps"], attempt + 1)
        await asyncio.sleep(2)
    else:
        await _mark_skipped(db, pos_id, "wide_spread", now,
                            spread_bps=book["spread_bps"] if book else None)
        logger.info("BOT: spread still wide, skip %s", coin)
        return

    mid = book["mid"]
    spread_at_entry = book["spread_bps"]
    first_attempt = True

    # ── Order placement loop (BOT_ORDER_RETRIES attempts, 30s wait each) ─────
    for attempt in range(settings.bot_order_retries):
        if not first_attempt:
            try:
                book = await ex.get_l2_book(coin)
            except Exception:
                # Before giving up, re-check whether the previous attempt's
                # order actually filled — a transient API error on that
                # attempt's _get_fill call could have produced a false
                # "not filled", leading us to cancel (no-op) an
                # already-filled order and abandon it here.
                try:
                    filled, actual_px, actual_sz = await _get_fill(oid, coin, since_ms)
                except Exception:
                    logger.exception("BOT: book+fill check both failed, leaving PENDING_FILL %s %s oid=%s",
                                      strategy, coin, oid)
                    return
                if filled:
                    await _mark_open(db, pos_id, actual_px, actual_sz, datetime.now(timezone.utc))
                else:
                    await _mark_skipped(db, pos_id, "no_fill_book_error", datetime.now(timezone.utc))
                return
            mid = book["mid"]
            if signal_px > 0:
                drift = abs(mid - signal_px) / signal_px * 10_000
                if drift > settings.drift_limit_bps:
                    await _mark_skipped(db, pos_id, "price_drifted_on_retry",
                                        datetime.now(timezone.utc), drift_bps=round(drift, 2))
                    return

        # Quote at our own side's best level (not mid) — guarantees ALO can never
        # cross the book regardless of price movement between fetch and placement.
        entry_px_quote = book["best_bid"] if is_buy else book["best_ask"]
        since_ms = int(time.time() * 1000)
        result, px, sz = await ex.place_limit_order(coin, is_buy, settings.bot_position_size_usdc, entry_px_quote)
        oid = ex.extract_oid(result)
        if oid is None:
            # extract_oid found no "resting" status — log the raw response so we can
            # tell whether this was a genuine rejection or an order that actually
            # rested under a status shape extract_oid doesn't recognize.
            logger.warning("BOT: entry oid not found, raw result: %s", result)
            logger.info("BOT: entry order not resting (status=%s), retry %d/%d %s %s",
                        result.get("status"), attempt + 1, settings.bot_order_retries, strategy, coin)
            first_attempt = False
            await asyncio.sleep(settings.bot_order_wait_s)
            continue

        hold_hours = STRATEGY_META.get(strategy, {}).get("hold_hours") or 4
        await db.bot_positions.update_one({"_id": pos_id}, {"$set": {
            "status":           "PENDING_FILL",
            "entry_order_id":   str(oid),
            "entry_limit_px":   px,
            "size_coin":        sz,
            "spread_at_entry":  spread_at_entry,
            "hold_until":       now + timedelta(hours=hold_hours),
            "updated_at":       datetime.now(timezone.utc),
        }})

        await asyncio.sleep(settings.bot_order_wait_s)
        try:
            filled, actual_px, actual_sz = await _get_fill(oid, coin, since_ms)
        except Exception:
            # Fills API still erroring after retries — we can't tell whether
            # this order filled. Leave it PENDING_FILL (entry_order_id is
            # recorded) rather than guess: cancelling a filled order is a
            # silent no-op, and a wrong "not filled" guess abandons a real
            # open position untracked.
            logger.exception("BOT: fill check failed, leaving PENDING_FILL %s %s oid=%s", strategy, coin, oid)
            return
        if filled:
            await _mark_open(db, pos_id, actual_px, actual_sz, datetime.now(timezone.utc))
            return

        try:
            await ex.cancel_order(coin, oid)
        except Exception:
            pass

        logger.info("BOT: attempt %d/%d no fill %s %s", attempt + 1,
                    settings.bot_order_retries, strategy, coin)
        first_attempt = False

    await _mark_skipped(db, pos_id, "no_fill", datetime.now(timezone.utc))
    logger.info("BOT: no fill after %d attempts, skip %s %s",
                settings.bot_order_retries, strategy, coin)


# ── Internal: close order (ALO at mid, same retry logic as entry) ────────────

async def _run_close(coin: str, is_long: bool, sz_coin: float) -> tuple[bool, float]:
    """ALO reduce-only at our own side's best level, retry up to BOT_ORDER_RETRIES times.
    Returns (filled, exit_px). Returns (False, 0) if no attempt fills — caller keeps position OPEN.
    """
    from ..lib import hl_exchange as ex

    for attempt in range(settings.bot_order_retries):
        try:
            book = await ex.get_l2_book(coin)
        except Exception as e:
            logger.warning("BOT: close book error %s attempt %d: %s", coin, attempt + 1, e)
            continue

        # Quote at our own side's best level (not mid) — guarantees ALO can never
        # cross the book regardless of price movement between fetch and placement.
        # Closing a long = sell -> quote at best_ask. Closing a short = buy -> quote at best_bid.
        close_px = book["best_ask"] if is_long else book["best_bid"]
        since_ms = int(time.time() * 1000)
        result, px, _ = await ex.place_limit_order_close(coin, is_long, sz_coin, close_px)
        oid = ex.extract_oid(result)
        if oid is None:
            # extract_oid found no "resting" status — log the raw response so we can
            # tell whether this was a genuine rejection or an order that actually
            # rested under a status shape extract_oid doesn't recognize.
            logger.warning("BOT: close oid not found, raw result: %s", result)
            logger.info("BOT: close order not resting (status=%s), retry %d/%d %s",
                        result.get("status"), attempt + 1, settings.bot_order_retries, coin)
            await asyncio.sleep(settings.bot_order_wait_s)
            continue

        await asyncio.sleep(settings.bot_order_wait_s)
        filled, fill_px, _ = await _get_fill(oid, coin, since_ms)
        if filled:
            return True, fill_px

        try:
            await ex.cancel_order(coin, oid)
        except Exception:
            pass

        logger.info("BOT: close attempt %d/%d no fill %s",
                    attempt + 1, settings.bot_order_retries, coin)

    # ALO (maker-only) exits exhausted — cross the spread with an IOC taker
    # order to guarantee the position closes rather than sitting OPEN past
    # its hold time indefinitely.
    logger.warning("BOT: ALO close did not fill %s after %d attempts, falling back to IOC taker",
                    coin, settings.bot_order_retries)
    try:
        book = await ex.get_l2_book(coin)
    except Exception as e:
        logger.warning("BOT: close book error (IOC fallback) %s: %s", coin, e)
        return False, 0.0

    taker_px = book["best_bid"] if is_long else book["best_ask"]
    try:
        result, _, _ = await ex.place_limit_order_close(coin, is_long, sz_coin, taker_px, tif="Ioc")
    except Exception:
        logger.exception("BOT: IOC close error %s", coin)
        return False, 0.0

    filled, fill_px, _ = ex.extract_fill(result)
    if filled:
        logger.info("BOT: IOC close filled %s px=%.6g", coin, fill_px)
        return True, fill_px

    logger.warning("BOT: IOC close did not fill %s — position stays OPEN", coin)
    return False, 0.0


# ── Internal: position close ────────────────────────────────────────────────

async def _close_position(db, pos: dict, reason: str, now: datetime) -> None:
    from ..lib import hl_exchange as ex

    coin      = pos["coin"]
    side      = pos["side"]
    sz_coin   = pos.get("size_coin") or 0.0
    entry_px  = pos.get("entry_px")  or 0.0

    await db.bot_positions.update_one(
        {"_id": pos["_id"]}, {"$set": {"status": "CLOSING", "updated_at": now}}
    )

    filled = False
    exit_px = entry_px
    if sz_coin > 0:
        is_long = side == "LONG"
        try:
            filled, exit_px = await _run_close(coin, is_long, sz_coin)
        except Exception:
            logger.exception("BOT: close error %s", coin)
    else:
        filled = True  # sz=0 means already flat, mark closed

    if not filled:
        # Revert to OPEN — bot_close_expired will retry next minute
        await db.bot_positions.update_one(
            {"_id": pos["_id"]},
            {"$set": {"status": "OPEN", "updated_at": datetime.now(timezone.utc)}},
        )
        logger.warning("BOT: close not filled %s — reverted to OPEN, will retry", coin)
        return

    raw = (exit_px - entry_px) / entry_px if entry_px > 0 else 0.0
    ret = raw if side == "LONG" else -raw
    pnl = round(ret * (pos.get("size_usdc") or settings.bot_position_size_usdc), 2)

    await db.bot_positions.update_one({"_id": pos["_id"]}, {"$set": {
        "status":      "CLOSED",
        "exit_px":     exit_px,
        "exit_ts":     now,
        "exit_reason": reason,
        "return_pct":  round(ret * 100, 3),
        "pnl_usdc":    pnl,
        "updated_at":  now,
    }})
    logger.info("BOT: closed %s %s ret=%.2f%% pnl=%.2f USDC (%s)",
                coin, side, ret * 100, pnl, reason)

    await _update_daily_pnl(db, now, pnl)


async def _get_fill(oid: int, coin: str, since_ms: int | None = None, retries: int = 3) -> tuple[bool, float, float]:
    """Check fills API for a specific oid. Returns (filled, fill_px, fill_sz).
    Using fills API (not open_orders) so cancelled orders are correctly detected as unfilled.

    since_ms, if given, is the time (ms epoch) the order was placed. Fills with
    f["time"] before that (minus a small clock-skew buffer) are ignored — guards
    against matching a stale fill from a previous order that happened to reuse
    this oid/coin pair.

    Retries on API errors (e.g. transient rate limits) — an exception here must
    NOT be treated as "not filled", since that can leave a genuinely filled
    order unmanaged (caller cancels an already-filled order, which silently
    no-ops, then gives up thinking nothing was ever placed).
    """
    from ..lib import hl_exchange as ex
    for attempt in range(retries):
        try:
            fills = await ex.get_user_fills(50)
        except Exception:
            if attempt < retries - 1:
                await asyncio.sleep(1)
                continue
            raise
        matched = [f for f in fills if int(f.get("oid", -1)) == oid and f.get("coin") == coin]
        if since_ms is not None:
            matched = [f for f in matched if int(f.get("time", 0)) >= since_ms - 2000]
        if not matched:
            return False, 0.0, 0.0
        fill_px = sum(float(f["px"]) * float(f["sz"]) for f in matched) / sum(float(f["sz"]) for f in matched)
        fill_sz = sum(float(f["sz"]) for f in matched)
        return True, fill_px, fill_sz


async def _update_daily_pnl(db, now: datetime, pnl_usdc: float) -> None:
    from ..lib import hl_exchange as ex
    date = now.strftime("%Y-%m-%d")
    doc = await db.bot_daily_summary.find_one({"date": date})
    if not doc:
        equity = None
        try:
            equity = await ex.get_account_equity()
        except Exception:
            pass
        ll = (equity * settings.daily_loss_limit_pct) if equity \
            else settings.bot_max_capital_usdc * settings.daily_loss_limit_pct
        await db.bot_daily_summary.insert_one({
            "date": date, "pnl_usdc": pnl_usdc, "trades_closed": 1,
            "halted": pnl_usdc < -ll, "portfolio_value": equity,
            "loss_limit_usdc": round(ll, 2),
        })
        return

    new_pnl = (doc.get("pnl_usdc") or 0) + pnl_usdc
    halted  = new_pnl < -(doc.get("loss_limit_usdc") or float("inf"))
    await db.bot_daily_summary.update_one({"date": date}, {
        "$set": {"pnl_usdc": round(new_pnl, 2), "halted": halted},
        "$inc": {"trades_closed": 1},
    })
    if halted:
        logger.warning("BOT: daily loss limit hit (%.2f USDC), halting today", new_pnl)


# ── Doc helpers ─────────────────────────────────────────────────────────────────

async def _create_pending(db, strategy, coin, side, signal_px, alert_id, now):
    r = await db.bot_positions.insert_one({
        "strategy": strategy, "coin": coin, "side": side,
        "status": "PENDING", "signal_px": signal_px, "alert_id": alert_id,
        "size_usdc": settings.bot_position_size_usdc, "size_coin": None,
        "leverage": settings.bot_leverage,
        "env": "testnet" if settings.bot_testnet else "mainnet",
        "entry_order_id": None, "entry_px": None, "entry_ts": None,
        "hold_until": None, "exit_order_id": None, "exit_px": None,
        "exit_ts": None, "exit_reason": None, "return_pct": None,
        "pnl_usdc": None, "fees_usdc": None, "skip_reason": None,
        "agent_call_id": None, "created_at": now, "updated_at": now,
    })
    return r.inserted_id


async def _mark_open(db, pos_id, fill_px, sz_coin, now):
    await db.bot_positions.update_one({"_id": pos_id}, {"$set": {
        "status": "OPEN", "entry_px": fill_px, "size_coin": sz_coin,
        "entry_ts": now, "updated_at": now,
    }})
    logger.info("BOT: OPEN id=%s px=%.6g sz=%.6f", pos_id, fill_px, sz_coin)


async def _mark_skipped(db, pos_id, reason, now, **extra):
    await db.bot_positions.update_one({"_id": pos_id}, {"$set": {
        "status": "SKIPPED", "skip_reason": reason, "updated_at": now, **extra,
    }})


async def _log_skip(db, strategy, coin, side, signal_px, alert_id, reason, now):
    await db.bot_skipped_signals.insert_one({
        "ts": now, "strategy": strategy, "coin": coin, "side": side,
        "signal_px": signal_px, "alert_id": alert_id, "skip_reason": reason,
    })
