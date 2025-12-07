# Polymarket Tracker - Production Deployment Guide

## 🎯 Feature Complete ✅

The Polymarket tracker service is **production-ready** with the following capabilities:

### Core Features
- ✅ Real-time trade monitoring (60-second polling)
- ✅ Position tracking (open & closed positions)
- ✅ Automatic metrics computation with advanced analytics
- ✅ Multi-wallet support via environment configuration
- ✅ Persistent MongoDB storage
- ✅ Automatic position refresh every 5 minutes

### Advanced Metrics
- ✅ Profit Factor (Total Won / Total Lost) - Industry standard trading metric
- ✅ Capital-based ROI (accurate returns on deployed capital)
- ✅ Win rate and trade statistics
- ✅ Time-based PnL (1d, 7d, 30d)
- ✅ Sharpe Ratio for risk-adjusted returns
- ✅ Bet size analysis (avg, median, max)

---

## 📋 Prerequisites

### Required
1. **Node.js** v18+ installed
2. **MongoDB** instance (local or cloud like MongoDB Atlas)
3. **Environment Variables** configured in `.env.local`

### Environment Variables

Create a `.env.local` file in the project root:

```bash
# MongoDB Connection
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/database?retryWrites=true&w=majority

# Polymarket Configuration
POLYMARKET_WALLETS=0xwallet1,0xwallet2,0xwallet3
POLYMARKET_POLL_INTERVAL_MS=60000      # 60 seconds (optional, default: 60000)
POLYMARKET_API_DELAY_MS=300            # 300ms between API calls (optional, default: 300)
```

---

## 🚀 Deployment Steps

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Edit `.env.local` with your MongoDB URI and wallet addresses to track.

### 3. Start Production Service

```bash
npm run polymarket:prod
```

This will:
1. Connect to MongoDB
2. Fetch all open positions (fast startup)
3. Start real-time trade monitoring every 60 seconds
4. Fetch all historical closed positions in background
5. Compute and display comprehensive metrics
6. Refresh open positions every 5 minutes

### Expected Startup Output

```
████████████████████████████████████████████████████████████████████████████████
█                                                                              █
█                    POLYMARKET TRACKER SERVICE                                █
█                                                                              █
████████████████████████████████████████████████████████████████████████████████

[Main] Connecting to MongoDB...
[Main] Connected to MongoDB
[Main] Found 1 wallet(s) to track

================================================================================
TRACKING WALLET: 0xecd55daa7c6900683b804d1d4db935fbfabe43f4
================================================================================

[Initial Fetch] Step 1: Quick load - Fetching open positions...
[Open Positions API] Fetched 2 open positions
[Initial Fetch] Saved 2 open positions
[Initial Fetch] ✓ Open positions loaded! Starting monitoring...

[Initial Fetch] Step 2: Starting real-time trade monitoring...
[Poller] Started poller for 0xecd55daa7c6900683b804d1d4db935fbfabe43f4
[Initial Fetch] ✓ Real-time monitoring active!

[Initial Fetch] Step 3: Background - Loading closed positions and computing metrics...
[Closed Positions API] Fetched 2530 closed positions
[Initial Fetch] Saved 2530 closed positions

[Metrics] Computing metrics for 0xecd55daa7c6900683b804d1d4db935fbfabe43f4

================================================================================
TRADER PERFORMANCE METRICS
================================================================================

📊 POSITIONS:
   Open Positions: 2
   Closed Positions: 2530
   Win Rate: 51.0% (1289W / 1241L)

💼 POSITION VALUE:
   Current Position Value: $4,947.82
   Initial Investment:     $2,606.86
   Closed Investment:      $2,844,878.77
   ─────────────────────────────────────────────
   Total Invested:         $2,847,485.63

💰 PnL:
   Unrealized PnL: $2,340.96
   Realized PnL:   $133,986.04
   Total PnL:      $136,327.00

📈 TIME-BASED PERFORMANCE:
   1d  PnL: $2,340.96   |  ROI: 0.08%
   7d  PnL: $103,143.12 |  ROI: 3.62%
   30d PnL: $136,327.00 |  ROI: 4.79%

💵 PROFIT/LOSS BREAKDOWN:
   Total Won:      $568,043.85
   Total Lost:     $431,342.71
   Profit Factor:  1.32x
                   (For every $1 lost, earning $1.32)

💼 CAPITAL ANALYSIS:
   Avg Bet Size:    $1,124.70
   Median Bet Size: $673.30
   Max Bet Size:    $10,326.28

🎯 RETURN ON CAPITAL (Accurate ROI):
   ROI on Avg Bet:    12,121.23%
   ROI on Median Bet: 20,247.68%
   ROI on Max Bet:    1,320.20%

📊 TRADITIONAL METRICS:
   Overall ROI (on total invested): 4.79%
   Sharpe Ratio:                    0.041

================================================================================

[Main] Wallet 0xecd55daa7c6900683b804d1d4db935fbfabe43f4 is now being tracked!

================================================================================
SERVICE STATUS: RUNNING
================================================================================

✅ Tracking 1 wallet(s)
⏱️  Polling interval: 60 seconds
🔄 API delay: 300ms

Press Ctrl+C to stop
```

