"""Backtest entry/exit triggers against actual price moves.

Reads coin_metrics + whale_events from Mongo, joins with hl_signals_prices
(populated by the live logger and the backfill_prices.py script), and reports
the forward-return distribution for each candidate trigger.

Usage:
    python -m scripts.backtest [--horizons 1,4,24,72] [--out report.md]
"""
import argparse
import asyncio
import bisect
import logging
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from statistics import mean, median

sys.path.insert(0, ".")
from src.db import get_db  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# Fine-grained L:S bands so we can see at which ratio forward return peaks,
# rather than only the coarse 5/10/20 crossings.
LS_THRESHOLDS = (2, 3, 4, 5, 7, 10, 15, 20)


def ls_band_label(ls: float) -> str:
    """Band label for L:S ratio. Bands below 1.0 mirror the bands above 1.0
    (e.g. "2-3 (long)" vs "2-3 (short)") so WAKEUP composites can be evaluated
    symmetrically for both LONG-crowded and SHORT-crowded cohorts."""
    for lo, hi, lbl in (
        (20, float("inf"), "≥20 (long)"),
        (10, 20, "10-20 (long)"),
        (7, 10, "7-10 (long)"),
        (5, 7, "5-7 (long)"),
        (3, 5, "3-5 (long)"),
        (2, 3, "2-3 (long)"),
        (1, 2, "1-2 (long)"),
        (0.5, 1, "1-2 (short)"),
        (1 / 3, 0.5, "2-3 (short)"),
        (0.2, 1 / 3, "3-5 (short)"),
        (1 / 7, 0.2, "5-7 (short)"),
        (0.1, 1 / 7, "7-10 (short)"),
        (1 / 20, 0.1, "10-20 (short)"),
        (0, 1 / 20, "≥20 (short)"),
    ):
        if lo <= ls < hi:
            return lbl
    return "?"


def ls_at(series: list[tuple[datetime, float]], ts: datetime) -> float | None:
    """Nearest L:S value at or before ts (the metrics snapshot preceding the event)."""
    if not series:
        return None
    arr = [s[0] for s in series]
    idx = bisect.bisect_right(arr, ts) - 1
    if idx < 0:
        return None
    return series[idx][1]


def oi_at(series: list[tuple[datetime, float, float]], ts: datetime) -> tuple[float, float] | None:
    """Nearest (long_usd, short_usd) at or before ts."""
    if not series:
        return None
    arr = [s[0] for s in series]
    idx = bisect.bisect_right(arr, ts) - 1
    if idx < 0:
        return None
    _, l, s = series[idx]
    return l, s


def pct(v): return f"{v*100:.1f}%" if v is not None else "—"
def pcts(v): return f"{v*100:+.2f}%" if v is not None else "—"


async def top_coins_by_volume(db, top_n: int) -> list[str]:
    """Top N coins by the cohort's total open notional at the latest snapshot."""
    latest = await db.hl_signals_coin_metrics.find().sort("snapshot_ts", -1).limit(1).to_list(1)
    if not latest:
        return []
    ts = latest[0]["snapshot_ts"]
    cursor = db.hl_signals_coin_metrics.find(
        {"snapshot_ts": ts}, {"_id": 0, "coin": 1, "total_usd": 1}
    ).sort("total_usd", -1).limit(top_n)
    docs = await cursor.to_list(top_n)
    return [d["coin"] for d in docs]


# ─── price lookup ─────────────────────────────────────────────────────────────


class PriceIndex:
    """In-memory price series per coin, sorted by ts. Supports O(log n) lookups."""

    def __init__(self):
        self._series: dict[str, list[tuple[datetime, float]]] = {}

    async def _load_one(self, db, coin: str, since: datetime | None, until: datetime | None) -> None:
        filt: dict = {"coin": coin}
        if since or until:
            filt["ts"] = {}
            if since:
                filt["ts"]["$gte"] = since
            if until:
                filt["ts"]["$lte"] = until
        cursor = db.hl_signals_prices.find(filt, {"_id": 0, "ts": 1, "price": 1}).sort("ts", 1)
        self._series[coin] = [(d["ts"], d["price"]) async for d in cursor]

    async def load(self, db, coins: list[str], since: datetime | None = None,
                   until: datetime | None = None, concurrency: int = 20) -> None:
        sem = asyncio.Semaphore(concurrency)

        async def _bounded(coin):
            async with sem:
                await self._load_one(db, coin, since, until)

        await asyncio.gather(*[_bounded(c) for c in coins])
        loaded = sum(len(v) for v in self._series.values())
        logger.info("Loaded %d price points across %d coins", loaded, len(coins))

    def price_at(self, coin: str, ts: datetime, max_lag_min: int = 10) -> float | None:
        """Nearest price at or after ts, within max_lag_min minutes."""
        series = self._series.get(coin)
        if not series:
            return None
        import bisect
        idx = bisect.bisect_left([s[0] for s in series], ts)
        if idx >= len(series):
            return None
        nearest_ts, nearest_px = series[idx]
        if (nearest_ts - ts).total_seconds() > max_lag_min * 60:
            return None
        return nearest_px


# ─── event generation ────────────────────────────────────────────────────────


