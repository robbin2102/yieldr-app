"""
MongoDB connection management using Motor (async driver).
Provides singleton connection pool for API routes.
"""

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from config import get_settings

settings = get_settings()

# Singleton connection pool
_client: AsyncIOMotorClient = None
_db: AsyncIOMotorDatabase = None


async def connect_db():
    """
    Initialize MongoDB connection on app startup.
    Creates singleton client and database instances.
    """
    global _client, _db
    _client = AsyncIOMotorClient(settings.mongodb_uri)
    _db = _client.yieldr
    print(f"✅ Connected to MongoDB: yieldr database")


async def close_db():
    """
    Close MongoDB connection on app shutdown.
    """
    global _client
    if _client:
        _client.close()
        print(f"🔌 Closed MongoDB connection")


def get_database() -> AsyncIOMotorDatabase:
    """
    Get the database instance for API routes.

    Returns:
        AsyncIOMotorDatabase: The yieldr database instance

    Raises:
        RuntimeError: If database is not initialized (connect_db not called)
    """
    if _db is None:
        raise RuntimeError("Database not initialized. Call connect_db() first.")
    return _db
