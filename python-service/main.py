from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import asyncio
import os
from web3 import Web3
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

class BatchFetchRequest(BaseModel):
    walletAddresses: list[str]
    rpcUrl: str = None

@app.get("/")
async def root():
    return {"service": "Yieldr Python Service", "status": "running"}

@app.get("/health")
async def health():
    return {"status": "healthy", "rpc": DEFAULT_RPC[:50] + "..."}

async def fetch_positions_for_wallet(wallet_address: str, rpc_url: str, trader_client: TraderClient):
    """Helper function to fetch positions for a single wallet"""
    try:
        # CRITICAL FIX: Convert address to checksum format
        checksummed_address = Web3.to_checksum_address(wallet_address.lower())

        print(f"Fetching positions for: {checksummed_address}")

        trades, _ = await trader_client.trade.get_trades(checksummed_address)

        if len(trades) == 0:
            return {
                'walletAddress': wallet_address,
                'totalPositions': 0,
                'positions': [],
                'summary': {'totalPnL': 0, 'totalMargin': 0, 'overallROI': 0}
            }

        return {
            'walletAddress': wallet_address,
            'trades': trades,
            'hasPositions': True
        }
    except Exception as e:
        print(f"❌ Error fetching wallet {wallet_address}: {str(e)}")
        return {
            'walletAddress': wallet_address,
            'totalPositions': 0,
            'positions': [],
            'summary': {'totalPnL': 0, 'totalMargin': 0, 'overallROI': 0},
            'error': str(e)
        }

@app.post("/fetch-positions")
async def fetch_positions(request: FetchRequest):
    """Single wallet endpoint (kept for backwards compatibility)"""
    try:
        rpc_url = request.rpcUrl if request.rpcUrl else DEFAULT_RPC

        # CRITICAL FIX: Convert address to checksum format
        checksummed_address = Web3.to_checksum_address(request.walletAddress.lower())

        print(f"Using RPC: {rpc_url[:50]}...")
        print(f"Fetching positions for: {checksummed_address}")

        trader_client = TraderClient(rpc_url)
        trades, _ = await trader_client.trade.get_trades(checksummed_address)

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

        # Get unique assets - use sorted list to ensure consistent ordering
        unique_assets = sorted(list(set([pair_map.get(trade.trade.pair_index) for trade in trades])))
        feed_client = FeedClient(pair_fetcher=trader_client.pairs_cache.get_pairs_info)
        price_data = await feed_client.get_latest_price_updates(unique_assets)

        print(f"📊 Fetching prices for {len(unique_assets)} unique assets")
        print(f"📊 Price data received: {len(price_data.parsed)} prices")

        # CRITICAL FIX: Map prices correctly by matching order
        # The feed client returns prices in the SAME ORDER as requested
        price_map = {}
        for i, asset in enumerate(unique_assets):
            if i < len(price_data.parsed):
                price_map[asset] = price_data.parsed[i].converted_price
                print(f"✅ {asset}: ${price_data.parsed[i].converted_price:.4f}")
            else:
                print(f"⚠️  Missing price for {asset}")

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

            # Debug: Check if we're using fallback price
            if asset not in price_map:
                print(f"⚠️  Using fallback price for {asset}: entry={entry_price}")

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

        print(f"✅ Found {len(positions)} positions")

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
        print(f"❌ Error: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/fetch-positions-batch")
async def fetch_positions_batch(request: BatchFetchRequest):
    """Optimized batch endpoint - fetches positions for multiple wallets in parallel"""
    try:
        rpc_url = request.rpcUrl if request.rpcUrl else DEFAULT_RPC
        wallets = request.walletAddresses

        print(f"🚀 Batch request for {len(wallets)} wallets")
        print(f"Using RPC: {rpc_url[:50]}...")

        # Create single trader client (reused for all wallets)
        trader_client = TraderClient(rpc_url)

        # Fetch trades for all wallets in parallel
        wallet_results = await asyncio.gather(*[
            fetch_positions_for_wallet(wallet, rpc_url, trader_client)
            for wallet in wallets
        ])

        # Collect all trades from wallets with positions
        all_trades = []
        wallet_data = {}
        for result in wallet_results:
            if result.get('hasPositions'):
                all_trades.extend(result['trades'])
                wallet_data[result['walletAddress']] = result['trades']

        if len(all_trades) == 0:
            print(f"ℹ️  No positions found across {len(wallets)} wallets")
            return {
                'success': True,
                'data': {
                    'walletsProcessed': len(wallets),
                    'totalPositions': 0,
                    'positionsByWallet': {},
                    'summary': {'totalPnL': 0, 'totalMargin': 0, 'overallROI': 0}
                }
            }

        # Get pairs info (once for all wallets)
        pairs_info = await trader_client.pairs_cache.get_pairs_info()
        pair_map = {}
        for pair_index, pair_data in pairs_info.items():
            pair_map[int(pair_index)] = f"{pair_data.from_}/{pair_data.to}"

        # Get unique assets across ALL wallets
        unique_assets = sorted(list(set([pair_map.get(trade.trade.pair_index) for trade in all_trades])))

        # Fetch prices ONCE for all assets
        feed_client = FeedClient(pair_fetcher=trader_client.pairs_cache.get_pairs_info)
        price_data = await feed_client.get_latest_price_updates(unique_assets)

        print(f"📊 Fetching prices for {len(unique_assets)} unique assets")
        print(f"📊 Price data received: {len(price_data.parsed)} prices")

        # Build price map
        price_map = {}
        for i, asset in enumerate(unique_assets):
            if i < len(price_data.parsed):
                price_map[asset] = price_data.parsed[i].converted_price
                print(f"✅ {asset}: ${price_data.parsed[i].converted_price:.4f}")

        # Process positions for each wallet
        positions_by_wallet = {}
        total_margin_all = 0
        total_pnl_all = 0
        total_positions_count = 0

        for wallet_address, trades in wallet_data.items():
            positions = []
            wallet_margin = 0
            wallet_pnl = 0

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

                wallet_margin += margin
                wallet_pnl += pnl

            positions_by_wallet[wallet_address] = {
                'positions': positions,
                'summary': {
                    'totalPositions': len(positions),
                    'totalPnL': wallet_pnl,
                    'totalMargin': wallet_margin,
                    'overallROI': (wallet_pnl / wallet_margin * 100) if wallet_margin > 0 else 0
                }
            }

            total_margin_all += wallet_margin
            total_pnl_all += wallet_pnl
            total_positions_count += len(positions)

        print(f"✅ Found {total_positions_count} positions across {len(wallet_data)} wallets")

        return {
            'success': True,
            'data': {
                'walletsProcessed': len(wallets),
                'walletsWithPositions': len(wallet_data),
                'totalPositions': total_positions_count,
                'positionsByWallet': positions_by_wallet,
                'summary': {
                    'totalPnL': total_pnl_all,
                    'totalMargin': total_margin_all,
                    'overallROI': (total_pnl_all / total_margin_all * 100) if total_margin_all > 0 else 0
                }
            }
        }
    except Exception as e:
        print(f"❌ Batch error: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
