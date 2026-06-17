"""Backfill bot_positions.leverage to reflect HL's actually-applied leverage,
not the bot's configured default.

Caused by the unverified set_leverage() bug (fixed alongside this script):
_run_entry called set_leverage(coin, settings.bot_leverage) and stored that
requested value unconditionally, but HL silently applies less than requested
when the coin's exchange max leverage is lower (and doesn't raise an error
for it). The stale stored value then corrupted the dashboard's Lev column,
its leveraged %-return calc, and _preflight's capital-cap margin math
(size_usdc / leverage) for any OPEN position on such a coin.

For each OPEN position, reads HL's clearinghouseState for the real
position.leverage.value and, if it differs from the stored leverage,
corrects it.

Usage:
    python -m scripts.backfill_leverage [env] [--apply]
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

    docs = await db.bot_positions.find({"env": env, "status": "OPEN"}).to_list(None)
    if not docs:
        print(f"No OPEN positions for env={env}")
        return

    state = await get_clearinghouse_state(addr)
    real_leverage: dict[str, int] = {}
    if state:
        for ap in state.get("assetPositions", []):
            pos = ap.get("position", {})
            coin = pos.get("coin")
            lev = (pos.get("leverage") or {}).get("value")
            if coin and lev:
                real_leverage[coin] = int(lev)

    print(f"HL leverage by coin: {real_leverage}\n")

    now = datetime.now(timezone.utc)
    changed = 0
    for pos in docs:
        coin = pos["coin"]
        actual = real_leverage.get(coin)
        stored = pos.get("leverage")
        if actual is None or actual == stored:
            continue
        changed += 1
        print(f"  {coin}/{pos['strategy']} (_id={pos['_id']}): leverage {stored} -> {actual}")
        if apply:
            await db.bot_positions.update_one(
                {"_id": pos["_id"]},
                {"$set": {"leverage": actual, "updated_at": now}},
            )

    if changed == 0:
        print("Nothing to fix — all stored leverage values already match HL.")
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
