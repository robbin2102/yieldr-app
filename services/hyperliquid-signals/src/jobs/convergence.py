import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from ..db import get_db
from ..config import settings

logger = logging.getLogger(__name__)


async def run_convergence(snapshot_ts: datetime) -> None:
    logger.info('"Starting convergence engine", "snapshot_ts": "%s"', snapshot_ts.isoformat())
    db = get_db()

    # Load all positions from this snapshot
    positions = await db.hl_signals_positions.find(
        {"snapshot_ts": snapshot_ts}
    ).to_list(None)

    if not positions:
        logger.warning('"No positions found for snapshot, skipping convergence"')
        return

    # Load trader month_roi map for weighted avg
    trader_cursor = db.hl_signals_traders.find(
        {"cohort_status": "active"}, {"address": 1, "month_roi": 1}
    )
    trader_roi: dict[str, float] = {doc["address"]: doc["month_roi"] async for doc in trader_cursor}

    # Aggregate by (coin, side)
    total_all_usd = sum(p["size_usd"] for p in positions)
    coin_total: dict[str, float] = defaultdict(float)
    for p in positions:
        coin_total[p["coin"]] += p["size_usd"]

    # (coin, side) → {traders, total_usd, roi_sum}
    buckets: dict[tuple, dict] = defaultdict(lambda: {"traders": [], "total_usd": 0.0, "roi_sum": 0.0})
    for p in positions:
        key = (p["coin"], p["side"])
        buckets[key]["traders"].append(p)
        buckets[key]["total_usd"] += p["size_usd"]
        buckets[key]["roi_sum"] += trader_roi.get(p["address"], 0.0)

    # Compute conviction per coin
    coin_long_usd: dict[str, float] = defaultdict(float)
    coin_short_usd: dict[str, float] = defaultdict(float)
    for (coin, side), data in buckets.items():
        if side == "LONG":
            coin_long_usd[coin] += data["total_usd"]
        else:
            coin_short_usd[coin] += data["total_usd"]

    convergence_docs = []
    alert_candidates = []

    for (coin, side), data in buckets.items():
        n = len(data["traders"])
        total_usd = data["total_usd"]
        avg_mo_roi = data["roi_sum"] / n if n > 0 else 0.0
        c_total = coin_total[coin]
        pct_of_coin = (total_usd / c_total * 100) if c_total > 0 else 0.0
        pct_of_all = (total_usd / total_all_usd * 100) if total_all_usd > 0 else 0.0

        long_usd = coin_long_usd[coin]
        short_usd = coin_short_usd[coin]
        denom = long_usd + short_usd
        conviction = abs(long_usd - short_usd) / denom if denom > 0 else 0.0

        top5 = sorted(data["traders"], key=lambda x: x["size_usd"], reverse=True)[:5]
        top_traders = [{"address": t["address"], "size_usd": t["size_usd"]} for t in top5]

        doc = {
            "snapshot_ts": snapshot_ts,
            "coin": coin,
            "side": side,
            "n_traders": n,
            "total_usd": total_usd,
            "pct_of_coin": pct_of_coin,
            "pct_of_all_portfolio": pct_of_all,
            "avg_mo_roi": avg_mo_roi,
            "conviction": conviction,
            "top_traders": top_traders,
        }
        convergence_docs.append(doc)

        # Tier classification — only the dominant side (higher USD) earns conviction-based tiers
        dominant_side = "LONG" if coin_long_usd[coin] >= coin_short_usd[coin] else "SHORT"
        is_dominant = side == dominant_side

        tier = None
        if is_dominant and conviction >= settings.tier1_conviction and n >= settings.tier1_min_traders and total_usd >= settings.tier1_min_usd:
            tier = 1
        elif is_dominant and conviction >= settings.tier2_conviction and n >= settings.tier2_min_traders:
            tier = 2
        elif n >= settings.tier3_min_traders:
            tier = 3

        if tier:
            alert_candidates.append((coin, side, tier, doc))

    if convergence_docs:
        await db.hl_signals_convergence.insert_many(convergence_docs)

    # Write tier alerts — deduplicate by (coin, side, severity) to avoid spam
    now = datetime.now(timezone.utc)
    for coin, side, tier, doc in alert_candidates:
        existing = await db.hl_signals_alerts.find_one(
            {"coin": coin, "side": side, "severity": tier, "acknowledged": False}
        )
        if not existing:
            await db.hl_signals_alerts.insert_one(
                {
                    "coin": coin,
                    "side": side,
                    "severity": tier,
                    "alert_type": "TIER_SIGNAL",
                    "n_traders": doc["n_traders"],
                    "total_usd": doc["total_usd"],
                    "conviction": doc["conviction"],
                    "acknowledged": False,
                    "created_at": now,
                    "snapshot_ts": snapshot_ts,
                }
            )

    # Momentum alerts — compare to 24h ago
    cutoff_24h = snapshot_ts - timedelta(hours=24)
    for (coin, side), data in buckets.items():
        prev = await db.hl_signals_convergence.find_one(
            {"coin": coin, "side": side, "snapshot_ts": {"$lte": cutoff_24h}},
            sort=[("snapshot_ts", -1)],
        )
        if not prev:
            continue
        n_now = len(data["traders"])
        usd_now = data["total_usd"]
        threshold = settings.momentum_threshold_pct / 100

        n_grew = prev["n_traders"] > 0 and (n_now - prev["n_traders"]) / prev["n_traders"] >= threshold
        usd_grew = prev["total_usd"] > 0 and (usd_now - prev["total_usd"]) / prev["total_usd"] >= threshold

        if n_grew or usd_grew:
            existing = await db.hl_signals_alerts.find_one(
                {"coin": coin, "side": side, "alert_type": "MOMENTUM_ALERT", "acknowledged": False}
            )
            if not existing:
                await db.hl_signals_alerts.insert_one(
                    {
                        "coin": coin,
                        "side": side,
                        "severity": 2,
                        "alert_type": "MOMENTUM_ALERT",
                        "n_traders": n_now,
                        "total_usd": usd_now,
                        "conviction": buckets[(coin, side)]["total_usd"],
                        "acknowledged": False,
                        "created_at": now,
                        "snapshot_ts": snapshot_ts,
                    }
                )

    logger.info(
        '"Convergence complete", "buckets": %d, "alerts": %d',
        len(convergence_docs),
        len(alert_candidates),
    )
