# Poly-Agent v1 - Polymarket Copy Trading Agent

Real-time copy trading agent that monitors a target trader's Polymarket activity and replicates their trades.

## Features

- **Real-time detection** (3s polling of Polymarket /activity API)
- **FOK order execution** (immediate fill or cancel)
- **Slippage tracking** (dollar-value buffer, no blocking)
- **Position reconciliation** (60s checks, log discrepancies)
- **Simplified architecture** (only orderbook cache for speed)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         POLY-AGENT v1                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [Detector] → [Executor] → [Confirmer] → [Reconciler]           │
│     3s poll     FOK orders    WSS fills     60s checks           │
│                                                                  │
│  [OrderbookCache] ← WSS Market Channel (ONLY CACHE)             │
│  [MongoDB] ← Direct writes (no other caches)                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Module Responsibilities

| Module | Interval | Responsibility |
|--------|----------|----------------|
| **Detector** | 3s | Poll /activity for new trades, emit events |
| **Executor** | On event | Risk checks + FOK order submission |
| **Confirmer** | Real-time | WSS User Channel for trade fills |
| **Reconciler** | 60s | Compare positions, log gaps |

### Why Only One Cache?

- **OrderbookCache**: ✅ **Required** - provides 0ms price lookups on critical execution path
- ~~seenTrades cache~~: ❌ Removed - MongoDB unique index handles deduplication
- ~~balanceCache~~: ❌ Removed - testing with small positions ($50 max)
- ~~slippageTracker cache~~: ❌ Removed - direct MongoDB writes post-fill

## Prerequisites

1. **Dedicated Trading Wallet**
   - Create a NEW wallet specifically for this bot
   - Fund with USDC on Polygon mainnet
   - **NEVER use your main wallet** (contains private key)

2. **Polymarket API Credentials**
   - **IMPORTANT:** You must derive credentials from your bot wallet private key
   - Polymarket WebSocket requires credentials derived from your wallet, not manually created ones
   - See "Deriving API Credentials" section below
   - Store securely in `.env.polyagent` file (isolated from main app)

3. **MongoDB**
   - Uses existing `yieldr` database
   - Collections created automatically:
     - `poly-agent-trades` - All copy trade records
     - `poly-agent-slippage` - Running slippage buffer
     - `poly-agent-reconcile` - Position gap logs

## Installation

```bash
cd services/.private/poly-agent

# Install dependencies
npm install

# Copy environment template
cp .env.polyagent.example .env.polyagent

# Edit .env.polyagent and add:
# - TARGET_WALLET (trader to copy)
# - BOT_WALLET_ADDRESS (your MetaMask wallet address)
# - BOT_PRIVATE_KEY (your MetaMask wallet private key)
# - MONGODB_URI (MongoDB connection string)

# Derive API credentials (see next section)
npx ts-node derive-keys.ts
# OR
python3 derive-keys.py

# Copy the output credentials into .env.polyagent

# Run in development
npm run dev
```

## Deriving API Credentials

**CRITICAL:** Polymarket WebSocket User Channel requires API credentials derived from your wallet private key. You CANNOT use manually created API keys from the Polymarket UI.

### Option 1: TypeScript Script (Recommended)

```bash
# Make sure dependencies are installed
npm install

# Run the key derivation script
npx ts-node derive-keys.ts
```

### Option 2: Python Script

```bash
# Install Python dependencies
pip install -r requirements.txt

# Run the Python key derivation script
python3 derive-keys.py
```

Both scripts will:
1. Read your `BOT_PRIVATE_KEY` from `.env.polyagent` (secure - no hardcoded secrets)
2. Connect to Polymarket CLOB API using your wallet
3. Derive WebSocket-compatible API credentials
4. Print output for you to copy into `.env.polyagent`

**Example output:**
```
✅ SUCCESS! API Credentials derived:

════════════════════════════════════════════════════════════
Copy these values to your .env.polyagent file:
════════════════════════════════════════════════════════════

POLYMARKET_API_KEY="abc123..."
POLYMARKET_API_SECRET="def456..."
POLYMARKET_PASSPHRASE="ghi789..."

════════════════════════════════════════════════════════════
```

**Important Notes:**
- Your wallet needs a small amount of MATIC (~0.01) for gas to derive credentials
- Use your **MetaMask wallet** private key (the one you connected to Polymarket with)
- Do NOT use the Polymarket proxy wallet address
- These credentials are permanent unless you explicitly revoke them

