import logging
from datetime import datetime

import aiohttp

from ..db import get_db
from ..lib.hyperliquid import fetch_all_mids

logger = logging.getLogger(__name__)


async def run_price_log() -> None:
    """Snapshot mid prices for cohort-active coins into hl_signals_prices.

    Only stores coins currently tracked in coin_metrics (i.e. coins where
    cohort traders have open positions) — no need to log all 400+ HL perps.
    """
    db = get_db()
    now = datetime.utcnow()

    active_coins: set[str] = set(await db.hl_signals_coin_metrics.distinct("coin"))
    if not active_coins:
        logger.warning('"Price log skipped — no active coins in coin_metrics"')
        return

    async with aiohttp.ClientSession() as session:
        mids = await fetch_all_mids(session)

    if not mids:
        logger.warning('"Price log skipped — no mids returned"')
        return

    docs = [
        {"coin": coin, "price": px, "ts": now}
        for coin, px in mids.items()
        if coin in active_coins
    ]
    await db.hl_signals_prices.insert_many(docs, ordered=False)
    logger.debug('"Price log complete", "coins": %d', len(docs))
