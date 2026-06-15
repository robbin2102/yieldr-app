"""Single-active-instance guard for live bot execution.

Multiple uvicorn processes can end up running against the same Mongo +
Hyperliquid account (e.g. a leftover process from a previous restart that
didn't fully exit, see the port-8000 holdover incident). If BOT_ENABLED is
true in more than one process, each independently-running scheduler can react
to the same signal and place its own live order — this is the root cause
identified for the INJ orphan leg (two ~2.1 INJ SHORT fills 22s apart, only
one tracked in bot_positions).

This module implements a simple heartbeat-based lock in a single Mongo doc
(bot_instance_lock/_id="lock"). On startup, a process claims the lock if no
other instance's heartbeat is fresh. A periodic job refreshes the heartbeat;
if another process steals the lock (only possible if this process's heartbeat
goes stale, e.g. a long GC pause), bot execution is disabled here to avoid
duplicate live orders. bot_execute/bot_close_expired both check is_active()
before doing anything that places or closes orders.
"""
import logging
import os
import socket
import uuid
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

_INSTANCE_ID = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
_STALE_AFTER = timedelta(seconds=150)

_active = False


def is_active() -> bool:
    """True if this process holds the bot-execution lock."""
    return _active


def instance_id() -> str:
    return _INSTANCE_ID


async def acquire(db) -> bool:
    """Claim the single bot-execution slot.

    Returns True if this process may run bot_execute/bot_close_expired.
    Returns False (without raising) if another instance's heartbeat is still
    fresh — the rest of the service (API, snapshots, signals) keeps running
    normally, just live order placement/closing is disabled in this process.
    """
    global _active
    now = datetime.now(timezone.utc)
    existing = await db.bot_instance_lock.find_one({"_id": "lock"})
    if existing and existing.get("instance_id") != _INSTANCE_ID:
        heartbeat_at = existing["heartbeat_at"]
        if heartbeat_at.tzinfo is None:
            # Motor/PyMongo returns naive datetimes (values are stored as
            # UTC but tzinfo is dropped on read) — reattach UTC so this is
            # comparable to datetime.now(timezone.utc).
            heartbeat_at = heartbeat_at.replace(tzinfo=timezone.utc)
        age_s = (now - heartbeat_at).total_seconds()
        if age_s < _STALE_AFTER.total_seconds():
            logger.error(
                '"Another bot instance appears active (instance_id=%s pid=%s, heartbeat %ds ago) '
                '— refusing to enable bot execution in this process to avoid duplicate live orders"',
                existing.get("instance_id"), existing.get("pid"), int(age_s),
            )
            _active = False
            return False
        logger.warning(
            '"Stale bot instance lock (instance_id=%s pid=%s, heartbeat %ds ago) — taking over"',
            existing.get("instance_id"), existing.get("pid"), int(age_s),
        )

    await db.bot_instance_lock.update_one(
        {"_id": "lock"},
        {"$set": {
            "instance_id": _INSTANCE_ID, "pid": os.getpid(),
            "hostname": socket.gethostname(), "started_at": now, "heartbeat_at": now,
        }},
        upsert=True,
    )
    _active = True
    logger.info('"Bot instance lock acquired" instance_id="%s"', _INSTANCE_ID)
    return True


async def heartbeat(db) -> None:
    """Refresh this instance's heartbeat, or detect takeover and disable."""
    global _active
    if not _active:
        return
    now = datetime.now(timezone.utc)
    result = await db.bot_instance_lock.update_one(
        {"_id": "lock", "instance_id": _INSTANCE_ID},
        {"$set": {"heartbeat_at": now}},
    )
    if result.matched_count == 0:
        logger.error('"Lost bot instance lock to another process — disabling bot execution"')
        _active = False


async def heartbeat_job() -> None:
    from ..db import get_db
    await heartbeat(get_db())
