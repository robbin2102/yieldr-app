"""
Standalone bot execution test.

Usage (from services/hyperliquid-signals/):
    python scripts/test_bot.py              # BTC LONG, WAKEUP_LS10_4H
    python scripts/test_bot.py ETH LONG WHALE_FLIP
    python scripts/test_bot.py --dry-run    # print settings only, no order
"""
import sys
import os
import asyncio
import logging
from pathlib import Path
from datetime import datetime, timezone

# ── Load .env.local from project root BEFORE importing any service modules ─────
# Works regardless of which directory the script is run from.
_repo_root = Path(__file__).resolve().parent.parent.parent.parent
for _candidate in [_repo_root / ".env.local", _repo_root / ".env"]:
    if _candidate.exists():
        from dotenv import load_dotenv
        load_dotenv(_candidate, override=True)
        print(f"[env] loaded {_candidate}")
        break
else:
    print("[env] WARNING: no .env.local / .env found — using process env only")

# ── Now import service modules (they read os.environ at import time) ───────────
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bson import ObjectId
from src.config import settings
from src.jobs.execution_bot import bot_execute

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)-7s %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)


def _print_settings() -> None:
    print("\n── Bot settings ─────────────────────────────────────────────────")
    print(f"  BOT_ENABLED          = {settings.bot_enabled}")
    print(f"  BOT_TESTNET          = {settings.bot_testnet}")
    print(f"  HL_WALLET_ADDRESS    = {settings.hl_wallet_address[:10]}..." if settings.hl_wallet_address else "  HL_WALLET_ADDRESS    = (not set)")
    print(f"  HL_PRIVATE_KEY       = {'*' * 8}..." if settings.hl_private_key else "  HL_PRIVATE_KEY       = (not set)")
    print(f"  BOT_POSITION_SIZE    = ${settings.bot_position_size_usdc}")
    print(f"  BOT_MAX_CAPITAL      = ${settings.bot_max_capital_usdc}")
    print(f"  SPREAD_LIMIT_BPS     = {settings.spread_limit_bps}")
    print(f"  DRIFT_LIMIT_BPS      = {settings.drift_limit_bps}")
    print(f"  BOT_STRATEGIES       = {settings.bot_strategies}")
    print(f"  BOT_EXCLUDED_COINS   = {settings.bot_excluded_coins or '(none)'}")
    print("─────────────────────────────────────────────────────────────────\n")


async def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in sys.argv

    coin     = args[0].upper() if len(args) > 0 else "BTC"
    side     = args[1].upper() if len(args) > 1 else "LONG"
    strategy = args[2].upper() if len(args) > 2 else "WAKEUP_LS10_4H"

    _print_settings()

    if dry_run:
        print("[dry-run] skipping bot_execute — settings printed above")
        return

    if not settings.bot_enabled:
        print("ERROR: BOT_ENABLED is False — set BOT_ENABLED=true in .env.local and restart")
        return

    if not settings.hl_private_key or not settings.hl_wallet_address:
        print("ERROR: HL_WALLET_ADDRESS or HL_PRIVATE_KEY missing in .env.local")
        return

    # Fake alert — entry_px=0 forces the bot to use live mid price at execution
    fake_alert = {
        "_id": ObjectId(),
        "strategy": strategy,
        "coin": coin,
        "side": side,
        "entry_px": 0.0,  # 0 → bot fetches live mid; no drift check applied
        "fired_at": datetime.now(timezone.utc),
        "hold_hours": 4,
        "trigger_detail": {"ls_ratio": 12.5},
    }

    print(f"Firing fake alert: {strategy}  {coin}  {side}")
    print("Watch logs below for: spread check → order → fill check\n")

    await bot_execute(fake_alert)

    print("\nDone. Verify with:")
    print("  curl -s http://localhost:8001/api/bot/positions | python -m json.tool")
    print("  curl -s http://localhost:8001/api/bot/summary  | python -m json.tool")


asyncio.run(main())
