from datetime import datetime, timedelta
from fastapi import APIRouter, Query
from ..db import get_db


def _utcnow() -> datetime:
    return datetime.utcnow()


router = APIRouter(tags=["coins"])


@router.get("/coin/{coin}")
async def get_coin(coin: str, days: int = Query(7, ge=1, le=30)):
    db = get_db()
    since = _utcnow() - timedelta(days=days)
    coin_upper = coin.upper()

    # Current holders
    latest = await db.hl_signals_convergence.find_one(sort=[("snapshot_ts", -1)])
    holders = []
    if latest:
        snap_ts = latest["snapshot_ts"]
        cursor = db.hl_signals_positions.find(
            {"coin": coin_upper, "snapshot_ts": snap_ts}, {"_id": 0}
        ).sort("size_usd", -1)
        holders = await cursor.to_list(50)

        if holders:
            addrs = [h["address"] for h in holders]

            # Enrich with open timestamp: most recent NEW_POSITION per address for this coin
            open_pipeline = [
                {
                    "$match": {
                        "address": {"$in": addrs},
                        "coin": coin_upper,
                        "change_type": "NEW_POSITION",
                    }
                },
                {"$sort": {"ts": -1}},
                {"$group": {"_id": "$address", "opened_at": {"$first": "$ts"}}},
            ]
            open_docs = await db.hl_signals_position_changes.aggregate(open_pipeline).to_list(
                len(addrs) + 5
            )
            open_map = {d["_id"]: d["opened_at"] for d in open_docs}

            # Enrich with skill quartile
            trader_cursor = db.hl_signals_traders.find(
                {"address": {"$in": addrs}},
                {"address": 1, "skill_quartile": 1, "_id": 0},
            )
            trader_docs = await trader_cursor.to_list(len(addrs) + 5)
            trader_map = {t["address"]: t.get("skill_quartile") for t in trader_docs}

            for h in holders:
                addr = h["address"]
                ts = open_map.get(addr)
                h["opened_at"] = ts.isoformat() if ts else None
                h["skill_quartile"] = trader_map.get(addr)

    # Conviction history (last N days)
    cursor = (
        db.hl_signals_convergence.find(
            {"coin": coin_upper, "snapshot_ts": {"$gte": since}}, {"_id": 0}
        )
        .sort("snapshot_ts", 1)
    )
    history = await cursor.to_list(None)

    return {"coin": coin_upper, "holders": holders, "conviction_history": history}


@router.get("/trader/{address}")
async def get_trader(address: str):
    db = get_db()
    addr = address.lower()

    profile = await db.hl_signals_traders.find_one({"address": addr}, {"_id": 0})
    if not profile:
        return {"error": "Trader not found"}

    # Current positions
    latest_pos = await db.hl_signals_positions.find_one(
        {"address": addr}, sort=[("snapshot_ts", -1)]
    )
    positions = []
    if latest_pos:
        # Excludes the "no open positions" sentinel doc (coin=None) written
        # by the snapshotter for addresses with zero positions.
        cursor = db.hl_signals_positions.find(
            {"address": addr, "snapshot_ts": latest_pos["snapshot_ts"], "coin": {"$ne": None}},
            {"_id": 0},
        )
        positions = await cursor.to_list(100)

    # Recent changes
    cursor = (
        db.hl_signals_position_changes.find({"address": addr}, {"_id": 0})
        .sort("ts", -1)
        .limit(50)
    )
    recent_changes = await cursor.to_list(50)

    return {"profile": profile, "positions": positions, "recent_changes": recent_changes}


@router.get("/heatmap")
async def get_heatmap(coins: int = Query(20, ge=5, le=50), days: int = Query(7, ge=1, le=30)):
    db = get_db()
    since = datetime.now(timezone.utc) - timedelta(days=days)

    # Find top N coins by recent total_usd
    latest = await db.hl_signals_convergence.find_one(sort=[("snapshot_ts", -1)])
    if not latest:
        return {"data": [], "coins": [], "snapshots": []}
    snap_ts = latest["snapshot_ts"]

    # Top coins by exposure
    pipeline = [
        {"$match": {"snapshot_ts": snap_ts}},
        {"$group": {"_id": "$coin", "total": {"$sum": "$total_usd"}}},
        {"$sort": {"total": -1}},
        {"$limit": coins},
    ]
    top_coins_docs = await db.hl_signals_convergence.aggregate(pipeline).to_list(coins)
    top_coins = [d["_id"] for d in top_coins_docs]

    cursor = (
        db.hl_signals_convergence.find(
            {"coin": {"$in": top_coins}, "snapshot_ts": {"$gte": since}}, {"_id": 0}
        )
        .sort("snapshot_ts", 1)
    )
    docs = await cursor.to_list(None)

    # Collect unique snapshot timestamps
    snap_times = sorted({d["snapshot_ts"] for d in docs})

    # Build matrix: coin → snapshot_ts → {conviction, net_side}
    matrix: dict[str, dict] = {c: {} for c in top_coins}
    for doc in docs:
        ts_key = doc["snapshot_ts"].isoformat()
        coin = doc["coin"]
        existing = matrix[coin].get(ts_key)
        if not existing or doc["total_usd"] > existing.get("total_usd", 0):
            matrix[coin][ts_key] = {
                "conviction": doc["conviction"],
                "side": doc["side"],
                "n_traders": doc["n_traders"],
                "total_usd": doc["total_usd"],
            }

    return {
        "coins": top_coins,
        "snapshots": [t.isoformat() for t in snap_times],
        "matrix": matrix,
    }
