"""Dump all bot_positions records for a coin (any status/env) plus all HL
fills for that coin, for manual reconciliation.

Usage:
    python -m scripts.inspect_coin AAVE
"""
import asyncio
import sys

sys.path.insert(0, ".")
from src.db import get_db  # noqa: E402
from src.lib import hl_exchange as ex  # noqa: E402


async def main(coin: str) -> None:
    db = get_db()

    print(f"=== bot_positions for {coin} ===")
    cursor = db.bot_positions.find({"coin": coin}).sort("created_at", 1)
    async for doc in cursor:
        print({
            "_id": doc["_id"], "status": doc.get("status"), "skip_reason": doc.get("skip_reason"),
            "strategy": doc.get("strategy"), "side": doc.get("side"), "env": doc.get("env"),
            "entry_order_id": doc.get("entry_order_id"), "entry_limit_px": doc.get("entry_limit_px"),
            "entry_px": doc.get("entry_px"), "size_coin": doc.get("size_coin"),
            "size_usdc": doc.get("size_usdc"), "hold_until": doc.get("hold_until"),
            "created_at": doc.get("created_at"), "updated_at": doc.get("updated_at"),
        })

    print(f"\n=== HL fills for {coin} ===")
    fills = await ex.get_user_fills(300)
    for f in fills:
        if f.get("coin") == coin:
            print({
                "oid": f.get("oid"), "dir": f.get("dir"), "side": f.get("side"),
                "px": f.get("px"), "sz": f.get("sz"), "startPosition": f.get("startPosition"),
                "closedPnl": f.get("closedPnl"), "time": f.get("time"),
            })


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