### 4. Monitor Logs

The service will log activity every 60 seconds:

```
[Trade Poller] Checking for new trades...
[Trade Poller] Found 3 new trades
[Trade Poller] Saved 3 new trades to database

[Position Update] Refreshing positions...
[Position Update] Updated 2 open positions
```

### 5. Graceful Shutdown

Press `Ctrl+C` to stop the service gracefully:

```
================================================================================
[Main] Shutting down gracefully...
[Poller] Stopped poller for 0xecd55daa7c6900683b804d1d4db935fbfabe43f4
[Main] All pollers stopped
================================================================================
```

---

## 🔧 Production Commands

### Start Service
```bash
npm run polymarket:prod
```

### Run Full Test (Clear + Fetch + Verify)
```bash
npm run polymarket:prod-test
```

### Clear All Data
```bash
npm run polymarket:clear-all
```

### Verify Data Integrity
```bash
npm run polymarket:verify-all
```

---

## 📊 MongoDB Collections

The service creates 4 collections:

### 1. `polymarket-openPositions`
- Stores current open positions
- Unique index: `{walletAddress, conditionId, asset}`
- Updated every 5 minutes

### 2. `polymarket-closedPositions`
- Stores all closed/settled positions
- Unique index: `{tradeId}` (UUID)
- Immutable records

### 3. `polymarket-trades`
- Stores all trading activity
- Unique index: `{transactionHash}`
- Updated every 60 seconds

### 4. `polymarket-metrics`
- Stores computed performance metrics
- Index: `{walletAddress, createdAt}`
- Historical tracking of trader performance

---

## 🎯 How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Polymarket Tracker Service                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Initial Fetch (Startup)                                 │
│     ├─ Fetch open positions (fast, 2-5 seconds)            │
│     ├─ Start trade poller immediately                       │
│     └─ Fetch closed positions in background (30-60s)       │
│                                                              │
│  2. Real-time Monitoring (Every 60 seconds)                 │
│     └─ Poll Polymarket API for new trades                   │
│                                                              │
│  3. Position Refresh (Every 5 minutes)                      │
│     ├─ Update open positions                                │
│     └─ Check for newly closed positions                     │
│                                                              │
│  4. Metrics Computation (After data fetch)                  │
│     ├─ Calculate PnL and ROI                                │
│     ├─ Compute profit factor                                │
│     ├─ Analyze capital deployment                           │
│     └─ Save to database                                     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Polymarket API → Service → MongoDB → Metrics Computation → Display
     ↓
  - Open Positions
  - Closed Positions
  - Trades/Activity
```

---

## 🔍 Verification

### Verify Data in MongoDB

```bash
mongosh "your_mongodb_connection_string"
```

```javascript
use your_database_name

