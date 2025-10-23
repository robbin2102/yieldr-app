from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import asyncio
import os
from avantis_trader_sdk import TraderClient, FeedClient

app = FastAPI(title="Yieldr Python Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_RPC = os.getenv('QUICKNODE_BASE_RPC_URL', 'https://mainnet.base.org')

class FetchRequest(BaseModel):
    walletAddress: str
    rpcUrl: str = None

@app.get("/")
async def root():
    return {"service": "Yieldr Python Service", "status": "running"}

@app.get("/health")
async def health():
    return {"status": "healthy", "rpc": DEFAULT_RPC[:50] + "..."}

@app.post("/fetch-positions")
async def fetch_positions(request: FetchRequest):
    try:
        rpc_url = request.rpcUrl if request.rpcUrl else DEFAULT_RPC
        print(f"Using RPC: {rpc_url[:50]}...")
        
        trader_client = TraderClient(rpc_url)
        trades, _ = await trader_client.trade.get_trades(request.walletAddress)
        
        if len(trades) == 0:
            return {
                'success': True,
                'data': {
                    'totalPositions': 0,
                    'positions': [],
                    'summary': {'totalPnL': 0, 'totalMargin': 0, 'overallROI': 0}
                }
            }
        
        pairs_info = await trader_client.pairs_cache.get_pairs_info()
        pair_map = {}
        for pair_index, pair_data in pairs_info.items():
            pair_map[int(pair_index)] = f"{pair_data.from_}/{pair_data.to}"
        
        unique_assets = list(set([pair_map.get(trade.trade.pair_index) for trade in trades]))
        feed_client = FeedClient(pair_fetcher=trader_client.pairs_cache.get_pairs_info)
        price_data = await feed_client.get_latest_price_updates(unique_assets)
        
        price_map = {}
        for i, asset in enumerate(unique_assets):
            if i < len(price_data.parsed):
                price_map[asset] = price_data.parsed[i].converted_price
        
        positions = []
        total_margin = 0
        total_pnl = 0
        
        for trade in trades:
            trade_data = trade.trade
            pair_index = trade_data.pair_index
            asset = pair_map.get(pair_index, f"Pair {pair_index}")
            
            margin = trade_data.open_collateral
            leverage = trade_data.leverage
            position_size = margin * leverage
            entry_price = trade_data.open_price
            is_long = trade_data.is_long
            current_price = price_map.get(asset, entry_price)
            
            if is_long:
                pnl = ((current_price - entry_price) / entry_price) * position_size
            else:
                pnl = ((entry_price - current_price) / entry_price) * position_size
            
            roi = (pnl / margin * 100) if margin > 0 else 0
            
            positions.append({
                'pairIndex': pair_index,
                'tradeIndex': trade_data.trade_index,
                'asset': asset,
                'direction': 'LONG' if is_long else 'SHORT',
                'leverage': leverage,
                'positionSize': position_size,
                'margin': margin,
                'entryPrice': entry_price,
                'currentPrice': current_price,
                'takeProfit': trade_data.tp,
                'stopLoss': trade_data.sl,
                'liquidationPrice': trade.liquidation_price,
                'pnl': pnl,
                'roi': roi,
            })
            
            total_margin += margin
            total_pnl += pnl
        
        return {
            'success': True,
            'data': {
                'totalPositions': len(positions),
                'positions': positions,
                'summary': {
                    'totalPnL': total_pnl,
                    'totalMargin': total_margin,
                    'overallROI': (total_pnl / total_margin * 100) if total_margin > 0 else 0
                }
            }
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
