# Hyperliquid Fills & Orders Implementation Summary

## Overview
Extended the monitoring system to fetch Hyperliquid user fills (closed positions) and open orders using their REST API. This provides real closed position data instead of relying solely on snapshot-based detection.

## Changes Made

### 1. MongoDB Schema Updates

#### `models/closed-position.ts`
- Added `dataSource` field to distinguish between:
  - `'api_fills'`: Real data from platform API (Hyperliquid userFills)
  - `'snapshot_detection'`: Inferred from snapshot comparison (Avantis, LP)

#### `models/open-order.ts`
- Already exists with comprehensive schema for storing open orders
- Supports Hyperliquid limit orders with all necessary fields

### 2. Position Fetcher (`services/monitoring/position-fetcher.ts`)

#### New Function: `fetchHyperliquidUserFills()`
```typescript
export async function fetchHyperliquidUserFills(
  wallets: ManagerWallets,
  lastFetchTime?: number
): Promise<PositionFetchResult>
```

**Behavior:**
- **First run** (no lastFetchTime): Fetches last 30 days of fills
- **Subsequent runs**: Incremental fetch from lastFetchTime to now
- Uses Hyperliquid API endpoint: `POST https://api.hyperliquid.xyz/info`
- Request type: `userFillsByTime`
- Returns fills with exact closedPnl, price, size, and timestamp

**Response Structure:**
```typescript
{
  success: true,
  platform: 'hyperliquid',
  positions: [
    {
      coin: "WLFI",
      px: "0.12345",
      sz: "100.0",
      side: "B",  // B = Buy, A = Sell
      closedPnl: "-12.34",
      time: 1762622261627,
      walletAddress: "0x..."
    }
  ]
}
```

#### New Function: `fetchHyperliquidOpenOrders()`
```typescript
export async function fetchHyperliquidOpenOrders(
  wallets: ManagerWallets
): Promise<PositionFetchResult>
```

**Behavior:**
- Fetches current open orders for all wallets
- Uses Hyperliquid API endpoint: `POST https://api.hyperliquid.xyz/info`
- Request type: `openOrders`
- Returns orders with limitPx, sz, side, timestamp

**Response Structure:**
```typescript
{
  success: true,
  platform: 'hyperliquid',
  positions: [
    {
      coin: "WLFI",
      side: "B",
      limitPx: "0.10447",
      sz: "2624.0",
      timestamp: 1762622261627,
      walletAddress: "0x..."
    }
  ]
}
```

### 3. Orchestrator Updates (`services/monitoring/orchestrator.ts`)

#### Manager Interface
- Added `lastFillsFetchTime?: number` field to track incremental fills fetching

#### Platform Call Types
Extended to include:
- `'avantis'`: Avantis positions
- `'hyperliquid'`: Hyperliquid open positions
- `'hyperliquid-fills'`: **NEW** - Hyperliquid closed positions (fills)
- `'hyperliquid-orders'`: **NEW** - Hyperliquid open orders
- `'lp'`: LP positions

#### Monitoring Cycle Changes
When `shouldFetchHyperliquid` is true, the orchestrator now fires **3 independent calls**:
1. `fetchHyperliquidPositions()` - Open positions (for snapshots)
2. `fetchHyperliquidUserFills()` - Closed positions (fills)
3. `fetchHyperliquidOpenOrders()` - Open orders

All calls still use 300ms stagger to prevent connection pool exhaustion.

#### New Helper Functions

**`getLastFillsFetchTime(managerId: string)`**
- Retrieves last fills fetch timestamp from manager document
- Returns `undefined` on first run (triggers 30-day fetch)

**`updateLastFillsFetchTime(managerId: string, timestamp: number)`**
- Updates manager document with latest fetch time
- Enables incremental fetching on subsequent runs

**`saveHyperliquidFills(fills: any[], managerId: string)`**
- Transforms fills to closed-position schema
- Sets `dataSource: 'api_fills'` (real API data)
- Generates unique positionId: `hyperliquid-{wallet}-{coin}-{time}`
- Checks for duplicates before inserting
- Returns count of new fills saved

**Schema mapping:**
```typescript
{
  positionId: `hyperliquid-${wallet}-${coin}-${time}`,
  platform: 'hyperliquid',
  dataSource: 'api_fills',
  asset: fill.coin,
  direction: fill.side === 'B' ? 'LONG' : 'SHORT',
  exitPrice: parseFloat(fill.px),
  positionSize: parseFloat(fill.sz) * parseFloat(fill.px),
  pnl: parseFloat(fill.closedPnl),
  closedAt: new Date(fill.time),
  rawData: fill
}
```

**`saveHyperliquidOrders(orders: any[], managerId: string)`**
- Transforms orders to open-order schema
- Uses upsert to handle order updates
- Generates unique orderId: `hyperliquid-{wallet}-{oid/coin}-{timestamp}`
- Returns count of orders processed

**Schema mapping:**
```typescript
{
  orderId: `hyperliquid-${wallet}-${oid}-${timestamp}`,
  platform: 'hyperliquid',
  asset: order.coin,
  orderType: 'limit',
  direction: order.side === 'B' ? 'BUY' : 'SELL',
  size: parseFloat(order.sz),
  price: parseFloat(order.limitPx),
  status: 'open',
  placedAt: new Date(order.timestamp),
  rawData: order
}
```

### 4. Change Detector Updates (`services/monitoring/change-detector.ts`)

