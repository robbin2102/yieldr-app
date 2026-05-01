from fastapi import APIRouter, HTTPException
from bson import ObjectId
from ..db import get_db
from ..config import settings

router = APIRouter(tags=["config"])


@router.get("/config")
async def get_config():
    db = get_db()
    doc = await db.hl_signals_config.find_one({"_id": "main"})
    if doc:
        doc.pop("_id", None)
        return {"data": doc, "source": "db"}
    # Return current env-based config
    return {
        "data": {
            "filter_settings": {
                "min_av": settings.min_av,
                "max_av": settings.max_av,
                "max_month_roi": settings.max_month_roi,
                "max_all_roi": settings.max_all_roi,
                "min_month_vlm": settings.min_month_vlm,
                "min_pnl_av_ratio": settings.min_pnl_av_ratio,
                "min_month_eff": settings.min_month_eff,
                "min_roi_ratio": settings.min_roi_ratio,
                "filter_roi_cap_enabled": settings.filter_roi_cap_enabled,
                "filter_efficiency_enabled": settings.filter_efficiency_enabled,
                "filter_roi_ratio_enabled": settings.filter_roi_ratio_enabled,
            },
            "signal_thresholds": {
                "tier1_conviction": settings.tier1_conviction,
                "tier1_min_traders": settings.tier1_min_traders,
                "tier1_min_usd": settings.tier1_min_usd,
                "tier2_conviction": settings.tier2_conviction,
                "tier2_min_traders": settings.tier2_min_traders,
                "tier3_min_traders": settings.tier3_min_traders,
                "momentum_threshold_pct": settings.momentum_threshold_pct,
            },
            "position_change_thresholds": {
                "position_change_threshold_pct": settings.position_change_threshold_pct,
                "leverage_change_threshold": settings.leverage_change_threshold,
            },
        },
        "source": "env",
    }


@router.post("/config")
async def update_config(body: dict):
    db = get_db()
    allowed_keys = {"filter_settings", "signal_thresholds", "position_change_thresholds"}
    if not any(k in body for k in allowed_keys):
        raise HTTPException(status_code=400, detail=f"Body must contain one of: {allowed_keys}")
    await db.hl_signals_config.update_one(
        {"_id": "main"},
        {"$set": body},
        upsert=True,
    )
    return {"ok": True}


@router.post("/alerts/{alert_id}/acknowledge")
async def acknowledge_alert(alert_id: str):
    db = get_db()
    try:
        oid = ObjectId(alert_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid alert id")
    result = await db.hl_signals_alerts.update_one({"_id": oid}, {"$set": {"acknowledged": True}})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"ok": True}
