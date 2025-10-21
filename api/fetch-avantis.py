from http.server import BaseHTTPRequestHandler
import json
import sys
import asyncio
from urllib.parse import parse_qs, urlparse

# Add the scripts directory to path
sys.path.insert(0, './scripts/python')

try:
    from avantis_trader_sdk import TraderClient, FeedClient
except ImportError:
    # Fallback if import fails
    pass

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            # Get request body
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            wallet_address = data.get('walletAddress')
            rpc_url = data.get('rpcUrl', 'https://mainnet.base.org')
            
            if not wallet_address:
                self.send_response(400)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({
                    'success': False,
                    'error': 'walletAddress required'
                }).encode())
                return
            
            # Fetch positions
            result = asyncio.run(self.fetch_positions(wallet_address, rpc_url))
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'success': False,
                'error': str(e)
            }).encode())
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    async def fetch_positions(self, trader_address, rpc_url):
        try:
            trader_client = TraderClient(rpc_url)
            
            trades, _ = await trader_client.trade.get_trades(trader_address)
            pairs_info = await trader_client.pairs_cache.get_pairs_info()
            
            pair_map = {}
            for pair_index, pair_data in pairs_info.items():
                asset_name = f"{pair_data.from_}/{pair_data.to}"
                pair_map[int(pair_index)] = asset_name
            
            unique_assets = list(set([pair_map.get(trade.trade.pair_index) for trade in trades]))
            
            feed_client = FeedClient(pair_fetcher=trader_client.pairs_cache.get_pairs_info)
            price_data = await feed_client.get_latest_price_updates(unique_assets)
            
            price_map = {}
            for i, asset in enumerate(unique_assets):
                if i < len(price_data.parsed):
                    price_feed = price_data.parsed[i]
                    price_map[asset] = price_feed.converted_price
            
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
                tp = trade_data.tp
                sl = trade_data.sl
                liq_price = trade.liquidation_price
                
                current_price = price_map.get(asset, entry_price)
                
                if is_long:
                    price_change_pct = (current_price - entry_price) / entry_price
                    pnl = price_change_pct * position_size
                else:
                    price_change_pct = (entry_price - current_price) / entry_price
                    pnl = price_change_pct * position_size
                
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
            return {
                'success': False,
                'error': str(e)
            }