async def load_whale_events(db, coins_filter: list[str] | None = None) -> list[dict]:
    """Each whale event becomes one candidate trade trigger."""
    filt: dict = {"coin": {"$in": coins_filter}} if coins_filter is not None else {}
    cursor = db.hl_signals_whale_events.find(filt, {"_id": 0}).sort("ts", 1)
    events = [doc async for doc in cursor]
    out = []
    for e in events:
        et = e["event_type"]
        if et in ("WAKEUP", "SCALEUP", "LEVERAGE_PUSH"):
            trade_side = e["side"]
        elif et == "FLIP":
            trade_side = e["side"]  # new side
        elif et == "EXIT":
            # EXIT signals smart money leaving — fade the previous side
            trade_side = "SHORT" if e["side"] == "LONG" else "LONG"
        else:
            continue
        out.append({
            "trigger": f"WHALE_{et}",
            "coin": e["coin"],
            "ts": e["ts"],
            "trade_side": trade_side,
            "size_usd": e.get("size_usd", 0),
            "address": e.get("address", ""),  # kept for actual-exit join
        })
    return out


async def load_whale_events_raw(db) -> list[dict]:
    """All whale events with full fields, for cross-event joins."""
    cursor = db.hl_signals_whale_events.find({}, {"_id": 0}).sort("ts", 1)
    return [doc async for doc in cursor]


def _state_size(state: dict | None) -> float | None:
    """Best-effort extraction of a position's USD-ish magnitude from a state blob.

    position_changes schema isn't guaranteed, so try several common keys and fall
    back to |szi| (coin units) — fine since it's only used for relative per-address
    shares within the same coin."""
    if not state:
        return None
    for k in ("size_usd", "notional_usd", "notional", "position_value", "value", "usd"):
        v = state.get(k)
        if isinstance(v, (int, float)) and v != 0:
            return abs(float(v))
    szi = state.get("szi")
    if isinstance(szi, (int, float)) and szi != 0:
        return abs(float(szi))
    return None


def _state_side(state: dict | None) -> str | None:
    if not state:
        return None
    s = state.get("side")
    if s in ("LONG", "SHORT"):
        return s
    szi = state.get("szi")
    if isinstance(szi, (int, float)) and szi != 0:
        return "LONG" if szi > 0 else "SHORT"
    return None


async def load_position_reductions(db) -> dict[str, list[dict]]:
    """Load position_changes that REDUCE exposure, indexed by coin and sorted by ts.

    Reductions = CLOSED / FLIP, plus SIZE_CHANGE where size shrank. Each entry keeps
    the address, the side being reduced (from previous_state), and a magnitude proxy
    so we can count distinct whales and measure concentration during an unwind window.
    """
    cursor = db.hl_signals_position_changes.find(
        {"change_type": {"$in": ["CLOSED", "FLIP", "SIZE_CHANGE"]}},
        {"_id": 0, "address": 1, "coin": 1, "change_type": 1, "ts": 1,
         "previous_state": 1, "new_state": 1},
    ).sort("ts", 1)

    by_coin: dict[str, list[dict]] = defaultdict(list)
    async for d in cursor:
        ct = d.get("change_type")
        prev, new = d.get("previous_state"), d.get("new_state")
        prev_sz, new_sz = _state_size(prev), _state_size(new)
        if ct == "SIZE_CHANGE":
            if prev_sz is None or new_sz is None or new_sz >= prev_sz:
                continue  # not a reduction
            reduced = prev_sz - new_sz
        else:  # CLOSED or FLIP — full previous side removed
            reduced = prev_sz if prev_sz is not None else 0.0
        by_coin[d["coin"]].append({
            "address": d.get("address", "unknown"),
            "ts": d["ts"],
            "side": _state_side(prev),
            "reduced": reduced,
        })
    return by_coin


def _window_whale_stats(
    pc_list: list[dict], pc_ts: list[datetime],
    win_start: datetime, anchor_ts: datetime, side: str,
) -> tuple[int, float | None]:
    """Within [win_start, anchor_ts], count distinct addresses reducing `side`
    exposure and the top-1 address's share of total reduced magnitude.

    Side filtering is best-effort: entries with unknown side are counted too
    (schema may not expose side), so we never under-count due to missing fields.
    """
    lo = bisect.bisect_left(pc_ts, win_start)
    hi = bisect.bisect_right(pc_ts, anchor_ts)
    per_addr: dict[str, float] = defaultdict(float)
    for i in range(lo, hi):
        pc = pc_list[i]
        if pc["side"] is not None and pc["side"] != side:
            continue
        per_addr[pc["address"]] += pc["reduced"] or 0.0
    if not per_addr:
        return 0, None
    total = sum(per_addr.values())
    top1 = max(per_addr.values())
    top1_share = (top1 / total) if total > 0 else None
    return len(per_addr), top1_share


def build_actual_exit_events(raw_events: list[dict]) -> list[dict]:
    """For each WAKEUP, find when that same whale next exits or flips on the same coin.

    Returns a list where each item has both ts (entry = wakeup) and exit_ts
    (when the triggering whale actually closes). Used for variable-hold evaluation.
    """
    by_whale_coin: dict[tuple, list[dict]] = defaultdict(list)
    for e in raw_events:
        addr = e.get("address", "")
        if addr:
            by_whale_coin[(addr, e["coin"])].append(e)
    for v in by_whale_coin.values():
        v.sort(key=lambda x: x["ts"])

    out = []
    for e in raw_events:
        if e["event_type"] != "WAKEUP":
            continue
        addr = e.get("address", "")
        if not addr:
            continue
        series = by_whale_coin[(addr, e["coin"])]
        exit_ev = next(
            (ev for ev in series if ev["ts"] > e["ts"] and ev["event_type"] in ("EXIT", "FLIP")),
            None,
        )
        if not exit_ev:
            continue
        hold_h = (exit_ev["ts"] - e["ts"]).total_seconds() / 3600
        out.append({
            "trigger": "WAKEUP_ACTUAL_EXIT",
            "coin": e["coin"],
            "ts": e["ts"],
            "exit_ts": exit_ev["ts"],
            "trade_side": e["side"],
            "size_usd": e.get("size_usd", 0),
            "actual_hold_h": round(hold_h, 1),
        })
    return out


