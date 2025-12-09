#!/usr/bin/env python3
"""
Script to derive Polymarket CLOB API credentials using Python

These credentials are required for WebSocket authentication.
Run: python3 derive-keys.py
"""

import os
from pathlib import Path
from dotenv import load_dotenv
from py_clob_client.client import ClobClient

def derive_api_keys():
    print('\n🔑 Deriving Polymarket CLOB API Credentials...\n')

    # Load environment variables from .env.polyagent
    env_path = Path(__file__).parent / '.env.polyagent'
    load_dotenv(dotenv_path=env_path)

    # Get private key from environment
    private_key = os.getenv('BOT_PRIVATE_KEY')

    if not private_key:
        print('❌ Error: BOT_PRIVATE_KEY not found in environment')
        print('Make sure .env.polyagent is present with BOT_PRIVATE_KEY set')
        print('  BOT_PRIVATE_KEY="0x..."')
        exit(1)

    if not private_key.startswith('0x'):
        print('❌ Error: BOT_PRIVATE_KEY must start with 0x')
        exit(1)

    try:
        # Initialize CLOB client
        client = ClobClient(
            host='https://clob.polymarket.com',
            key=private_key,
            chain_id=137  # Polygon chain ID
        )

        print(f'Wallet address: {client.address}\n')
        print('🔄 Deriving API credentials from wallet...\n')

        # Derive API credentials
        api_creds = client.derive_api_key()

        print('✅ SUCCESS! API Credentials derived:\n')
        print('════════════════════════════════════════════════════════════')
        print('Copy these values to your .env.polyagent file:')
        print('════════════════════════════════════════════════════════════\n')
        print(f'POLYMARKET_API_KEY="{api_creds.api_key}"')
        print(f'POLYMARKET_API_SECRET="{api_creds.api_secret}"')
        print(f'POLYMARKET_PASSPHRASE="{api_creds.api_passphrase}"')
        print('\n════════════════════════════════════════════════════════════')
        print('\n⚠️  IMPORTANT: Keep these credentials secure!')
        print('Replace the existing values in .env.polyagent with the above.\n')

    except Exception as error:
        print(f'\n❌ Error deriving API credentials:')
        print(str(error))

        if 'insufficient funds' in str(error).lower():
            print('\n💡 Your wallet needs a small amount of MATIC for gas.')
            print('   Send ~0.01 MATIC to your MetaMask wallet address')

        exit(1)

if __name__ == '__main__':
    derive_api_keys()
