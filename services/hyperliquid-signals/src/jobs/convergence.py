import asyncio
import ctypes
import ctypes.util
import gc
import logging
import os
import resource
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import aiohttp

from ..db import get_db
from ..config import settings
from ..lib.hyperliquid import fetch_funding_rates

# Exit cleanly when RSS exceeds this level so Railway restarts with a fresh heap.
# Python's pymalloc arena fragmentation is permanent within a process lifetime;
# the only cure is periodic restart before RSS hits the 2 GB Railway limit.
_RSS_RESTART_MB = 1300


def _current_rss_mb() -> float:
    """Current RSS in MB. Reads /proc/self/status (Linux); falls back to ru_maxrss."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024  # kB → MB
    except Exception:
        pass
    # Fallback: ru_maxrss is historical peak, not current, but better than nothing.
    # Units differ by platform: KB on Linux, bytes on macOS.
    ru_maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
    return ru_maxrss / divisor

logger = logging.getLogger(__name__)

# Time windows in hours for acceleration analysis
ACCEL_WINDOWS = [1, 4, 12, 24, 48, 72, 168]


def _find_closest_before(history: list[dict], cutoff: datetime) -> dict | None:
    """Return the most recent doc with snapshot_ts <= cutoff.
    Motor returns naive datetimes; cutoff may be tz-aware — strip tz for comparison.
    """
    cutoff_naive = cutoff.replace(tzinfo=None)
    result = None
    for doc in history:  # assumes sorted ascending by snapshot_ts
        ts = doc["snapshot_ts"]
        ts_naive = ts.replace(tzinfo=None) if ts.tzinfo else ts
        if ts_naive <= cutoff_naive:
            result = doc
        else:
            break
    return result


async def run_convergence(snapshot_ts: datetime) -> None:
    # Ensure naive UTC throughout — Motor stores naive datetimes, comparisons must match
    if snapshot_ts.tzinfo is not None:
        snapshot_ts = snapshot_ts.replace(tzinfo=None)
    logger.info('"Starting convergence v2", "snapshot_ts": "%s"', snapshot_ts.isoformat())
    db = get_db()

    # ── 1. Load current positions ────────────────────────────────────────────
    # Excludes the "no open positions" sentinel docs (coin=None) written by
    # the snapshotter for addresses with zero positions.
    positions = await db.hl_signals_positions.find(
        {"snapshot_ts": snapshot_ts, "coin": {"$ne": None}}
    ).to_list(None)

    if not positions:
        logger.warning('"No positions for snapshot, skipping convergence"')
        return

    # ── 2. Load trader info ──────────────────────────────────────────────────
    traders_cursor = db.hl_signals_traders.find(
        {"cohort_status": "active"},
        {"address": 1, "skill_quartile": 1, "month_roi": 1, "account_value": 1},
    )
    traders: dict[str, dict] = {doc["address"]: doc async for doc in traders_cursor}
    total_cohort = len(traders)

    # ── 3. Aggregate per-coin ────────────────────────────────────────────────
    coin_buckets: dict[str, dict] = {}
    coin_current_addrs: dict[str, set] = {}
    total_portfolio_usd = sum(p["size_usd"] for p in positions)

    for p in positions:
        coin = p["coin"]
        if coin not in coin_buckets:
            coin_buckets[coin] = {
                "long_usd": 0.0, "short_usd": 0.0,
                "long_count": 0, "short_count": 0,
                "long_entry_wsum": 0.0, "short_entry_wsum": 0.0,
                "leverages": [],
                "q1_long": 0, "q1_short": 0,
                "q4_long": 0, "q4_short": 0,
                "roi_sum_long": 0.0, "roi_sum_short": 0.0,
                "top_long": [], "top_short": [],
            }
        t = traders.get(p["address"], {})
        q = t.get("skill_quartile", 4)
        roi = t.get("month_roi", 0.0)
        cd = coin_buckets[coin]

        if p["side"] == "LONG":
            cd["long_usd"] += p["size_usd"]
            cd["long_count"] += 1
            cd["roi_sum_long"] += roi
            cd["long_entry_wsum"] += p["entry_px"] * p["size_usd"]
            cd["top_long"].append({"address": p["address"], "size_usd": p["size_usd"]})
            if q == 1: cd["q1_long"] += 1
            if q == 4: cd["q4_long"] += 1
        else:
            cd["short_usd"] += p["size_usd"]
            cd["short_count"] += 1
            cd["roi_sum_short"] += roi
            cd["short_entry_wsum"] += p["entry_px"] * p["size_usd"]
            cd["top_short"].append({"address": p["address"], "size_usd": p["size_usd"]})
            if q == 1: cd["q1_short"] += 1
            if q == 4: cd["q4_short"] += 1

        cd["leverages"].append(p["leverage"])
        coin_current_addrs.setdefault(coin, set()).add(p["address"])

    # ── 3b. Active cohort per coin (current holders + closed last 30d) ───────
    coins_list_early = list(coin_buckets.keys())
    thirty_days_ago = snapshot_ts - timedelta(days=30)
    active_close_docs = await db.hl_signals_position_changes.aggregate([
        {"$match": {
            "coin": {"$in": coins_list_early},
            "change_type": "CLOSED",
            "ts": {"$gte": thirty_days_ago},
        }},
        {"$group": {"_id": "$coin", "closers": {"$addToSet": "$address"}}},
    ]).to_list(len(coins_list_early) + 10)
    closed_30d_map: dict[str, set] = {d["_id"]: set(d["closers"]) for d in active_close_docs}
    del active_close_docs

    # ── 4. Compute coin_metrics and save ────────────────────────────────────
    coin_metrics: dict[str, dict] = {}
    coin_metrics_docs = []

    for coin, cd in coin_buckets.items():
        total_count = cd["long_count"] + cd["short_count"]
        total_usd = cd["long_usd"] + cd["short_usd"]

        count_conviction = (
            abs(cd["long_count"] - cd["short_count"]) / total_count if total_count > 0 else 0.0
        )
        dollar_conviction = (
            abs(cd["long_usd"] - cd["short_usd"]) / total_usd if total_usd > 0 else 0.0
        )
        cohort_participation = total_count / total_cohort if total_cohort > 0 else 0.0
        active_cohort_size = len(coin_current_addrs.get(coin, set()) | closed_30d_map.get(coin, set()))
        active_participation = total_count / active_cohort_size if active_cohort_size > 0 else 0.0
        wt_avg_entry_long = cd["long_entry_wsum"] / cd["long_usd"] if cd["long_usd"] > 0 else 0.0
        wt_avg_entry_short = cd["short_entry_wsum"] / cd["short_usd"] if cd["short_usd"] > 0 else 0.0
        dominant_side = "LONG" if cd["long_usd"] >= cd["short_usd"] else "SHORT"
        avg_leverage = sum(cd["leverages"]) / len(cd["leverages"]) if cd["leverages"] else 0.0
        portfolio_share = total_usd / total_portfolio_usd if total_portfolio_usd > 0 else 0.0

        dom_count = cd["long_count"] if dominant_side == "LONG" else cd["short_count"]
        dom_roi_sum = cd["roi_sum_long"] if dominant_side == "LONG" else cd["roi_sum_short"]
        avg_mo_roi = dom_roi_sum / dom_count if dom_count > 0 else 0.0

        top_long = sorted(cd["top_long"], key=lambda x: x["size_usd"], reverse=True)[:5]
        top_short = sorted(cd["top_short"], key=lambda x: x["size_usd"], reverse=True)[:5]

        doc = {
            "snapshot_ts": snapshot_ts,
            "coin": coin,
            "long_usd": cd["long_usd"],
            "short_usd": cd["short_usd"],
            "long_count": cd["long_count"],
            "short_count": cd["short_count"],
            "total_count": total_count,
            "total_usd": total_usd,
            "count_conviction": count_conviction,
            "dollar_conviction": dollar_conviction,
            "cohort_participation": cohort_participation,
            "active_cohort_size": active_cohort_size,
            "active_participation": active_participation,
            "wt_avg_entry_long": wt_avg_entry_long,
            "wt_avg_entry_short": wt_avg_entry_short,
            "dominant_side": dominant_side,
            "avg_leverage": avg_leverage,
            "portfolio_share": portfolio_share,
            "avg_mo_roi": avg_mo_roi,
            "q1_long": cd["q1_long"],
            "q1_short": cd["q1_short"],
            "q4_long": cd["q4_long"],
            "q4_short": cd["q4_short"],
            "top_long": top_long,
            "top_short": top_short,
        }
        coin_metrics[coin] = doc
        coin_metrics_docs.append(doc)

    if coin_metrics_docs:
        await db.hl_signals_coin_metrics.insert_many(coin_metrics_docs)

    # Also write legacy convergence docs for backward compat
    convergence_docs = []
    for coin, cm in coin_metrics.items():
        cd = coin_buckets[coin]
        for side in ("LONG", "SHORT"):
            n = cm["long_count"] if side == "LONG" else cm["short_count"]
            if n == 0:
                continue
            total_usd = cm["long_usd"] if side == "LONG" else cm["short_usd"]
            top_traders = cm["top_long"] if side == "LONG" else cm["top_short"]
            c_total = cm["total_usd"]
            pct_of_coin = (total_usd / c_total * 100) if c_total > 0 else 0.0
            pct_of_all = (total_usd / total_portfolio_usd * 100) if total_portfolio_usd > 0 else 0.0
            roi_sum = cd["roi_sum_long"] if side == "LONG" else cd["roi_sum_short"]
            avg_mo_roi = roi_sum / n if n > 0 else 0.0
            convergence_docs.append(
                {
                    "snapshot_ts": snapshot_ts,
                    "coin": coin,
                    "side": side,
                    "n_traders": n,
                    "total_usd": total_usd,
                    "pct_of_coin": pct_of_coin,
                    "pct_of_all_portfolio": pct_of_all,
                    "avg_mo_roi": avg_mo_roi,
                    "conviction": cm["dollar_conviction"],
                    "top_traders": top_traders,
                }
            )
    if convergence_docs:
        await db.hl_signals_convergence.insert_many(convergence_docs)

    # ── 5. Fetch historical snapshots per time-window (targeted, not bulk) ───
    # Instead of loading all 7d history into RAM, run one aggregation per window
    # that returns the single closest snapshot per coin. ~176 docs × 6 windows
    # vs ~350K docs loaded all at once.
    coins_list = list(coin_metrics.keys())

    async def _fetch_window(hours_ago: int) -> dict[str, dict]:
        """Return coin → nearest coin_metrics doc at or before snapshot_ts - hours_ago."""
        cutoff = snapshot_ts - timedelta(hours=hours_ago)
        pipeline = [
            {"$match": {"coin": {"$in": coins_list}, "snapshot_ts": {"$lte": cutoff}}},
            {"$sort": {"coin": 1, "snapshot_ts": -1}},
            {"$group": {"_id": "$coin", "doc": {"$first": "$$ROOT"}}},
            {"$replaceRoot": {"newRoot": "$doc"}},
            {"$project": {"_id": 0}},
        ]
        docs = await db.hl_signals_coin_metrics.aggregate(pipeline).to_list(
            len(coins_list) + 10
        )
        return {d["coin"]: d for d in docs}

    # Run all window lookups concurrently
    window_results = await asyncio.gather(*[_fetch_window(w) for w in ACCEL_WINDOWS])
    hist_by_window: dict[int, dict[str, dict]] = {
        w: result for w, result in zip(ACCEL_WINDOWS, window_results)
    }

    def find_hist(coin: str, hours_ago: int) -> dict | None:
        return hist_by_window.get(hours_ago, {}).get(coin)

    # ── 6. Detect signals ────────────────────────────────────────────────────
    signals: list[dict] = []

    def emit(signal_type: str, coin: str, side: str, severity: str, meta: dict) -> None:
        signals.append(
            {
                "signal_type": signal_type,
                "coin": coin,
                "side": side,
                "severity": severity,
                "snapshot_ts": snapshot_ts,
                "created_at": snapshot_ts,
                "metadata": meta,
            }
        )

    # ── Signal 1: CONVERGENCE_ACCELERATION ───────────────────────────────────
    SUB_METRICS = ["count_conviction", "dollar_conviction", "cohort_participation"]
    THRESHOLD = settings.accel_metric_threshold

    for coin, cm in coin_metrics.items():
        metric_window_hits: dict[str, int] = {m: 0 for m in SUB_METRICS}
        window_details = []

        for w in ACCEL_WINDOWS:
            hist = find_hist(coin, w)
            if not hist:
                continue
            accel_in_window = []
            for m in SUB_METRICS:
                cur_v = cm.get(m, 0.0)
                hist_v = hist.get(m, 0.0)
                if hist_v > 0 and (cur_v - hist_v) / hist_v >= THRESHOLD:
                    accel_in_window.append(m)
                    metric_window_hits[m] += 1
            if accel_in_window:
                window_details.append({"window_h": w, "metrics": accel_in_window})

        strong_metrics = [m for m, cnt in metric_window_hits.items() if cnt >= 2]
        any_very_consistent = any(cnt >= 3 for cnt in metric_window_hits.values())

        if len(strong_metrics) >= 2:
            severity = "HIGH"
        elif len(strong_metrics) >= 1 or any_very_consistent:
            severity = "MEDIUM"
        else:
            continue

        emit(
            "CONVERGENCE_ACCELERATION",
            coin,
            cm["dominant_side"],
            severity,
            {
                "count_conviction": cm["count_conviction"],
                "dollar_conviction": cm["dollar_conviction"],
                "cohort_participation": cm["cohort_participation"],
                "window_details": window_details,
            },
        )

    # ── Signal 3: COHORT_DIRECTION_FLIP ──────────────────────────────────────
    for coin, cm in coin_metrics.items():
        hist_48h = find_hist(coin, 48)
        if not hist_48h:
            continue
        if hist_48h["dominant_side"] != cm["dominant_side"]:
            emit(
                "COHORT_DIRECTION_FLIP",
                coin,
                cm["dominant_side"],
                "HIGH",
                {
                    "prev_dominant": hist_48h["dominant_side"],
                    "new_dominant": cm["dominant_side"],
                    "count_conviction": cm["count_conviction"],
                    "dollar_conviction": cm["dollar_conviction"],
                    "cohort_participation": cm["cohort_participation"],
                },
            )

    # ── Signal 4: SMART_EXIT ─────────────────────────────────────────────────
    # Q1 closing at higher rate than Q4 in past 24h.
    # Aggregate (coin, address) → close_count instead of loading every event doc.
    close_agg = await db.hl_signals_position_changes.aggregate([
        {"$match": {
            "ts": {"$gte": snapshot_ts - timedelta(hours=24)},
            "change_type": "CLOSED",
        }},
        {"$group": {"_id": {"coin": "$coin", "address": "$address"}, "n": {"$sum": 1}}},
    ]).to_list(10_000)

    closes_by_coin: dict[str, dict[str, int]] = {}
    for row in close_agg:
        coin = row["_id"]["coin"]
        addr = row["_id"]["address"]
        q = traders.get(addr, {}).get("skill_quartile", 4)
        if coin not in closes_by_coin:
            closes_by_coin[coin] = {"q1": 0, "q4": 0}
        if q == 1:
            closes_by_coin[coin]["q1"] += row["n"]
        elif q == 4:
            closes_by_coin[coin]["q4"] += row["n"]
    del close_agg

    for coin, close_counts in closes_by_coin.items():
        cm = coin_metrics.get(coin)
        if not cm:
            continue
        q1_closes = close_counts["q1"]
        q4_closes = close_counts["q4"]
        if q1_closes < 2:
            continue
        # Normalise by quartile size in current holders
        q1_holders = cm["q1_long"] + cm["q1_short"]
        q4_holders = cm["q4_long"] + cm["q4_short"]
        q1_rate = q1_closes / q1_holders if q1_holders > 0 else 0.0
        q4_rate = q4_closes / q4_holders if q4_holders > 0 else 0.0
        if q1_rate > q4_rate * 1.5:
            # Smart money exiting faster than dumb money
            emit(
                "SMART_EXIT",
                coin,
                cm["dominant_side"],
                "HIGH" if q1_rate > q4_rate * 2.5 else "MEDIUM",
                {
                    "q1_closes": q1_closes,
                    "q4_closes": q4_closes,
                    "q1_rate": q1_rate,
                    "q4_rate": q4_rate,
                    "count_conviction": cm["count_conviction"],
                    "dollar_conviction": cm["dollar_conviction"],
                    "cohort_participation": cm["cohort_participation"],
                },
            )

    # ── Signal 5: LEVERAGE_SPIKE ─────────────────────────────────────────────
    for coin, cm in coin_metrics.items():
        hist_4h = find_hist(coin, 4)
        if not hist_4h or hist_4h["avg_leverage"] <= 0:
            continue
        ratio = cm["avg_leverage"] / hist_4h["avg_leverage"]
        if ratio >= settings.leverage_spike_ratio:
            emit(
                "LEVERAGE_SPIKE",
                coin,
                cm["dominant_side"],
                "HIGH" if ratio >= settings.leverage_spike_ratio * 1.5 else "MEDIUM",
                {
                    "avg_leverage_now": cm["avg_leverage"],
                    "avg_leverage_4h_ago": hist_4h["avg_leverage"],
                    "ratio": ratio,
                    "count_conviction": cm["count_conviction"],
                    "dollar_conviction": cm["dollar_conviction"],
                    "cohort_participation": cm["cohort_participation"],
                },
            )

    # ── Signal 6: ASYMMETRIC_POSITIONING ─────────────────────────────────────
    for coin, cm in coin_metrics.items():
        gap = abs(cm["count_conviction"] - cm["dollar_conviction"])
        if gap >= settings.asymmetric_threshold and cm["total_count"] >= 5:
            # Determine which direction: count > dollar means small traders leading; dollar > count means whales leading
            if cm["dollar_conviction"] > cm["count_conviction"]:
                side = cm["dominant_side"]
                detail = "whales_leading"
            else:
                side = cm["dominant_side"]
                detail = "crowd_leading"
            emit(
                "ASYMMETRIC_POSITIONING",
                coin,
                side,
                "HIGH" if gap >= settings.asymmetric_threshold * 2 else "MEDIUM",
                {
                    "count_conviction": cm["count_conviction"],
                    "dollar_conviction": cm["dollar_conviction"],
                    "cohort_participation": cm["cohort_participation"],
                    "gap_pp": gap,
                    "detail": detail,
                },
            )

    # ── Signal 7: CAPITAL_ROTATION ───────────────────────────────────────────
    ROTATION_WINDOWS = [4, 12, 24, 72]
    for coin, cm in coin_metrics.items():
        for w in ROTATION_WINDOWS:
            hist = find_hist(coin, w)
            if not hist:
                continue
            delta = cm["portfolio_share"] - hist["portfolio_share"]
            if abs(delta) >= settings.rotation_threshold:
                direction = "INFLOW" if delta > 0 else "OUTFLOW"
                emit(
                    "CAPITAL_ROTATION",
                    coin,
                    cm["dominant_side"],
                    "HIGH" if abs(delta) >= settings.rotation_threshold * 2 else "MEDIUM",
                    {
                        "portfolio_share_now": cm["portfolio_share"],
                        "portfolio_share_prev": hist["portfolio_share"],
                        "delta": delta,
                        "window_h": w,
                        "direction": direction,
                        "count_conviction": cm["count_conviction"],
                        "dollar_conviction": cm["dollar_conviction"],
                        "cohort_participation": cm["cohort_participation"],
                    },
                )
                break  # only emit once per coin (shortest window that fires)

    # ── Signal 8: FUNDING_DIVERGENCE ─────────────────────────────────────────
    try:
        async with aiohttp.ClientSession() as session:
            funding_rates = await fetch_funding_rates(session)

        for coin, cm in coin_metrics.items():
            rate = funding_rates.get(coin)
            if rate is None or abs(rate) < settings.funding_threshold:
                continue
            # Positive funding = market leans long; negative = market leans short
            market_side = "LONG" if rate > 0 else "SHORT"
            if market_side != cm["dominant_side"]:
                emit(
                    "FUNDING_DIVERGENCE",
                    coin,
                    cm["dominant_side"],
                    "HIGH" if abs(rate) >= settings.funding_threshold * 3 else "MEDIUM",
                    {
                        "funding_rate": rate,
                        "market_side": market_side,
                        "cohort_side": cm["dominant_side"],
                        "count_conviction": cm["count_conviction"],
                        "dollar_conviction": cm["dollar_conviction"],
                        "cohort_participation": cm["cohort_participation"],
                    },
                )
    except Exception as e:
        logger.warning('"Funding divergence check failed", "error": "%s"', e)

    # ── Signal 9: STALE_POSITION_DECAY ───────────────────────────────────────
    # Single bulk aggregation instead of 176×2 per-coin queries
    stale_cutoff = snapshot_ts - timedelta(days=settings.stale_age_days)
    week_cutoff = snapshot_ts - timedelta(days=7)

    stale_pipeline = [
        {
            "$match": {
                "coin": {"$in": coins_list},
                "change_type": "NEW_POSITION",
                "ts": {"$lte": stale_cutoff},
            }
        },
        {"$group": {"_id": "$coin", "old_addrs": {"$addToSet": "$address"}}},
    ]
    new_pipeline = [
        {
            "$match": {
                "coin": {"$in": coins_list},
                "change_type": "NEW_POSITION",
                "ts": {"$gte": week_cutoff},
            }
        },
        {"$group": {"_id": "$coin", "new_count": {"$sum": 1}}},
    ]
    stale_docs, new_docs = await asyncio.gather(
        db.hl_signals_position_changes.aggregate(stale_pipeline).to_list(len(coins_list) + 10),
        db.hl_signals_position_changes.aggregate(new_pipeline).to_list(len(coins_list) + 10),
    )
    stale_map = {d["_id"]: d["old_addrs"] for d in stale_docs}
    new_map = {d["_id"]: d["new_count"] for d in new_docs}

    for coin, cm in coin_metrics.items():
        old_entry_addrs = stale_map.get(coin, [])
        new_entry_count = new_map.get(coin, 0)

        # Only fire if majority of holders have old entries and few new entries
        if (
            len(old_entry_addrs) >= 3
            and new_entry_count <= settings.stale_max_new_entries
            and cm["total_count"] >= 3
        ):
            stale_ratio = len(old_entry_addrs) / cm["total_count"]
            if stale_ratio >= 0.5:
                emit(
                    "STALE_POSITION_DECAY",
                    coin,
                    cm["dominant_side"],
                    "MEDIUM",
                    {
                        "stale_holders": len(old_entry_addrs),
                        "total_holders": cm["total_count"],
                        "stale_ratio": stale_ratio,
                        "new_entries_7d": new_entry_count,
                        "count_conviction": cm["count_conviction"],
                        "dollar_conviction": cm["dollar_conviction"],
                        "cohort_participation": cm["cohort_participation"],
                    },
                )

    # ── 7. Persist signals ───────────────────────────────────────────────────
    if signals:
        await db.hl_signals_signals.insert_many(signals)

    # ── 8. Legacy tier alerts ────────────────────────────────────────────────
    # Single query to find all existing open alerts, then bulk-insert new ones.
    existing_alert_keys: set[tuple] = set()
    async for doc in db.hl_signals_alerts.find(
        {"coin": {"$in": coins_list}, "acknowledged": False},
        {"coin": 1, "side": 1, "severity": 1},
    ):
        existing_alert_keys.add((doc["coin"], doc["side"], doc["severity"]))

    new_alerts = []
    for coin, cm in coin_metrics.items():
        conviction = cm["dollar_conviction"]
        n = cm["long_count"] if cm["dominant_side"] == "LONG" else cm["short_count"]
        total_usd = cm["long_usd"] if cm["dominant_side"] == "LONG" else cm["short_usd"]

        tier = None
        if (
            conviction >= settings.tier1_conviction
            and n >= settings.tier1_min_traders
            and total_usd >= settings.tier1_min_usd
        ):
            tier = 1
        elif conviction >= settings.tier2_conviction and n >= settings.tier2_min_traders:
            tier = 2
        elif n >= settings.tier3_min_traders:
            tier = 3

        if tier and (coin, cm["dominant_side"], tier) not in existing_alert_keys:
            new_alerts.append({
                "coin": coin,
                "side": cm["dominant_side"],
                "severity": tier,
                "alert_type": "TIER_SIGNAL",
                "n_traders": n,
                "total_usd": total_usd,
                "conviction": conviction,
                "acknowledged": False,
                "created_at": snapshot_ts,
                "snapshot_ts": snapshot_ts,
            })

    if new_alerts:
        await db.hl_signals_alerts.insert_many(new_alerts, ordered=False)

    by_type = defaultdict(int)
    for s in signals:
        by_type[s["signal_type"]] += 1
    n_metrics = len(coin_metrics)
    n_signals = len(signals)

    # Free all large in-memory structures before returning
    del positions, traders, coin_buckets, coin_current_addrs, closed_30d_map
    del coin_metrics, coin_metrics_docs, convergence_docs, hist_by_window
    del signals, closes_by_coin, new_alerts
    gc.collect()

    # malloc_trim(0) releases glibc-malloc free pages to the OS.
    # Note: Python's pymalloc (small objects <512 B) bypasses glibc malloc,
    # so arena fragmentation there is NOT fixed by this — see watchdog below.
    _lib = ctypes.util.find_library("c")
    if _lib:
        try:
            ctypes.CDLL(_lib).malloc_trim(0)
        except Exception:
            pass

    rss_mb = _current_rss_mb()
    logger.info(
        '"Convergence v2 complete", "coin_metrics": %d, "signals": %d, "rss_mb": %.1f, "breakdown": %s',
        n_metrics,
        n_signals,
        rss_mb,
        dict(by_type),
    )

    # Watchdog: Python pymalloc arenas fragment permanently — the only fix is restart.
    # Exit cleanly here so Railway (restartPolicyType=ALWAYS) brings up a fresh process.
    if rss_mb > _RSS_RESTART_MB:
        logger.warning(
            '"RSS %.1f MB exceeds %d MB threshold — exiting for clean heap restart"',
            rss_mb, _RSS_RESTART_MB,
        )
        os._exit(0)  # bypass Python cleanup to avoid triggering atexit bugs at high RSS
