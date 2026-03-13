"""
CDP Wallet Service — FastAPI microservice for Coinbase CDP signing.

Responsibility: receive a raw EIP-1559 transaction, sign it via CDP MPC
wallets, broadcast it to Base mainnet, and return the tx hash.

This service owns ALL cdp-sdk imports so that the yieldr-data-api (which uses
avantis-trader-sdk / web3 <7) has zero dependency on cdp-sdk.

Environment variables required:
  CDP_API_KEY_ID       Coinbase CDP API key ID
  CDP_API_KEY_SECRET   Coinbase CDP API key secret (PEM, supports \\n escaping)
  CDP_WALLET_SECRET    Coinbase CDP wallet secret
  CDP_SERVICE_SECRET   Shared secret for intra-service auth (X-CDP-Secret header)
"""

import os
import logging
from contextlib import asynccontextmanager
from dotenv import load_dotenv

load_dotenv("../../.env.local")  # local dev only; Railway uses actual env vars

from fastapi import FastAPI
from router import router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("cdp-wallet-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Validate required env vars on startup
    required = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "CDP_SERVICE_SECRET"]
    missing = [k for k in required if not os.getenv(k)]
    if missing:
        logger.warning(f"[startup] Missing env vars: {missing} — service will return 503 on signing requests")
    else:
        logger.info("[startup] All CDP env vars present — service ready")
    yield


app = FastAPI(
    title="CDP Wallet Service",
    description="Internal microservice for Coinbase CDP MPC transaction signing",
    version="1.0.0",
    lifespan=lifespan,
    # Disable docs on production (internal service)
    docs_url="/docs" if os.getenv("ENV") != "production" else None,
    redoc_url=None,
)

app.include_router(router)


@app.get("/health")
async def health():
    key_id = os.getenv("CDP_API_KEY_ID")
    service_secret = os.getenv("CDP_SERVICE_SECRET")
    return {
        "status": "ok",
        "cdp_configured": bool(key_id),
        "auth_configured": bool(service_secret),
    }
