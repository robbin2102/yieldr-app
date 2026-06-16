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

# (level, logger-substring) pairs to suppress from the health panel.
# These are expected / self-healing events — showing them as "issues" is noise.
_SUPPRESS: list[tuple[str, str]] = [
    ("WARNING", "instance_lock"),    # rolling-deploy lock handover
    ("WARNING", "ws_whale_monitor"), # HL WS expiry every ~10 min (auto-reconnects)
    ("ERROR",   "instance_lock"),    # new instance refused lock during deploy window
]

# Short friendly labels shown in the UI instead of the raw logger path
_LOGGER_LABELS: dict[str, str] = {
    "src.jobs.execution_bot":    "bot",
    "src.jobs.ws_whale_monitor": "ws-monitor",
    "src.jobs.instance_lock":    "instance-lock",
    "src.jobs.snapshotter":      "snapshotter",
    "src.jobs.discovery":        "discovery",
    "src.jobs.price_logger":     "price-logger",
    "src.jobs.rules":            "rules",
    "src.main":                  "startup",
}


class RingBufferHandler(logging.Handler):
    """Captures WARNING+ log records into an in-memory ring buffer."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            for level, logger_substr in _SUPPRESS:
                if record.levelname == level and logger_substr in record.name:
                    return
            label = _LOGGER_LABELS.get(record.name, record.name.split(".")[-1])
            _events.append({
                "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
                "level": record.levelname,
                "logger": label,
                "message": record.getMessage().strip('"'),
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