def evaluate_actual_exit(events: list[dict], prices: PriceIndex) -> dict:
    """Variable-hold evaluation: exit at the actual_exit_ts, not a fixed horizon."""
    from statistics import mean, median
    returns, hold_hours = [], []
    skipped = 0
    for e in events:
        entry_px = prices.price_at(e["coin"], e["ts"])
        exit_px  = prices.price_at(e["coin"], e["exit_ts"], max_lag_min=30)
        if not entry_px or not exit_px or entry_px <= 0:
            skipped += 1
            continue
        raw = (exit_px - entry_px) / entry_px
        ret = raw if e["trade_side"] == "LONG" else -raw
        returns.append(ret)
        hold_hours.append(e["actual_hold_h"])
    n = len(returns)
    return {
        "n": n,
        "n_total": len(events),
        "win_rate": sum(1 for r in returns if r > 0) / n if n else None,
        "mean": mean(returns) if returns else None,
        "median": median(returns) if returns else None,
        "avg_hold_h": mean(hold_hours) if hold_hours else None,
        "median_hold_h": median(hold_hours) if hold_hours else None,
    }


def build_oi_unwind_events(
    oi_series: dict[str, list[tuple[datetime, float, float]]],
    reductions_by_coin: dict[str, list[dict]] | None = None,
    windows_h: tuple = (1, 3, 6),
    decline_thresholds: tuple = (0.20, 0.30, 0.40, 0.50),
    min_notional: float = 1_000_000,
) -> list[dict]:
    """Detect systematic unwinding of open positions in the cohort.

    For each coin we have a time series of (ts, long_usd, short_usd) — the cohort's
    aggregate open notional on each side. We scan for windows where one side's open
    notional drops ≥ decline% from its in-window peak (e.g. 30% of open longs removed
    over 3h). That captures "whales systematically unwinding" regardless of how many
    individual EXIT events the snapshotter logged.

    If reductions_by_coin is provided (from position_changes), each event is enriched
    with n_whales (distinct addresses reducing that side in the window) and top1_share
    (largest single address's fraction of total reduced) — so we can tell a broad
    consensus exit apart from one whale cleaning up their book.

    Forward returns are measured LONG-perspective (raw price change), so the reader
    sees which direction price actually moved:
      - mean > 0  → price ROSE after the unwind (capitulation bounce → go LONG)
      - mean < 0  → price kept FALLING (continuation → go SHORT)

    Only one signal per (coin, side, window, threshold) within win_h hours (cooldown).
    """
    reductions_by_coin = reductions_by_coin or {}
    # Pre-extract sorted ts arrays per coin for fast window slicing.
    pc_ts_by_coin = {
        c: [p["ts"] for p in lst] for c, lst in reductions_by_coin.items()
    }

    out = []
    for coin, series in oi_series.items():
        if len(series) < 2:
            continue
        series = sorted(series, key=lambda s: s[0])
        pc_list = reductions_by_coin.get(coin, [])
        pc_ts = pc_ts_by_coin.get(coin, [])
        for side_name, idx in (("LONG", 1), ("SHORT", 2)):
            fired: dict[tuple, datetime] = {}
            for i, row in enumerate(series):
                ts = row[0]
                cur = row[idx]
                for win_h in windows_h:
                    win_start = ts - timedelta(hours=win_h)
                    peak = cur
                    j = i
                    while j >= 0 and series[j][0] >= win_start:
                        peak = max(peak, series[j][idx])
                        j -= 1
                    if peak < min_notional:
                        continue
                    decline = (peak - cur) / peak if peak > 0 else 0.0
                    for thr in decline_thresholds:
                        key = (side_name, win_h, thr)
                        last = fired.get(key)
                        if last and (ts - last).total_seconds() < win_h * 3600:
                            continue
                        if decline >= thr:
                            n_whales, top1_share = (0, None)
                            if pc_list:
                                n_whales, top1_share = _window_whale_stats(
                                    pc_list, pc_ts, win_start, ts, side_name
                                )
                            out.append({
                                "trigger": f"OI_{side_name}_UNWIND_{win_h}h≥{int(thr*100)}%",
                                "coin": coin,
                                "ts": ts,
                                "trade_side": "LONG",  # eval raw price move; sign shows direction
                                "size_usd": peak - cur,
                                "decline": round(decline, 3),
                                "peak_usd": peak,
                                "n_whales": n_whales,
                                "top1_share": top1_share,
                            })
                            fired[key] = ts
    return out


