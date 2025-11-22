# Avantis Event Listener Service

Real-time blockchain event monitoring service for tracking Avantis trading activity on Base chain. Built for the Yieldr platform to enable comprehensive performance tracking and future features like automated trade mirroring.

## Overview

This service provides:
- **Real-time monitoring** - WebSocket/polling for live trade events
- **Historical backfilling** - Fetch past trades for new managers
- **Event correlation** - Match order initiation with execution by orderId
- **Performance metrics** - Calculate daily/weekly/monthly PnL, win rate, ROI
- **Plugin architecture** - Extensible system for future features (copy trading, analytics, notifications)
- **API endpoints** - Query trades, stats, and trigger backfills

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Base Blockchain                         │
│                                                              │
│  Trading Contract (0x44914408...)  Events Contract (0x0c16ff40...)
│         │                                    │               │
│         │ MarketOrderInitiated              │ MarketExecuted│
└─────────┼────────────────────────────────────┼───────────────┘
          │                                    │
          ▼                                    ▼
     ┌────────────────────────────────────────────┐
     │        EventListener (viem watchEvent)     │
     └────────────────┬───────────────────────────┘
                      │
                      ▼
              ┌───────────────┐
              │  EventParser  │  (decimal conversion)
              └───────┬───────┘
                      │
                      ▼
          ┌───────────────────────┐
          │   EventCorrelator     │  (match by orderId)
          └───────┬───────────────┘
                  │
            ┌─────┴─────┐
            │           │
            ▼           ▼
       ┌─────────┐  ┌──────────────┐
       │ MongoDB │  │ EventEmitter │
       └─────────┘  └───────┬──────┘
                            │
                            ▼
                    ┌──────────────┐
                    │ Plugin System│
                    └──────────────┘
```

## Project Structure

```
services/avantis-listener/
├── server.ts                  # Railway deployment entry point
├── index.ts                   # Service exports & PluginManager
├── EventListener.ts           # Real-time event monitoring
├── EventParser.ts             # Parse events & convert decimals
├── EventCorrelator.ts         # Match initiated/executed events
├── Backfiller.ts              # Historical event fetching
├── MetricsComputer.ts         # Performance calculations
│
├── config/
│   ├── contracts.ts           # Contract addresses
│   ├── events.ts              # Event ABI & topics
│   ├── constants.ts           # Decimals, block config
│   └── features.ts            # Feature flags
│
├── core/
│   ├── ViemClient.ts          # Viem setup & utilities
│   ├── decimals.ts            # Conversion helpers
│   └── types.ts               # Shared types
│
├── types/
│   ├── events.ts              # Event type definitions
│   └── trades.ts              # Trade data types
│
└── plugins/
    ├── README.md              # Plugin development guide
    └── BasePlugin.ts          # Abstract plugin class
```

## Setup

### 1. Environment Variables

Add to your `.env.local`:

```bash
# Required for event listening
QUICKNODE_BASE_RPC_URL=https://your-quicknode-base-endpoint

# Required for MongoDB connection
MONGODB_URI=mongodb://localhost:27017/yieldr
```

### 2. Install Dependencies

Already installed (viem, mongoose, express):

```bash
npm install
```

### 3. MongoDB Indexes

Indexes are created automatically on startup, but you can manually run:

```javascript
await TradeEvent.createIndexes();
```

## Usage

### Option A: Standalone Service (Railway)

Run the listener as a standalone service:

```bash
# Development (with auto-reload)
npm run listener:dev

# Production
npm run listener
```

This starts:
- Event listener monitoring all verified managers
- HTTP server on port 3001 (or `PORT` env var)
- Health check endpoint: `GET /health`
- Status endpoint: `GET /status`

### Option B: Programmatic Usage

```typescript
import { startAvantisListener, backfillWalletHistory } from './services/avantis-listener';

// Start real-time monitoring
const wallets = ['0x780BB763e1463D2236FEC780b7BD6ADb40AAa120'];
await startAvantisListener(wallets);

// Backfill historical trades (last 90 days)
const result = await backfillWalletHistory(wallets[0], 90);
console.log(`Found ${result.eventsFound} historical events`);
```

### Option C: API Endpoints

The Next.js app exposes API routes:

**Trigger Backfill:**
```bash
curl -X POST http://localhost:3000/api/avantis/backfill \
  -H "Content-Type: application/json" \
  -d '{"walletAddress": "0x780BB763e1463D2236FEC780b7BD6ADb40AAa120", "daysBack": 90}'
```

**Get Trades:**
```bash
curl "http://localhost:3000/api/avantis/trades?address=0x780BB763e1463D2236FEC780b7BD6ADb40AAa120&status=all&limit=100"
```

**Get Performance Stats:**
```bash
curl "http://localhost:3000/api/avantis/stats?address=0x780BB763e1463D2236FEC780b7BD6ADb40AAa120"
```

### Option D: Backfill Script

Run ad-hoc backfill for all managers:

```bash
# Backfill last 90 days
npm run backfill