## Configuration

Edit `.env.polyagent` file (isolated from main app secrets):

```env
# Target wallet to copy
TARGET_WALLET=0xcde6e9587582e568041e1aa0ea0b01793e1311d7

# Your bot wallet (dedicated wallet, NOT your main wallet)
BOT_WALLET_ADDRESS=0x...
BOT_PRIVATE_KEY=0x...

# Polymarket API credentials
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_PASSPHRASE=...

# MongoDB connection
MONGODB_URI=mongodb+srv://...

# Agent parameters
COPY_RATIO=0.05              # 5% of trader's size
MAX_POSITION_USDC=50         # Max $50 per position (testing)
MIN_TRADE_SIZE=1             # Minimum 1 share
```

## How It Works

### 1. Trade Detection (Detector)

- Polls Polymarket `/activity` API every 3 seconds
- Filters for TRADE events from target wallet
- Resumes from last seen trade in MongoDB
- Emits `trade:detected` event

### 2. Trade Execution (Executor)

**Deduplication:** MongoDB unique index on `txHash` auto-rejects duplicates

**Risk Checks** (in-memory, <5ms):
1. Calculate copy size: `traderSize × COPY_RATIO`
2. Check minimum size threshold
3. Get best price from orderbook cache (0ms lookup)
4. Cap at `MAX_POSITION_USDC`

**Execution:** Submit FOK (Fill-Or-Kill) order to CLOB API

### 3. Fill Confirmation (Confirmer)

- Connects to WebSocket User Channel (authenticated)
- Tracks submitted orders in `pendingOrders` Map
- Receives fill notifications via WSS
- Updates MongoDB with:
  - Executed size/price
  - Slippage (expectedCost - actualCost)
  - Cumulative slippage buffer

### 4. Position Reconciliation (Reconciler)

- Every 60 seconds: compare positions
- Fetch trader positions vs. our positions
- Calculate expected: `traderSize × COPY_RATIO`
- If gap > 5% AND > 1 share: log to MongoDB
- **v1 only logs gaps** (no auto-fix)

## Risk Checks

All checks are **in-memory** (no blocking API calls):

| Check | Action |
|-------|--------|
| Copy size < MIN_TRADE_SIZE | Skip trade |
| No orderbook data | Subscribe + skip (ready for next trade) |
| Order cost > MAX_POSITION_USDC | Cap size |
| Duplicate txHash | Skip (MongoDB unique index) |

## MongoDB Collections

### poly-agent-trades
```javascript
{
  originalTxHash: "0x1234...",  // Unique index
  original: { /* Trader's trade */ },
  copy: { /* Our execution */ },
  status: "FILLED",
  slippage: { /* Dollar slippage */ },
  detectedAt, executedAt, confirmedAt, latencyMs
}
```

### poly-agent-slippage
```javascript
{
  _id: "current",  // Singleton
  totalExpectedCost, totalActualCost,
  bufferUsdc,  // expectedCost - actualCost
  totalTrades, totalPositiveSlippage, totalNegativeSlippage
}
```

### poly-agent-reconcile
```javascript
{
  checkedAt, conditionId, title, outcome,
  traderPosition, expectedPosition, actualPosition,
  gapSize, gapPercent, gapDirection
}
```

## Running

### Development
```bash
npm run dev
```

### Production
```bash
npm run build
npm start
```

## Expected Console Output

