import logging
from datetime import datetime, timezone

import aiohttp

from ..db import get_db
from ..config import settings
from ..lib.hyperliquid import fetch_leaderboard
from ..lib.filters import apply_filters, load_config_overrides
from ..lib.skills import compute_skill_scores

logger = logging.getLogger(__name__)


async def run_discovery() -> None:
    logger.info('"Starting trader discovery"')
    db = get_db()
    now = datetime.now(timezone.utc)

    # Load live config overrides from DB
    db_config = await db.hl_signals_config.find_one({"_id": "main"})
    cfg = load_config_overrides(db_config, settings)

    async with aiohttp.ClientSession() as session:
        rows = await fetch_leaderboard(session)

    logger.info('"Leaderboard fetched", "total_rows": %d', len(rows))

    passing = apply_filters(rows, cfg)
    passing_addresses = {t["address"] for t in passing}

    logger.info('"Filter applied", "passing": %d', len(passing))

    # Compute skill scores and quartiles across entire filtered cohort
    compute_skill_scores(passing)
    logger.info('"Skill scores computed"')

    # Fetch current active cohort from DB
    existing_cursor = db.hl_signals_traders.find({"cohort_status": "active"}, {"address": 1})
    existing_addresses = {doc["address"] async for doc in existing_cursor}

    new_entrants = passing_addresses - existing_addresses
    dropped = existing_addresses - passing_addresses

    # Upsert each passing trader
    for trader in passing:
        addr = trader["address"]
        update = {
            "$set": {
                **trader,
                "cohort_status": "active",
                "last_seen": now,
            },
            "$setOnInsert": {"in_cohort_since": now},
        }
        await db.hl_signals_traders.update_one({"address": addr}, update, upsert=True)

    # Mark dropped traders
    if dropped:
        await db.hl_signals_traders.update_many(
            {"address": {"$in": list(dropped)}},
            {"$set": {"cohort_status": "dropped", "last_seen": now}},
        )

    # Log cohort changes
    changes = []
    for addr in new_entrants:
        trader_data = next((t for t in passing if t["address"] == addr), {})
        changes.append(
            {
                "address": addr,
                "display_name": trader_data.get("display_name"),
                "change_type": "NEW_ENTRANT",
                "ts": now,
                "snapshot": trader_data,
            }
        )
    for addr in dropped:
        changes.append({"address": addr, "change_type": "DROPPED", "ts": now, "snapshot": {}})

    if changes:
        await db.hl_signals_cohort_changes.insert_many(changes)

    logger.info(
        '"Discovery complete", "cohort_size": %d, "new_entrants": %d, "dropped": %d',
        len(passing),
        len(new_entrants),
        len(dropped),
    )
