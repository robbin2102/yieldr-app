# Traders Collection - Dynamic Wallet Tracking

## Overview
The `traders` collection enables dynamic, database-driven wallet tracking without service restarts. Users can add wallet addresses through a frontend, and the service automatically detects and starts tracking them.

## Collection: `traders`

### Schema
```typescript
{
  userId: ObjectId;              // Optional - ref to User
  username: string;              // Optional - unique username
  profilePicture: string;        // Profile image URL
  walletAddress: string;         // Required, unique Polymarket wallet

  // Profile
  marketOutlook: string;
  investmentThesis: string;
  positionStrategy: string;

  // Platforms
  platforms: string[];           // ['polymarket']

  // Performance Metrics (auto-synced)
  metrics: {
    totalPnL30d: number;
    totalPnL7d: number;
    totalPnL1d: number;
    roi30d: number;
    roi7d: number;
    roi1d: number;
    overallRoi: number;
    winRate: number;
    totalInvested: number;
    openPositions: number;
    closedPositions: number;
    sharpeRatio: number;
  };

  // Current Positions (auto-synced)
  positions: [{
    conditionId: string;
    asset: string;
    title: string;
    outcome: string;
    size: number;
    avgPrice: number;
    curPrice: number;
    initialValue: number;
    currentValue: number;
    pnl: number;
    roi: number;
    endDate: Date;
    redeemable: boolean;
  }];

  // Tracking Status
  trackingStatus: 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'ERROR';

  // Sync Status
  polymarketSyncStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  polymarketSyncStartedAt: Date;
  polymarketSyncCompletedAt: Date;
  polymarketLastSyncAt: Date;
  polymarketSyncError: string;

  // Metadata
  verified: boolean;
  lastPositionSync: Date;
  lastMetricsSync: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

### Indexes
```javascript
{ username: 1 }                  // Unique username lookup
{ walletAddress: 1 }             // Unique wallet lookup
{ trackingStatus: 1 }            // Find active traders
{ polymarketSyncStatus: 1 }      // Monitor sync progress
```

## User Journey

### 1. Frontend: User Inputs Wallet
```typescript
// POST /api/traders/add
{
  "walletAddress": "0x5248313731287b61d714ab9df655442d6ed28aa2",
  "username": "bitcoin_pro_trader" // optional
}
```

### 2. Backend API: Create Trader
```javascript
const trader = await Trader.create({
  walletAddress: req.body.walletAddress.toLowerCase(),
  username: req.body.username,
  trackingStatus: 'ACTIVE',         // Start tracking immediately
  platforms: ['polymarket']
});
```

### 3. Service: Auto-Detect (within 60 seconds)
```
[Main] Checking for new traders...
[Main] New trader detected: 0x5248...8aa2
[Main] Step 1: Fetching all historical data...
[Main] Step 2: Computing performance metrics...
[Main] Step 3: Starting trade monitoring...
[Main] Started tracking 0x5248...8aa2
```

### 4. Service: Real-Time Sync
```
Every 60 seconds:
- Detect new trades
- Update positions
- Compute metrics
- Sync to traders collection ✅
```

## How It Works

### Service Startup
```typescript
// 1. Load wallets from both sources
const wallets = await getWalletsToTrack();
// - ENV: POLYMARKET_WALLETS (backward compatible)
// - DB: traders collection WHERE trackingStatus = 'ACTIVE'

// 2. Start tracking each wallet
for (const wallet of wallets) {
  const poller = await trackWallet(wallet);
  pollers.set(wallet, poller);
}

// 3. Check for new traders every 60s
setInterval(async () => {
  await checkForNewTraders(pollers);
}, 60000);
```

### Adding a New Trader (While Running)

**Step 1: Insert into MongoDB**
```javascript
db.traders.insertOne({
  walletAddress: '0x5248313731287b61d714ab9df655442d6ed28aa2',
  trackingStatus: 'ACTIVE',
  platforms: ['polymarket'],
  createdAt: new Date()
});
```

**Step 2: Service Detects (within 60s)**
```
[Main] Checking for new traders...
[Main] New trader detected: 0x5248313731287b61d714ab9df655442d6ed28aa2
[Main] Tracking WALLET: 0x5248313731287b61d714ab9df655442d6ed28aa2

[Positions API] Fetching open positions...
[Closed Positions API] Fetching closed positions...
[Activity API] Fetching historical activity...

[Metrics] Computing metrics...
[Metrics] Metrics saved to MongoDB

✅ Started tracking 0x5248313731287b61d714ab9df655442d6ed28aa2
```

**Step 3: Trader Record Updated**
```javascript
{
  walletAddress: '0x5248313731287b61d714ab9df655442d6ed28aa2',
  trackingStatus: 'ACTIVE',
  polymarketSyncStatus: 'COMPLETED', // ✅
  polymarketSyncCompletedAt: ISODate('2025-12-05T23:00:00Z'),
  polymarketLastSyncAt: ISODate('2025-12-05T23:00:00Z'),
  metrics: {
    totalPnL30d: 15234.56,
    roi30d: 12.45,
    winRate: 58.3,
    openPositions: 5,
    closedPositions: 142,
    // ... all metrics
  },
  lastMetricsSync: ISODate('2025-12-05T23:00:00Z')
}
```

### Pausing/Stopping a Trader

**Pause Tracking:**
```javascript
db.traders.updateOne(
  { walletAddress: '0x5248...8aa2' },
  { $set: { trackingStatus: 'PAUSED' } }
);
```

Service will stop tracking within 60 seconds.

**Resume Tracking:**
```javascript
db.traders.updateOne(
  { walletAddress: '0x5248...8aa2' },
  { $set: { trackingStatus: 'ACTIVE' } }
);
```

Service will resume tracking within 60 seconds.

## Testing the New Wallet

### 1. Add Trader via MongoDB
```bash
mongosh "YOUR_MONGODB_URI"
```

```javascript
use yieldr

