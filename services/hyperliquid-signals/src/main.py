import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from .config import settings
from .db import ensure_indexes, ping, close

logging.basicConfig(
    level=logging.INFO,
    format='{"time": "%(asctime)s", "level": "%(levelname)s", "logger": "%(name)s", "msg": %(message)s}',
)
logger = logging.getLogger(__name__)

# APScheduler logs "Running job ..." / "... executed successfully" on every
# tick (every 60s by default) — drop to WARNING to cut routine noise while
# still surfacing job errors. The scheduler logger also logs one-time
# "Adding job tentatively"/"Added job"/"Scheduler started" lines at startup —
# silence those too; the "Scheduler started: ..." line logged below covers it.
logging.getLogger("apscheduler.executors.default").setLevel(logging.WARNING)
logging.getLogger("apscheduler.scheduler").setLevel(logging.WARNING)

scheduler = AsyncIOScheduler(timezone="UTC")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_indexes()
    logger.info('"Service starting, indexes ensured"')

    from .jobs.discovery import run_discovery
    from .jobs.snapshotter import run_snapshot
    from .jobs.price_logger import run_price_log
    from .jobs.execution_bot import bot_close_expired

    interval_s = settings.snapshot_interval_s
    scheduler.add_job(run_discovery,     CronTrigger(hour=0, minute=0),         id="discovery",    replace_existing=True)
    scheduler.add_job(run_snapshot,      IntervalTrigger(seconds=interval_s),   id="snapshotter",  replace_existing=True)
    scheduler.add_job(run_price_log,     IntervalTrigger(seconds=interval_s),   id="price_logger", replace_existing=True)
    scheduler.add_job(bot_close_expired, IntervalTrigger(minutes=1),            id="bot_timer",    replace_existing=True)
    scheduler.start()
    logger.info('"Scheduler started: discovery=daily, snapshot=%ds, prices=%ds, bot_timer=1min"',
                interval_s, interval_s)
    logger.info('"Config: bot_enabled=%s, bot_testnet=%s, bot_strategies=%s, ws_monitor_enabled=%s, ws_monitor_refresh_s=%d"',
                settings.bot_enabled, settings.bot_testnet, settings.bot_strategies,
                settings.ws_monitor_enabled, settings.ws_monitor_refresh_s)

    ws_task = None
    if settings.ws_monitor_enabled:
        from .jobs.ws_whale_monitor import run_ws_monitor
        ws_task = asyncio.create_task(run_ws_monitor())
        logger.info('"WS whale monitor task started"')

    yield

    if ws_task:
        ws_task.cancel()
        try:
            await ws_task
        except asyncio.CancelledError:
            pass
    scheduler.shutdown(wait=False)
    await close()
    logger.info('"Service shutdown complete"')


app = FastAPI(title="hyperliquid-signals", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from .api.cohort import router as cohort_router
from .api.signals import router as signals_router
from .api.positions import router as positions_router
from .api.coins import router as coins_router
from .api.config import router as config_router
from .api.trade_alerts import router as trade_alerts_router
from .api.bot import router as bot_router

app.include_router(cohort_router,       prefix="/api")
app.include_router(signals_router,      prefix="/api")
app.include_router(positions_router,    prefix="/api")
app.include_router(coins_router,        prefix="/api")
app.include_router(config_router,       prefix="/api")
app.include_router(trade_alerts_router, prefix="/api")
app.include_router(bot_router,          prefix="/api")


@app.get("/health")
async def health():
    db_ok = await ping()
    return {
        "status": "ok" if db_ok else "degraded",
        "db": "connected" if db_ok else "unreachable",
        "ts": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/dev/trigger-discovery")
async def trigger_discovery():
    from .jobs.discovery import run_discovery
    import asyncio
    asyncio.create_task(run_discovery())
    return {"ok": True, "msg": "Discovery started in background"}


@app.post("/dev/trigger-snapshot")
async def trigger_snapshot():
    from .jobs.snapshotter import run_snapshot
    import asyncio
    asyncio.create_task(run_snapshot())
    return {"ok": True, "msg": "Snapshot started in background"}


@app.get("/dev/account-status")
async def account_status():
    """Surface the addresses the bot signs orders as vs. the address its
    fill/position/order checks query — and what each address actually holds
    on Hyperliquid. Use this to diagnose "order placed but no position
    visible in HL UI" — a mismatch between HL_WALLET_ADDRESS and the
    HL_PRIVATE_KEY-derived signing address means orders are placed for one
    account while everything else is checked against the other.
    """
    from .lib import hl_exchange as ex

    configured = settings.hl_wallet_address
    signing = ex.signing_address() if settings.hl_private_key else None
    match = bool(configured and signing and configured.lower() == signing.lower())

    result = {
        "api_url": ex.api_url(),
        "bot_testnet": settings.bot_testnet,
        "configured_wallet_address": configured,
        "signing_address": signing,
        "addresses_match": match,
    }

    seen = set()
    for label, addr in (("configured", configured), ("signing", signing)):
        if not addr or addr.lower() in seen:
            continue
        seen.add(addr.lower())

        state = await ex.get_clearinghouse_state(addr)
        equity = None
        positions = []
        if state:
            try:
                equity = float(state["crossMarginSummary"]["accountValue"])
            except (KeyError, TypeError):
                pass
            for p in state.get("assetPositions", []):
                pos = p.get("position", {})
                if float(pos.get("szi", 0) or 0) != 0:
                    positions.append({
                        "coin": pos.get("coin"),
                        "szi": pos.get("szi"),
                        "entryPx": pos.get("entryPx"),
                        "positionValue": pos.get("positionValue"),
                        "unrealizedPnl": pos.get("unrealizedPnl"),
                    })

        result[f"{label}_account"] = {
            "address": addr,
            "equity": equity,
            "open_positions": positions,
            "open_orders": await ex.get_open_orders(addr),
            "recent_fills": await ex.get_user_fills(10, addr),
        }

    return result


@app.post("/dev/trigger-bot-test")
async def trigger_bot_test(strategy: str, coin: str, side: str):
    """Fire a synthetic trade alert and run it through the real bot_execute
    pipeline (preflight, order placement, fill tracking, timer exit) — for
    end-to-end testing on testnet without waiting for an organic signal.

    Only available when BOT_TESTNET=true, as a guard against accidental use
    on a live mainnet deployment.
    """
    from fastapi import HTTPException
    from .jobs.rules import fire, STRATEGY_HOLD
    from .jobs.execution_bot import bot_execute
    from .lib import hl_exchange as ex
    from .db import get_db

    if not settings.bot_testnet:
        raise HTTPException(status_code=403, detail="Only available when BOT_TESTNET=true")
    if strategy not in STRATEGY_HOLD:
        raise HTTPException(status_code=400, detail=f"Unknown strategy {strategy!r}")
    side = side.upper()
    if side not in ("LONG", "SHORT"):
        raise HTTPException(status_code=400, detail="side must be LONG or SHORT")

    coin = coin.upper()
    book = await ex.get_l2_book(coin)
    now = datetime.now(timezone.utc)
    db = get_db()

    alert = await fire(db, strategy, coin, side, book["mid"], now,
                        {"source": "dev_test_trigger"})
    if alert is None:
        return {"ok": False, "msg": f"already an OPEN alert for {strategy}/{coin}"}

    asyncio.create_task(bot_execute(alert))
    return {
        "ok": True,
        "alert_id": str(alert["_id"]),
        "entry_px": book["mid"],
        "bot_will_execute": strategy in {s.strip() for s in settings.bot_strategies.split(",")},
    }
