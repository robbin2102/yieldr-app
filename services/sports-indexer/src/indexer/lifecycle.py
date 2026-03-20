"""Match lifecycle state machine — determines which phase a match is in."""

from datetime import datetime, timezone, timedelta

# Lifecycle phases
DISCOVERY = "discovery"
PRE_MATCH = "pre_match"       # Phase 1: T-24h research
PRE_KICKOFF = "pre_kickoff"   # Phase 2: T-1h lineups + fresh data
LIVE = "live"                 # Phase 3: every 15min during match
POST_MATCH = "post_match"     # Phase 4: final stats
CLOSED = "closed"

# API-Football status codes
LIVE_STATUSES = {"1H", "HT", "2H", "ET", "P", "BT", "LIVE"}
FINISHED_STATUSES = {"FT", "AET", "PEN"}
NOT_STARTED_STATUSES = {"NS", "TBD"}
CANCELLED_STATUSES = {"PST", "CANC", "ABD", "AWD", "WO", "SUSP", "INT"}


def determine_phase(match_doc: dict) -> str:
    """Determine what lifecycle phase a match should be in based on current time and status."""
    now = datetime.now(timezone.utc)
    status = match_doc.get("status", {}).get("short", "NS")
    match_date = match_doc.get("date")

    if isinstance(match_date, str):
        match_date = datetime.fromisoformat(match_date.replace("Z", "+00:00"))

    if status in CANCELLED_STATUSES:
        return CLOSED

    if status in FINISHED_STATUSES:
        current = match_doc.get("lifecycle_phase", "")
        if current == POST_MATCH:
            return CLOSED
        return POST_MATCH

    if status in LIVE_STATUSES:
        return LIVE

    # Not started — determine by time
    if match_date:
        time_to_kick = match_date - now

        if time_to_kick <= timedelta(hours=0):
            # Past kickoff time but API hasn't updated status yet
            return LIVE
        if time_to_kick <= timedelta(hours=1):
            return PRE_KICKOFF
        if time_to_kick <= timedelta(hours=24):
            return PRE_MATCH
        return DISCOVERY

    return DISCOVERY


def should_transition(match_doc: dict) -> tuple[bool, str]:
    """Check if a match should transition to a new phase.

    Returns (should_transition, new_phase).
    """
    current_phase = match_doc.get("lifecycle_phase", DISCOVERY)
    target_phase = determine_phase(match_doc)

    # Define valid transitions (can only move forward)
    phase_order = [DISCOVERY, PRE_MATCH, PRE_KICKOFF, LIVE, POST_MATCH, CLOSED]
    try:
        current_idx = phase_order.index(current_phase)
        target_idx = phase_order.index(target_phase)
    except ValueError:
        return False, current_phase

    if target_idx > current_idx:
        return True, target_phase
    return False, current_phase


def needs_live_poll(match_doc: dict, interval_sec: int = 900) -> bool:
    """Check if a live match needs another poll (every 15min by default)."""
    if match_doc.get("lifecycle_phase") != LIVE:
        return False

    last_update = match_doc.get("match_stats", {}).get("last_updated")
    if not last_update:
        return True

    if isinstance(last_update, str):
        last_update = datetime.fromisoformat(last_update.replace("Z", "+00:00"))

    elapsed = (datetime.now(timezone.utc) - last_update).total_seconds()
    return elapsed >= interval_sec


def needs_polymarket_poll(match_doc: dict, interval_sec: int = 300) -> bool:
    """Check if Polymarket data needs refresh (every 5min during live)."""
    phase = match_doc.get("lifecycle_phase", "")
    if phase not in (LIVE, PRE_KICKOFF):
        return False

    last_update = match_doc.get("polymarket", {}).get("last_updated")
    if not last_update:
        return True

    if isinstance(last_update, str):
        last_update = datetime.fromisoformat(last_update.replace("Z", "+00:00"))

    elapsed = (datetime.now(timezone.utc) - last_update).total_seconds()
    return elapsed >= interval_sec
