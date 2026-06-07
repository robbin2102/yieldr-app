import logging
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from .config import settings

logger = logging.getLogger(__name__)

_client: AsyncIOMotorClient | None = None


def get_client() -> AsyncIOMotorClient:
    global _client
    if _client is None:
        _client = AsyncIOMotorClient(settings.mongo_uri, maxPoolSize=20, minPoolSize=2)
    return _client


def get_db() -> AsyncIOMotorDatabase:
    return get_client()[settings.mongo_db_name]


async def _drop_index_if_exists(collection, name: str) -> None:
    try:
        await collection.drop_index(name)
    except Exception:
        pass


async def ensure_indexes() -> None:
    db = get_db()

    await db.hl_signals_traders.create_index("address", unique=True)
    await db.hl_signals_traders.create_index("cohort_status")

    await db.hl_signals_positions.create_index([("address", 1), ("snapshot_ts", -1)])
    await db.hl_signals_positions.create_index([("address", 1), ("coin", 1), ("snapshot_ts", -1)])

    await db.hl_signals_position_changes.create_index([("ts", -1)])
    await db.hl_signals_position_changes.create_index([("address", 1), ("ts", -1)])
    await db.hl_signals_position_changes.create_index("coin")
    await db.hl_signals_position_changes.create_index([("coin", 1), ("ts", -1)])

    await db.hl_signals_convergence.create_index([("coin", 1), ("side", 1), ("snapshot_ts", -1)])

    await db.hl_signals_alerts.create_index([("acknowledged", 1), ("severity", 1)])
    await db.hl_signals_alerts.create_index([("coin", 1), ("side", 1)])

    await db.hl_signals_cohort_changes.create_index("ts")
    await db.hl_signals_cohort_changes.create_index("address")

    await db.hl_signals_coin_metrics.create_index([("coin", 1), ("snapshot_ts", -1)])

    await db.hl_signals_whale_events.create_index([("ts", -1)])
    await db.hl_signals_whale_events.create_index([("coin", 1), ("ts", -1)])
    await db.hl_signals_whale_events.create_index("event_type")

    await db.hl_signals_signals.create_index([("snapshot_ts", -1)])
    await db.hl_signals_signals.create_index([("signal_type", 1), ("snapshot_ts", -1)])
    await db.hl_signals_signals.create_index([("coin", 1), ("snapshot_ts", -1)])

    await _drop_index_if_exists(db.hl_signals_positions, "positions_ttl")
    await _drop_index_if_exists(db.hl_signals_positions, "snapshot_ts_1")
    await db.hl_signals_positions.create_index(
        "snapshot_ts", expireAfterSeconds=1 * 24 * 3600, name="positions_ttl"
    )

    await _drop_index_if_exists(db.hl_signals_convergence, "snapshot_ts_1")
    await db.hl_signals_convergence.create_index(
        "snapshot_ts", expireAfterSeconds=7 * 24 * 3600, name="convergence_ttl"
    )

    await _drop_index_if_exists(db.hl_signals_signals, "signals_ttl")
    await db.hl_signals_signals.create_index(
        "snapshot_ts", expireAfterSeconds=48 * 3600, name="signals_ttl"
    )

    await _drop_index_if_exists(db.hl_signals_coin_metrics, "coin_metrics_ttl")
    await _drop_index_if_exists(db.hl_signals_coin_metrics, "snapshot_ts_1")
    await db.hl_signals_coin_metrics.create_index(
        "snapshot_ts", expireAfterSeconds=30 * 24 * 3600, name="coin_metrics_ttl"
    )

    await db.hl_signals_prices.create_index([("coin", 1), ("ts", -1)])
    await _drop_index_if_exists(db.hl_signals_prices, "prices_ttl")
    await db.hl_signals_prices.create_index(
        "ts", expireAfterSeconds=30 * 24 * 3600, name="prices_ttl"
    )

    await db.hl_signals_position_changes.create_index(
        "ts", expireAfterSeconds=30 * 24 * 3600, name="position_changes_ttl"
    )

    await db.hl_signals_whale_events.create_index(
        "ts", expireAfterSeconds=30 * 24 * 3600, name="whale_events_ttl"
    )

    await db.hl_signals_trade_alerts.create_index([("status", 1), ("fired_at", -1)])
    await db.hl_signals_trade_alerts.create_index([("strategy", 1), ("coin", 1), ("status", 1)])
    await db.hl_signals_trade_alerts.create_index("hold_until")
    await db.hl_signals_trade_alerts.create_index(
        "fired_at", expireAfterSeconds=90 * 24 * 3600, name="trade_alerts_ttl"
    )

    # ── Bot collections ────────────────────────────────────────────────────────
    await db.bot_positions.create_index([("status", 1), ("created_at", -1)])
    await db.bot_positions.create_index([("strategy", 1), ("coin", 1), ("status", 1)])
    await db.bot_positions.create_index("hold_until")
    await db.bot_positions.create_index("created_at")

    await db.bot_skipped_signals.create_index([("ts", -1)])
    await db.bot_skipped_signals.create_index([("coin", 1), ("skip_reason", 1)])

    await db.bot_daily_summary.create_index("date", unique=True)

    await db.agent_calls.create_index([("ts", -1)])

    logger.info('"MongoDB indexes ensured"')


async def ping() -> bool:
    try:
        await get_client().admin.command("ping")
        return True
    except Exception:
        return False


async def close() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None
