from datetime import datetime, timedelta

from fastapi import APIRouter, Query

from ..db import get_db

router = APIRouter(tags=["trade-alerts"])

STRATEGY_META: dict[str, dict] = {
    "WAKEUP_LS10": {
        "label": "WAKEUP + L:S≥10",
        "rule": "Q1 whale wakes up while L:S ≥ 10 on same coin",
        "hold_hours": 24,
        "backtest_win_pct": 91.7,
        "backtest_return_pct": 1.58,
        "backtest_horizon_h": 4,
        "backtest_n": 36,
    },
    "LS10_CROSS": {
        "label": "L:S≥10 Cross",
        "rule": "Long/short ratio crosses above 10 for the first time",
        "hold_hours": 72,
        "backtest_win_pct": 73.1,
        "backtest_return_pct": 10.63,
        "backtest_horizon_h": 72,
        "backtest_n": 43,
    },
    "WHALE_EXIT_FADE": {
        "label": "Whale Exit Fade",
        "rule": "Q1 whale exits — enter opposite direction",
        "hold_hours": 72,
        "backtest_win_pct": 71.5,
        "backtest_return_pct": 2.38,
        "backtest_horizon_h": 72,
        "backtest_n": 6602,
    },
}


def _ser(doc: dict) -> dict:
    doc.pop("_id", None)
    for k, v in list(doc.items()):
        if isinstance(v, datetime):
            doc[k] = v.isoformat()
    return doc


@router.get("/trade-alerts/active")
async def get_active_alerts():
    db = get_db()
    cursor = db.hl_signals_trade_alerts.find({"status": "OPEN"}).sort("fired_at", -1)
    alerts = [_ser(doc) async for doc in cursor]

    for a in alerts:
        price_doc = await db.hl_signals_prices.find_one(
            {"coin": a["coin"]}, sort=[("ts", -1)]
        )
        if price_doc:
            cur_px = float(price_doc["price"])
            a["current_px"] = cur_px
            entry_px = a.get("entry_px") or 0
            if entry_px > 0:
                raw = (cur_px - entry_px) / entry_px
                ret = raw if a["side"] == "LONG" else -raw
                a["live_return_pct"] = round(ret * 100, 2)
        a["strategy_meta"] = STRATEGY_META.get(a["strategy"], {})

    return {"data": alerts, "total": len(alerts)}


@router.get("/trade-alerts/history")
async def get_alert_history(days: int = Query(30, ge=1, le=90)):
    db = get_db()
    since = datetime.utcnow() - timedelta(days=days)
    cursor = db.hl_signals_trade_alerts.find(
        {"status": {"$in": ["WIN", "LOSS"]}, "fired_at": {"$gte": since}}
    ).sort("fired_at", -1)
    alerts = [_ser(doc) async for doc in cursor]
    for a in alerts:
        a["strategy_meta"] = STRATEGY_META.get(a["strategy"], {})
    return {"data": alerts, "total": len(alerts)}


@router.get("/trade-alerts/scorecard")
async def get_scorecard():
    db = get_db()
    result = []
    for strategy, meta in STRATEGY_META.items():
        pipeline = [
            {"$match": {"strategy": strategy, "status": {"$in": ["WIN", "LOSS"]}}},
            {"$group": {
                "_id": "$status",
                "count": {"$sum": 1},
                "avg_ret": {"$avg": "$return_pct"},
            }},
        ]
        rows = await db.hl_signals_trade_alerts.aggregate(pipeline).to_list(10)
        wins   = next((r["count"] for r in rows if r["_id"] == "WIN"), 0)
        losses = next((r["count"] for r in rows if r["_id"] == "LOSS"), 0)
        total  = wins + losses
        open_n = await db.hl_signals_trade_alerts.count_documents(
            {"strategy": strategy, "status": "OPEN"}
        )
        avg_win  = next((r["avg_ret"] for r in rows if r["_id"] == "WIN"),  None)
        avg_loss = next((r["avg_ret"] for r in rows if r["_id"] == "LOSS"), None)
        result.append({
            "strategy": strategy,
            **meta,
            "open": open_n,
            "live_wins": wins,
            "live_losses": losses,
            "live_total": total,
            "live_win_pct": round(wins / total * 100, 1) if total > 0 else None,
            "live_avg_win_pct": round(avg_win, 2) if avg_win is not None else None,
            "live_avg_loss_pct": round(avg_loss, 2) if avg_loss is not None else None,
        })
    return {"data": result}
