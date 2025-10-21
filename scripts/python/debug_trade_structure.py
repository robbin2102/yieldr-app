import asyncio
from avantis_trader_sdk import TraderClient

async def debug_trades(trader_address, rpc_url):
    trader_client = TraderClient(rpc_url)
    trades, pending_orders = await trader_client.trade.get_trades(trader_address)
    
    if len(trades) > 0:
        trade = trades[0]
        print("=== Full Trade Object ===")
        print(f"Type: {type(trade)}")
        print(f"\nTrade attributes:")
        for attr in dir(trade):
            if not attr.startswith('_'):
                try:
                    value = getattr(trade, attr)
                    if not callable(value):
                        print(f"  {attr}: {value}")
                except:
                    pass
        
        print("\n=== Trade.trade Object ===")
        trade_data = trade.trade
        print(f"Type: {type(trade_data)}")
        print(f"\nTrade.trade attributes:")
        for attr in dir(trade_data):
            if not attr.startswith('_'):
                try:
                    value = getattr(trade_data, attr)
                    if not callable(value):
                        print(f"  {attr}: {value}")
                except:
                    pass

if __name__ == "__main__":
    import sys
    trader_address = sys.argv[1]
    rpc_url = sys.argv[2]
    asyncio.run(debug_trades(trader_address, rpc_url))
