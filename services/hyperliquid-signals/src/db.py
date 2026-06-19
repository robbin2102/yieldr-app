import logging
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from .config import settings

logger = logging.getLogger(__name__)

_client: AsyncIOMotorClient | None = None


def get_client() -> AsyncIOMotorClient:
    global _client
    if _client is None:
        # pymongo's socketTimeoutMS defaults to None (no timeout) — after the
        # host sleeps/wakes, a pooled socket can be dead but not yet detected,
        # and a query on it blocks forever. That permanently stalls whichever
        # job holds the connection (e.g. run_snapshot, max_instances=1),
        # which then "skips" on every subsequent tick. Same hang-class fix as
        # the SDK HTTP timeout in lib/hl_exchange.py.
        _client = AsyncIOMotorClient(
            settings.mongo_uri,
            maxPoolSize=20,
            minPoolSize=2,
            connectTimeoutMS=10_000,
            serverSelectionTimeoutMS=10_000,
            socketTimeoutMS=20_000,
        )
    return _client


def get_db() -> AsyncIOMotorDatabase:
    return get_client()[settings.mongo_db_name]


async def _drop_index_if_exists(collection, name: str) -> None:
    try:
        await collection.drop_index(name)
    except Exception:
        pass


async def _ensure_ttl_index(collection, key: str, expire_after_s: int, name: str) -> None:
    """create_index() is a no-op when an index with this name already has the
    same spec, but a TTL index's expireAfterSeconds is part of that spec — so
    if it's ever wrong, drop+recreate is needed to fix it. That drop+recreate
    forces a full collection scan + index rebuild, which previously ran
    unconditionally on every single app startup (a leftover from one-time
    migrations that renamed/changed these indexes and was never removed).
    Now it only runs when the stored value actually differs from the target.
    """
    try:
        existing = await collection.index_information()
    except Exception:
        existing = {}

    spec = existing.get(name)
    if spec is not None and spec.get("expireAfterSeconds") == expire_after_s:
        return

    if spec is not None:
        await _drop_index_if_exists(collection, name)
    await collection.create_index(key, expireAfterSeconds=expire_after_s, name=name)


async def ensure_indexes() -> None:
    db = get_db()

    await db.hl_signals_traders.create_index("address", unique=True)
    await db.hl_signals_traders.create_index("cohort_status")
    await db.hl_signals_traders.create_index([("cohort_status", 1), ("skill_quartile", 1)])

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

    # One-time cleanup of indexes from older migrations that these TTL
    # indexes replaced — drop_index() on a name that doesn't exist is a no-op
    # (caught by _drop_index_if_exists), so this is harmless once gone.
    await _drop_index_if_exists(db.hl_signals_positions, "snapshot_ts_1")
    await _drop_index_if_exists(db.hl_signals_coin_metrics, "snapshot_ts_1")

    await _ensure_ttl_index(db.hl_signals_positions, "snapshot_ts", 1 * 24 * 3600, "positions_ttl")
    await _ensure_ttl_index(db.hl_signals_convergence, "snapshot_ts", 7 * 24 * 3600, "convergence_ttl")
    await _ensure_ttl_index(db.hl_signals_signals, "snapshot_ts", 48 * 3600, "signals_ttl")
    await _ensure_ttl_index(db.hl_signals_coin_metrics, "snapshot_ts", 30 * 24 * 3600, "coin_metrics_ttl")

    await db.hl_signals_prices.create_index([("coin", 1), ("ts", -1)])
    await _ensure_ttl_index(db.hl_signals_prices, "ts", 30 * 24 * 3600, "prices_ttl")

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
