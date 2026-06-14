"""One-off reconciliation backfill for the no_fill_book_error unmanaged-position
bug (fixed in execution_bot.py, commit 25a6b3d).

Two kinds of drift between bot_positions and Hyperliquid ground truth:

1. UNMANAGED — bot_positions rows stuck in status=SKIPPED (skip_reason=
   no_fill_book_error) whose entry order actually filled and is still open on
   HL. Backfilled to status=OPEN using the real fill (px/size/time) from
   get_user_fills, matched by entry_order_id (oid). hold_until was already
   set correctly when the order was placed, so it's left as-is.

2. STALE — bot_positions rows stuck in status=OPEN whose position was already
   closed on HL (closed successfully but the close-fill check errored before
   recording it). Backfilled to status=CLOSED using the matching "Close *"
   fill (first fill for that coin after the entry fill), and bot_daily_summary
   is updated with the realized pnl via _update_daily_pnl.

Run once, review the printed actions, then restart the server.

Usage:
    python -m scripts.backfill_positions [--apply]
    (without --apply, only prints what WOULD change)
"""
import asyncio
import sys
from datetime import datetime, timezone

sys.path.insert(0, ".")
from src.db import get_db  # noqa: E402
from src.lib import hl_exchange as ex  # noqa: E402
from src.jobs.execution_bot import _mark_open, _update_daily_pnl  # noqa: E402

UNMANAGED_COINS = ["AAVE", "ATOM", "TON", "VVV", "kLUNC"]
STALE_COINS = ["BNB", "VIRTUAL"]


async def main(apply: bool) -> None:
    db = get_db()
    fills = await ex.get_user_fills(300)

    by_oid: dict[int, list[dict]] = {}
    for f in fills:
        try:
            by_oid.setdefault(int(f["oid"]), []).append(f)
        except (KeyError, ValueError, TypeError):
            pass

    print(f"Fetched {len(fills)} fills, {len(by_oid)} distinct oids\n")

    # ── 1. UNMANAGED: SKIPPED (no_fill_book_error) -> OPEN ──────────────────
    print("=== Unmanaged SKIPPED -> OPEN ===")
    cursor = db.bot_positions.find({
        "status": "SKIPPED",
        "coin": {"$in": UNMANAGED_COINS},
        "entry_order_id": {"$ne": None},
    })
    async for pos in cursor:
        coin = pos["coin"]
        oid = int(pos["entry_order_id"])
        matched = by_oid.get(oid, [])
        if not matched:
            print(f"  SKIP {coin} pos_id={pos['_id']} skip_reason={pos.get('skip_reason')}: "
                  f"no fills found for oid={oid}")
            continue

        fill_px = sum(float(f["px"]) * float(f["sz"]) for f in matched) / sum(float(f["sz"]) for f in matched)
        fill_sz = sum(float(f["sz"]) for f in matched)
        entry_ts = datetime.utcfromtimestamp(min(int(f["time"]) for f in matched) / 1000)

        print(f"  {coin} pos_id={pos['_id']} strategy={pos.get('strategy')} "
              f"oid={oid} -> entry_px={fill_px:.6g} size_coin={fill_sz} entry_ts={entry_ts} "
              f"hold_until={pos.get('hold_until')}")

        if apply:
            await _mark_open(db, pos["_id"], fill_px, fill_sz, entry_ts)
            print(f"    -> marked OPEN")

    # ── 2. STALE OPEN -> CLOSED (already closed on HL) ──────────────────────
    print("\n=== Stale OPEN -> CLOSED ===")
    cursor = db.bot_positions.find({"status": "OPEN", "coin": {"$in": STALE_COINS}})
    async for pos in cursor:
        coin = pos["coin"]
        entry_oid = int(pos["entry_order_id"])
        entry_fills = by_oid.get(entry_oid, [])
        if not entry_fills:
            print(f"  SKIP {coin} pos_id={pos['_id']}: no entry fills for oid={entry_oid}")
            continue
        entry_time = min(int(f["time"]) for f in entry_fills)

        candidates = sorted(
            (f for f in fills
             if f.get("coin") == coin
             and int(f["time"]) > entry_time
             and str(f.get("dir", "")).startswith("Close")),
            key=lambda f: int(f["time"]),
        )
        if not candidates:
            print(f"  SKIP {coin} pos_id={pos['_id']}: no Close fill found after entry "
                  f"({datetime.utcfromtimestamp(entry_time/1000)})")
            continue

        close = candidates[0]
        exit_px = float(close["px"])
        exit_ts = datetime.utcfromtimestamp(int(close["time"]) / 1000)
        pnl = round(float(close.get("closedPnl", 0)), 2)
        entry_px = pos.get("entry_px") or 0.0
        raw = (exit_px - entry_px) / entry_px if entry_px else 0.0
        ret = raw if pos["side"] == "LONG" else -raw

        print(f"  {coin} pos_id={pos['_id']} strategy={pos.get('strategy')} "
              f"entry_px={entry_px} -> exit_px={exit_px} exit_ts={exit_ts} "
              f"pnl={pnl} return_pct={round(ret*100, 3)}")

        if apply:
            now = datetime.now(timezone.utc)
            await db.bot_positions.update_one({"_id": pos["_id"]}, {"$set": {
                "status":      "CLOSED",
                "exit_px":     exit_px,
                "exit_ts":     exit_ts,
                "exit_reason": "reconciled_already_closed",
                "return_pct":  round(ret * 100, 3),
                "pnl_usdc":    pnl,
                "updated_at":  now,
            }})
            await _update_daily_pnl(db, exit_ts, pnl)
            print(f"    -> marked CLOSED, daily pnl updated")

    if not apply:
        print("\n(dry run — re-run with --apply to write these changes)")


if __name__ == "__main__":
    asyncio.run(main(apply="--apply" in sys.argv))
