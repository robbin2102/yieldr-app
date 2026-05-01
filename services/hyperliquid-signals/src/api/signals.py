from fastapi import APIRouter, Query
from bson import ObjectId
from ..db import get_db

router = APIRouter(tags=["signals"])


def _serialize(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


@router.get("/signals/convergence")
async def get_convergence(limit: int = Query(30, ge=1, le=100)):
    db = get_db()
    # Get most recent snapshot_ts
    latest = await db.hl_signals_convergence.find_one(sort=[("snapshot_ts", -1)])
    if not latest:
        return {"data": [], "snapshot_ts": None}
    snap_ts = latest["snapshot_ts"]

    cursor = (
        db.hl_signals_convergence.find({"snapshot_ts": snap_ts}, {"_id": 0})
        .sort("total_usd", -1)
        .limit(limit)
    )
    docs = await cursor.to_list(limit)
    return {"data": docs, "snapshot_ts": snap_ts}


@router.get("/signals/divergence")
async def get_divergence():
    db = get_db()
    latest = await db.hl_signals_convergence.find_one(sort=[("snapshot_ts", -1)])
    if not latest:
        return {"data": []}
    snap_ts = latest["snapshot_ts"]

    cursor = db.hl_signals_convergence.find({"snapshot_ts": snap_ts}, {"_id": 0})
    docs = await cursor.to_list(None)

    # Pivot to per-coin divergence view
    coins: dict[str, dict] = {}
    for doc in docs:
        coin = doc["coin"]
        if coin not in coins:
            coins[coin] = {"coin": coin, "long": None, "short": None, "conviction": doc.get("conviction", 0)}
        if doc["side"] == "LONG":
            coins[coin]["long"] = doc
        else:
            coins[coin]["short"] = doc
        coins[coin]["conviction"] = doc.get("conviction", 0)

    result = sorted(coins.values(), key=lambda x: x["conviction"], reverse=True)
    return {"data": result}


@router.get("/signals/alerts")
async def get_alerts(
    severity: int | None = Query(None),
    acknowledged: bool = Query(False),
    limit: int = Query(50, ge=1, le=200),
):
    db = get_db()
    filt: dict = {"acknowledged": acknowledged}
    if severity is not None:
        filt["severity"] = severity
    cursor = db.hl_signals_alerts.find(filt, {"_id": 0}).sort("created_at", -1).limit(limit)
    alerts = await cursor.to_list(limit)
    return {"data": alerts, "total": len(alerts)}
