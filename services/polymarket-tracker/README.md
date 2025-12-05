# Polymarket Tracker Service

A standalone Node.js service that tracks Polymarket traders by wallet address, fetching positions, trades, and computing performance metrics.

## Features

- ✅ Fetch open positions (current holdings)
- ✅ Fetch closed positions (last 30 days) with pagination
- ✅ Fetch historical trades (last 30 days) with pagination
- ✅ Real-time trade monitoring (60-second polling)
- ✅ Performance metrics (PnL, ROI, Win Rate, Sharpe Ratio)
- ✅ Time-based PnL (1d, 7d, 30d)
- ✅ MongoDB storage with duplicate prevention
- ✅ Rate limiting (300ms between API calls)
- ✅ Webhook notifications
- ✅ Error email notifications (placeholder)

## Architecture

- **Standalone Service**: Runs independently from Next.js app
- **MongoDB**: Stores data in separate collections (`polymarket_*`)
- **Deployment**: Railway (separate from Vercel)
- **Polling**: 60-second intervals for new trades

## Installation

```bash
cd services/polymarket-tracker
npm install
```

## Configuration

Add these variables to your main app's `.env.local`:

```env
# Polymarket Tracker Configuration
POLYMARKET_WALLETS=0xcde6e9587582e568041e1aa0ea0b01793e1311d7
POLYMARKET_POLL_INTERVAL_MS=60000
POLYMARKET_API_DELAY_MS=300
POLYMARKET_WEBHOOK_URL=https://placeholder-webhook-url.com/notifications
POLYMARKET_ERROR_EMAIL=robbin@yieldr.org
```

## Usage

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

## MongoDB Collections

### `polymarket_positions`
Stores open positions with unrealized PnL

### `polymarket_closedpositions`
Stores closed positions with realized PnL

### `polymarket_trades`
Stores all trades (BUY/SELL) with unique transaction hash

### `polymarket_metrics`
Stores computed performance metrics per wallet

## API Endpoints Used

- **Open Positions**: `GET /positions?user={wallet}`
- **Closed Positions**: `GET /closed-positions?user={wallet}&limit=50` (paginated)
- **Activity/Trades**: `GET /activity?user={wallet}&type=TRADE&start={timestamp}&limit=500` (paginated)

## Metrics Computed

- Total PnL (realized + unrealized)
- ROI (return on investment)
- Win Rate (% of profitable closed positions)
- Sharpe Ratio (risk-adjusted return)
- Time-based PnL (1d, 7d, 30d)
- Open/Closed positions count
- Wins/Losses count

## How It Works

1. **Initial Fetch**: When wallet is added, fetch all data from last 30 days
2. **Save to MongoDB**: Store positions, trades, and metrics
3. **Start Polling**: Monitor for new trades every 60 seconds
4. **Real-time Updates**: Detect and save new trades immediately
5. **Notifications**: Send webhooks for new trades

## Error Handling

- MongoDB connection failures
- API rate limit errors
- Duplicate trade prevention
- Email notifications on critical errors

## Testing Locally

```bash
# 1. Ensure MongoDB connection in .env.local
# 2. Add test wallet address
# 3. Run the service
npm run dev

# Watch the console for:
# - Initial fetch progress
# - Metrics computation
# - Poller status
# - New trade detection
```

## Deployment to Railway

1. Push code to GitHub
2. Create new Railway project
3. Connect GitHub repository
4. Set environment variables
5. Deploy

## Future Enhancements

- [ ] Admin API to add/remove wallets dynamically
- [ ] UI dashboard in Next.js app
- [ ] Real email integration (SendGrid)
- [ ] Real webhook integration
- [ ] Merge with main `managers` collection for production
- [ ] Historical PnL charts
- [ ] Position alerts (profit/loss thresholds)

## License

MIT
