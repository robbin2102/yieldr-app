# Polymarket Tracker Service

A standalone Node.js service that tracks Polymarket traders by wallet address, fetching open positions, closed positions, and monitoring new trades in real-time.

## Features

- 📊 **Fetch Open Positions**: Get all current active positions with unrealized PnL
- 📈 **Fetch Closed Positions**: Retrieve last 30 days of closed positions with realized PnL
- 🔄 **Real-time Monitoring**: Poll for new trades every 60 seconds
- 💰 **Performance Metrics**: Compute 1d/7d/30d PnL, ROI, win rate, Sharpe ratio
- 🗄️ **MongoDB Storage**: All data stored in MongoDB collections for future frontend integration

## Collections

The service creates/updates 3 MongoDB collections:

1. **`polymarket-openPositions`** - Current active positions
2. **`polymarket-closedPositions`** - Closed positions (last 30 days)
3. **`polymarket-trades`** - All trading activity (TRADE + REDEEM events)

## Installation

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Add to `.env.local`:

```env
# MongoDB
MONGODB_URI=mongodb+srv://your-connection-string

# Polymarket Configuration
POLYMARKET_WALLETS=0xcde6e9587582e568041e1aa0ea0b01793e1311d7
POLYMARKET_POLL_INTERVAL_MS=60000    # 60 seconds
POLYMARKET_API_DELAY_MS=300          # 300ms between API calls
```

Multiple wallets can be tracked by separating them with commas:
```env
POLYMARKET_WALLETS=0xwallet1,0xwallet2,0xwallet3
```

## Usage

### Start the Service

```bash
npm run polymarket:start
```

### Development Mode (with auto-restart)

```bash
npm run polymarket:dev
```

### What Happens on Start

1. **Initial Fetch**: Fetches all historical data for each wallet
   - Open positions (all)
   - Closed positions (last 30 days)
   - Historical trades (last 30 days)

2. **Metrics Computation**: Calculates performance metrics
   - Open/closed position counts
   - Win rate
   - 1d/7d/30d PnL and ROI
   - Sharpe ratio

3. **Live Monitoring**: Starts polling for new trades every 60 seconds

### Example Output

```
████████████████████████████████████████████████████████████████████████████████
█                                                                              █
█                    POLYMARKET TRACKER SERVICE                                █
█                                                                              █
████████████████████████████████████████████████████████████████████████████████

[Main] Connecting to MongoDB...
[Main] Connected to MongoDB
[Main] Tracking 1 wallet(s): 0xcde6e9587582e568041e1aa0ea0b01793e1311d7

================================================================================
TRACKING WALLET: 0xcde6e9587582e568041e1aa0ea0b01793e1311d7
================================================================================

[Positions API] Fetched 15 open positions
[Closed Positions API] Fetched 42 closed positions
[Activity API] Fetched 127 activities (TRADE + REDEEM)

================================================================================
TRADER PERFORMANCE METRICS
================================================================================

📊 POSITIONS:
   Open Positions: 15
   Closed Positions: 42
   Win Rate: 64.3% (27W / 15L)

💰 PnL:
   Unrealized PnL: $234.56
   Realized PnL:   $1,245.78
   Total PnL:      $1,480.34

📈 TIME-BASED PERFORMANCE:
   1d  PnL: $45.67  |  ROI: 3.2%
   7d  PnL: $189.34  |  ROI: 5.8%
   30d PnL: $1,245.78  |  ROI: 8.4%

🎯 OVERALL:
   Total Invested: $14,830.50
   Overall ROI:    9.98%
   Sharpe Ratio:   1.245

================================================================================

[Poller] Starting poller for 0xcde6e9... (interval: 60s)

================================================================================
SERVICE STATUS: RUNNING
================================================================================

✅ Tracking 1 wallet(s)
⏱️  Polling interval: 60 seconds
🔄 API delay: 300ms

Press Ctrl+C to stop
```

## API Endpoints Used

| Endpoint | Limit | Pagination | Purpose |
|----------|-------|------------|---------|
| `/positions` | 500 | Yes | Fetch open positions |
| `/closed-positions` | 50 | Yes | Fetch closed positions |
| `/activity` | 500 | Yes | Fetch trades (TRADE + REDEEM) |

## Rate Limiting

- **300ms delay** between paginated API calls
- Automatic pagination handling
- No authentication required for Polymarket Data API

## File Structure

```
services/polymarket-tracker/
├── index.ts                    # Main entry point
├── config.ts                   # Configuration
├── api/
│   ├── client.ts              # HTTP client with rate limiting
│   ├── positions.ts           # Fetch open positions
│   ├── closedPositions.ts     # Fetch closed positions
│   └── activity.ts            # Fetch trades
├── services/
│   ├── initialFetch.ts        # Initial data fetch
│   ├── poller.ts              # 60s trade polling
│   └── metrics.ts             # Metrics computation
├── types/
│   └── polymarket.ts          # TypeScript types
└── utils/
    ├── logger.ts              # Colored console logging
    └── pagination.ts          # Pagination helpers

models/
├── PolymarketOpenPosition.ts   # Open positions schema
├── PolymarketClosedPosition.ts # Closed positions schema
└── PolymarketTrade.ts          # Trades schema
```

## Deployment

### Local Testing

1. Set environment variables in `.env.local`
2. Run `npm run polymarket:start`
3. Verify data is being fetched and stored in MongoDB

### Railway Deployment

1. Create new Railway service
2. Connect to GitHub repository
3. Set build command: `npm install`
4. Set start command: `npm run polymarket:start`
5. Add environment variables:
   - `MONGODB_URI`
   - `POLYMARKET_WALLETS`
   - `POLYMARKET_POLL_INTERVAL_MS`
   - `POLYMARKET_API_DELAY_MS`

## Troubleshooting

### No wallets configured
- Ensure `POLYMARKET_WALLETS` is set in `.env.local`
- Wallet addresses should be checksummed or lowercase

### MongoDB connection failed
- Verify `MONGODB_URI` is correct
- Check MongoDB Atlas IP whitelist
- Ensure database user has read/write permissions

### API rate limiting
- Increase `POLYMARKET_API_DELAY_MS` if getting rate limited
- Default 300ms should be sufficient for most cases

### No data fetched
- Verify wallet address has trading activity on Polymarket
- Check if wallet address is correct (lowercase or checksummed)
- Test API manually: `https://data-api.polymarket.com/positions?user=0x...`

## Future Enhancements

- [ ] Add Next.js API routes to read from MongoDB
- [ ] Build frontend dashboard to display trader metrics
- [ ] Add leaderboard of top traders
- [ ] Add webhook notifications for new trades
- [ ] Add more advanced metrics (Kelly criterion, etc.)

## License

MIT