// Insert new trader
db.traders.insertOne({
  walletAddress: '0x5248313731287b61d714ab9df655442d6ed28aa2',
  trackingStatus: 'ACTIVE',
  platforms: ['polymarket'],
  polymarketSyncStatus: 'NOT_STARTED',
  createdAt: new Date()
})

// Verify insertion
db.traders.findOne({
  walletAddress: '0x5248313731287b61d714ab9df655442d6ed28aa2'
})
```

### 2. Watch Service Logs
Within 60 seconds you should see:
```
[Main] Checking for new traders...
[Main] New trader detected: 0x5248313731287b61d714ab9df655442d6ed28aa2
[Main] Fetching all historical data...
...
[Main] Started tracking 0x5248313731287b61d714ab9df655442d6ed28aa2
```

### 3. Verify Metrics Synced
```javascript
db.traders.findOne(
  { walletAddress: '0x5248313731287b61d714ab9df655442d6ed28aa2' },
  { metrics: 1, polymarketSyncStatus: 1, lastMetricsSync: 1 }
)
```

Should show:
```javascript
{
  polymarketSyncStatus: 'COMPLETED',
  lastMetricsSync: ISODate('2025-12-05T...'),
  metrics: {
    totalPnL30d: <value>,
    roi30d: <value>,
    winRate: <value>,
    // ... populated with real data
  }
}
```

### 4. Watch Real-Time Updates
```javascript
// Watch metrics update as new trades come in
db.traders.watch([
  { $match: {
    'fullDocument.walletAddress': '0x5248313731287b61d714ab9df655442d6ed28aa2'
  }}
])
```

## Backend API Example

### POST /api/traders/add
```typescript
import Trader from '../models/Trader';

app.post('/api/traders/add', async (req, res) => {
  try {
    const { walletAddress, username } = req.body;

    // Validate wallet format
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // Check if already exists
    const existing = await Trader.findOne({
      walletAddress: walletAddress.toLowerCase()
    });

    if (existing) {
      return res.status(409).json({ error: 'Wallet already being tracked' });
    }

    // Create trader
    const trader = await Trader.create({
      walletAddress: walletAddress.toLowerCase(),
      username: username?.toLowerCase(),
      trackingStatus: 'ACTIVE',
      platforms: ['polymarket'],
      polymarketSyncStatus: 'NOT_STARTED'
    });

    res.json({
      success: true,
      trader: {
        walletAddress: trader.walletAddress,
        trackingStatus: trader.trackingStatus,
        message: 'Trader will be tracked within 60 seconds'
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### GET /api/traders/:walletAddress
```typescript
app.get('/api/traders/:walletAddress', async (req, res) => {
  const trader = await Trader.findOne({
    walletAddress: req.params.walletAddress.toLowerCase()
  });

  if (!trader) {
    return res.status(404).json({ error: 'Trader not found' });
  }

  res.json({ trader });
});
```

### GET /api/traders (List all)
```typescript
app.get('/api/traders', async (req, res) => {
  const traders = await Trader.find({
    trackingStatus: 'ACTIVE'
  }).select('walletAddress username metrics trackingStatus polymarketSyncStatus');

  res.json({ traders });
});
```

## Deployment (Railway)

### Environment Variables
```bash
# .env or Railway environment
MONGODB_URI=mongodb+srv://...
POLYMARKET_POLL_INTERVAL_MS=60000
POLYMARKET_API_DELAY_MS=300

# NO POLYMARKET_WALLETS needed!
# Wallets come from traders collection
```

### Railway Deployment
```bash
railway up
```

Service will:
1. Connect to MongoDB
2. Load all traders with `trackingStatus: ACTIVE`
3. Start tracking each wallet
4. Check for new traders every 60s
5. Auto-scale with new traders

## Migration from ENV to DB

### Before (ENV-based):
```bash
POLYMARKET_WALLETS=0xabc...,0xdef...,0x123...
```

### After (DB-driven):
```javascript
// Migrate existing wallets to DB
const envWallets = ['0xabc...', '0xdef...', '0x123...'];

for (const wallet of envWallets) {
  await Trader.create({
    walletAddress: wallet.toLowerCase(),
    trackingStatus: 'ACTIVE',
    platforms: ['polymarket']
  });
}

// Remove from ENV (optional - backward compatible)
```

## Merging with Managers Collection

Future plan: Merge `traders` with `managers` collection

```javascript
// Unified schema
{
  walletAddress: string,
  platforms: ['avantis', 'polymarket', 'hyperliquid'],

  // Platform-specific metrics
  avantisMetrics: { ... },
  polymarketMetrics: { ... },
  hyperliquidMetrics: { ... },

  // Combined metrics
  overallMetrics: { ... }
}
```

## MongoDB Queries

### List Active Traders
```javascript
db.traders.find({ trackingStatus: 'ACTIVE' })
```

### Check Sync Status
```javascript
db.traders.aggregate([
  {
    $group: {
      _id: '$polymarketSyncStatus',
      count: { $sum: 1 }
    }
  }
])
```

### Top Performers
```javascript
db.traders.find({
  trackingStatus: 'ACTIVE'
}).sort({
  'metrics.overallRoi': -1
}).limit(10)
```

### Recently Synced
```javascript
db.traders.find({
  polymarketLastSyncAt: {
    $gte: new Date(Date.now() - 5 * 60 * 1000) // Last 5 minutes
  }
})
```

## Commit
```
0eb70cb - feat: Add traders collection for dynamic wallet tracking
```

## Date
2025-12-05
