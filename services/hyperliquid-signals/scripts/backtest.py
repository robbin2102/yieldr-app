"""Backtest entry/exit triggers against actual price moves.

Reads coin_metrics + whale_events from Mongo, joins with hl_signals_prices
(populated by the live logger and the backfill_prices.py script), and reports
the forward-return distribution for each candidate trigger.

Usage:
    python -m scripts.backtest [--horizons 1,4,24,72] [--out report.md]
"""
import argparse
import asyncio
import logging
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from statistics import mean, median

sys.path.insert(0, ".")
from src.db import get_db  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


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


async def load_whale_events(db) -> list[dict]:
    """Each whale event becomes one candidate trade trigger."""
    cursor = db.hl_signals_whale_events.find({}, {"_id": 0}).sort("ts", 1)
    events = [doc async for doc in cursor]
    out = []
    for e in events:
        # Map event_type → side we'd take if we follow the cohort
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
        })
    return out


async def load_threshold_events(db) -> list[dict]:
    """Synthesise events from coin_metrics threshold crossings."""
    out: list[dict] = []

    coins = await db.hl_signals_coin_metrics.distinct("coin")
    for coin in coins:
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

        prev_ls = None
        prev_q1_long = 0
        prev_dconv = 0
        prev_cohort = 0
        prev_lev = 0
        for r in rows:
            cur_ls = ls(r)
            ts = r["snapshot_ts"]

            for thr in (5, 10, 20):
                if prev_ls is not None:
                    if prev_ls < thr <= cur_ls:
                        out.append({"trigger": f"L:S≥{thr} (long)", "coin": coin,
                                    "ts": ts, "trade_side": "LONG", "size_usd": r["long_usd"]})
                    inv = 1 / thr
                    if prev_ls > inv >= cur_ls:
                        out.append({"trigger": f"L:S≤1/{thr} (short)", "coin": coin,
                                    "ts": ts, "trade_side": "SHORT", "size_usd": r["short_usd"]})

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

    return out


# ─── composite events: whale + threshold together ────────────────────────────


def composite_events(whale: list[dict], thresh: list[dict]) -> list[dict]:
    """WAKEUP + (L:S≥10 active) — find whale events that happen while a threshold
    condition is true on the same coin within the past 1h."""
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
        # was L:S≥10 (or any high-conviction L:S) triggered in past 60 min on same side?
        relevant = [t for t in by_coin.get(w["coin"], [])
                    if "L:S≥" in t["trigger"]
                    and t["trade_side"] == w["trade_side"]
                    and timedelta(0) <= (w["ts"] - t["ts"]) <= timedelta(minutes=60)]
        if relevant:
            out.append({**w, "trigger": "WAKEUP + L:S≥10"})
    return out


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
        report[trigger] = {
            "n_total": len(items),
            "n_priced": len(items) - skipped,
            "horizons": {
                h: {
                    "n": len(rs),
                    "win_rate": sum(1 for r in rs if r > 0) / len(rs) if rs else None,
                    "mean": mean(rs) if rs else None,
                    "median": median(rs) if rs else None,
                }
                for h, rs in per_horizon.items()
            },
        }
    return report


def render_markdown(report: dict, horizons_h: list[int]) -> str:
    lines = ["# HL Signals Backtest Report", ""]
    lines.append(f"Generated: {datetime.utcnow().isoformat()}Z")
    lines.append("")
    header = ["Trigger", "N (priced/total)"] + [f"{h}h: win% / mean / median" for h in horizons_h]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("|" + "|".join(["---"] * len(header)) + "|")

    def pct(v): return f"{v*100:.1f}%" if v is not None else "—"
    def pcts(v): return f"{v*100:+.2f}%" if v is not None else "—"

    rows = sorted(report.items(), key=lambda kv: -(kv[1]["horizons"].get(horizons_h[0], {}).get("mean") or -9))
    for trigger, r in rows:
        cells = [trigger, f"{r['n_priced']}/{r['n_total']}"]
        for h in horizons_h:
            h_data = r["horizons"][h]
            cells.append(f"{pct(h_data['win_rate'])} / {pcts(h_data['mean'])} / {pcts(h_data['median'])}")
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


async def main(horizons_h: list[int], out_path: str | None) -> None:
    db = get_db()

    logger.info("Loading whale events…")
    whale_events = await load_whale_events(db)
    logger.info("Whale events: %d", len(whale_events))

    logger.info("Loading threshold events from coin_metrics…")
    thresh_events = await load_threshold_events(db)
    logger.info("Threshold events: %d", len(thresh_events))

    comp = composite_events(whale_events, thresh_events)
    logger.info("Composite events: %d", len(comp))

    all_events = whale_events + thresh_events + comp
    if not all_events:
        logger.error("No events generated — nothing to backtest")
        return

    coins = sorted({e["coin"] for e in all_events})
    # Bound price window to the actual event range + max horizon — avoids loading
    # months of price history when only a few weeks of events exist.
    event_times = [e["ts"] for e in all_events if isinstance(e["ts"], datetime)]
    price_since = min(event_times) - timedelta(minutes=10) if event_times else None
    price_until = max(event_times) + timedelta(hours=max(horizons_h) + 1) if event_times else None
    logger.info("Price window: %s → %s across %d coins", price_since, price_until, len(coins))
    prices = PriceIndex()
    await prices.load(db, coins, since=price_since, until=price_until)

    report = evaluate(all_events, prices, horizons_h)
    md = render_markdown(report, horizons_h)

    print("\n" + md)
    if out_path:
        with open(out_path, "w") as f:
            f.write(md)
        logger.info("Wrote report to %s", out_path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--horizons", default="1,4,24,72", help="Forward return horizons in hours, comma-separated")
    ap.add_argument("--out", default="backtest_report.md")
    args = ap.parse_args()
    horizons = [int(h) for h in args.horizons.split(",")]
    asyncio.run(main(horizons, args.out))
