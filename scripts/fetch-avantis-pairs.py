#!/usr/bin/env python3
"""
Fetch Avantis trading pairs from blockchain and save to MongoDB
Uses the Avantis Trader SDK to fetch pair information
"""

import asyncio
import os
import sys
from datetime import datetime
from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError

# Add parent directory to path to allow imports
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Load environment variables from .env.local
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', '.env.local'))

# Import Avantis SDK
try:
    from avantis_trader_sdk import TraderClient
    print(f"✓ Avantis Trader SDK loaded successfully")
except ImportError as e:
    print("❌ Error: Avantis Trader SDK not installed")
    print("   Please install it with: pip install avantis-trader-sdk")
    sys.exit(1)


async def fetch_pairs_from_blockchain(provider_url: str):
    """
    Fetch trading pairs from Avantis using the SDK

    Args:
        provider_url: Base mainnet RPC URL

    Returns:
        Dictionary of pairs information
    """
    print(f"🔌 Connecting to Base RPC...")
    trader_client = TraderClient(provider_url)

    print("📊 Fetching pairs information from blockchain...")
    pairs_info = await trader_client.pairs_cache.get_pairs_info()

    pairs_count = await trader_client.pairs_cache.get_pairs_count()
    print(f"✓ Found {pairs_count} trading pairs")

    return pairs_info


def save_pairs_to_mongodb(pairs_info: dict, mongodb_uri: str):
    """
    Save pairs information to MongoDB

    Args:
        pairs_info: Dictionary of pairs data from blockchain
        mongodb_uri: MongoDB connection string
    """
    print(f"\n🔌 Connecting to MongoDB...")

    # Parse MongoDB URI to extract database name
    # Format: mongodb+srv://user:pass@host/dbname?params
    db_name = 'yieldr'  # Default
    if '/' in mongodb_uri:
        parts = mongodb_uri.split('/')
        if len(parts) >= 4:
            db_part = parts[3].split('?')[0]
            if db_part:
                db_name = db_part

    client = MongoClient(mongodb_uri)
    db = client[db_name]
    pairs_collection = db['avantispairs']

    print(f"✓ Connected to MongoDB database: {db_name}")
    print(f"📝 Saving to collection: avantispairs")

    # Clear existing pairs (to ensure fresh data)
    result = pairs_collection.delete_many({})
    print(f"🗑️  Cleared {result.deleted_count} old pair records")

    # Insert new pairs
    pairs_list = []
    for pair_index, pair_data in pairs_info.items():
        # Build document
        # pair_data is a PairInfoWithData Pydantic model
        doc = {
            'pairIndex': int(pair_index),
            'from': pair_data.from_,  # Note: 'from_' because 'from' is Python keyword
            'to': pair_data.to,
            'symbol': f"{pair_data.from_}/{pair_data.to}",
            'groupIndex': pair_data.group_index,
            'feeIndex': pair_data.fee_index,
            'maxLeverage': pair_data.leverages.max_leverage,
            'minLeverage': pair_data.leverages.min_leverage,
            'spreadP': pair_data.constant_spread_bps,
            'updatedAt': datetime.utcnow(),
        }
        pairs_list.append(doc)

    if pairs_list:
        result = pairs_collection.insert_many(pairs_list)
        print(f"✓ Inserted {len(result.inserted_ids)} pairs into MongoDB")
    else:
        print("⚠️  No pairs to insert")

    # Create index on pairIndex for fast lookups
    pairs_collection.create_index('pairIndex', unique=True)
    print("✓ Created index on pairIndex")

    client.close()

    return len(pairs_list)


async def main():
    """Main function"""
    print("=" * 60)
    print("Avantis Pairs Fetcher")
    print("=" * 60)
    print()

    # Get environment variables
    rpc_url = os.getenv('QUICKNODE_BASE_RPC_URL')
    mongodb_uri = os.getenv('MONGODB_URI')

    if not rpc_url:
        print("❌ Error: QUICKNODE_BASE_RPC_URL not found in .env.local")
        print("   Please add your QuickNode Base RPC URL to .env.local")
        sys.exit(1)

    if not mongodb_uri:
        print("❌ Error: MONGODB_URI not found in .env.local")
        print("   Please add your MongoDB connection string to .env.local")
        sys.exit(1)

    # Hide password in MongoDB URI for logging
    safe_mongodb_uri = mongodb_uri
    if '@' in safe_mongodb_uri:
        parts = safe_mongodb_uri.split('@')
        if ':' in parts[0]:
            user_pass = parts[0].split(':')
            safe_mongodb_uri = f"{user_pass[0]}:***@{parts[1]}"

    print(f"📡 RPC URL: {rpc_url[:50]}...")
    print(f"🗄️  MongoDB: {safe_mongodb_uri[:60]}...")
    print()

    try:
        # Fetch pairs from blockchain
        pairs_info = await fetch_pairs_from_blockchain(rpc_url)

        # Save to MongoDB
        count = save_pairs_to_mongodb(pairs_info, mongodb_uri)

        print()
        print("=" * 60)
        print("✅ Pairs fetch complete!")
        print(f"✓ {count} pairs saved to MongoDB")
        print("=" * 60)

    except Exception as e:
        print()
        print("=" * 60)
        print(f"❌ Error: {str(e)}")
        print("=" * 60)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
