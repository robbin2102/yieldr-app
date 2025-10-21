import asyncio
from avantis_trader_sdk import TraderClient

async def debug_pairs(rpc_url):
    trader_client = TraderClient(rpc_url)
    pairs_info = await trader_client.pairs_cache.get_pairs_info()
    
    print(f"Type: {type(pairs_info)}")
    print(f"Length: {len(pairs_info) if hasattr(pairs_info, '__len__') else 'N/A'}")
    
    if isinstance(pairs_info, dict):
        print("\n=== It's a dictionary ===")
        for key, value in list(pairs_info.items())[:2]:
            print(f"\nKey: {key}")
            print(f"Value type: {type(value)}")
            print(f"Value: {value}")
            if hasattr(value, '__dict__'):
                print(f"Attributes: {value.__dict__}")
    elif isinstance(pairs_info, list):
        print("\n=== It's a list ===")
        if len(pairs_info) > 0:
            print(f"First item type: {type(pairs_info[0])}")
            print(f"First item: {pairs_info[0]}")

if __name__ == "__main__":
    import sys
    rpc_url = sys.argv[1]
    asyncio.run(debug_pairs(rpc_url))
