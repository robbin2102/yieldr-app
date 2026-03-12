"""
Yieldr Data Services API
FastAPI application for token scanning, trader indexing, and market data.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from web3 import Web3
from db.mongodb import connect_db, close_db
from api.spot.router import router as spot_router
from api.trending.tokens import router as trending_router
from api.trader.top import router as trader_router
from api.avantis_trade.router import router as avantis_trade_router
from config import get_settings

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan manager.
    Handles startup and shutdown events.
    """
    # Startup
    print("🚀 Starting Yieldr Data Services API...")
    await connect_db()
    print("✅ Application ready")

    yield

    # Shutdown
    print("🔌 Shutting down...")
    await close_db()
    print("👋 Shutdown complete")


# Create FastAPI application
app = FastAPI(
    title="Yieldr Data Services",
    description="API for token scanning, trader indexing, PnL computation, and market data on Base",
    version="1.0.0",
    lifespan=lifespan
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Health check endpoint (no auth required)
@app.get("/health", tags=["System"])
async def health_check():
    return {
        "status": "healthy",
        "service": "Yieldr Data Services",
        "version": "1.0.0"
    }


# ─────────────────────────────────────────────────────────────────────────────
# POST /fetch-positions
# Backward-compatible with the legacy python-service that was previously deployed.
# Used by /api/avantis-positions in Next.js to show live Avantis positions for
# any external wallet (read-only, no signer required).
# ─────────────────────────────────────────────────────────────────────────────

class FetchPositionsRequest(BaseModel):
    walletAddress: str
    rpcUrl: str = None


@app.post("/fetch-positions", tags=["Legacy"])
async def fetch_positions(request: FetchPositionsRequest):
    from avantis_trader_sdk import TraderClient, FeedClient

    rpc_url = request.rpcUrl or settings.quicknode_endpoint or "https://mainnet.base.org"

    try:
        checksummed = Web3.to_checksum_address(request.walletAddress.lower())
        print(f"[fetch-positions] wallet={checksummed} rpc={rpc_url[:50]}...")

        trader_client = TraderClient(rpc_url)
        trades, _ = await trader_client.trade.get_trades(checksummed)

        if not trades:
            return {
                "success": True,
                "data": {
                    "totalPositions": 0,
                    "positions": [],
                    "summary": {"totalPnL": 0, "totalMargin": 0, "overallROI": 0},
                },
            }

        pairs_info = await trader_client.pairs_cache.get_pairs_info()
        pair_map = {int(k): f"{v.from_}/{v.to}" for k, v in pairs_info.items()}

        unique_assets = sorted(set(pair_map.get(t.trade.pair_index) for t in trades))
        feed_client = FeedClient(pair_fetcher=trader_client.pairs_cache.get_pairs_info)
        price_data = await feed_client.get_latest_price_updates(unique_assets)

        price_map = {asset: price_data.parsed[i].converted_price
                     for i, asset in enumerate(unique_assets)
                     if i < len(price_data.parsed)}

        positions, total_margin, total_pnl = [], 0.0, 0.0
        for trade in trades:
            td = trade.trade
            asset = pair_map.get(td.pair_index, f"Pair {td.pair_index}")
            margin = td.open_collateral
            pos_size = margin * td.leverage
            current_price = price_map.get(asset, td.open_price)
            pnl = (
                ((current_price - td.open_price) / td.open_price) * pos_size
                if td.is_long
                else ((td.open_price - current_price) / td.open_price) * pos_size
            )
            positions.append({
                "pairIndex": td.pair_index,
                "tradeIndex": td.trade_index,
                "asset": asset,
                "direction": "LONG" if td.is_long else "SHORT",
                "leverage": td.leverage,
                "positionSize": pos_size,
                "margin": margin,
                "entryPrice": td.open_price,
                "currentPrice": current_price,
                "takeProfit": td.tp,
                "stopLoss": td.sl,
                "liquidationPrice": trade.liquidation_price,
                "pnl": pnl,
                "roi": (pnl / margin * 100) if margin > 0 else 0,
            })
            total_margin += margin
            total_pnl += pnl

        print(f"[fetch-positions] found {len(positions)} positions")
        return {
            "success": True,
            "data": {
                "totalPositions": len(positions),
                "positions": positions,
                "summary": {
                    "totalPnL": total_pnl,
                    "totalMargin": total_margin,
                    "overallROI": (total_pnl / total_margin * 100) if total_margin > 0 else 0,
                },
            },
        }

    except Exception as e:
        print(f"[fetch-positions] error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Register API routers
app.include_router(spot_router, prefix="/api/v1", tags=["Spot Wallet Scanning"])
app.include_router(trending_router, prefix="/api/v1/trending", tags=["Trending Tokens"])
app.include_router(trader_router, prefix="/api/v1/trader", tags=["Top Traders"])
app.include_router(avantis_trade_router, prefix="/api/v1/trade", tags=["Avantis Trade Execution"])


if __name__ == "__main__":
    import uvicorn
    print(f"🌐 Starting server on port {settings.api_port}...")
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=settings.api_port,
        reload=True
    )
