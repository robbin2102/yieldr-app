"""In-memory service health tracking — process uptime + a ring buffer of
recent WARNING/ERROR log records, surfaced via /api/bot/health for the
Agent dashboard's "service status" panel.
"""
import logging
import time
from collections import deque
from datetime import datetime, timezone

START_TIME = time.time()

_MAX_EVENTS = 50
_events: deque[dict] = deque(maxlen=_MAX_EVENTS)


class RingBufferHandler(logging.Handler):
    """Captures WARNING+ log records into an in-memory ring buffer."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            _events.append({
                "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
                "level": record.levelname,
                "logger": record.name,
                "message": record.getMessage(),
            })
        except Exception:
            pass


def install() -> None:
    handler = RingBufferHandler()
    handler.setLevel(logging.WARNING)
    logging.getLogger().addHandler(handler)


def get_uptime_s() -> float:
    return time.time() - START_TIME


def get_recent_issues(limit: int = 20) -> list[dict]:
    return list(_events)[-limit:][::-1]
