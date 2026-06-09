"""Execution bot — strategy-driven order execution on Hyperliquid (testnet first)."""
import asyncio
import logging
from datetime import datetime, timezone, timedelta

from bson import ObjectId

from ..config import settings
from ..db import get_db

logger = logging.getLogger(__name__)


def _bot_strategies() -> set[str]:
    return {s.strip() for s in settings.bot_strategies.split(",") if s.strip()}


def _excluded_coins() -> set[str]:
    return {c.strip().upper() for c in settings.bot_excluded_coins.split(",") if c.strip()}


# ── Entry point (called from alert_engine after _fire) ─────────────────────────

async def bot_execute(alert: dict) -> None:
    if not settings.bot_enabled:
        return
    if not settings.hl_private_key or not settings.hl_wallet_address:
        logger.warning("BOT: credentials missing, set HL_WALLET_ADDRESS + HL_PRIVATE_KEY")
        return

    strategy  = alert["strategy"]
    coin      = alert["coin"]
    side      = alert["side"]
    signal_px = float(alert.get("entry_px") or 0)
    alert_id  = str(alert.get("_id", ""))
    now       = datetime.now(timezone.utc)

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

    # ── Attempt 1 ────────────────────────────────────────────────────────────
    result, px1, sz1 = await ex.place_limit_order(coin, is_buy, settings.bot_position_size_usdc, mid)
    oid1 = ex.extract_oid(result)
    if oid1 is None:
        await _mark_skipped(db, pos_id, f"order_rejected:{result.get('status')}", now)
        return

    await db.bot_positions.update_one({"_id": pos_id}, {"$set": {
        "status":            "PENDING_FILL",
        "entry_order_id":   str(oid1),
        "entry_limit_px":   px1,
        "size_coin":         sz1,
        "spread_at_entry":  book["spread_bps"],
        "hold_until":        now + timedelta(hours=4),
        "updated_at":        now,
    }})

    await asyncio.sleep(30)
    filled1 = await _is_filled(oid1)
    if filled1:
        await _mark_open(db, pos_id, px1, sz1, datetime.now(timezone.utc))
        return

    # Cancel and retry once
    try:
        await ex.cancel_order(coin, oid1)
    except Exception:
        pass

    # ── Attempt 2 (updated mid, fresh drift check) ───────────────────────
    try:
        book2 = await ex.get_l2_book(coin)
    except Exception:
        await _mark_skipped(db, pos_id, "no_fill_book_error", datetime.now(timezone.utc))
        return

    mid2 = book2["mid"]
    if signal_px > 0:
        drift2 = abs(mid2 - signal_px) / signal_px * 10_000
        if drift2 > settings.drift_limit_bps:
            await _mark_skipped(db, pos_id, "price_drifted_on_retry", datetime.now(timezone.utc),
                                drift_bps=round(drift2, 2))
            return

    result2, px2, sz2 = await ex.place_limit_order(coin, is_buy, settings.bot_position_size_usdc, mid2)
    oid2 = ex.extract_oid(result2)
    if oid2 is None:
        await _mark_skipped(db, pos_id, f"retry_rejected:{result2.get('status')}",
                            datetime.now(timezone.utc))
        return

    await db.bot_positions.update_one({"_id": pos_id}, {"$set": {
        "entry_order_id": str(oid2),
        "entry_limit_px": px2,
        "size_coin":       sz2,
        "updated_at":      datetime.now(timezone.utc),
    }})

    await asyncio.sleep(30)
    now3 = datetime.now(timezone.utc)
    filled2 = await _is_filled(oid2)
    if filled2:
        await _mark_open(db, pos_id, px2, sz2, now3)
    else:
        try:
            await ex.cancel_order(coin, oid2)
        except Exception:
            pass
        await _mark_skipped(db, pos_id, "no_fill", now3)
        logger.info("BOT: no fill after 2 attempts, skip %s %s", strategy, coin)


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

    exit_px = entry_px  # fallback
    if sz_coin > 0:
        is_long = side == "LONG"
        try:
            await ex.close_position_ioc(coin, is_long, sz_coin)
            # Get fill price from most recent fill for this coin
            fills = await ex.get_user_fills(10)
            fill = next((f for f in fills if f.get("coin") == coin), None)
            if fill:
                exit_px = float(fill["px"])
        except Exception:
            logger.exception("BOT: close error %s", coin)

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


async def _is_filled(oid: int) -> bool:
    """True if the order is no longer in open orders (= filled)."""
    from ..lib import hl_exchange as ex
    try:
        open_orders = await ex.get_open_orders()
        oids = {int(o.get("oid", -1)) for o in open_orders}
        return oid not in oids
    except Exception:
        return False  # conservative: assume not filled if we can't check


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
