"""One-off fix for the orphaned INJ leg (entry ~5.2360, size 2.1 SHORT) that
was never written to bot_positions.

Same root cause as the AAVE orphan (see backfill_aave_orphan.py): the entry
order-retry loop placed two ALO orders ~20s apart (5.2352 and 5.2360), BOTH
filled, but only the first fill's oid/record (size_coin=2.1, entry_px=5.2352)
was persisted to bot_positions doc 6a2f9975e16adc1cb7593284. HL's
clearinghouseState shows the TRUE combined position: 4.2 INJ SHORT @
entry_px=5.2356 (volume-weighted average of the two 2.1 fills).

Unlike the AAVE case, an OPEN doc already exists here — so instead of
inserting a second row, this script MERGES the untracked leg into the
existing doc (size_coin -> 4.2, entry_px -> HL's weighted entry_px, size_usdc
scaled to match). This keeps the existing entry_order_id/hold_until intact so
the normal timer-based close in bot_close_expired closes the FULL 4.2 INJ
position on HL, instead of leaving ~2.1 INJ unmanaged.

Usage:
    python -m scripts.fix_inj_orphan [--apply]
    (without --apply, only prints what WOULD change)
"""
import asyncio
import sys
from datetime import datetime, timezone

sys.path.insert(0, ".")
from src.config import settings  # noqa: E402
from src.db import get_db  # noqa: E402
from src.lib.hl_exchange import get_clearinghouse_state  # noqa: E402

COIN = "INJ"


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
        print(f"No open {COIN} position on HL — nothing to fix.")
        return

    env = "testnet" if settings.bot_testnet else "mainnet"
    existing = await db.bot_positions.find_one({"coin": COIN, "status": "OPEN", "env": env})
    if existing is None:
        print(f"No OPEN {COIN} row in DB — this is the AAVE-style case, use backfill_aave_orphan.py instead.")
        return

    print(f"HL {COIN} position:  side={hl_pos['side']}  size={hl_pos['size']}  "
          f"entry_px={hl_pos['entry_px']}  leverage={hl_pos['leverage']}")
    print(f"DB {COIN} doc _id={existing['_id']}:  side={existing['side']}  "
          f"size_coin={existing['size_coin']}  entry_px={existing['entry_px']}  "
          f"size_usdc={existing['size_usdc']}")

    if existing["side"] != hl_pos["side"]:
        print(f"  -> side mismatch (DB={existing['side']} vs HL={hl_pos['side']}) — "
              f"refusing to auto-merge, needs manual review.")
        return

    if abs(hl_pos["size"] - existing["size_coin"]) < 1e-9:
        print("  -> sizes already match — nothing to fix.")
        return

    old_size = existing["size_coin"]
    new_size = hl_pos["size"]
    new_entry_px = hl_pos["entry_px"]
    new_size_usdc = round(new_size * new_entry_px, 2)

    now = datetime.now(timezone.utc)
    update = {
        "size_coin": new_size,
        "entry_px": new_entry_px,
        "size_usdc": new_size_usdc,
        "updated_at": now,
    }

    print(f"\n  -> merge untracked leg: size_coin {old_size} -> {new_size}, "
          f"entry_px {existing['entry_px']} -> {new_entry_px}, "
          f"size_usdc {existing['size_usdc']} -> {new_size_usdc}")
    print(f"  (entry_order_id, hold_until, strategy left unchanged — "
          f"existing timer-exit will now close the full {new_size} {COIN})")

    if apply:
        await db.bot_positions.update_one({"_id": existing["_id"]}, {"$set": update})
        print("  -> updated")
    else:
        print("\n(dry run — re-run with --apply to write these changes)")


if __name__ == "__main__":
    asyncio.run(main(apply="--apply" in sys.argv))
