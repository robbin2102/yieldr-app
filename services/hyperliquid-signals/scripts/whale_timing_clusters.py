"""Whale-entry timing clusters: optimal entry/exit windows for top-volume coins.

Two analyses, both restricted to the top N coins by volume (hl_signals_coin_metrics
.total_usd, latest snapshot):

  A. Forward-return profile per (coin, side) — for every Q1 whale directional
     event (WAKEUP / FLIP / SCALEUP), measures the price return at 1h/3h/6h/12h/24h
     after the event (signed so LONG profits when price rises, SHORT when it
     falls). The horizon with the highest mean return is reported as the
     "best exit" hold time for that coin/side.

  B. Cohort follow-through lag — for the same whale events, finds broader-cohort
     FLIP position changes (hl_signals_position_changes) on the same coin into
     the same side, and buckets how long after the whale event those follow-on
     flips happen (0-1h / 1-3h / 3-6h / 6-12h). A bucket with a high count means
     "the crowd typically reacts in this window" — i.e. the window where you'd
     want to already be positioned ahead of the crowd-driven move.

Usage (from services/hyperliquid-signals/):
    python -m scripts.whale_timing_clusters [--top-n 30] [--days 30] [--out report.md]
"""
import argparse
import asyncio
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from statistics import mean

sys.path.insert(0, ".")
from src.db import get_db  # noqa: E402
from scripts.backtest import PriceIndex  # noqa: E402

import logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

WHALE_EVENT_TYPES = ("WAKEUP", "FLIP", "SCALEUP")
HORIZONS_H = (1, 3, 6, 12, 24)
LAG_BUCKETS = ((0, 1, "0-1h"), (1, 3, "1-3h"), (3, 6, "3-6h"), (6, 12, "6-12h"))


async def top_coins_by_volume(db, top_n: int) -> list[str]:
    latest = await db.hl_signals_coin_metrics.find().sort("snapshot_ts", -1).limit(1).to_list(1)
    if not latest:
        return []
    ts = latest[0]["snapshot_ts"]
    cursor = db.hl_signals_coin_metrics.find(
        {"snapshot_ts": ts}, {"_id": 0, "coin": 1, "total_usd": 1}
    ).sort("total_usd", -1).limit(top_n)
    docs = await cursor.to_list(top_n)
    return [d["coin"] for d in docs]


async def load_directional_whale_events(db, coins: list[str], since: datetime) -> list[dict]:
    cursor = db.hl_signals_whale_events.find(
        {
            "coin": {"$in": coins},
            "event_type": {"$in": list(WHALE_EVENT_TYPES)},
            "side": {"$in": ["LONG", "SHORT"]},
            "ts": {"$gte": since},
        },
        {"_id": 0, "coin": 1, "side": 1, "ts": 1, "size_usd": 1, "event_type": 1},
    ).sort("ts", 1)
    return await cursor.to_list(None)


async def load_cohort_flips(db, coins: list[str], since: datetime) -> list[dict]:
    cursor = db.hl_signals_position_changes.find(
        {"coin": {"$in": coins}, "change_type": "FLIP", "ts": {"$gte": since}},
        {"_id": 0, "coin": 1, "ts": 1, "new_state": 1},
    ).sort("ts", 1)
    return await cursor.to_list(None)


# ─── Part A: forward-return profile ────────────────────────────────────────


def analyze_forward_returns(events: list[dict], prices: PriceIndex, horizons: tuple) -> list[dict]:
    grouped: dict[tuple, list[dict]] = defaultdict(list)
    for e in events:
        grouped[(e["coin"], e["side"])].append(e)

    rows = []
    for (coin, side), evs in grouped.items():
        per_h: dict[int, list[float]] = {h: [] for h in horizons}
        n_priced = 0
        for e in evs:
            entry_px = prices.price_at(coin, e["ts"])
            if entry_px is None or entry_px <= 0:
                continue
            n_priced += 1
            for h in horizons:
                exit_px = prices.price_at(coin, e["ts"] + timedelta(hours=h))
                if exit_px is None or exit_px <= 0:
                    continue
                raw = (exit_px - entry_px) / entry_px
                ret = raw if side == "LONG" else -raw
                per_h[h].append(ret)

        stats = {
            h: {
                "n": len(rs),
                "mean": mean(rs) if rs else None,
                "win_rate": (sum(1 for r in rs if r > 0) / len(rs)) if rs else None,
            }
            for h, rs in per_h.items()
        }
        valid = {h: s["mean"] for h, s in stats.items() if s["mean"] is not None}
        best_h = max(valid, key=valid.get) if valid else None

        rows.append({
            "coin": coin, "side": side,
            "n_events": len(evs), "n_priced": n_priced,
            "stats": stats, "best_exit_h": best_h,
        })
    return rows


# ─── Part B: cohort follow-through lag ─────────────────────────────────────


def analyze_cohort_follow(
    whale_events: list[dict], cohort_flips: list[dict], lag_buckets: tuple,
) -> dict[tuple, dict[str, int]]:
    by_coin: dict[str, list[tuple[datetime, str]]] = defaultdict(list)
    for f in cohort_flips:
        side = (f.get("new_state") or {}).get("side")
        if side in ("LONG", "SHORT"):
            by_coin[f["coin"]].append((f["ts"], side))
    for v in by_coin.values():
        v.sort(key=lambda x: x[0])

    counts: dict[tuple, dict[str, int]] = defaultdict(lambda: {b[2]: 0 for b in lag_buckets})
    for e in whale_events:
        coin, side, ts = e["coin"], e["side"], e["ts"]
        for f_ts, f_side in by_coin.get(coin, []):
            if f_side != side or f_ts <= ts:
                continue
            lag_h = (f_ts - ts).total_seconds() / 3600
            for lo, hi, label in lag_buckets:
                if lo < lag_h <= hi:
                    counts[(coin, side)][label] += 1
                    break
            if lag_h > lag_buckets[-1][1]:
                continue
    return counts