async def load_threshold_events(db, coins_filter: list[str] | None = None) -> tuple[
    list[dict],
    dict[str, list[tuple[datetime, float]]],
    dict[str, list[tuple[datetime, float, float]]],
]:
    """Synthesise events from coin_metrics threshold crossings.

    Returns (events, ls_series, oi_series):
      - ls_series[coin]: time-ordered L:S ratio — tags whale wakeups by L:S band.
      - oi_series[coin]: time-ordered (ts, long_usd, short_usd) open notional —
        used to detect systematic position unwinding.
    """
    out: list[dict] = []
    ls_series: dict[str, list[tuple[datetime, float]]] = {}
    oi_series: dict[str, list[tuple[datetime, float, float]]] = {}

    coins = await db.hl_signals_coin_metrics.distinct("coin")
    if coins_filter is not None:
        coins = [c for c in coins if c in coins_filter]
    logger.info("Loading threshold events for %d coins…", len(coins))
    for i, coin in enumerate(coins):
        if i and i % 10 == 0:
            logger.info("  …%d/%d coins (%d events so far)", i, len(coins), len(out))
        cursor = db.hl_signals_coin_metrics.find(
            {"coin": coin},
            {"_id": 0, "snapshot_ts": 1, "long_usd": 1, "short_usd": 1,
             "q1_long": 1, "q1_short": 1, "q4_long": 1, "q4_short": 1,
             "dollar_conviction": 1, "cohort_participation": 1, "avg_leverage": 1},
        ).sort("snapshot_ts", 1)
        rows = [doc async for doc in cursor]

        def ls(r):
            l, s = r.get("long_usd", 0), r.get("short_usd", 0)
            if s <= 0:
                return float("inf") if l > 0 else 1.0
            return l / s

        def count_ls(longc, shortc):
            if shortc <= 0:
                return float("inf") if longc > 0 else 1.0
            return longc / shortc

        ls_series[coin] = [(r["snapshot_ts"], ls(r)) for r in rows]
        oi_series[coin] = [
            (r["snapshot_ts"], r.get("long_usd", 0), r.get("short_usd", 0)) for r in rows
        ]

        prev_ls = None
        prev_q1_long = 0
        prev_q1_ls = None
        prev_q4_ls = None
        prev_dconv = 0
        prev_cohort = 0
        prev_lev = 0
        for i, r in enumerate(rows):
            cur_ls = ls(r)
            ts = r["snapshot_ts"]

            for thr in LS_THRESHOLDS:
                if prev_ls is not None:
                    if prev_ls < thr <= cur_ls:
                        out.append({"trigger": f"L:S≥{thr} (long)", "coin": coin,
                                    "ts": ts, "trade_side": "LONG", "size_usd": r["long_usd"]})
                        # Velocity tag at the key 10x level: how fast did it climb here?
                        if thr == 10:
                            cutoff = ts - timedelta(hours=4)
                            base_ls = cur_ls
                            for j in range(i, -1, -1):
                                if rows[j]["snapshot_ts"] < cutoff:
                                    break
                                base_ls = ls(rows[j])
                            speed = "fast" if base_ls > 0 and cur_ls >= 2 * base_ls else "slow"
                            out.append({"trigger": f"L:S≥10 {speed} (≤4h)", "coin": coin,
                                        "ts": ts, "trade_side": "LONG", "size_usd": r["long_usd"]})
                    inv = 1 / thr
                    if prev_ls > inv >= cur_ls:
                        out.append({"trigger": f"L:S≤1/{thr} (short)", "coin": coin,
                                    "ts": ts, "trade_side": "SHORT", "size_usd": r["short_usd"]})

            # Q1 vs Q4 crowding by trader COUNT — does smart-money crowding beat
            # dumb-money crowding? (only meaningful with ≥3 traders in that quartile)
            q1l_c, q1s_c = r.get("q1_long", 0), r.get("q1_short", 0)
            q4l_c, q4s_c = r.get("q4_long", 0), r.get("q4_short", 0)
            cur_q1_ls = count_ls(q1l_c, q1s_c)
            cur_q4_ls = count_ls(q4l_c, q4s_c)
            for thr in (2, 3, 5, 10):
                if prev_q1_ls is not None and (q1l_c + q1s_c) >= 3 and prev_q1_ls < thr <= cur_q1_ls:
                    out.append({"trigger": f"Q1 L:S≥{thr} (cnt)", "coin": coin, "ts": ts,
                                "trade_side": "LONG", "size_usd": r["long_usd"]})
                if prev_q4_ls is not None and (q4l_c + q4s_c) >= 3 and prev_q4_ls < thr <= cur_q4_ls:
                    out.append({"trigger": f"Q4 L:S≥{thr} (cnt)", "coin": coin, "ts": ts,
                                "trade_side": "LONG", "size_usd": r["long_usd"]})

            q1l = r.get("q1_long", 0)
            if prev_q1_long < 10 <= q1l:
                out.append({"trigger": "Q1_long≥10", "coin": coin, "ts": ts,
                            "trade_side": "LONG", "size_usd": r["long_usd"]})

            dconv = r.get("dollar_conviction", 0)
            if prev_dconv < 0.7 <= dconv:
                side = "LONG" if r.get("long_usd", 0) > r.get("short_usd", 0) else "SHORT"
                out.append({"trigger": "dollar_conv≥70%", "coin": coin, "ts": ts,
                            "trade_side": side, "size_usd": max(r["long_usd"], r["short_usd"])})

            cp = r.get("cohort_participation", 0)
            if prev_cohort < 0.3 <= cp:
                side = "LONG" if r.get("long_usd", 0) > r.get("short_usd", 0) else "SHORT"
                out.append({"trigger": "cohort_part≥30%", "coin": coin, "ts": ts,
                            "trade_side": side, "size_usd": max(r["long_usd"], r["short_usd"])})

            lev = r.get("avg_leverage", 0)
            if prev_lev < 10 <= lev:
                side = "LONG" if r.get("long_usd", 0) > r.get("short_usd", 0) else "SHORT"
                out.append({"trigger": "avg_lev≥10x", "coin": coin, "ts": ts,
                            "trade_side": side, "size_usd": max(r["long_usd"], r["short_usd"])})

            # Q1 vs Q4 divergence ≥ 40pp
            q1_total = q1l + r.get("q1_short", 0)
            q4_total = r.get("q4_long", 0) + r.get("q4_short", 0)
            if q1_total >= 3 and q4_total >= 3:
                q1_skew = (q1l - r.get("q1_short", 0)) / q1_total
                q4_skew = (r.get("q4_long", 0) - r.get("q4_short", 0)) / q4_total
                if abs(q1_skew - q4_skew) >= 0.4:
                    side = "LONG" if q1_skew > q4_skew else "SHORT"
                    out.append({"trigger": "Q1−Q4 divergence ≥40pp", "coin": coin, "ts": ts,
                                "trade_side": side, "size_usd": r["long_usd"] + r["short_usd"]})

            prev_ls, prev_q1_long, prev_dconv, prev_cohort, prev_lev = (
                cur_ls, q1l, dconv, cp, lev
            )
            prev_q1_ls, prev_q4_ls = cur_q1_ls, cur_q4_ls

    return out, ls_series, oi_series


