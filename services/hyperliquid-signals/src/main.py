import logging
import json
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

scheduler = AsyncIOScheduler(timezone="UTC")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_indexes()
    logger.info('"Service starting, indexes ensured"')

    from .jobs.discovery import run_discovery
    from .jobs.snapshotter import run_snapshot
    from .jobs.price_logger import run_price_log

    scheduler.add_job(run_discovery, CronTrigger(hour=0, minute=0), id="discovery", replace_existing=True)
    scheduler.add_job(run_snapshot, IntervalTrigger(minutes=5), id="snapshotter", replace_existing=True)
    scheduler.add_job(run_price_log, IntervalTrigger(minutes=5), id="price_logger", replace_existing=True)
    scheduler.start()
    logger.info('"Scheduler started: discovery=daily@00:00UTC, snapshot=every5min, prices=every5min"')

    yield

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

# Routers — imported after app is defined to avoid circular imports
from .api.cohort import router as cohort_router
from .api.signals import router as signals_router
from .api.positions import router as positions_router
from .api.coins import router as coins_router
from .api.config import router as config_router

app.include_router(cohort_router, prefix="/api")
app.include_router(signals_router, prefix="/api")
app.include_router(positions_router, prefix="/api")
app.include_router(coins_router, prefix="/api")
app.include_router(config_router, prefix="/api")


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
    return {"ok": True, "msg": "Discovery started in background — watch logs"}


@app.post("/dev/trigger-snapshot")
async def trigger_snapshot():
    from .jobs.snapshotter import run_snapshot
    import asyncio
    asyncio.create_task(run_snapshot())
    return {"ok": True, "msg": "Snapshot started in background — watch logs"}
