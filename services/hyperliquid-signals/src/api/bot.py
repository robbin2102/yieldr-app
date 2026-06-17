"""Bot API — position status, manual exit, daily summary, agent dashboard data."""
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, HTTPException

from ..config import settings
from ..db import get_db, ping
from ..lib import health_log
from ..lib import hl_exchange
from .trade_alerts import STRATEGY_META

router = APIRouter(tags=["bot"])


def _ser(doc: dict) -> dict:
    doc["id"] = str(doc.pop("_id", ""))
    for k, v in list(doc.items()):
        if isinstance(v, datetime):
            doc[k] = v.isoformat()
    return doc


async def _mark_prices(db, coins: set[str]) -> dict[str, float]:
    """Mark prices for open bot positions — fetched live from the network the
    bot trades on (testnet/mainnet per BOT_TESTNET), since hl_signals_prices
    is sourced from mainnet only and can diverge from testnet prices.
    """
    if not coins:
        return {}
    try:
        mids = await hl_exchange.get_all_mids()
    except Exception:
        mids = {}
    prices = {coin: mids[coin] for coin in coins if coin in mids}

    missing = coins - prices.keys()
    for coin in missing:
        doc = await db.hl_signals_prices.find_one({"coin": coin}, sort=[("ts", -1)])
        if doc:
            prices[coin] = float(doc["price"])
    return prices


@router.get("/bot/positions")
async def get_bot_positions(status: str | None = None, env: str | None = None):
    db = get_db()
    query: dict = {}
    if status:
        query["status"] = status
    if env:
        query["env"] = env
    cursor = db.bot_positions.find(query).sort("created_at", -1).limit(200)
    docs = [_ser(d) async for d in cursor]

    open_coins = {d["coin"] for d in docs if d["status"] == "OPEN"}
    if open_coins:
        prices = await _mark_prices(db, open_coins)
        for d in docs:
            if d["status"] != "OPEN":
                continue
            mark_px = prices.get(d["coin"])
            if mark_px is None:
                continue
            d["mark_px"] = mark_px
            entry_px = d.get("entry_px") or 0
            if entry_px > 0:
                raw = (mark_px - entry_px) / entry_px
                ret = raw if d["side"] == "LONG" else -raw
                leverage = d.get("leverage") or 1
                # ROE % (return on margin), matching HL's position display.
                d["live_return_pct"] = round(ret * leverage * 100, 3)
                d["live_pnl_usdc"] = round(ret * (d.get("size_usdc") or 0), 2)

    return {"data": docs, "total": len(docs)}


@router.get("/bot/skipped")
async def get_bot_skipped(limit: int = 100):
    db = get_db()
    cursor = db.bot_skipped_signals.find().sort("ts", -1).limit(limit)
    docs = [_ser(d) async for d in cursor]
    return {"data": docs, "total": len(docs)}


async def _open_positions_unrealized_pnl(db, open_query: dict) -> float:
    """Live unrealized PnL across currently open positions, using the same
    mark-price + ret*size_usdc calc as get_bot_positions' live_pnl_usdc —
    so today/all-time PnL reflect the book as it stands, not just closed
    trades."""
    docs = await db.bot_positions.find(
        open_query, {"coin": 1, "side": 1, "entry_px": 1, "size_usdc": 1},
    ).to_list(None)
    if not docs:
        return 0.0
    coins = {d["coin"] for d in docs}
    prices = await _mark_prices(db, coins)
    total = 0.0
    for d in docs:
        mark_px = prices.get(d["coin"])
        entry_px = d.get("entry_px") or 0.0
        if mark_px is None or entry_px <= 0:
            continue
        raw = (mark_px - entry_px) / entry_px
        ret = raw if d["side"] == "LONG" else -raw
        total += ret * (d.get("size_usdc") or 0.0)
    return total