# ─── composite events: whale + threshold together ────────────────────────────


def composite_events(
    whale: list[dict],
    thresh: list[dict],
    ls_series: dict[str, list[tuple[datetime, float]]],
) -> list[dict]:
    """Composite whale+L:S triggers.

    1. WAKEUP + L:S≥10 — original composite (kept for continuity).
    2. WAKEUP @ L:S {band} — every wakeup tagged by the L:S band at fire time,
       so we can see at which crowding level wakeups produce the best forward return.
    """
    out = []
    # index threshold events by coin
    by_coin = defaultdict(list)
    for t in thresh:
        by_coin[t["coin"]].append(t)
    for c in by_coin.values():
        c.sort(key=lambda x: x["ts"])

    for w in whale:
        if w["trigger"] != "WHALE_WAKEUP":
            continue

        # 1. original ≥10 composite (long-crowded cohort, L:S ≥ 10)
        relevant_long = [t for t in by_coin.get(w["coin"], [])
                    if "L:S≥" in t["trigger"]
                    and t["trade_side"] == w["trade_side"]
                    and timedelta(0) <= (w["ts"] - t["ts"]) <= timedelta(minutes=60)]
        if relevant_long:
            out.append({**w, "trigger": "WAKEUP + L:S≥10"})

        # 1b. symmetric composite (short-crowded cohort, S:L ≥ 10, i.e. L:S ≤ 1/10)
        relevant_short = [t for t in by_coin.get(w["coin"], [])
                    if "L:S≤1/" in t["trigger"]
                    and t["trade_side"] == w["trade_side"]
                    and timedelta(0) <= (w["ts"] - t["ts"]) <= timedelta(minutes=60)]
        if relevant_short:
            out.append({**w, "trigger": "WAKEUP + S:L≥10"})

        # 2. band-tagged wakeup
        cur_ls = ls_at(ls_series.get(w["coin"], []), w["ts"])
        if cur_ls is not None:
            out.append({**w, "trigger": f"WAKEUP @ L:S {ls_band_label(cur_ls)}"})

    return out


# ─── live-strategy mapping (mirrors src/jobs/alert_engine.py) ────────────────

# strategy -> hold hours, must match STRATEGY_HOLD in rules.py
STRATEGY_HOLD_H: dict[str, int] = {
    "WAKEUP_LS10_4H":          4,
    "WAKEUP_LS10":             24,
    "WHALE_FLIP":              4,
    "WAKEUP_LS_LOW_24H":       24,
    "WAKEUP_LS_LOW_SHORT_24H": 24,
    "WHALE_SCALEUP_4H":        4,
}


def strategy_events(
    whale: list[dict],
    oi_series: dict[str, list[tuple[datetime, float, float]]],
) -> list[dict]:
    """Re-derive exactly the alerts alert_engine.py would have fired.

    Mirrors Rule 1 (WAKEUP while the cohort is >=10:1 crowded on either side,
    same strategy names regardless of which side), Rule 2 (WHALE_FLIP), and
    the signal-only WAKEUP_LS_LOW_24H / WAKEUP_LS_LOW_SHORT_24H /
    WHALE_SCALEUP_4H trackers.
    """
    out = []
    for w in whale:
        if w["trigger"] == "WHALE_FLIP":
            out.append({**w, "trigger": "WHALE_FLIP"})
            continue
        if w["trigger"] == "WHALE_SCALEUP":
            out.append({**w, "trigger": "WHALE_SCALEUP_4H"})
            continue
        if w["trigger"] != "WHALE_WAKEUP":
            continue

        oi = oi_at(oi_series.get(w["coin"], []), w["ts"])
        if oi is None:
            continue
        long_usd, short_usd = oi

        ratio = None
        if short_usd > 0 and long_usd / short_usd >= 10:
            ratio = long_usd / short_usd
        elif long_usd > 0 and short_usd / long_usd >= 10:
            ratio = short_usd / long_usd
        if ratio is not None:
            out.append({**w, "trigger": "WAKEUP_LS10_4H"})
            out.append({**w, "trigger": "WAKEUP_LS10"})

        if short_usd > 0 and 1 <= long_usd / short_usd < 2:
            out.append({**w, "trigger": "WAKEUP_LS_LOW_24H"})

        if short_usd > 0 and 0.5 <= long_usd / short_usd < 1:
            out.append({**w, "trigger": "WAKEUP_LS_LOW_SHORT_24H"})

    return out