```
═══════════════════════════════════════════════════════════════
                    POLY-AGENT v1
═══════════════════════════════════════════════════════════════
Target:     0xcde6e9587582e568041e1aa0ea0b01793e1311d7
Bot:        0x1234567890abcdef...
Copy Ratio: 5.0%
Max Size:   $50
Min Size:   1 shares
═══════════════════════════════════════════════════════════════

[Main] Connecting to MongoDB...
[DB] Connected to MongoDB (yieldr database)

[Main] Connecting to orderbook cache...
[OrderbookCache] ✅ Connected

[Main] Initializing CLOB client...
[CLOB] Wallet address: 0x1234567890abcdef...
[CLOB] ✅ Client ready

[Main] Connecting to User Channel...
[Confirmer] ✅ Authenticated

[Main] Initializing Executor...
[Executor] Initialized with nonce: 42

[Main] Starting Detector...
[Detector] Starting 3000ms polling for 0xcde6e9587582e568...

[Main] Starting Reconciler...
[Reconciler] Starting 60000ms position checks

✅ Poly-Agent is running. Listening for trades...

[Detector] 🎯 Trade detected!
  BUY 1000 Yes @ $0.4500
  Market: Will Bitcoin hit $98,000 by Dec 15?
  Value: $450.00
  TX: 0x1234abcd1234...

[Executor] Processing 0x1234abcd...
[OrderbookCache] Subscribing to 71321045679252...
[Executor] Placing FOK: BUY 50 @ $0.4550
[Executor] ✅ Submitted: order-xyz123 (287ms)

[Confirmer] Fill update: MATCHED - 50 @ 0.455
[Confirmer] ✅ FILLED: 50 @ $0.4550
  Slippage: -$0.25 (-1.11%)
  Buffer: $-0.25 (1 trades)

[Stats] ────────────────────────────────────────
  Trades: 1 (0 positive, 1 negative)
  Buffer: $-0.25
  Buffer %: -0.56%
────────────────────────────────────────────────

[Reconciler] Checking positions...
[Reconciler] ✅ All positions in sync
```

## Safety Features

1. **Unique index on txHash** - MongoDB prevents duplicate trades
2. **Max position size cap** - Never exceed `MAX_POSITION_USDC`
3. **Private directory** - Never committed to git (`.gitignore`)
4. **FOK orders** - Either fill completely or cancel (no partials)
5. **Graceful shutdown** - SIGINT/SIGTERM handlers

## Monitoring

### View Recent Trades
```javascript
// In MongoDB shell or Compass
use yieldr;
db['poly-agent-trades'].find().sort({ createdAt: -1 }).limit(10);
```

### View Slippage Buffer
```javascript
db['poly-agent-slippage'].findOne({ _id: 'current' });
```

### View Position Gaps
```javascript
db['poly-agent-reconcile'].find({ gapDirection: 'UNDER' }).sort({ checkedAt: -1 });
```

## Troubleshooting

### "No orderbook data" messages
- First trade in a new market always skipped (no data yet)
- Agent subscribes automatically
- Next trade in same market will execute

### Orders not filling (FOK cancelled)
- Orderbook lacks liquidity at target price
- FOK requires immediate FULL fill or cancels
- Check orderbook depth for the market

### Position gaps in reconciliation
- Expected: trades may fail or be skipped
- Check `poly-agent-trades` for FAILED/SKIPPED status
- v1 only logs gaps (no auto-fix)

### API rate limits
- Detector: 1 req/3s = ~3/10s (well under 200/10s limit)
- CLOB orders: ~1/trade (well under 2400/10s limit)

## API Documentation

- **Activity API**: https://docs.polymarket.com/api-reference/core/get-user-activity
- **Positions API**: https://docs.polymarket.com/api-reference/core/get-current-positions-for-a-user
- **CLOB Orders**: https://docs.polymarket.com/developers/CLOB/orders/create-order
- **Market WebSocket**: https://docs.polymarket.com/developers/CLOB/websocket/market-channel
- **User WebSocket**: https://docs.polymarket.com/developers/CLOB/websocket/user-channel

## Development

### Build TypeScript
```bash
npm run build
```

### Run Tests (TODO)
```bash
npm test
```

## Future Improvements (v2)

- [ ] Auto-reconciliation (fix position gaps)
- [ ] Slippage limits (block trades if buffer too negative)
- [ ] Multiple target wallets
- [ ] Web dashboard
- [ ] Telegram notifications
- [ ] Balance tracking and refills

## Security Warnings

⚠️ **NEVER commit `.env.polyagent` to git** (excluded via `.gitignore`)
⚠️ **NEVER share your `.env.polyagent` file** (contains private keys!)
⚠️ **NEVER use your main wallet** - create a dedicated bot wallet
⚠️ **Start with small amounts** - test with `MAX_POSITION_USDC=10` first

## Why `.env.polyagent`?

✅ **Better Security Isolation**
- Poly-agent secrets (private key, Polymarket API) stay separate from main app
- Root `.env.local` only has Next.js/app secrets
- If main app is compromised, trading bot keys are still safe
- Follows principle of least privilege

## License

Private - Not for distribution