// Count records
db['polymarket-openPositions'].countDocuments({
  walletAddress: '0xYOUR_WALLET'
})

db['polymarket-closedPositions'].countDocuments({
  walletAddress: '0xYOUR_WALLET'
})

db['polymarket-trades'].countDocuments({
  walletAddress: '0xYOUR_WALLET'
})

// Check profit factor
db['polymarket-closedPositions'].aggregate([
  { $match: { walletAddress: '0xYOUR_WALLET' } },
  {
    $group: {
      _id: null,
      totalWon: {
        $sum: { $cond: [{ $gt: ["$realizedPnl", 0] }, "$realizedPnl", 0] }
      },
      totalLost: {
        $sum: { $cond: [{ $lte: ["$realizedPnl", 0] }, { $abs: "$realizedPnl" }, 0] }
      }
    }
  },
  {
    $project: {
      totalWon: 1,
      totalLost: 1,
      profitFactor: { $divide: ["$totalWon", "$totalLost"] }
    }
  }
])
```

---

## 🛡️ Production Best Practices

### 1. Use Process Manager

For production, use PM2 or similar to keep the service running:

```bash
npm install -g pm2

# Start with PM2
pm2 start npm --name "polymarket-tracker" -- run polymarket:prod

# View logs
pm2 logs polymarket-tracker

# Restart
pm2 restart polymarket-tracker

# Stop
pm2 stop polymarket-tracker
```

### 2. Environment Variables

Never commit `.env.local` to git. Use secure environment variable management:
- For local: `.env.local` (gitignored)
- For production: Environment variables in your hosting platform
- For CI/CD: Encrypted secrets

### 3. MongoDB Connection

Use connection pooling and proper error handling (already implemented).

### 4. Monitoring

Monitor these metrics:
- Service uptime
- MongoDB connection status
- API response times
- Error rates in logs

### 5. Backups

Regular MongoDB backups recommended for production data.

---

## 🚨 Troubleshooting

### Service Won't Start

**Error**: `Please define the MONGODB_URI environment variable`
```bash
# Solution: Check .env.local exists and has MONGODB_URI
cat .env.local | grep MONGODB_URI
```

**Error**: `Connection refused to MongoDB`
```bash
# Solution: Verify MongoDB is running and URI is correct
# Test connection:
mongosh "your_connection_string"
```

### No Data Appearing

1. Check wallet address is correctly formatted (lowercase, with 0x prefix)
2. Verify the wallet has trading activity on Polymarket
3. Check API is accessible:
```bash
curl https://data-api.polymarket.com/positions?user=0xYOUR_WALLET
```

### Duplicate Key Errors

If you see `E11000 duplicate key error`:
```bash
# Drop old indexes
npm run polymarket:drop-indexes

# Clear data and restart
npm run polymarket:clear-all
npm run polymarket:prod
```

---

## 📈 Future Enhancements

The service is ready for:
1. **Web API Integration** - Expose metrics via REST API
2. **User Dashboard** - Display trader performance in UI
3. **Multi-user Support** - Track multiple traders with profiles
4. **Alerts** - Notify on significant trades or PnL changes
5. **Historical Analysis** - Trend analysis and performance charts

---

## ✅ Production Checklist

Before deploying to production:

- [ ] `.env.local` configured with production MongoDB URI
- [ ] Wallet addresses verified and added to `POLYMARKET_WALLETS`
- [ ] MongoDB indexes created (automatic on first run)
- [ ] Service tested with `npm run polymarket:prod-test`
- [ ] PM2 or similar process manager configured
- [ ] Monitoring and logging set up
- [ ] Backup strategy in place

---

## 📞 Support

For issues or questions:
1. Check logs for error messages
2. Verify MongoDB connection
3. Test with `npm run polymarket:prod-test`
4. Review troubleshooting section above

---

**Status**: ✅ **PRODUCTION READY**

Last Updated: 2025-12-06
Version: 1.0.0