@router.get("/bot/summary")
async def get_bot_summary(env: str | None = None):
    db = get_db()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    daily = await db.bot_daily_summary.find_one({"date": today})

    open_query = {"status": "OPEN"}
    if env:
        open_query["env"] = env
    open_n = await db.bot_positions.count_documents(open_query)

    margin_expr = {"$divide": ["$size_usdc", {"$ifNull": ["$leverage", 1]}]}

    rows = await db.bot_positions.aggregate([
        {"$match": open_query},
        {"$group": {
            "_id": None,
            "total":  {"$sum": "$size_usdc"},
            "margin": {"$sum": margin_expr},
        }},
    ]).to_list(1)
    position_size = round(rows[0]["total"], 2) if rows else 0.0
    margin_deployed = round(rows[0]["margin"], 2) if rows else 0.0

    unrealized_pnl = await _open_positions_unrealized_pnl(db, open_query)

    closed_query: dict = {"status": "CLOSED"}
    if env:
        closed_query["env"] = env
    rows = await db.bot_positions.aggregate([
        {"$match": closed_query},
        {"$group": {
            "_id": None,
            "total":    {"$sum": 1},
            "wins":     {"$sum": {"$cond": [{"$gt": ["$pnl_usdc", 0]}, 1, 0]}},
            "total_pnl":{"$sum": "$pnl_usdc"},
            "margin":   {"$sum": margin_expr},
        }},
    ]).to_list(1)
    s = rows[0] if rows else {"total": 0, "wins": 0, "total_pnl": 0.0, "margin": 0.0}
    # Open margin folded into the denominator alongside the open positions'
    # unrealized PnL in the numerator, so the % figures stay consistent.
    all_time_margin = (s.get("margin") or 0.0) + margin_deployed
    all_time_pnl = round(s["total_pnl"] + unrealized_pnl, 2)

    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    today_closed_query: dict = {**closed_query, "exit_ts": {"$gte": today_start, "$lt": today_start + timedelta(days=1)}}
    rows = await db.bot_positions.aggregate([
        {"$match": today_closed_query},
        {"$group": {"_id": None, "margin": {"$sum": margin_expr}}},
    ]).to_list(1)
    today_margin = ((rows[0]["margin"] if rows else 0.0) or 0.0) + margin_deployed
    today_pnl = round((daily.get("pnl_usdc", 0.0) if daily else 0.0) + unrealized_pnl, 2)

    return {
        "open_positions":        open_n,
        "position_size_usdc":    position_size,
        "margin_deployed_usdc":  margin_deployed,
        "max_capital_usdc":      settings.bot_max_capital_usdc,
        "all_time_closed":       s["total"],
        "all_time_wins":         s["wins"],
        "all_time_pnl_usdc":     all_time_pnl,
        "all_time_pnl_pct":      round(all_time_pnl / all_time_margin * 100, 2) if all_time_margin else None,
        "today": {
            "date":             today,
            "pnl_usdc":         today_pnl,
            "pnl_pct":          round(today_pnl / today_margin * 100, 2) if today_margin else None,
            "trades_closed":    daily.get("trades_closed", 0) if daily else 0,
            "halted":           daily.get("halted", False) if daily else False,
            "loss_limit_usdc":  daily.get("loss_limit_usdc") if daily else None,
        },
    }


