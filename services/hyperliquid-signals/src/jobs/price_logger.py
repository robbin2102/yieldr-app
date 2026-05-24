import logging
from datetime import datetime

import aiohttp

from ..db import get_db
from ..lib.hyperliquid import fetch_all_mids

logger = logging.getLogger(__name__)


async def run_price_log() -> None:
    """Snapshot mid prices for every HL perp into hl_signals_prices.

    Runs every 5 minutes alongside the position snapshotter so each price row
    aligns with a coin_metrics row at the same timestamp.
    """
    db = get_db()
    now = datetime.utcnow()

    async with aiohttp.ClientSession() as session:
        mids = await fetch_all_mids(session)

    if not mids:
        logger.warning('"Price log skipped — no mids returned"')
        return

    docs = [{"coin": coin, "price": px, "ts": now} for coin, px in mids.items()]
    await db.hl_signals_prices.insert_many(docs, ordered=False)
    logger.info('"Price log complete", "coins": %d', len(docs))
