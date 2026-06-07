"""Bot API — position status, manual exit, daily summary."""
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException

from ..db import get_db

router = APIRouter(tags=["bot"])


def _ser(doc: dict) -> dict:
    doc["id"] = str(doc.pop("_id", ""))
    for k, v in list(doc.items()):
        if isinstance(v, datetime):
            doc[k] = v.isoformat()
    return doc


@router.get("/bot/positions")
async def get_bot_positions(status: str | None = None):
    db = get_db()
    query = {"status": status} if status else {}
    cursor = db.bot_positions.find(query).sort("created_at", -1).limit(200)
    docs = [_ser(d) async for d in cursor]
    return {"data": docs, "total": len(docs)}


@router.get("/bot/skipped")
async def get_bot_skipped(limit: int = 100):
    db = get_db()
    cursor = db.bot_skipped_signals.find().sort("ts", -1).limit(limit)
    docs = [_ser(d) async for d in cursor]
    return {"data": docs, "total": len(docs)}


@router.get("/bot/summary")
async def get_bot_summary():
    db = get_db()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    daily = await db.bot_daily_summary.find_one({"date": today})

    open_n = await db.bot_positions.count_documents({"status": "OPEN"})

    rows = await db.bot_positions.aggregate([
        {"$match": {"status": "CLOSED"}},
        {"$group": {
            "_id": None,
            "total":    {"$sum": 1},
            "wins":     {"$sum": {"$cond": [{"$gt": ["$pnl_usdc", 0]}, 1, 0]}},
            "total_pnl":{"$sum": "$pnl_usdc"},
        }},
    ]).to_list(1)
    s = rows[0] if rows else {"total": 0, "wins": 0, "total_pnl": 0.0}

    return {
        "open_positions":   open_n,
        "all_time_closed":  s["total"],
        "all_time_wins":    s["wins"],
        "all_time_pnl_usdc": round(s["total_pnl"], 2),
        "today": {
            "date":             today,
            "pnl_usdc":         daily.get("pnl_usdc", 0.0) if daily else 0.0,
            "trades_closed":    daily.get("trades_closed", 0) if daily else 0,
            "halted":           daily.get("halted", False) if daily else False,
            "loss_limit_usdc":  daily.get("loss_limit_usdc") if daily else None,
        },
    }


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
