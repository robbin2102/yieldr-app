# Indexer Services Deployment Guide

This guide covers deploying the Hyperliquid and Polymarket indexer services to Railway.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         RAILWAY SERVICES                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────┐      ┌─────────────────────┐              │
│  │ hyperliquid-indexer │      │ polymarket-indexer  │              │
│  │                     │      │                     │              │
│  │ • Polls every 5min  │      │ • Polls every 5min  │              │
│  │ • Fetches fills     │      │ • Fetches trades    │              │
│  │ • Updates positions │      │ • Updates positions │              │
│  │ • Computes metrics  │      │ • Computes profiles │              │
│  └──────────┬──────────┘      └──────────┬──────────┘              │
│             │                            │                         │
│             └────────────┬───────────────┘                         │
│                          │                                         │
│                          ▼                                         │
│                  ┌───────────────┐                                 │
│                  │   MongoDB     │                                 │
│                  │   (yieldr)    │                                 │
│                  └───────────────┘                                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## MongoDB Collections

### Hyperliquid Indexer Creates:
| Collection | Purpose |
|------------|---------|
| `hyperliquid-trackedWallets` | Wallets to index |
| `hyperliquidfills` | Trade history (fills) |
| `hyperliquidpositions` | Current open positions |
| `hyperliquidmetrics` | Computed metrics (for `get_top_perp_traders`) |
| `hyperliquidpnlsnapshots` | PnL history for Sharpe calculation |

### Polymarket Indexer Creates:
| Collection | Purpose |
|------------|---------|
| `polymarket-trackedTraders` | Traders to index |
| `polymarket-traderProfiles` | Computed profiles (for `get_top_pm_traders`) |
| `polymarket-openPositions` | Current open positions |
| `polymarket-trades` | Trade history |
| `polymarket-closedPositions` | Historical closed positions |

## Deployment Steps

### Prerequisites
1. Railway account with project created
2. MongoDB Atlas connection string
3. Git repository connected to Railway

### Step 1: Deploy Hyperliquid Indexer

```bash
# From Railway Dashboard:
# 1. Create new service from GitHub repo
# 2. Set Root Directory: services/hyperliquid-indexer
# 3. Add environment variables:
#    - MONGODB_URI: mongodb+srv://...
#    - PORT: 3000 (optional, default)
#    - POLL_INTERVAL_MS: 300000 (optional, 5 min default)
# 4. Deploy
```

**Railway Service Settings:**
- Builder: Dockerfile
- Root Directory: `services/hyperliquid-indexer`
- Health Check: `/health`

### Step 2: Deploy Polymarket Indexer

```bash
# From Railway Dashboard:
# 1. Create new service from GitHub repo
# 2. Set Root Directory: services/polymarket-indexer
# 3. Add environment variables:
#    - MONGODB_URI: mongodb+srv://...
#    - PORT: 3000 (optional, default)
#    - POLL_INTERVAL_MS: 300000 (optional, 5 min default)
# 4. Deploy
```

**Railway Service Settings:**
- Builder: Dockerfile
- Root Directory: `services/polymarket-indexer`
- Health Check: `/health`

### Step 3: Add Traders to Index

After services are deployed, add traders to be indexed:

```bash
# Add individual trader
npx tsx scripts/add-trader-to-index.ts --protocol hyperliquid --wallet 0x... --label "Top Trader"

# List tracked traders
npx tsx scripts/add-trader-to-index.ts --list --protocol hyperliquid

# Add bulk top traders (edit the script first with real addresses)
npx tsx scripts/add-top-traders.ts
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MONGODB_URI` | Yes | - | MongoDB connection string |
| `PORT` | No | 3000 | Health check server port |
| `POLL_INTERVAL_MS` | No | 300000 | Polling interval (5 min) |

## Health Checks

Both services expose health endpoints:

```bash
# Health check
curl http://localhost:3000/health
# Response: {"status":"healthy","timestamp":"..."}

# Status check
curl http://localhost:3000/status
# Response: {"status":"running","isPolling":false,"pollInterval":300000,...}
```

## Monitoring

### Railway Dashboard
- View logs in real-time
- Monitor memory/CPU usage
- Set up alerts for failures

### MongoDB Atlas
- Monitor collection sizes
- Check index usage
- Set up performance alerts

## Troubleshooting

### Service not starting
1. Check Railway logs for errors
2. Verify `MONGODB_URI` is correct
3. Ensure MongoDB IP whitelist includes Railway IPs (or use 0.0.0.0/0)

### No data being indexed
1. Check if traders are added to tracked collections
2. Verify service is running (check `/health`)
3. Check for API rate limiting in logs

### High memory usage
1. Reduce `POLL_INTERVAL_MS` (poll less frequently)
2. Limit number of tracked traders
3. Consider horizontal scaling

## Adding New Traders

### Via Script (Recommended)
```bash
npx tsx scripts/add-trader-to-index.ts \
  --protocol hyperliquid \
  --wallet 0x1234... \
  --label "Whale Trader"
```

### Via MongoDB Directly
```javascript
// Hyperliquid
db.getCollection('hyperliquid-trackedWallets').insertOne({
  walletAddress: "0x1234...",
  label: "Whale Trader",
  isActive: true,
  lastCheckedTime: 0,
  addedAt: new Date()
});

// Polymarket
db.getCollection('polymarket-trackedTraders').insertOne({
  wallet: "0x1234...",
  label: "Top Predictor",
  isActive: true,
  isTracking: true,
  addedAt: new Date()
});
```

## Service Architecture

### Hyperliquid Indexer Flow
```
1. Read tracked wallets from MongoDB
2. For each wallet:
   a. Fetch 30-day fills from Hyperliquid API
   b. Fetch current positions
   c. Compute metrics (win rate, PnL, Sharpe ratio)
   d. Save to MongoDB
3. Wait for poll interval
4. Repeat
```

### Polymarket Indexer Flow
```
1. Read tracked traders from MongoDB
2. For each trader:
   a. Fetch 90-day trades from Polymarket API
   b. Fetch open/closed positions
   c. Compute profile metrics
   d. Save trader profile to MongoDB
3. Wait for poll interval
4. Repeat
```

## MCP Tool Mapping

| MCP Tool | Collection | Protocol |
|----------|------------|----------|
| `get_top_perp_traders` | `hyperliquidmetrics` | Hyperliquid |
| `get_top_pm_traders` | `polymarket-traderProfiles` | Polymarket |
| `hl_get_positions` | `hyperliquidpositions` (or live API) | Hyperliquid |
| `hl_get_trades` | `hyperliquidfills` (or live API) | Hyperliquid |
| `pm_get_positions` | `polymarket-openPositions` (or live API) | Polymarket |
| `pm_get_trades` | `polymarket-trades` (or live API) | Polymarket |