#### `enrichClosedPosition()` Function
- Now sets `dataSource: 'snapshot_detection'` for all snapshot-detected positions
- This differentiates Avantis/LP positions (approximate) from Hyperliquid fills (exact)

## Data Flow

### First Monitoring Cycle (No Previous Data)
```
1. orchestrator.runMonitoringCycle()
2. For each manager with Hyperliquid:
   a. Fire: fetchHyperliquidPositions() → snapshot
   b. Fire: fetchHyperliquidUserFills(lastFetchTime=undefined)
      → Fetches last 30 days
      → saveHyperliquidFills() → closedpositions collection
      → updateLastFillsFetchTime(now)
   c. Fire: fetchHyperliquidOpenOrders()
      → saveHyperliquidOrders() → openorders collection
3. All calls fire with 300ms stagger
4. Analytics computed after all data collected
```

### Subsequent Cycles (Incremental)
```
1. orchestrator.runMonitoringCycle()
2. For each manager:
   a. Fire: fetchHyperliquidPositions() → snapshot
   b. Fire: fetchHyperliquidUserFills(lastFetchTime=1234567890)
      → Fetches only NEW fills since last fetch
      → saveHyperliquidFills() → only new fills saved
      → updateLastFillsFetchTime(now)
   c. Fire: fetchHyperliquidOpenOrders()
      → Upserts orders (updates existing, creates new)
3. 300ms stagger between all calls
4. Analytics computed
```

## API Call Count Impact

### Before (per cycle with 12 managers):
- Avantis: 12 calls (if shouldFetchAvantis)
- Hyperliquid: 12 calls (if shouldFetchHyperliquid)
- LP: 12 calls (if shouldFetchLP)
- **Total: ~36 calls** (when all platforms active)

### After (per cycle with 12 managers):
- Avantis: 12 calls
- Hyperliquid positions: 12 calls
- **Hyperliquid fills: 12 calls** (NEW)
- **Hyperliquid orders: 12 calls** (NEW)
- LP: 12 calls
- **Total: ~60 calls** (when all platforms active)

**Performance Impact:**
- Stagger delay: 60 calls × 300ms = 18 seconds to start all calls
- Actual completion time depends on slowest API call
- Expected: 16-20 seconds total (based on previous 36-call test: 16.13s)

## Database Collections Modified

### `closedpositions`
- New documents with `dataSource: 'api_fills'` for Hyperliquid
- Existing documents with `dataSource: 'snapshot_detection'` for Avantis/LP

### `openorders`
- New/updated documents for Hyperliquid open orders
- Auto-cleanup after 30 days (TTL index on filled/cancelled orders)

### `managers`
- New field: `lastFillsFetchTime` (number, Unix timestamp)

## Next Steps

### 1. Testing Required
- [ ] Run monitoring cycle locally with environment variables
- [ ] Verify fills are saved correctly
- [ ] Verify orders are tracked
- [ ] Check incremental fetching works (run twice, verify only new fills)
- [ ] Verify no duplicate fills created

### 2. Analytics Updates Needed
- [ ] Update `compute-analytics.ts` to use Hyperliquid fills for exact metrics
- [ ] Add per-asset analytics computation
- [ ] Add daily performance aggregation
- [ ] Add equity curve calculation
- [ ] Update win rate to prioritize `dataSource: 'api_fills'`

### 3. Deployment
- [ ] Deploy updated Python service with batch endpoint
- [ ] Deploy Next.js with new monitoring logic
- [ ] Monitor Railway logs for errors
- [ ] Verify database writes

## Testing Locally

### Prerequisites
1. MongoDB URI in `.env.local`
2. Python service running on port 8000 (for Avantis)
3. Active managers in database

### Run Test
```bash
npm run test:monitor
```

### Expected Output
```
==================================================
🔄 Starting monitoring cycle...
==================================================
📊 Found 12 active managers

🚀 Firing all API calls independently...

📊 Total API calls to make: 60

✓ manager1/avantis: 5 positions (1234ms)
✓ manager1/hyperliquid: 3 positions (567ms)
✓ manager1/fills: 12 new fills (890ms)
✓ manager1/orders: 2 orders (234ms)
...

📊 Computing analytics for 12 managers...

==================================================
✅ Monitoring cycle completed
==================================================
   Managers: 12
   API calls made: 60
   Total positions: 145
   Closed positions: 89
   Analytics updated: 12
   Duration: 18.45s
   Errors: 0
==================================================
```

## Known Limitations

1. **Hyperliquid fills don't include open time**
   - `openedAt` is set to `closedAt` (approximate)
   - `holdDuration` is set to 0
   - Can potentially be enriched by matching with open position snapshots

2. **Exit reason detection**
   - All fills marked as `exitReason: 'manual'`
   - Could be enhanced by analyzing fill patterns

3. **ROI calculation**
   - Set to 0 in fills (missing margin info)
   - Will be calculated in analytics phase

4. **Order updates**
   - Orders are upserted but filled/cancelled orders not automatically removed
   - TTL index handles cleanup after 30 days

## Benefits

✅ **Real closed position data** for Hyperliquid (exact PnL, prices, times)
✅ **Open orders tracking** for better manager insights
✅ **Incremental fetching** reduces API load after first run
✅ **Data source tracking** enables quality filtering in analytics
✅ **Backward compatible** - existing snapshot detection still works for Avantis/LP
