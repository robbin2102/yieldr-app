from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Query
from bson import ObjectId
from ..db import get_db

router = APIRouter(tags=["signals"])


def _strip_id(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


# ── Legacy endpoints ──────────────────────────────────────────────────────────

@router.get("/signals/convergence")
async def get_convergence(limit: int = Query(30, ge=1, le=100)):
    db = get_db()
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
    coins: dict[str, dict] = {}
    for doc in docs:
        coin = doc["coin"]
        if coin not in coins:
            coins[coin] = {"coin": coin, "long": None, "short": None, "conviction": 0}
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
    cursor = db.hl_signals_alerts.find(filt).sort("created_at", -1).limit(limit)
    raw = await cursor.to_list(limit)
    alerts = [{**{k: v for k, v in doc.items() if k != "_id"}, "id": str(doc["_id"])} for doc in raw]
    return {"data": alerts, "total": len(alerts)}


@router.post("/alerts/{alert_id}/acknowledge")
async def acknowledge_alert(alert_id: str):
    db = get_db()
    try:
        oid = ObjectId(alert_id)
    except Exception:
        return {"ok": False, "error": "Invalid id"}
    await db.hl_signals_alerts.update_one({"_id": oid}, {"$set": {"acknowledged": True}})
    return {"ok": True}


# ── v2 endpoints ──────────────────────────────────────────────────────────────

@router.get("/signals/v2/coin-metrics")
async def get_coin_metrics(limit: int = Query(50, ge=1, le=200)):
    """Latest coin metrics snapshot — the 3 sub-metrics per coin."""
    db = get_db()
    latest = await db.hl_signals_coin_metrics.find_one(sort=[("snapshot_ts", -1)])
    if not latest:
        return {"data": [], "snapshot_ts": None}
    snap_ts = latest["snapshot_ts"]
    cursor = (
        db.hl_signals_coin_metrics.find({"snapshot_ts": snap_ts}, {"_id": 0})
        .sort("total_usd", -1)
        .limit(limit)
    )
    docs = await cursor.to_list(limit)
    return {"data": docs, "snapshot_ts": snap_ts}


@router.get("/signals/v2/signals")
async def get_signals_v2(
    signal_type: str | None = Query(None),
    hours: int = Query(24, ge=1, le=168),
    limit: int = Query(100, ge=1, le=500),
):
    """Active signals detected in the last N hours, optionally filtered by type."""
    db = get_db()
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    filt: dict = {"snapshot_ts": {"$gte": since}}
    if signal_type:
        filt["signal_type"] = signal_type
    cursor = (
        db.hl_signals_signals.find(filt, {"_id": 0})
        .sort("snapshot_ts", -1)
        .limit(limit)
    )
    docs = await cursor.to_list(limit)
    return {"data": docs, "total": len(docs)}


@router.get("/signals/v2/dashboard")
async def get_dashboard(hours: int = Query(24, ge=1, le=72)):
    """Returns signals grouped into the 4 dashboard columns."""
    db = get_db()
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    cursor = db.hl_signals_signals.find(
        {"snapshot_ts": {"$gte": since}}, {"_id": 0}
    ).sort("snapshot_ts", -1)
    all_signals = await cursor.to_list(500)

    # Column mapping
    ACCELERATING = {"CONVERGENCE_ACCELERATION", "CAPITAL_ROTATION", "LEVERAGE_SPIKE"}
    WHALE_MOVES = {"WHALE_ACTIVITY"}
    DIRECTION_FLIPS = {"COHORT_DIRECTION_FLIP", "FUNDING_DIVERGENCE"}
    EXITS = {"SMART_EXIT", "STALE_POSITION_DECAY", "ASYMMETRIC_POSITIONING"}

    # Deduplicate: keep highest severity per (signal_type, coin)
    seen: dict[tuple, dict] = {}
    sev_order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    for s in all_signals:
        key = (s["signal_type"], s["coin"])
        existing = seen.get(key)
        if not existing or sev_order.get(s["severity"], 9) < sev_order.get(existing["severity"], 9):
            seen[key] = s

    deduped = list(seen.values())

    # Get latest coin_metrics for sub-metric enrichment
    latest_metrics_doc = await db.hl_signals_coin_metrics.find_one(sort=[("snapshot_ts", -1)])
    coin_metrics: dict[str, dict] = {}
    if latest_metrics_doc:
        snap_ts = latest_metrics_doc["snapshot_ts"]
        m_cursor = db.hl_signals_coin_metrics.find({"snapshot_ts": snap_ts}, {"_id": 0})
        for m in await m_cursor.to_list(None):
            coin_metrics[m["coin"]] = m

    # Get recent whale events (past N hours)
    whale_cursor = db.hl_signals_whale_events.find(
        {"ts": {"$gte": since}}, {"_id": 0}
    ).sort("ts", -1).limit(100)
    whale_events = await whale_cursor.to_list(100)

    def enrich(sig: dict) -> dict:
        cm = coin_metrics.get(sig["coin"], {})
        return {
            **sig,
            "count_conviction": cm.get("count_conviction", sig.get("metadata", {}).get("count_conviction")),
            "dollar_conviction": cm.get("dollar_conviction", sig.get("metadata", {}).get("dollar_conviction")),
            "cohort_participation": cm.get("cohort_participation", sig.get("metadata", {}).get("cohort_participation")),
            "total_usd": cm.get("total_usd"),
            "total_count": cm.get("total_count"),
        }

    return {
        "accelerating": [enrich(s) for s in deduped if s["signal_type"] in ACCELERATING],
        "whale_moves": whale_events,
        "direction_flips": [enrich(s) for s in deduped if s["signal_type"] in DIRECTION_FLIPS],
        "exits": [enrich(s) for s in deduped if s["signal_type"] in EXITS],
        "snapshot_ts": latest_metrics_doc["snapshot_ts"] if latest_metrics_doc else None,
    }


@router.get("/signals/v2/whale-events")
async def get_whale_events(
    coin: str | None = Query(None),
    event_type: str | None = Query(None),
    hours: int = Query(24, ge=1, le=168),
    limit: int = Query(50, ge=1, le=200),
):
    db = get_db()
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    filt: dict = {"ts": {"$gte": since}}
    if coin:
        filt["coin"] = coin.upper()
    if event_type:
        filt["event_type"] = event_type
    cursor = (
        db.hl_signals_whale_events.find(filt, {"_id": 0})
        .sort("ts", -1)
        .limit(limit)
    )
    docs = await cursor.to_list(limit)
    return {"data": docs, "total": len(docs)}
