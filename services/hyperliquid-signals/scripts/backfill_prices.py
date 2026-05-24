"""Backfill 5m price candles for every coin that appears in coin_metrics.

Usage:
    python -m scripts.backfill_prices [--days 30]

Pulls 5m candles from Hyperliquid's public candleSnapshot endpoint and writes
them into hl_signals_prices so the backtest script can align prices with
coin_metrics + whale_events on the same 5m grid.

Idempotent: skips (coin, ts) pairs already present.
"""
import argparse
import asyncio
import logging
import sys
from datetime import datetime, timedelta, timezone

import aiohttp

sys.path.insert(0, ".")
from src.db import get_db, ensure_indexes  # noqa: E402
from src.lib.hyperliquid import fetch_candles  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


async def backfill_coin(
    session: aiohttp.ClientSession,
    db,
    coin: str,
    start_ms: int,
    end_ms: int,
    sem: asyncio.Semaphore,
    pause_s: float = 0.5,
) -> int:
    async with sem:
        candles = await fetch_candles(session, coin, "5m", start_ms, end_ms)
        # Polite pacing — HL allows ~10 req/s before rate-limiting hard.
        await asyncio.sleep(pause_s)
    if not candles:
        return 0

    docs = []
    for c in candles:
        ts = datetime.fromtimestamp(c["t"] / 1000, tz=timezone.utc).replace(tzinfo=None)
        try:
            close = float(c["c"])
        except (KeyError, TypeError, ValueError):
            continue
        docs.append({"coin": coin, "price": close, "ts": ts, "backfilled": True})

    if not docs:
        return 0

    # Upsert per (coin, ts): use bulk write
    from pymongo import UpdateOne
    ops = [
        UpdateOne(
            {"coin": d["coin"], "ts": d["ts"]},
            {"$setOnInsert": d},
            upsert=True,
        )
        for d in docs
    ]
    result = await db.hl_signals_prices.bulk_write(ops, ordered=False)
    inserted = result.upserted_count
    logger.info("%s: %d candles fetched, %d new rows", coin, len(docs), inserted)
    return inserted


async def main(days: int) -> None:
    await ensure_indexes()
    db = get_db()

    coins: list[str] = await db.hl_signals_coin_metrics.distinct("coin")
    if not coins:
        logger.error("No coins found in hl_signals_coin_metrics — run service first")
        return
    logger.info("Backfilling %d coins for %d days", len(coins), days)

    end_dt = datetime.now(timezone.utc).replace(tzinfo=None)
    start_dt = end_dt - timedelta(days=days)
    start_ms = int(start_dt.timestamp() * 1000)
    end_ms = int(end_dt.timestamp() * 1000)

    sem = asyncio.Semaphore(1)
    total = 0
    async with aiohttp.ClientSession() as session:
        results = await asyncio.gather(
            *[backfill_coin(session, db, c, start_ms, end_ms, sem) for c in coins],
            return_exceptions=True,
        )
    for r in results:
        if isinstance(r, int):
            total += r
        else:
            logger.warning("Coin backfill failed: %s", r)

    logger.info("Backfill complete — %d new price rows across %d coins", total, len(coins))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    args = ap.parse_args()
    asyncio.run(main(args.days))
