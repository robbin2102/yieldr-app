#!/usr/bin/env python3
"""
Fixed Avantis Position Fetcher with Correct Margin and PnL
"""
import sys
import json
import asyncio
from avantis_trader_sdk import TraderClient, FeedClient

async def fetch_positions(trader_address, rpc_url):
    try:
        trader_client = TraderClient(rpc_url)
        
        # Fetch trades and pairs info
        trades, _ = await trader_client.trade.get_trades(trader_address)
        pairs_info = await trader_client.pairs_cache.get_pairs_info()
        
        # Create pair mapping
        pair_map = {}
        for pair_index, pair_data in pairs_info.items():
            asset_name = f"{pair_data.from_}/{pair_data.to}"
            pair_map[int(pair_index)] = asset_name
        
        # Get unique asset names from trades
        unique_assets = list(set([pair_map.get(trade.trade.pair_index) for trade in trades]))
        
        # Fetch current prices using FeedClient
        print(f"Fetching prices for: {unique_assets}", file=sys.stderr)
        feed_client = FeedClient(pair_fetcher=trader_client.pairs_cache.get_pairs_info)
        price_data = await feed_client.get_latest_price_updates(unique_assets)
        
        # Create price map
        price_map = {}
        for i, asset in enumerate(unique_assets):
            if i < len(price_data.parsed):
                price_feed = price_data.parsed[i]
                price_map[asset] = price_feed.converted_price
        
        print(f"Got prices: {price_map}", file=sys.stderr)
        
        positions = []
        total_margin = 0
        total_pnl = 0
        
        for trade in trades:
            trade_data = trade.trade
            pair_index = trade_data.pair_index
            asset = pair_map.get(pair_index, f"Pair {pair_index}")
            
            # ✅ Use open_collateral (actual margin)
            margin = trade_data.open_collateral
            leverage = trade_data.leverage
            position_size = margin * leverage
            
            entry_price = trade_data.open_price
            is_long = trade_data.is_long
            tp = trade_data.tp
            sl = trade_data.sl
            liq_price = trade.liquidation_price
            
            # Get current price from price map
            current_price = price_map.get(asset, entry_price)
            
            # Calculate PnL based on direction
            if is_long:
                # Long: profit when price goes up
                price_change_pct = (current_price - entry_price) / entry_price
                pnl = price_change_pct * position_size
            else:
                # Short: profit when price goes down
                price_change_pct = (entry_price - current_price) / entry_price
                pnl = price_change_pct * position_size
            
            # Calculate ROI
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
                'takeProfit': tp,
                'stopLoss': sl,
                'liquidationPrice': liq_price,
                'pnl': pnl,
                'roi': roi,
            })
            
            total_margin += margin
            total_pnl += pnl
        
        result = {
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
        
        print(json.dumps(result))
    
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(json.dumps({'success': False, 'error': str(e), 'details': error_details}), file=sys.stderr)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({'success': False, 'error': 'Address and RPC URL required'}))
        sys.exit(1)
    
    trader_address = sys.argv[1]
    rpc_url = sys.argv[2]
    asyncio.run(fetch_positions(trader_address, rpc_url))
