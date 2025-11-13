# Avantis Position Timestamp Investigation

## Problem
Avantis positions currently show fetch time instead of position open time.

## Findings

### Current SDK Data
The Avantis SDK returns:
- `pairIndex`: Asset pair identifier
- `tradeIndex`: Unique trade identifier
- `open_price`, `open_collateral`, `leverage`, etc.
- **NO timestamp fields visible in API response**

### Potential Solutions

#### 1. Check SDK Source Code
Look for timestamp fields in the SDK:
```python
# Possible fields to check:
- trade.timestamp
- trade.open_timestamp
- trade.trade.block_number
- trade.trade.created_at
```

#### 2. Query Blockchain Events (RECOMMENDED)
Each Avantis trade opening triggers a `TradeOpened` or `TradeStored` event on-chain.

**Contract:** Avantis Trading contract on Base
**Event signature:** Look for events with tradeIndex

**Implementation:**
```python
from web3 import Web3

async def get_trade_open_timestamp(web3, trade_index, pair_index, trader_address):
    """
    Query blockchain for when a trade was opened
    """
    # Avantis Trading contract address on Base
    TRADING_CONTRACT = "0x..." # Find from Avantis docs

    # Event signature for TradeStored/TradeOpened
    event_signature = Web3.keccak(text="TradeStored(address,uint256,uint256)")

    # Query logs
    logs = web3.eth.get_logs({
        'address': TRADING_CONTRACT,
        'topics': [event_signature],
        'fromBlock': 'earliest',  # Or use a starting block
        'toBlock': 'latest'
    })

    # Filter for this specific trade
    for log in logs:
        # Decode log data to get tradeIndex
        # Match with our trade
        # Get block timestamp
        block = web3.eth.get_block(log['blockNumber'])
        return block['timestamp']
```

#### 3. Use First-Seen Time (FALLBACK)
Store position data in MongoDB with logic:
```javascript
// In /app/api/positions/route.ts
const existingPosition = await db.collection('positions').findOne({
  walletAddress,
  platform: 'Avantis',
  positionId: pos.tradeIndex
});

const createdAt = existingPosition?.createdAt || new Date();
```

## Next Steps
1. Find Avantis contract addresses on Base
2. Identify the event signature for trade opening
3. Implement blockchain query function
4. Add to python service or create separate endpoint

## Resources
- Avantis Docs: https://docs.avantisfi.com/
- Base Mainnet RPC: QuickNode (already configured)
- Avantis Contracts: Check BaseScan for verified contracts
