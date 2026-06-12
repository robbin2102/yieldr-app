"""Backfill the `env` field on bot_positions docs created before it existed.

All positions opened before the env field was introduced were created while
running on testnet, so they're stamped "testnet".

Usage:
    python -m scripts.backfill_bot_env
"""
import asyncio
import sys

sys.path.insert(0, ".")
from src.db import get_db, ensure_indexes  # noqa: E402


async def main() -> None:
    await ensure_indexes()
    db = get_db()
    result = await db.bot_positions.update_many(
        {"env": {"$exists": False}},
        {"$set": {"env": "testnet"}},
    )
    print(f"Updated {result.modified_count} bot_positions docs to env=testnet")


if __name__ == "__main__":
    asyncio.run(main())
