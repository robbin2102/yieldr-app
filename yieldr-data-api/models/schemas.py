"""
MongoDB Collection Schemas for Yieldr Data API

This file documents the structure of all MongoDB collections.
Collections are accessed via Motor (async MongoDB driver).
"""

from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field


class TokenMetrics(BaseModel):
    """Trader's performance metrics for a specific token."""
    token_address: str
    symbol: str
    is_profitable: bool = False  # Found in top profitable traders
    is_whale: bool = False  # Found in top holders

    # From Moralis profitable endpoint
    pnl_usd: Optional[float] = None
    avg_buy_price_usd: Optional[float] = None
    avg_sell_price_usd: Optional[float] = None
    total_bought: Optional[float] = None
    total_sold: Optional[float] = None

    # From Moralis holders endpoint
    total_holdings: Optional[float] = None
    holding_percentage: Optional[float] = None  # % of total supply


class TraderPerformance(BaseModel):
    """Computed performance metrics for trader profile UI."""

    # Total AUM
    total_aum_usd: float = 0.0
    total_positions: int = 0

    # ROI metrics
    roi_1d_pct: float = 0.0
    roi_7d_pct: float = 0.0
    roi_30d_pct: float = 0.0
    pnl_1d_usd: float = 0.0
    pnl_7d_usd: float = 0.0
    pnl_30d_usd: float = 0.0

    # Win rate
    win_rate_pct: float = 0.0
    total_trades: int = 0
    total_wins: int = 0
    total_losses: int = 0

    # Average performance
    avg_win_usd: float = 0.0
    avg_loss_usd: float = 0.0
    best_trade_usd: float = 0.0
    best_trade_token: Optional[str] = None
    worst_trade_usd: float = 0.0
    worst_trade_token: Optional[str] = None

    # Risk metrics
    sharpe_ratio: float = 0.0
    max_drawdown_pct: float = 0.0
    avg_leverage: float = 1.0  # Default 1x (no leverage on Base DEX spot)
    max_leverage: float = 1.0


class AssetPerformance(BaseModel):
    """Performance breakdown by asset."""
    asset_symbol: str
    trades: int
    win_rate_pct: float
    best_win_usd: float
    worst_loss_usd: float
    pnl_usd: float


# MongoDB Collection Schemas (as dictionaries for documentation)

TOP_TRADERS_SCHEMA = {
    "_id": "ObjectId",
    "wallet_address": "str (lowercase, checksummed)",
    "chain": "str (base)",
    "tokens": [
        {
            "token_address": "str",
            "symbol": "str",
            "is_profitable": "bool",
            "is_whale": "bool",
            "pnl_usd": "float | None",
            "avg_buy_price_usd": "float | None",
            "avg_sell_price_usd": "float | None",
            "total_bought": "float | None",
            "total_sold": "float | None",
            "total_holdings": "float | None",
            "holding_percentage": "float | None"
        }
    ],
    "performance": {
        "total_aum_usd": "float",
        "total_positions": "int",
        "roi_1d_pct": "float",
        "roi_7d_pct": "float",
        "roi_30d_pct": "float",
        "pnl_1d_usd": "float",
        "pnl_7d_usd": "float",
        "pnl_30d_usd": "float",
        "win_rate_pct": "float",
        "total_trades": "int",
        "total_wins": "int",
        "total_losses": "int",
        "avg_win_usd": "float",
        "avg_loss_usd": "float",
        "best_trade_usd": "float",
        "best_trade_token": "str | None",
        "worst_trade_usd": "float",
        "worst_trade_token": "str | None",
        "sharpe_ratio": "float",
        "max_drawdown_pct": "float",
        "avg_leverage": "float",
        "max_leverage": "float"
    },
    "asset_performance": [
        {
            "asset_symbol": "str",
            "trades": "int",
            "win_rate_pct": "float",
            "best_win_usd": "float",
            "worst_loss_usd": "float",
            "pnl_usd": "float"
        }
    ],
    "status": "str (active | inactive)",
    "indexed_at": "datetime",
    "last_swap_indexed": "datetime | None",
    "backfill_status": "str (pending | in_progress | completed)"
}

TRADER_SWAPS_SCHEMA = {
    "_id": "ObjectId",
    "wallet_address": "str (lowercase)",
    "chain": "str (base)",
    "token_address": "str (the token being transferred)",
    "token_symbol": "str",
    "type": "str (buy | sell)",
    "amount_raw": "str (hex or decimal string)",
    "amount": "float (normalized by decimals)",
    "value_usd": "float | None",
    "from_address": "str (transfer from)",
    "to_address": "str (transfer to)",
    "dex": "str | None (uniswap_v3 | aerodrome | unknown)",
    "tx_hash": "str",
    "block_number": "int",
    "log_index": "int",
    "timestamp": "datetime",
    "indexed_at": "datetime",
    "processed": "bool (for PnL computation)"
}

TRENDING_TOKENS_SCHEMA = {
    "_id": "ObjectId",
    "token_address": "str (lowercase)",
    "chain": "str (base)",
    "symbol": "str",
    "name": "str",
    "price_usd": "float | None",
    "volume_24h_usd": "float",
    "price_change_24h_pct": "float",
    "pool_address": "str",
    "dex": "str (uniswap_v3 | aerodrome)",
    "indexed_at": "datetime",
    "trader_count": "int (number of tracked traders for this token)",
    "rank": "int (1-100)"
}


# MongoDB Indexes
INDEXES = {
    "top_traders": [
        {"keys": [("wallet_address", 1)], "unique": True},
        {"keys": [("status", 1), ("indexed_at", -1)]},
        {"keys": [("tokens.token_address", 1)]},
        {"keys": [("performance.pnl_30d_usd", -1)]}  # For leaderboard
    ],
    "trader_swaps": [
        {"keys": [("wallet_address", 1), ("timestamp", -1)]},
        {"keys": [("token_address", 1), ("timestamp", -1)]},
        {"keys": [("tx_hash", 1), ("log_index", 1)], "unique": True},
        {"keys": [("timestamp", -1)]},  # For cleanup
        {"keys": [("processed", 1)]}  # For PnL computation queue
    ],
    "trending_tokens": [
        {"keys": [("token_address", 1), ("chain", 1)], "unique": True},
        {"keys": [("rank", 1)]},
        {"keys": [("indexed_at", -1)]}
    ]
}
