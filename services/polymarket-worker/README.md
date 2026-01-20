# Polymarket Worker Service

Background worker that monitors tracked Polymarket traders and provides real-time updates.

## Features

- **Alert Monitor** (every 10s): Detects new trades from tracked traders, creates alerts
- **Position Refresher** (every 60s): Updates open position prices and P&L
- **Profile Refresher** (every 5 min): Updates trader stats, conviction trades
- **WebSocket Server**: Real-time updates pushed to frontend

## Local Development

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env with your MONGODB_URI

# Run in development mode
npm run dev
```

## Railway Deployment

1. Create new service in Railway project
2. Connect this directory as the source
3. Set environment variables:
   - `MONGODB_URI` - Your MongoDB connection string
   - `WS_PORT` - WebSocket port (default: 8080)
4. Deploy

The service will automatically start all monitors and expose the WebSocket server.

## WebSocket Events

Connect to `ws://your-railway-url:8080` to receive real-time events:

### Event Types

```typescript
// New trade alert
{ type: 'alert', data: { traderLabel, market, outcome, side, price, usdcValue, ... } }

// Positions updated
{ type: 'positions', data: { wallet, positions, count } }

// Profile updated
{ type: 'profile', data: { wallet, profile } }

// Connection established
{ type: 'connected', data: { message } }
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Polymarket Worker                  │
├─────────────────────────────────────────────────┤
│  Alert Monitor ─────────┐                       │
│  (10s polling)          │                       │
│                         ├──▶ WebSocket Server   │
│  Position Refresher ────┤    (port 8080)        │
│  (60s polling)          │         │             │
│                         │         │             │
│  Profile Refresher ─────┘         │             │
│  (5 min polling)                  │             │
└───────────────────────────────────│─────────────┘
                                    │
                                    ▼
                            Frontend (Next.js)
```

## MongoDB Collections Used

- `polymarket-trackedTraders` - Traders being monitored
- `polymarket-traderProfiles` - Full profile data
- `polymarket-openPositions` - Current position data
- `polymarket-tradeAlerts` - Trade alerts
