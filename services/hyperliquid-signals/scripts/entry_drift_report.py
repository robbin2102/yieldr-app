"""Report comparing signal-detection price vs the bot's actual execution price,
across all OPEN and CLOSED positions.

For each position this computes:
  - drift_bps:    (entry_px - signal_px) / signal_px, signed, in bps.
  - adverse_bps:  drift_bps reframed so positive always means the bot paid a
                   worse price than the signal saw (slippage cost), regardless
                   of side — i.e. drift_bps for LONG, -drift_bps for SHORT.
  - latency_s:    seconds between the signal firing (hl_signals_trade_alerts.fired_at,
                   falling back to bot_positions.created_at if the alert doc is
                   missing/unlinked) and the bot's actual fill (entry_ts).

Usage:
    python -m scripts.entry_drift_report [env] [--strategy NAME] [--csv path]
    env defaults to "testnet" if BOT_TESTNET=true else "mainnet".
"""
import asyncio
import statistics
import sys

from bson import ObjectId

sys.path.insert(0, ".")
from src.config import settings  # noqa: E402
from src.db import get_db  # noqa: E402


def _bps(entry_px: float, signal_px: float) -> float:
    return (entry_px - signal_px) / signal_px * 10_000


async def main(env: str, strategy: str | None, csv_path: str | None) -> None:
    db = get_db()

    query: dict = {
        "env": env,
        "status": {"$in": ["OPEN", "CLOSED"]},
        "entry_px": {"$gt": 0},
        "signal_px": {"$gt": 0},
    }
    if strategy:
        query["strategy"] = strategy

    docs = await db.bot_positions.find(query).sort("created_at", 1).to_list(None)
    if not docs:
        print(f"No positions with entry_px+signal_px for env={env}")
        return

    # alert_id on bot_positions is stored as str(_id), not an ObjectId — convert
    # back to look up the alert doc for its more precise fired_at timestamp.
    alert_oids = []
    for d in docs:
        try:
            alert_oids.append(ObjectId(d["alert_id"]))
        except Exception:
            pass
    alerts = {}
    if alert_oids:
        async for a in db.hl_signals_trade_alerts.find({"_id": {"$in": alert_oids}}):
            alerts[str(a["_id"])] = a

    rows = []
    for pos in docs:
        signal_px = pos["signal_px"]
        entry_px = pos["entry_px"]
        side = pos["side"]
        drift_bps = _bps(entry_px, signal_px)
        adverse_bps = drift_bps if side == "LONG" else -drift_bps

        alert = alerts.get(pos.get("alert_id"))
        fired_at = (alert or {}).get("fired_at") or pos.get("created_at")
        entry_ts = pos.get("entry_ts")
        latency_s = (entry_ts - fired_at).total_seconds() if fired_at and entry_ts else None

        rows.append({
            "id": pos["_id"], "strategy": pos["strategy"], "coin": pos["coin"],
            "side": side, "status": pos["status"], "signal_px": signal_px,
            "entry_px": entry_px, "drift_bps": drift_bps, "adverse_bps": adverse_bps,
            "latency_s": latency_s,
        })

    print(f"{'coin':<8} {'strategy':<20} {'side':<6} {'status':<7} "
          f"{'signal_px':>12} {'entry_px':>12} {'adverse_bps':>11} {'latency_s':>9}")
    for r in rows:
        lat = f"{r['latency_s']:.1f}" if r["latency_s"] is not None else "n/a"
        print(f"{r['coin']:<8} {r['strategy']:<20} {r['side']:<6} {r['status']:<7} "
              f"{r['signal_px']:>12.6g} {r['entry_px']:>12.6g} {r['adverse_bps']:>11.2f} {lat:>9}")

    adverse = [r["adverse_bps"] for r in rows]
    latencies = [r["latency_s"] for r in rows if r["latency_s"] is not None]

    print(f"\n{len(rows)} position(s), env={env}" + (f", strategy={strategy}" if strategy else ""))
    print(f"  adverse_bps  mean={statistics.mean(adverse):+.2f}  "
          f"median={statistics.median(adverse):+.2f}  "
          f"stdev={statistics.pstdev(adverse):.2f}  "
          f"min={min(adverse):+.2f}  max={max(adverse):+.2f}")
    if latencies:
        print(f"  latency_s    mean={statistics.mean(latencies):.1f}  "
              f"median={statistics.median(latencies):.1f}  "
              f"max={max(latencies):.1f}")

    by_strategy: dict[str, list[float]] = {}
    for r in rows:
        by_strategy.setdefault(r["strategy"], []).append(r["adverse_bps"])
    print("\nBy strategy (adverse_bps mean / count):")
    for strat, vals in sorted(by_strategy.items()):
        print(f"  {strat:<20} {statistics.mean(vals):+8.2f}  (n={len(vals)})")

    if csv_path:
        import csv
        with open(csv_path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["id", "coin", "strategy", "side", "status", "signal_px",
                        "entry_px", "drift_bps", "adverse_bps", "latency_s"])
            for r in rows:
                w.writerow([str(r["id"]), r["coin"], r["strategy"], r["side"], r["status"],
                            r["signal_px"], r["entry_px"], round(r["drift_bps"], 2),
                            round(r["adverse_bps"], 2),
                            round(r["latency_s"], 1) if r["latency_s"] is not None else ""])
        print(f"\nWrote CSV: {csv_path}")


if __name__ == "__main__":
    args = sys.argv[1:]
    csv_arg = None
    if "--csv" in args:
        i = args.index("--csv")
        csv_arg = args[i + 1]
        args = args[:i] + args[i + 2:]
    strat_arg = None
    if "--strategy" in args:
        i = args.index("--strategy")
        strat_arg = args[i + 1]
        args = args[:i] + args[i + 2:]
    env_args = [a for a in args if not a.startswith("--")]
    env = env_args[0] if env_args else ("testnet" if settings.bot_testnet else "mainnet")
    asyncio.run(main(env=env, strategy=strat_arg, csv_path=csv_arg))
