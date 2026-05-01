from datetime import datetime, timezone
from fastapi import APIRouter, Query
from ..db import get_db

router = APIRouter(tags=["positions"])


@router.get("/positions/changes")
async def get_position_changes(
    since: float | None = Query(None, description="Unix timestamp"),
    min_size_usd: float = Query(0, ge=0),
    change_type: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
):
    db = get_db()
    filt: dict = {}
    if since is not None:
        filt["ts"] = {"$gte": datetime.fromtimestamp(since, tz=timezone.utc)}
    if min_size_usd > 0:
        filt["$or"] = [
            {"new_state.size_usd": {"$gte": min_size_usd}},
            {"previous_state.size_usd": {"$gte": min_size_usd}},
        ]
    if change_type:
        filt["change_type"] = change_type.upper()

    cursor = db.hl_signals_position_changes.find(filt, {"_id": 0}).sort("ts", -1).limit(limit)
    changes = await cursor.to_list(limit)
    return {"data": changes, "total": len(changes)}