def render_by_strategy(strat_events: list[dict], prices: PriceIndex, horizons_h: list[int]) -> str:
    """Per-strategy summary at each strategy's actual hold horizon."""
    lines = ["", "## By live strategy (mirrors alert_engine.py rules)", ""]
    report = evaluate(strat_events, prices, horizons_h)
    header = ["Strategy", "Hold", "N (priced/total)", "Win%", "Net", "Avg Win", "Avg Loss"]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("|" + "|".join(["---"] * len(header)) + "|")
    for strat, hold_h in STRATEGY_HOLD_H.items():
        r = report.get(strat)
        if not r:
            lines.append(f"| {strat} | {hold_h}h | 0/0 | — | — | — | — |")
            continue
        if hold_h not in r["horizons"]:
            lines.append(f"| {strat} | {hold_h}h | {r['n_priced']}/{r['n_total']} | "
                          f"_hold horizon {hold_h}h not in --horizons_ |  |  |  |")
            continue
        h = r["horizons"][hold_h]
        cells = [strat, f"{hold_h}h", f"{r['n_priced']}/{r['n_total']}",
                 pct(h["win_rate"]), pcts(h["mean"]), pcts(h["avg_win"]), pcts(h["avg_loss"])]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


# ─── backtest driver ─────────────────────────────────────────────────────────


def evaluate(events: list[dict], prices: PriceIndex, horizons_h: list[int]) -> dict:
    """Group events by trigger and compute forward returns at each horizon."""
    grouped: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        grouped[e["trigger"]].append(e)

    report = {}
    for trigger, items in grouped.items():
        per_horizon: dict[int, list[float]] = {h: [] for h in horizons_h}
        skipped = 0
        for e in items:
            entry_px = prices.price_at(e["coin"], e["ts"])
            if entry_px is None or entry_px <= 0:
                skipped += 1
                continue
            for h in horizons_h:
                exit_px = prices.price_at(e["coin"], e["ts"] + timedelta(hours=h))
                if exit_px is None or exit_px <= 0:
                    continue
                raw = (exit_px - entry_px) / entry_px
                # Sign by trade direction: SHORT trade profits when price falls
                ret = raw if e["trade_side"] == "LONG" else -raw
                per_horizon[h].append(ret)
        def _stats(rs):
            wins = [r for r in rs if r > 0]
            losses = [r for r in rs if r <= 0]
            return {
                "n": len(rs),
                "win_rate": len(wins) / len(rs) if rs else None,
                "mean": mean(rs) if rs else None,
                "median": median(rs) if rs else None,
                "avg_win": mean(wins) if wins else None,
                "avg_loss": mean(losses) if losses else None,
            }

        report[trigger] = {
            "n_total": len(items),
            "n_priced": len(items) - skipped,
            "horizons": {h: _stats(rs) for h, rs in per_horizon.items()},
        }
    return report


def render_markdown(report: dict, horizons_h: list[int]) -> str:
    lines = ["# HL Signals Backtest Report", ""]
    lines.append(f"Generated: {datetime.utcnow().isoformat()}Z")
    lines.append("")
    header = ["Trigger", "N (priced/total)"] + \
             [f"{h}h: win% / net / avg-win / avg-loss" for h in horizons_h]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("|" + "|".join(["---"] * len(header)) + "|")

    def pct(v): return f"{v*100:.1f}%" if v is not None else "—"
    def pcts(v): return f"{v*100:+.2f}%" if v is not None else "—"

    rows = sorted(report.items(), key=lambda kv: -(kv[1]["horizons"].get(horizons_h[0], {}).get("mean") or -9))
    for trigger, r in rows:
        cells = [trigger, f"{r['n_priced']}/{r['n_total']}"]
        for h in horizons_h:
            h_data = r["horizons"][h]
            cells.append(
                f"{pct(h_data['win_rate'])} / {pcts(h_data['mean'])} / "
                f"{pcts(h_data['avg_win'])} / {pcts(h_data['avg_loss'])}"
            )
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def render_by_coin(
    events: list[dict], prices: PriceIndex, horizons_h: list[int],
    focus_triggers: list[str], focus_coins: list[str],
) -> str:
    """Per-coin breakdown: for each focus trigger, a table with one row per focus coin."""
    lines = ["", "## Per-coin breakdown", ""]

    def pct(v): return f"{v*100:.1f}%" if v is not None else "—"
    def pcts(v): return f"{v*100:+.2f}%" if v is not None else "—"

    for trigger in focus_triggers:
        sub = [e for e in events if e["trigger"] == trigger]
        if not sub:
            continue
        lines.append(f"### {trigger}")
        lines.append("")
        header = ["Coin", "N"] + [f"{h}h: win% / mean" for h in horizons_h]
        lines.append("| " + " | ".join(header) + " |")
        lines.append("|" + "|".join(["---"] * len(header)) + "|")
        for coin in focus_coins:
            coin_events = [e for e in sub if e["coin"] == coin]
            if not coin_events:
                continue
            rep = evaluate(coin_events, prices, horizons_h)[trigger]
            cells = [coin, str(rep["n_priced"])]
            for h in horizons_h:
                hd = rep["horizons"][h]
                cells.append(f"{pct(hd['win_rate'])} / {pcts(hd['mean'])}")
            lines.append("| " + " | ".join(cells) + " |")
        lines.append("")
    return "\n".join(lines)


DEFAULT_FOCUS_COINS = ["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE", "SUI", "LINK", "AAVE", "NEAR"]
DEFAULT_FOCUS_TRIGGERS = [
    "L:S≥2 (long)", "L:S≥3 (long)", "L:S≥5 (long)", "L:S≥10 (long)",
    "L:S≤1/2 (short)", "L:S≤1/3 (short)", "L:S≤1/5 (short)", "L:S≤1/10 (short)",
    "WAKEUP + L:S≥10", "WAKEUP + S:L≥10",
]


