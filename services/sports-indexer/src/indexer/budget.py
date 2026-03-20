"""API request budget tracker — reads request_log collection."""

import logging
from datetime import datetime, timezone, timedelta
from src.config import INDEXER_LIMIT

logger = logging.getLogger(__name__)


class BudgetTracker:
    """Tracks daily API-Football request count against budget."""

    def __init__(self, db):
        self.db = db
        self.limit = INDEXER_LIMIT

    async def get_today_count(self) -> int:
        """Count requests made today (UTC)."""
        today_start = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        count = await self.db.request_log.count_documents({
            "timestamp": {"$gte": today_start},
            "source": "indexer",
        })
        return count

    async def can_make_request(self, reserve: int = 0) -> bool:
        """Check if we have budget for another request."""
        count = await self.get_today_count()
        available = self.limit - reserve - count
        if available <= 0:
            logger.warning(f"Budget exhausted: {count}/{self.limit} used (reserve={reserve})")
            return False
        return True

    async def remaining(self) -> int:
        """How many requests remain today."""
        count = await self.get_today_count()
        return max(0, self.limit - count)

    async def get_status(self) -> dict:
        """Full budget status."""
        count = await self.get_today_count()
        return {
            "used": count,
            "limit": self.limit,
            "remaining": max(0, self.limit - count),
            "pct_used": round(count / self.limit * 100, 1) if self.limit else 0,
        }
