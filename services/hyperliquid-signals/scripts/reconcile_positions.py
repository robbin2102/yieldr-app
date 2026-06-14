"""Reconcile bot_positions (status=OPEN) in our DB against Hyperliquid's
ground-truth clearinghouseState for the bot wallet.

Prints:
  - Positions open on HL but with no matching OPEN row in bot_positions
    (unmanaged — likely from the no_fill_book_error bug).
  - OPEN rows in bot_positions with no matching position on HL (likely
    already closed on HL but never marked CLOSED in our DB).
  - Positions present in both, with a side-by-side comparison.

Usage:
    python -m scripts.reconcile_positions [env]
    (env defaults to "testnet" if BOT_TESTNET=true else "mainnet")
"""
import asyncio
import sys

sys.path.insert(0, ".")
from src.config import settings  # noqa: E402
from src.db import get_db  # noqa: E402
from src.lib.hl_exchange import get_clearinghouse_state  # noqa: E402


async def main(env: str) -> None:
    addr = settings.hl_wallet_address
    if not addr:
        print("HL_WALLET_ADDRESS not set")
        return

    state = await get_clearinghouse_state(addr)
    if state is None:
        print("Failed to fetch clearinghouseState")
        return

    hl_positions = {}
    for ap in state.get("assetPositions", []):
        pos = ap.get("position", {})
        coin = pos.get("coin")
        szi = float(pos.get("szi", "0"))
        if abs(szi) < 1e-12:
            continue
        hl_positions[coin] = {
            "side": "LONG" if szi > 0 else "SHORT",
            "size": abs(szi),
            "entry_px": float(pos.get("entryPx", "0")),
            "unrealized_pnl": float(pos.get("unrealizedPnl", "0")),
            "leverage": pos.get("leverage", {}).get("value"),
        }

    db = get_db()
    cursor = db.bot_positions.find({"status": "OPEN", "env": env})
    db_positions = {}
    async for doc in cursor:
        db_positions[doc["coin"]] = doc

    all_coins = sorted(set(hl_positions) | set(db_positions))

    print(f"env={env}  wallet={addr}")
    print(f"HL open positions: {sorted(hl_positions)}")
    print(f"DB OPEN positions: {sorted(db_positions)}")
    print()

    for coin in all_coins:
        hl = hl_positions.get(coin)
        dbp = db_positions.get(coin)
        if hl and dbp:
            print(f"{coin}: OK — open on both. HL side={hl['side']} size={hl['size']} "
                  f"entry={hl['entry_px']} | DB side={dbp['side']} size={dbp.get('size_coin')} "
                  f"entry={dbp.get('entry_px')} strategy={dbp.get('strategy')}")
        elif hl and not dbp:
            print(f"{coin}: ** UNMANAGED ** open on HL, no OPEN row in DB. "
                  f"HL side={hl['side']} size={hl['size']} entry={hl['entry_px']} "
                  f"uPnl={hl['unrealized_pnl']} leverage={hl['leverage']}")
        else:
            print(f"{coin}: ** STALE DB ** OPEN in DB but not open on HL (likely already closed). "
                  f"DB side={dbp['side']} size={dbp.get('size_coin')} entry={dbp.get('entry_px')} "
                  f"strategy={dbp.get('strategy')} hold_until={dbp.get('hold_until')} "
                  f"pos_id={dbp['_id']}")


if __name__ == "__main__":
    env = sys.argv[1] if len(sys.argv) > 1 else ("testnet" if settings.bot_testnet else "mainnet")
    asyncio.run(main(env))