def render_actual_exit(result: dict) -> str:
    """Render the WAKEUP_ACTUAL_EXIT variable-hold analysis as a markdown section."""
    lines = ["", "## WAKEUP_ACTUAL_EXIT — variable hold (exit when whale closes)", ""]
    if result["n"] == 0:
        lines.append("No priced events found.")
        return "\n".join(lines)

    def pct(v): return f"{v*100:.1f}%" if v is not None else "—"
    def pcts(v): return f"{v*100:+.2f}%" if v is not None else "—"
    def hrs(v): return f"{v:.1f}h" if v is not None else "—"

    lines += [
        f"| Metric | Value |",
        "|---|---|",
        f"| N (priced / total) | {result['n']} / {result['n_total']} |",
        f"| Win rate | {pct(result['win_rate'])} |",
        f"| Mean return | {pcts(result['mean'])} |",
        f"| Median return | {pcts(result['median'])} |",
        f"| Avg hold | {hrs(result['avg_hold_h'])} |",
        f"| Median hold | {hrs(result['median_hold_h'])} |",
        "",
        "_Exit = when the triggering whale next closes or flips position on that coin._",
    ]
    return "\n".join(lines)


def render_oi_unwind(unwind_events: list[dict], prices: PriceIndex, horizons_h: list[int]) -> str:
    """Evaluate OI-unwind signals and render as markdown section."""
    lines = ["", "## Position Unwind Signals — cohort OI decline vs forward price", ""]
    if not unwind_events:
        lines.append("No unwind events generated.")
        return "\n".join(lines)

    report = evaluate(unwind_events, prices, horizons_h)
    # avg decline per trigger for context
    avg_decline: dict[str, float] = {}
    for e in unwind_events:
        avg_decline.setdefault(e["trigger"], [])
        avg_decline[e["trigger"]].append(e["decline"])
    avg_decline = {k: mean(v) for k, v in avg_decline.items()}

    def pct(v): return f"{v*100:.1f}%" if v is not None else "—"
    def pcts(v): return f"{v*100:+.2f}%" if v is not None else "—"

    # avg distinct-whale count per trigger for context
    avg_whales: dict[str, list[int]] = defaultdict(list)
    for e in unwind_events:
        avg_whales[e["trigger"]].append(e.get("n_whales", 0))
    avg_whales = {k: mean(v) for k, v in avg_whales.items()}
    has_whale_data = any(e.get("n_whales") for e in unwind_events)

    header = ["Signal (side / window / decline)", "N (priced/total)", "Avg drop", "Avg whales"] + \
             [f"{h}h: price-up% / mean" for h in horizons_h]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("|" + "|".join(["---"] * len(header)) + "|")

    rows = sorted(report.items(), key=lambda kv: kv[0])
    for trigger, r in rows:
        nw = avg_whales.get(trigger)
        cells = [trigger, f"{r['n_priced']}/{r['n_total']}", pct(avg_decline.get(trigger)),
                 f"{nw:.1f}" if nw is not None else "—"]
        for h in horizons_h:
            hd = r["horizons"][h]
            cells.append(f"{pct(hd['win_rate'])} / {pcts(hd['mean'])}")
        lines.append("| " + " | ".join(cells) + " |")

    lines += [
        "",
        "_Signal fires when a coin's cohort open notional on one side drops ≥X% from "
        "its in-window peak. Returns are LONG-perspective (raw price move):_",
        "_  • `price-up%` and `mean` > 0 → price ROSE after the unwind (capitulation bounce → LONG)._",
        "_  • mean < 0 → price kept FALLING (continuation → SHORT, i.e. follow the exit)._",
        "_`Avg whales` = distinct addresses from position_changes reducing that side in the window._",
        "_OI taken from coin_metrics long_usd/short_usd; min peak notional $1M._",
    ]

    # ── Concentration breakdown: does it matter how many whales were unwinding? ──
    if has_whale_data:
        lines += ["", "### Unwind by participant concentration", ""]
        lines += [
            "_Buckets ALL long-side unwind events by how many distinct whales were "
            "reducing. Tests whether a broad consensus exit (many whales) predicts "
            "price differently than one whale cleaning up._", "",
        ]
        long_unwinds = [e for e in unwind_events if "_LONG_" in e["trigger"]]
        buckets = [
            ("1 whale", lambda n: n == 1),
            ("2 whales", lambda n: n == 2),
            ("3-5 whales", lambda n: 3 <= n <= 5),
            ("6+ whales", lambda n: n >= 6),
            ("concentrated (top1 >70%)", None),  # special-cased below
            ("distributed (top1 ≤70%)", None),
        ]
        header2 = ["Bucket (long unwind)", "N (priced/total)"] + \
                  [f"{h}h: price-up% / mean" for h in horizons_h]
        lines.append("| " + " | ".join(header2) + " |")
        lines.append("|" + "|".join(["---"] * len(header2)) + "|")
        for label, pred in buckets:
            if label.startswith("concentrated"):
                sub = [e for e in long_unwinds if e.get("top1_share") is not None and e["top1_share"] > 0.7]
            elif label.startswith("distributed"):
                sub = [e for e in long_unwinds if e.get("top1_share") is not None and e["top1_share"] <= 0.7]
            else:
                sub = [e for e in long_unwinds if pred(e.get("n_whales", 0))]
            if not sub:
                continue
            tagged = [{**e, "trigger": label} for e in sub]
            rep = evaluate(tagged, prices, horizons_h)[label]
            cells = [label, f"{rep['n_priced']}/{rep['n_total']}"]
            for h in horizons_h:
                hd = rep["horizons"][h]
                cells.append(f"{pct(hd['win_rate'])} / {pcts(hd['mean'])}")
            lines.append("| " + " | ".join(cells) + " |")

    return "\n".join(lines)


