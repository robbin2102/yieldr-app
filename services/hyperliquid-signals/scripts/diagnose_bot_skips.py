"""For each trade alert fired today, show what the bot did with it.

hl_signals_trade_alerts always records every fired signal regardless of bot
participation. bot_positions/bot_skipped_signals are only written if
bot_execute() got past the early-return guards (bot_enabled, strategy in
BOT_STRATEGIES, coin not excluded, credentials present) — those guards return
silently with no DB record. This script joins on alert_id (str(alert._id))
to classify each alert as EXECUTED / PREFLIGHT_SKIP / NO_BOT_RECORD so the
exact cause per signal is visible at a glance.

Usage:
    python -m scripts.diagnose_bot_skips [days]
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, ".")
from src.db import get_db  # noqa: E402


async def main(days: float) -> None:
    db = get_db()
    since = datetime.now(timezone.utc) - timedelta(days=days)

    cursor = db.hl_signals_trade_alerts.find(
        {"fired_at": {"$gte": since}}
    ).sort("fired_at", -1)

    async for alert in cursor:
        alert_id = str(alert["_id"])
        fired = alert["fired_at"].strftime("%m-%d %H:%M:%S")
        label = f'{fired}  {alert["strategy"]:<24} {alert["coin"]:<6} {alert["side"]:<5}'

        pos = await db.bot_positions.find_one({"alert_id": alert_id})
        if pos:
            status = pos["status"]
            extra = f' skip_reason={pos.get("skip_reason")}' if pos.get("skip_reason") else ""
            print(f'{label}  -> bot_positions status={status}{extra}')
            continue

        skip = await db.bot_skipped_signals.find_one({"alert_id": alert_id})
        if skip:
            print(f'{label}  -> PREFLIGHT_SKIP reason={skip["skip_reason"]}')
            continue

        print(f'{label}  -> NO_BOT_RECORD (bot_enabled/BOT_STRATEGIES/excluded/credentials guard, or pre-preflight error)')


if __name__ == "__main__":
    days = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
    asyncio.run(main(days))
