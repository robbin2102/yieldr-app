import asyncio
from avantis_trader_sdk import FeedClient, TraderClient

async def debug_price(rpc_url):
    trader_client = TraderClient(rpc_url)
    feed_client = FeedClient(pair_fetcher=trader_client.pairs_cache.get_pairs_info)
    
    price_data = await feed_client.get_latest_price_updates(["ENA/USD", "ZORA/USD"])
    
    print(f"Type: {type(price_data)}")
    print(f"Parsed length: {len(price_data.parsed)}")
    
    for i, parsed in enumerate(price_data.parsed):
        print(f"\n=== Parsed item {i} ===")
        print(f"Type: {type(parsed)}")
        print(f"Dir: {dir(parsed)}")
        print(f"Value: {parsed}")
        
        if hasattr(parsed, 'price'):
            print(f"\nPrice attribute type: {type(parsed.price)}")
            print(f"Price value: {parsed.price}")
            
            if isinstance(parsed.price, dict):
                print(f"Price keys: {parsed.price.keys()}")
                for key, val in parsed.price.items():
                    print(f"  {key}: {val} (type: {type(val)})")

if __name__ == "__main__":
    import sys
    rpc_url = sys.argv[1]
    asyncio.run(debug_price(rpc_url))