async def main(horizons_h: list[int], out_path: str | None,
               by_coin: bool, focus_coins: list[str],
               actual_exit: bool, flow_windows: bool,
               top_coins: int | None = None,
               since: datetime | None = None, until: datetime | None = None) -> None:
    db = get_db()

    coins_filter: list[str] | None = None
    if top_coins:
        coins_filter = await top_coins_by_volume(db, top_coins)
        logger.info("Restricting to top %d coins by volume: %s", top_coins, ", ".join(coins_filter))
        if focus_coins == DEFAULT_FOCUS_COINS:
            focus_coins = coins_filter

    logger.info("Loading whale events…")
    whale_events = await load_whale_events(db, coins_filter)
    logger.info("Whale events: %d", len(whale_events))

    raw_events = None
    if actual_exit:
        logger.info("Loading raw whale events for cross-event analysis…")
        raw_events = await load_whale_events_raw(db)

    logger.info("Loading threshold events from coin_metrics…")
    thresh_events, ls_series, oi_series = await load_threshold_events(db, coins_filter)
    logger.info("Threshold events: %d", len(thresh_events))

    comp = composite_events(whale_events, thresh_events, ls_series)
    logger.info("Composite events: %d", len(comp))

    strat_events = strategy_events(whale_events, oi_series)
    logger.info("Live-strategy events: %d", len(strat_events))

    all_events = whale_events + thresh_events + comp

    if since or until:
        def _in_range(e):
            return (since is None or e["ts"] >= since) and (until is None or e["ts"] < until)

        before = len(all_events)
        all_events = [e for e in all_events if _in_range(e)]
        strat_events = [e for e in strat_events if _in_range(e)]
        logger.info("Date filter %s → %s: %d → %d events", since, until, before, len(all_events))

    if not all_events:
        logger.error("No events generated — nothing to backtest")
        return

    coins = sorted({e["coin"] for e in all_events})
    event_times = [e["ts"] for e in all_events if isinstance(e["ts"], datetime)]
    price_since = min(event_times) - timedelta(minutes=10) if event_times else None
    price_until = max(event_times) + timedelta(hours=max(horizons_h) + 1) if event_times else None
    logger.info("Price window: %s → %s across %d coins", price_since, price_until, len(coins))
    prices = PriceIndex()
    await prices.load(db, coins, since=price_since, until=price_until)

    report = evaluate(all_events, prices, horizons_h)
    md = render_markdown(report, horizons_h)
    md += render_by_strategy(strat_events, prices, horizons_h)

    if by_coin:
        md += "\n\n" + render_by_coin(
            all_events, prices, horizons_h, DEFAULT_FOCUS_TRIGGERS, focus_coins
        )

    if actual_exit and raw_events is not None:
        logger.info("Building actual-exit events…")
        ae_events = build_actual_exit_events(raw_events)
        logger.info("Actual-exit pairs: %d", len(ae_events))
        ae_result = evaluate_actual_exit(ae_events, prices)
        md += render_actual_exit(ae_result)

    if flow_windows:
        logger.info("Loading position reductions for whale-count enrichment…")
        reductions = await load_position_reductions(db)
        logger.info("Coins with position-reduction data: %d", len(reductions))
        logger.info("Building OI-unwind events…")
        unwind_evs = build_oi_unwind_events(oi_series, reductions)
        logger.info("Unwind events: %d", len(unwind_evs))
        md += render_oi_unwind(unwind_evs, prices, horizons_h)

    print("\n" + md)
    if out_path:
        with open(out_path, "w") as f:
            f.write(md)
        logger.info("Wrote report to %s", out_path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--horizons", default="1,4,24,72", help="Forward return horizons in hours, comma-separated")
    ap.add_argument("--out", default="backtest_report.md")
    ap.add_argument("--by-coin", action="store_true",
                    help="Append a per-coin breakdown for the L:S long ladder on focus coins")
    ap.add_argument("--coins", default=",".join(DEFAULT_FOCUS_COINS),
                    help="Comma-separated focus coins for --by-coin")
    ap.add_argument("--actual-exit", action="store_true",
                    help="Add WAKEUP_ACTUAL_EXIT section: exit when triggering whale closes")
    ap.add_argument("--flow-windows", action="store_true",
                    help="Add position-unwind signals: cohort OI drops ≥X%% in 1h/3h/6h")
    ap.add_argument("--top-coins", type=int, default=None,
                    help="Restrict to the top N coins by cohort open notional (speeds up runs)")
    ap.add_argument("--since", default=None, help="Only include events on/after this date (YYYY-MM-DD)")
    ap.add_argument("--until", default=None, help="Only include events before this date (YYYY-MM-DD)")
    args = ap.parse_args()
    horizons = [int(h) for h in args.horizons.split(",")]
    focus_coins = [c.strip().upper() for c in args.coins.split(",") if c.strip()]
    since = datetime.fromisoformat(args.since) if args.since else None
    until = datetime.fromisoformat(args.until) if args.until else None
    asyncio.run(main(horizons, args.out, args.by_coin, focus_coins,
                     args.actual_exit, args.flow_windows, args.top_coins, since, until))
