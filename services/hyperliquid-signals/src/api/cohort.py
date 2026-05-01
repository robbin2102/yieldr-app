from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Query
from ..db import get_db

router = APIRouter(tags=["cohort"])


@router.get("/cohort")
async def get_cohort(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    sort_by: str = Query("month_roi"),
    order: str = Query("desc"),
):
    db = get_db()
    sort_dir = -1 if order == "desc" else 1
    skip = (page - 1) * limit
    total = await db.hl_signals_traders.count_documents({"cohort_status": "active"})
    cursor = (
        db.hl_signals_traders.find({"cohort_status": "active"}, {"_id": 0})
        .sort(sort_by, sort_dir)
        .skip(skip)
        .limit(limit)
    )
    traders = await cursor.to_list(limit)
    return {"data": traders, "total": total, "page": page, "limit": limit}


@router.get("/cohort/changes")
async def get_cohort_changes(days: int = Query(7, ge=1, le=90)):
    db = get_db()
    since = datetime.now(timezone.utc) - timedelta(days=days)
    cursor = db.hl_signals_cohort_changes.find(
        {"ts": {"$gte": since}}, {"_id": 0}
    ).sort("ts", -1)
    changes = await cursor.to_list(500)
    return {"data": changes, "total": len(changes)}
