"""Backfill size_usdc to reflect actual filled notional (entry_px * size_coin)
instead of the stale intended-notional value frozen at order placement.

Caused by the entry retry-loop overfill bug (fixed alongside this script):
_mark_open never updated size_usdc after a fill, so any position that filled
for more or less than the intended margin*leverage notional carries a wrong
size_usdc forever. This affects three things per position:
  - OPEN:   position-size display + capital-cap accounting are wrong.
  - CLOSED: pnl_usdc (computed as ret * size_usdc in _close_position) is
            wrong, which also means the cached bot_daily_summary.pnl_usdc
            for that position's exit date is off by the same delta.

For each position with entry_px and size_coin set:
  - OPEN:   recompute size_usdc = entry_px * size_coin.
  - CLOSED: recompute size_usdc, recompute pnl_usdc from the corrected
            size_usdc, and apply the (new_pnl - old_pnl) delta to
            bot_daily_summary for that position's exit date.

Usage:
    python -m scripts.backfill_size_usdc [env] [--apply]
    env defaults to "testnet" if BOT_TESTNET=true else "mainnet".
    Without --apply, only prints what WOULD change.
"""
import asyncio
import sys
from datetime import datetime, timezone

sys.path.insert(0, ".")
from src.config import settings  # noqa: E402
from src.db import get_db  # noqa: E402


async def main(env: str, apply: bool) -> None:
    db = get_db()
    now = datetime.now(timezone.utc)

    docs = await db.bot_positions.find({
        "env": env,
        "status": {"$in": ["OPEN", "CLOSED"]},
        "entry_px": {"$gt": 0},
        "size_coin": {"$gt": 0},
    }).to_list(None)

    if not docs:
        print(f"No OPEN/CLOSED positions with entry_px+size_coin for env={env}")
        return

    print(f"Checking {len(docs)} position(s) for env={env}\n")
    changed = 0

    for pos in docs:
        entry_px = pos["entry_px"]
        size_coin = pos["size_coin"]
        old_size_usdc = pos.get("size_usdc") or 0.0
        new_size_usdc = round(entry_px * size_coin, 2)

        if abs(new_size_usdc - old_size_usdc) < 0.01:
            continue  # already correct, nothing to do

        coin = pos["coin"]
        strategy = pos["strategy"]
        status = pos["status"]
        changed += 1

        if status == "OPEN":
            print(f"  OPEN {coin}/{strategy} (_id={pos['_id']}): "
                  f"size_usdc {old_size_usdc:.2f} -> {new_size_usdc:.2f}")
            if apply:
                await db.bot_positions.update_one(
                    {"_id": pos["_id"]},
                    {"$set": {"size_usdc": new_size_usdc, "updated_at": now}},
                )
            continue

        # CLOSED — recompute pnl_usdc from the corrected size_usdc too.
        exit_px = pos.get("exit_px") or entry_px
        raw = (exit_px - entry_px) / entry_px
        ret = raw if pos["side"] == "LONG" else -raw
        old_pnl = pos.get("pnl_usdc") or 0.0
        new_pnl = round(ret * new_size_usdc, 2)
        delta = round(new_pnl - old_pnl, 2)

        print(f"  CLOSED {coin}/{strategy} (_id={pos['_id']}): "
              f"size_usdc {old_size_usdc:.2f} -> {new_size_usdc:.2f}, "
              f"pnl_usdc {old_pnl:.2f} -> {new_pnl:.2f} (delta {delta:+.2f})")

        if apply:
            await db.bot_positions.update_one(
                {"_id": pos["_id"]},
                {"$set": {"size_usdc": new_size_usdc, "pnl_usdc": new_pnl, "updated_at": now}},
            )
            exit_ts = pos.get("exit_ts") or now
            date = exit_ts.strftime("%Y-%m-%d")
            daily = await db.bot_daily_summary.find_one({"date": date})
            if daily and abs(delta) >= 0.01:
                new_daily_pnl = round((daily.get("pnl_usdc") or 0.0) + delta, 2)
                await db.bot_daily_summary.update_one(
                    {"date": date}, {"$set": {"pnl_usdc": new_daily_pnl}},
                )
                print(f"    -> bot_daily_summary[{date}].pnl_usdc adjusted by {delta:+.2f} "
                      f"(now {new_daily_pnl:.2f})")

    if changed == 0:
        print("Nothing to fix — all size_usdc values already correct.")
    elif not apply:
        print(f"\n{changed} position(s) would change — re-run with --apply to write them.")
    else:
        print(f"\n{changed} position(s) updated.")


if __name__ == "__main__":
    args = sys.argv[1:]
    apply_flag = "--apply" in args
    env_args = [a for a in args if not a.startswith("--")]
    env = env_args[0] if env_args else ("testnet" if settings.bot_testnet else "mainnet")
    asyncio.run(main(env=env, apply=apply_flag))
