"""One-off backfill for the orphaned AAVE leg (entry ~67.036, size 0.16 SHORT)
that was never written to ANY bot_positions document.

Root cause (fixed alongside this script in execution_bot.py): the entry
order-retry loop only ever stored the LATEST attempt's oid in
entry_order_id, overwriting earlier attempts. If an earlier attempt's order
filled "late" — after _get_fill reported "not filled" and we issued a (no-op)
cancel — that fill's oid was lost entirely. backfill_positions.py matches by
entry_order_id, so it could only recover the leg whose oid happened to be the
one left in the doc; this leg's oid was never recorded anywhere.

Fill-based recovery (matching by oid against userFills, even at the 2000-fill
API max) couldn't find this fill — WHALE_SCALEUP_4H's signal volume has
scrolled it out of the available window. Instead, this script reads the
position directly from HL's ground-truth clearinghouseState (entry_px, size,
side, leverage, unrealized_pnl) and inserts a matching OPEN row, copying
strategy/size_usdc/env from the sibling AAVE position that *was* tracked.
Since the true entry time is unknown, hold_until is set to "now" so the bot's
normal timer-exit picks this leg up and closes it on the next tick.

Usage:
    python -m scripts.backfill_aave_orphan [--apply]
    (without --apply, only prints what WOULD be inserted)
"""
import asyncio
import sys
from datetime import datetime, timezone

sys.path.insert(0, ".")
from src.config import settings  # noqa: E402
from src.db import get_db  # noqa: E402
from src.lib.hl_exchange import get_clearinghouse_state  # noqa: E402

COIN = "AAVE"


async def main(apply: bool) -> None:
    db = get_db()
    addr = settings.hl_wallet_address
    if not addr:
        print("HL_WALLET_ADDRESS not set")
        return

    state = await get_clearinghouse_state(addr)
    if state is None:
        print("Failed to fetch clearinghouseState")
        return

    hl_pos = None
    for ap in state.get("assetPositions", []):
        pos = ap.get("position", {})
        if pos.get("coin") != COIN:
            continue
        szi = float(pos.get("szi", "0"))
        if abs(szi) < 1e-12:
            continue
        hl_pos = {
            "side": "LONG" if szi > 0 else "SHORT",
            "size": abs(szi),
            "entry_px": float(pos.get("entryPx", "0")),
            "leverage": pos.get("leverage", {}).get("value"),
        }

    if hl_pos is None:
        print(f"No open {COIN} position on HL — nothing to backfill.")
        return

    env = "testnet" if settings.bot_testnet else "mainnet"
    existing = await db.bot_positions.find_one({"coin": COIN, "status": "OPEN", "env": env})
    if existing:
        print(f"{COIN} already has an OPEN row in DB (_id={existing['_id']}) — nothing to backfill.")
        return

    sibling = None
    async for pos in db.bot_positions.find({"coin": COIN}):
        if pos.get("status") in ("OPEN", "CLOSED"):
            sibling = pos
            break

    if sibling:
        print(f"Sibling AAVE doc: _id={sibling['_id']} status={sibling['status']} "
              f"strategy={sibling.get('strategy')} entry_px={sibling.get('entry_px')}")

    strategy = sibling.get("strategy") if sibling else "WHALE_SCALEUP_4H"
    leverage = hl_pos["leverage"] or (sibling.get("leverage") if sibling else 10)
    size_usdc = sibling.get("size_usdc") if sibling else round(hl_pos["entry_px"] * hl_pos["size"], 2)

    now = datetime.now(timezone.utc)
    doc = {
        "strategy": strategy, "coin": COIN, "side": hl_pos["side"],
        "status": "OPEN", "signal_px": hl_pos["entry_px"], "alert_id": None,
        "size_usdc": size_usdc, "size_coin": hl_pos["size"],
        "leverage": leverage, "env": env,
        "entry_order_id": None, "entry_order_ids": [],
        "entry_px": hl_pos["entry_px"], "entry_ts": now,
        "hold_until": now, "exit_order_id": None, "exit_px": None,
        "exit_ts": None, "exit_reason": None, "return_pct": None,
        "pnl_usdc": None, "fees_usdc": None,
        "skip_reason": "backfilled_orphan_leg",
        "agent_call_id": None, "created_at": now, "updated_at": now,
    }

    print(f"\nHL {COIN} position: side={hl_pos['side']} size={hl_pos['size']} "
          f"entry_px={hl_pos['entry_px']} leverage={hl_pos['leverage']}")
    print(f"  -> insert OPEN strategy={strategy} size_usdc={size_usdc} env={env} "
          f"hold_until=now (picked up by bot_close_expired on next tick)")

    if apply:
        await db.bot_positions.insert_one(doc)
        print("  -> inserted OPEN")
    else:
        print("\n(dry run — re-run with --apply to write these changes)")


if __name__ == "__main__":
    asyncio.run(main(apply="--apply" in sys.argv))
