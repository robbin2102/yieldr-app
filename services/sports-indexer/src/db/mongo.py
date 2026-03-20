"""MongoDB connection using motor (async)."""

import logging
from motor.motor_asyncio import AsyncIOMotorClient
from src.config import MONGODB_URI, MONGODB_DB

logger = logging.getLogger(__name__)

_client: AsyncIOMotorClient | None = None
_db = None


async def get_db():
    """Get or create the async MongoDB connection."""
    global _client, _db
    if _db is not None:
        return _db
    if not MONGODB_URI:
        raise RuntimeError("MONGODB_URI not set")
    _client = AsyncIOMotorClient(MONGODB_URI)
    _db = _client[MONGODB_DB]
    logger.info(f"Connected to MongoDB database: {MONGODB_DB}")
    return _db


async def close_db():
    """Close the MongoDB connection."""
    global _client, _db
    if _client:
        _client.close()
        _client = None
        _db = None
        logger.info("MongoDB connection closed")


async def ensure_indexes(db):
    """Create required indexes."""
    await db.matches.create_index("fixture_id", unique=True)
    await db.matches.create_index([("lifecycle_phase", 1), ("date", 1)])
    await db.matches.create_index([("status.short", 1)])
    await db.matches.create_index(
        [("home.name", "text"), ("away.name", "text")]
    )
    await db.odds_history.create_index([("fixture_id", 1), ("captured_at", 1)])
    await db.polymarket_snapshots.create_index(
        [("fixture_id", 1), ("captured_at", 1)]
    )
    await db.request_log.create_index(
        "timestamp", expireAfterSeconds=604800
    )
    logger.info("MongoDB indexes ensured")