@router.get("/bot/strategy-summary")
async def get_strategy_summary(env: str | None = None):
    db = get_db()
    result = []
    for strategy, meta in STRATEGY_META.items():
        match: dict = {"strategy": strategy}
        if env:
            match["env"] = env

        open_n = await db.bot_positions.count_documents({**match, "status": "OPEN"})

        rows = await db.bot_positions.aggregate([
            {"$match": {**match, "status": "CLOSED"}},
            {"$group": {
                "_id": None,
                "total":      {"$sum": 1},
                "wins":       {"$sum": {"$cond": [{"$gt": ["$pnl_usdc", 0]}, 1, 0]}},
                "total_pnl":  {"$sum": "$pnl_usdc"},
                "avg_ret":    {"$avg": "$return_pct"},
            }},
        ]).to_list(1)
        s = rows[0] if rows else {"total": 0, "wins": 0, "total_pnl": 0.0, "avg_ret": None}
        total = s["total"]

        # Signal-level performance — every alert this strategy ever fired
        # (hl_signals_trade_alerts), independent of whether the bot executed
        # it or which env it ran on. Lets signal-only strategies (no
        # bot_positions rows) still show real performance.
        sig_rows = await db.hl_signals_trade_alerts.aggregate([
            {"$match": {"strategy": strategy, "status": {"$in": ["WIN", "LOSS"]}}},
            {"$group": {
                "_id": None,
                "total_roi": {"$sum": "$return_pct"},
                "avg_roi":   {"$avg": "$return_pct"},
                "n":         {"$sum": 1},
            }},
        ]).to_list(1)
        sig = sig_rows[0] if sig_rows else {"total_roi": 0.0, "avg_roi": None, "n": 0}

        result.append({
            "strategy": strategy,
            **meta,
            "open": open_n,
            "closed": total,
            "wins": s["wins"],
            "losses": total - s["wins"],
            "win_pct": round(s["wins"] / total * 100, 1) if total > 0 else None,
            "avg_return_pct": round(s["avg_ret"], 2) if s["avg_ret"] is not None else None,
            "total_pnl_usdc": round(s["total_pnl"], 2) if s["total_pnl"] else 0.0,
            "signal_closed":        sig["n"],
            "signal_total_roi_pct": round(sig["total_roi"], 2) if sig["n"] > 0 else None,
            "signal_avg_net_pct":   round(sig["avg_roi"], 2) if sig["n"] > 0 else None,
        })
    return {"data": result}


@router.get("/bot/activity")
async def get_bot_activity(limit: int = 30, env: str | None = None):
    db = get_db()

    pos_query: dict = {}
    if env:
        pos_query["env"] = env
    pos_cursor = db.bot_positions.find(pos_query).sort("created_at", -1).limit(limit)
    positions = [_ser(d) async for d in pos_cursor]

    skip_cursor = db.bot_skipped_signals.find().sort("ts", -1).limit(limit)
    skipped = [_ser(d) async for d in skip_cursor]

    events = []
    for p in positions:
        events.append({
            "ts": p["created_at"],
            "strategy": p["strategy"],
            "coin": p["coin"],
            "side": p["side"],
            "action": "executed",
            "status": p["status"],
            "skip_reason": p.get("skip_reason"),
        })
    for sk in skipped:
        events.append({
            "ts": sk["ts"],
            "strategy": sk["strategy"],
            "coin": sk["coin"],
            "side": sk["side"],
            "action": "skipped",
            "status": None,
            "skip_reason": sk.get("skip_reason"),
        })

    events.sort(key=lambda e: e["ts"], reverse=True)
    return {"data": events[:limit], "total": len(events[:limit])}


@router.get("/bot/health")
async def get_bot_health():
    from ..jobs import ws_whale_monitor

    db_ok = await ping()
    db = get_db()
    cfg = await db.bot_runtime_config.find_one({"_id": "bot"})
    paused = bool(cfg and cfg.get("paused"))
    return {
        "status": "ok" if db_ok else "degraded",
        "db": "connected" if db_ok else "unreachable",
        "uptime_s": round(health_log.get_uptime_s(), 1),
        "bot_enabled": settings.bot_enabled,
        "bot_testnet": settings.bot_testnet,
        "paused": paused,
        "ws_monitor": ws_whale_monitor.get_status() if settings.ws_monitor_enabled else None,
        "recent_issues": health_log.get_recent_issues(),
    }


@router.post("/bot/pause")
async def bot_pause():
    db = get_db()
    await db.bot_runtime_config.update_one(
        {"_id": "bot"},
        {"$set": {"paused": True, "paused_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return {"ok": True, "paused": True}


@router.post("/bot/resume")
async def bot_resume():
    db = get_db()
    await db.bot_runtime_config.update_one(
        {"_id": "bot"},
        {"$set": {"paused": False, "paused_at": None}},
        upsert=True,
    )
    return {"ok": True, "paused": False}


@router.post("/bot/positions/{position_id}/exit")
async def manual_exit(position_id: str):
    from ..jobs.execution_bot import bot_manual_exit
    result = await bot_manual_exit(position_id)
    if not result["ok"]:
        raise HTTPException(status_code=404, detail=result.get("error"))
    return result


@router.post("/bot/positions/exit-all")
async def manual_exit_all():
    from ..jobs.execution_bot import bot_manual_exit_all
    return await bot_manual_exit_all()
