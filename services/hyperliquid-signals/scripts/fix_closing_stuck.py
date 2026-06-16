"""Fix positions stuck in CLOSING status (process crash during close attempt).

Fetches HL clearinghouseState and for each CLOSING doc:
  - If coin still open on HL → reset to OPEN so bot_close_expired retries it.
  - If coin not on HL → mark CLOSED (closed_externally_or_crash) with entry_px as exit_px.

Usage:
    python -m scripts.fix_closing_stuck [env] [--apply]
    env defaults to "testnet" if BOT_TESTNET=true else "mainnet".
    Without --apply, only prints what WOULD change.
"""
import asyncio
import sys
from datetime import datetime, timezone

sys.path.insert(0, ".")
from src.config import settings  # noqa: E402
from src.db import get_db  # noqa: E402
from src.lib.hl_exchange import get_clearinghouse_state  # noqa: E402


async def main(env: str, apply: bool) -> None:
    db = get_db()
    addr = settings.hl_wallet_address
    if not addr:
        print("HL_WALLET_ADDRESS not set")
        return

    closing = await db.bot_positions.find({"status": "CLOSING", "env": env}).to_list(None)
    if not closing:
        print(f"No CLOSING positions for env={env}")
        return

    print(f"Found {len(closing)} CLOSING position(s) for env={env}")

    state = await get_clearinghouse_state(addr)
    hl_coins: set[str] = set()
    if state:
        for ap in state.get("assetPositions", []):
            pos = ap.get("position", {})
            szi = float(pos.get("szi", "0"))
            if abs(szi) > 1e-12:
                hl_coins.add(pos.get("coin"))

    print(f"HL open positions: {sorted(hl_coins) or 'none'}\n")

    now = datetime.now(timezone.utc)
    for pos in closing:
        coin = pos["coin"]
        if coin in hl_coins:
            print(f"  {coin} (_id={pos['_id']}): still OPEN on HL → reset to OPEN (bot will close it)")
            if apply:
                await db.bot_positions.update_one(
                    {"_id": pos["_id"]},
                    {"$set": {"status": "OPEN", "updated_at": now}},
                )
                print(f"    -> updated to OPEN")
        else:
            entry_px = pos.get("entry_px") or 0.0
            print(f"  {coin} (_id={pos['_id']}): NOT on HL "
                  f"(side={pos['side']} size={pos.get('size_coin')} entry_px={entry_px}) "
                  f"→ mark CLOSED (closed_externally_or_crash)")
            if apply:
                await db.bot_positions.update_one(
                    {"_id": pos["_id"]},
                    {"$set": {
                        "status": "CLOSED",
                        "exit_reason": "closed_externally_or_crash",
                        "exit_px": entry_px,
                        "return_pct": 0.0,
                        "pnl_usdc": 0.0,
                        "exit_ts": now,
                        "updated_at": now,
                    }},
                )
                print(f"    -> marked CLOSED")

    if not apply:
        print("\n(dry run — re-run with --apply to write these changes)")


if __name__ == "__main__":
    args = sys.argv[1:]
    apply_flag = "--apply" in args
    env_args = [a for a in args if not a.startswith("--")]
    env = env_args[0] if env_args else ("testnet" if settings.bot_testnet else "mainnet")
    asyncio.run(main(env=env, apply=apply_flag))
