"""
Yieldr Data Services API
FastAPI application for token scanning, trader indexing, and market data.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
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
    """
    Health check endpoint.
    Returns service status and version.
    """
    return {
        "status": "healthy",
        "service": "Yieldr Data Services",
        "version": "1.0.0"
    }


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
