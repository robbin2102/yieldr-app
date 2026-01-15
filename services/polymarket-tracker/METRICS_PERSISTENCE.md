# Metrics Persistence

## Overview
Trader performance metrics are now automatically saved to MongoDB with timestamps, enabling historical tracking and trend analysis.

## Collection: `polymarket-metrics`

### Schema
```typescript
{
  walletAddress: string;        // Lowercase wallet address

  // Open Positions
  openPositionsCount: number;
  currentPositionValue: number;
  initialInvestment: number;
  totalUnrealizedPnl: number;

  // Closed Positions
  closedPositionsCount: number;
  closedInvestment: number;
  totalRealizedPnl: number;
  wins: number;
  losses: number;
  winRate: number;              // Percentage

  // Combined Metrics
  totalPnl: number;
  totalInvested: number;
  overallRoi: number;           // Percentage

  // Time-based Performance
  pnl1d: number;
  pnl7d: number;
  pnl30d: number;
  roi1d: number;                // Percentage
  roi7d: number;                // Percentage
  roi30d: number;               // Percentage

  // Risk Metrics
  sharpeRatio: number;

  // Metadata
  createdAt: Date;              // Timestamp of metrics snapshot
}
```

### Indexes
```javascript
{ walletAddress: 1 }              // Single field index
{ walletAddress: 1, createdAt: -1 } // Compound index for time queries
```

## When Metrics are Saved

### 1. Initial Startup
```
[Main] Step 2: Computing performance metrics...
[Metrics] Metrics computed successfully
[Metrics] Metrics saved to MongoDB
```
- After fetching all historical data
- Before starting the poller

### 2. After Each Trade Update
```
[Poller] Found 3 new activities
[Poller] Saved: 3 new, 0 updated
[Metrics] Metrics computed successfully
[Metrics] Metrics saved to MongoDB
[Metrics] Metrics updated and saved
```
- Every time new trades are detected (60s polling)
- Automatically recomputes and saves updated metrics

## Usage Examples

### Query Latest Metrics
```javascript
const latestMetrics = await PolymarketMetrics
  .findOne({ walletAddress: '0xecd55...e43f4' })
  .sort({ createdAt: -1 });

console.log('Overall ROI:', latestMetrics.overallRoi);
console.log('Total PnL:', latestMetrics.totalPnl);
```

### Query Metrics History
```javascript
// Get metrics for last 24 hours
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

const metricsHistory = await PolymarketMetrics
  .find({
    walletAddress: '0xecd55...e43f4',
    createdAt: { $gte: yesterday }
  })
  .sort({ createdAt: 1 });

// Plot ROI over time
metricsHistory.forEach(m => {
  console.log(m.createdAt, m.overallRoi);
});
```

### Track Performance Changes
```javascript
// Compare first vs last metrics snapshot
const [first, last] = await PolymarketMetrics
  .find({ walletAddress: '0xecd55...e43f4' })
  .sort({ createdAt: 1 })
  .limit(1)
  .union(
    PolymarketMetrics
      .find({ walletAddress: '0xecd55...e43f4' })
      .sort({ createdAt: -1 })
      .limit(1)
  );

const roiChange = last.overallRoi - first.overallRoi;
console.log(`ROI changed by ${roiChange.toFixed(2)}%`);
```

### Aggregate Metrics
```javascript
// Average ROI over last 7 days
const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

const avgMetrics = await PolymarketMetrics.aggregate([
  {
    $match: {
      walletAddress: '0xecd55...e43f4',
      createdAt: { $gte: weekAgo }
    }
  },
  {
    $group: {
      _id: null,
      avgRoi: { $avg: '$overallRoi' },
      avgWinRate: { $avg: '$winRate' },
      avgSharpe: { $avg: '$sharpeRatio' }
    }
  }
]);
```

## Benefits

### 1. Historical Tracking
- See how performance changes over time
- Identify trends and patterns
- Track ROI evolution

### 2. No Recomputation
- Metrics computed once per update
- Fast queries from saved snapshots
- Reduces database load

### 3. API Ready
- Can expose metrics via REST API
- Build real-time dashboards
- Share performance data

### 4. Trend Analysis
- Compare performance across different time periods
- Identify best/worst performing days
- Analyze correlation with market events

## Example Dashboard Queries

### Performance Over Time Chart
```javascript
// Hourly snapshots for last 24h
const metrics = await PolymarketMetrics
  .find({
    walletAddress: wallet,
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
  })
  .sort({ createdAt: 1 })
  .select('createdAt overallRoi totalPnl');

// Returns: [{ createdAt, overallRoi, totalPnl }, ...]
```

### Win Rate Trend
```javascript
// Track win rate changes
const winRateTrend = await PolymarketMetrics
  .find({ walletAddress: wallet })
  .sort({ createdAt: 1 })
  .select('createdAt winRate wins losses');
```

### Best/Worst Periods
```javascript
// Find highest ROI snapshot
const bestPeriod = await PolymarketMetrics
  .findOne({ walletAddress: wallet })
  .sort({ overallRoi: -1 });

// Find lowest ROI snapshot
const worstPeriod = await PolymarketMetrics
  .findOne({ walletAddress: wallet })
  .sort({ overallRoi: 1 });
```

## Data Retention

By default, all metrics snapshots are kept indefinitely. To implement retention:

```javascript
// Delete metrics older than 90 days
const retentionDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

await PolymarketMetrics.deleteMany({
  createdAt: { $lt: retentionDate }
});
```

Or create a TTL index for automatic cleanup:
```javascript
// In the schema
createdAt: {
  type: Date,
  default: Date.now,
  expires: 7776000  // 90 days in seconds
}
```

## MongoDB Queries

### View Latest Metrics
```bash
mongosh "YOUR_MONGODB_URI"
use yieldr

# Get latest metrics for a wallet
db['polymarket-metrics'].find({
  walletAddress: '0xecd55daa7c6900683b804d1d4db935fbfabe43f4'
}).sort({ createdAt: -1 }).limit(1).pretty()

# Count total snapshots
db['polymarket-metrics'].countDocuments({
  walletAddress: '0xecd55daa7c6900683b804d1d4db935fbfabe43f4'
})

# Get metrics from last hour
db['polymarket-metrics'].find({
  walletAddress: '0xecd55daa7c6900683b804d1d4db935fbfabe43f4',
  createdAt: { $gte: new Date(Date.now() - 3600000) }
}).sort({ createdAt: 1 })
```

## Commit
```
2b2855c - feat: Add metrics persistence to MongoDB
```

## Date
2025-12-05