# Custom days
npm run backfill 30
```

## Key Features

### 1. Event Correlation

The service handles a two-event lifecycle:

1. **MarketOrderInitiated** - User submits trade (contains orderId)
2. **MarketExecuted** - Keeper executes trade 2-10s later (same orderId)

The correlator:
- Stores initiated events as `PENDING`
- Matches executed events by `orderId`
- Updates status to `EXECUTED` (open) or `CLOSED` (close)
- Handles orphaned events (executed before initiated)

### 2. Decimal Conversion

On-chain values are converted:
- Prices: ÷ 10^10
- Leverage: ÷ 10^10
- USDC amounts: ÷ 10^6
- Percentage: ÷ 10^10 (handles negative values)

### 3. Performance Metrics

Computes for each wallet:
- Total trades, open/closed counts
- Win rate, average ROI
- Total PnL (24h, 7d, 30d, all-time)
- Average position size, leverage, duration
- Per-pair breakdown

### 4. Plugin System

Extend functionality without modifying core code:

```typescript
import { BasePlugin } from './plugins/BasePlugin';

class MyPlugin extends BasePlugin {
  readonly name = 'MyPlugin';
  readonly enabled = true;

  async onTradeOpened(trade) {
    // React to opened trades
  }

  async onTradeClosed(trade) {
    // React to closed trades
  }

  cleanup() {
    // Clean up resources
  }
}

// Register plugin
registerPlugin(new MyPlugin());
```

See `plugins/README.md` for full documentation.

## Data Models

### TradeEvent (MongoDB)

```typescript
{
  orderId: string;                 // Unique ID (correlation key)
  status: 'PENDING' | 'EXECUTED' | 'CLOSED';
  trader: string;                  // Wallet address
  pairIndex: number;               // Trading pair
  isBuy: boolean;                  // Long (true) or Short (false)

  // Entry data
  initiatedAt: Date;
  collateralUsdc: number;
  positionSizeUsdc: number;
  leverage: number;
  openPrice: number;
  tp: number;                      // Take profit
  sl: number;                      // Stop loss

  // Close data (if closed)
  closePrice: number;
  profitPercent: number;
  pnlUsdc: number;
  closedAt: Date;

  // Computed
  durationSeconds: number;
  roi: number;
}
```

### Manager Model Updates

Added fields for backfill tracking:

```typescript
{
  avantisBackfillStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  avantisBackfillStartedAt: Date;
  avantisBackfillCompletedAt: Date;
  avantisLastBackfillBlock: number;
  avantisBackfillError: string;
}
```

## Configuration

### Feature Flags (`config/features.ts`)

```typescript
ENABLE_REALTIME_LISTENER: true    // Real-time event monitoring
ENABLE_EVENT_EMISSION: true       // Plugin system events
ENABLE_TRADE_MIRRORING: false     // Future: copy trading
ENABLE_ANALYTICS: false           // Future: advanced analytics
ENABLE_VERBOSE_LOGGING: false     // Debug logging
```

### Block Configuration

- Block time: 2 seconds (Base L2)
- Blocks per day: 43,200
- Backfill chunk size: 5,000 blocks
- Chunk delay: 200ms (rate limiting)

### Retry Configuration

- Max retries: 3
- Initial delay: 1s
- Max delay: 16s
- Exponential backoff (2x)

## Railway Deployment

### 1. Create Service

```bash
railway login
railway init
```

### 2. Environment Variables

Set in Railway dashboard:
- `QUICKNODE_BASE_RPC_URL`
- `MONGODB_URI`

### 3. Deployment

Railway auto-detects the start command:

```json
{
  "scripts": {
    "listener": "ts-node services/avantis-listener/server.ts"
  }
}
```

Or use `Procfile`:

```
web: npm run listener
```

### 4. Health Check

Railway will ping: `GET /health`

## Monitoring

### Listener Status

```bash
curl http://localhost:3001/status
```

Response:
```json
{
  "isActive": true,
  "monitoredWallets": ["0x..."],
  "eventsProcessed": 143,
  "errorsCount": 0,
  "lastEventTime": "2025-11-22T10:30:00Z",
  "reconnectAttempts": 0,
  "plugins": []
}
```

### Database Stats

```bash
curl http://localhost:3001/stats
```

Response:
```json
{
  "totalEvents": 1250,
  "openPositions": 12,
  "closedPositions": 1238,
  "uniqueTraders": 45
}
```

## Testing

### Test Connection

```bash
cd services/avantis-listener
npx ts-node test-client.ts
```

### Test with Known Transaction

The implementation prompt includes a test transaction:
- TX: `0xd9f051b9ecfd47d9d647bff8125e0effe3126a344d8f8a848e8c9589f725d93e`
- orderId: `3720355`
- Trader: `0x8361B6b46D9Fe73c88F155768550Da75c261D34c`

You can verify parsing by querying this specific event.

## Troubleshooting

### Event listener not receiving events

1. Check RPC connection: `verifyConnection()`
2. Verify wallet is in monitored list
3. Check feature flag: `ENABLE_REALTIME_LISTENER`
4. Review logs for WebSocket disconnects

### Backfill timing out

1. Reduce `daysBack` parameter (try 30 days)
2. Increase chunk delay in `config/constants.ts`
3. Check QuickNode rate limits

### Events not correlating

1. Check MongoDB for PENDING orders: `{ status: 'PENDING' }`
2. Look for orphaned events in logs
3. Verify both contracts are being monitored

## Future Enhancements

Enabled via plugins:

1. **Trade Mirroring** - Automatic copy trading for followers
2. **Analytics Dashboard** - Real-time charts and metrics
3. **Notifications** - Discord/Telegram alerts
4. **Risk Management** - Auto-close on loss limits
5. **Social Features** - Activity feed, leaderboards

## Support

For questions or issues, check:
- Main repo README
- Plugin development: `plugins/README.md`
- Implementation prompt (original spec)

---

**Built for Yieldr** - Track manager performance, enable copy trading, grow the community.
