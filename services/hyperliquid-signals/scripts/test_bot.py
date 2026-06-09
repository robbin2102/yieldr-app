"""
Standalone bot execution test.

Usage (from services/hyperliquid-signals/):
    python scripts/test_bot.py                    # place order: BTC LONG WAKEUP_LS10_4H
    python scripts/test_bot.py ETH LONG WHALE_FLIP
    python scripts/test_bot.py --dry-run          # print settings only
    python scripts/test_bot.py --test-drift       # verify drift gate skips stale price
    python scripts/test_bot.py --test-timer-exit  # expire open position and close it
"""
import sys
import asyncio
import logging
from pathlib import Path
from datetime import datetime, timezone, timedelta

# ── Load .env.local from project root BEFORE importing any service modules ─────
_repo_root = Path(__file__).resolve().parent.parent.parent.parent
for _candidate in [_repo_root / ".env.local", _repo_root / ".env"]:
    if _candidate.exists():
        from dotenv import load_dotenv
        load_dotenv(_candidate, override=True)
        print(f"[env] loaded {_candidate}")
        break
else:
    print("[env] WARNING: no .env.local / .env found — using process env only")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bson import ObjectId
from src.config import settings
from src.jobs.execution_bot import bot_execute, bot_close_expired, bot_manual_exit_all
from src.db import get_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
for _n in ("pymongo", "asyncio", "aiohttp", "urllib3"):
    logging.getLogger(_n).setLevel(logging.WARNING)

log = logging.getLogger(__name__)


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
    print(f"  BOT_LEVERAGE         = {settings.bot_leverage}x")
    print(f"  BOT_STRATEGIES       = {settings.bot_strategies}")
    print(f"  BOT_EXCLUDED_COINS   = {settings.bot_excluded_coins or '(none)'}")
    print("─────────────────────────────────────────────────────────────────\n")


# ── Test 1: normal order ──────────────────────────────────────────────────────

async def test_order(coin: str, side: str, strategy: str) -> None:
    fake_alert = {
        "_id":            ObjectId(),
        "strategy":       strategy,
        "coin":           coin,
        "side":           side,
        "entry_px":       0.0,
        "fired_at":       datetime.now(timezone.utc),
        "hold_hours":     4,
        "trigger_detail": {"ls_ratio": 12.5},
    }
    print(f"[test-order] {strategy}  {coin}  {side}")
    print("Expected: leverage set → spread OK → order placed → fill → OPEN\n")
    await bot_execute(fake_alert)


# ── Test 2: drift gate ────────────────────────────────────────────────────────

async def test_drift(coin: str, side: str, strategy: str) -> None:
    from src.lib import hl_exchange as ex
    book = await ex.get_l2_book(coin)
    live_mid = book["mid"]
    # Use a price 5% away from live mid — guaranteed to exceed 20 bps drift limit
    stale_px = round(live_mid * 0.95, 1)
    drift_bps = abs(live_mid - stale_px) / stale_px * 10_000
    print(f"[test-drift] live mid={live_mid:.1f}  stale entry_px={stale_px:.1f}  drift={drift_bps:.0f} bps")
    print(f"Expected: skip with 'price_drifted' (limit={settings.drift_limit_bps} bps)\n")
    fake_alert = {
        "_id":            ObjectId(),
        "strategy":       strategy,
        "coin":           coin,
        "side":           side,
        "entry_px":       stale_px,
        "fired_at":       datetime.now(timezone.utc),
        "hold_hours":     4,
        "trigger_detail": {"ls_ratio": 12.5},
    }
    await bot_execute(fake_alert)


# ── Test 3: timer exit ────────────────────────────────────────────────────────

async def test_timer_exit() -> None:
    db = get_db()
    pos = await db.bot_positions.find_one({"status": "OPEN"})
    if not pos:
        print("[test-timer-exit] No OPEN position found. Run test_order first.")
        return

    print(f"[test-timer-exit] Found OPEN position: {pos['coin']} {pos['side']} id={pos['_id']}")
    # Expire it by setting hold_until to 2 minutes ago
    expired_at = datetime.now(timezone.utc) - timedelta(minutes=2)
    await db.bot_positions.update_one(
        {"_id": pos["_id"]},
        {"$set": {"hold_until": expired_at}},
    )
    print(f"  hold_until set to {expired_at.strftime('%H:%M:%S')} (2 min ago)")
    print("Expected: IOC close order placed → position → CLOSED\n")
    await bot_close_expired(now=datetime.now(timezone.utc))


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    args  = [a for a in sys.argv[1:] if not a.startswith("--")]

    coin     = args[0].upper() if len(args) > 0 else "BTC"
    side     = args[1].upper() if len(args) > 1 else "LONG"
    strategy = args[2].upper() if len(args) > 2 else "WAKEUP_LS10_4H"

    _print_settings()

    if "--dry-run" in flags:
        print("[dry-run] settings printed above — no action taken")
        return

    if not settings.bot_enabled:
        print("ERROR: BOT_ENABLED is False in .env.local")
        return
    if not settings.hl_private_key or not settings.hl_wallet_address:
        print("ERROR: HL_WALLET_ADDRESS or HL_PRIVATE_KEY missing")
        return

    if "--test-drift" in flags:
        await test_drift(coin, side, strategy)
    elif "--test-timer-exit" in flags:
        await test_timer_exit()
    elif "--exit-all" in flags:
        print("[exit-all] closing all OPEN positions via IOC market order\n")
        result = await bot_manual_exit_all()
        print(f"Result: {result}")
    else:
        await test_order(coin, side, strategy)

    print("\nVerify:")
    print("  curl -s http://localhost:8001/api/bot/positions | python -m json.tool")
    print("  curl -s http://localhost:8001/api/bot/summary  | python -m json.tool")


asyncio.run(main())