# ─── rendering ───────────────────────────────────────────────────────────────


def pct(v):
    return f"{v*100:+.2f}%" if v is not None else "—"


def pctw(v):
    return f"{v*100:.0f}%" if v is not None else "—"


def render(
    fwd_rows: list[dict], follow_counts: dict[tuple, dict[str, int]],
    horizons: tuple, lag_buckets: tuple, top_coins: list[str],
) -> str:
    lines = ["# Whale Entry Timing Clusters", ""]
    lines.append(f"Generated: {datetime.utcnow().isoformat()}Z")
    lines.append(f"Top coins by volume ({len(top_coins)}): {', '.join(top_coins)}")
    lines.append("")

    lines.append("## A. Forward-return profile (price move after a Q1 whale entry)")
    lines.append("")
    lines.append(
        "_For each coin+side, returns are signed so a LONG whale entry profits "
        "when price rises and a SHORT entry profits when price falls. "
        "`Best exit` = the horizon with the highest mean return — i.e. the "
        "suggested hold time after entering alongside the whale._"
    )
    lines.append("")
    header = ["Coin", "Side", "N (priced/total)"] + [f"{h}h: win% / mean" for h in horizons] + ["Best exit"]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("|" + "|".join(["---"] * len(header)) + "|")

    coin_order = {c: i for i, c in enumerate(top_coins)}
    fwd_rows_sorted = sorted(
        fwd_rows, key=lambda r: (coin_order.get(r["coin"], 999), r["side"])
    )
    for r in fwd_rows_sorted:
        cells = [r["coin"], r["side"], f"{r['n_priced']}/{r['n_events']}"]
        for h in horizons:
            s = r["stats"][h]
            cells.append(f"{pctw(s['win_rate'])} / {pct(s['mean'])}")
        best_h = r["best_exit_h"]
        if best_h is not None:
            cells.append(f"{best_h}h ({pct(r['stats'][best_h]['mean'])})")
        else:
            cells.append("—")
        lines.append("| " + " | ".join(cells) + " |")

    lines.append("")
    lines.append("## B. Cohort follow-through lag (when does the crowd react?)")
    lines.append("")
    lines.append(
        "_For each whale entry, counts how many broader-cohort traders FLIP into "
        "the same side within each lag window after the whale. A bucket with the "
        "highest count is when the crowd-driven move is most likely to be underway "
        "— enter before/at that window to front-run it._"
    )
    lines.append("")
    bucket_labels = [b[2] for b in lag_buckets]
    header = ["Coin", "Side", "Whale events"] + [f"Cohort flips {b}" for b in bucket_labels] + ["Peak window"]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("|" + "|".join(["---"] * len(header)) + "|")

    keys_sorted = sorted(
        follow_counts.keys(), key=lambda k: (coin_order.get(k[0], 999), k[1])
    )
    n_events_by_key: dict[tuple, int] = defaultdict(int)
    for r in fwd_rows:
        n_events_by_key[(r["coin"], r["side"])] = r["n_events"]

    for key in keys_sorted:
        coin, side = key
        bucket_counts = follow_counts[key]
        total = sum(bucket_counts.values())
        if total == 0:
            continue
        cells = [coin, side, str(n_events_by_key.get(key, 0))]
        for label in bucket_labels:
            cells.append(str(bucket_counts[label]))
        peak = max(bucket_counts, key=bucket_counts.get)
        cells.append(f"{peak} ({bucket_counts[peak]})")
        lines.append("| " + " | ".join(cells) + " |")

    return "\n".join(lines)


async def main(top_n: int, days: int, out_path: str | None) -> None:
    db = get_db()
    since = datetime.utcnow() - timedelta(days=days)

    logger.info("Finding top %d coins by volume...", top_n)
    top_coins = await top_coins_by_volume(db, top_n)
    if not top_coins:
        logger.error("No coin_metrics found — has the snapshotter run?")
        return
    logger.info("Top coins: %s", ", ".join(top_coins))

    logger.info("Loading whale events since %s...", since.isoformat())
    whale_events = await load_directional_whale_events(db, top_coins, since)
    logger.info("Whale events: %d", len(whale_events))
    if not whale_events:
        logger.error("No whale events in range — try a larger --days")
        return

    logger.info("Loading cohort FLIP position changes...")
    cohort_flips = await load_cohort_flips(db, top_coins, since)
    logger.info("Cohort flips: %d", len(cohort_flips))

    logger.info("Loading price history...")
    event_times = [e["ts"] for e in whale_events]
    price_since = min(event_times) - timedelta(minutes=10)
    price_until = max(event_times) + timedelta(hours=max(HORIZONS_H) + 1)
    prices = PriceIndex()
    await prices.load(db, top_coins, since=price_since, until=price_until)

    fwd_rows = analyze_forward_returns(whale_events, prices, HORIZONS_H)
    follow_counts = analyze_cohort_follow(whale_events, cohort_flips, LAG_BUCKETS)

    md = render(fwd_rows, follow_counts, HORIZONS_H, LAG_BUCKETS, top_coins)
    print("\n" + md)
    if out_path:
        with open(out_path, "w") as f:
            f.write(md)
        logger.info("Wrote report to %s", out_path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--top-n", type=int, default=30, help="Top N coins by volume")
    ap.add_argument("--days", type=int, default=30, help="Lookback window in days")
    ap.add_argument("--out", default="whale_timing_report.md")
    args = ap.parse_args()
    asyncio.run(main(args.top_n, args.days, args.out))
