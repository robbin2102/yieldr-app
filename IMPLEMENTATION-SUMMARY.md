# Real-Time Event Listener - Implementation Summary

## Overview
This document describes the implementation of the real-time Avantis event listener integrated with universal collections for multi-platform position tracking.

---

## Architecture

### Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│                    BLOCKCHAIN EVENTS                         │
│         MarketExecuted + LimitExecuted (Base Chain)          │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                 Node.js Real-Time Listener                   │
│                  (Polling every 2 seconds)                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  IF OPEN event:                                       │  │
│  │    1. Save to historicaltrades (event log)           │  │
│  │    2. Add to positions (current state)               │  │
│  │                                                       │  │
│  │  IF CLOSE event:                                      │  │
│  │    1. Save to historicaltrades (with PnL)            │  │
│  │    2. Remove from positions (by trader+tradeIndex)   │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                    MONGODB COLLECTIONS                       │
│  ┌──────────────────┬───────────────────┬─────────────────┐ │
│  │  positions       │  historicaltrades │  pendingorders  │ │
│  │  (ALL platforms) │  (ALL platforms)  │  (ALL platforms)│ │
│  │  ──────────────  │  ───────────────  │  ──────────────│ │
│  │  • Avantis      │  • Avantis        │  • Avantis      │ │
│  │  • Hyperliquid  │  • Hyperliquid    │  • Hyperliquid  │ │
│  │  • LP           │  • LP             │                  │ │
│  │  • Predictions  │  • Predictions    │                  │ │
│  └──────────────────┴───────────────────┴─────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                      NEW UI DESIGN                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 💼 Positions                                           │  │
│  │  ┌─────────────────┬──────────────────┐              │  │
│  │  │ Perps Live (47) │ Perps Closed (247)│              │  │
│  │  │ Prediction (12) │ Prediction (89)   │              │  │
│  │  └─────────────────┴──────────────────┘              │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## Database Collections

### 1. **`positions`** (Universal - Open Positions)
**Purpose:** Store ALL currently open positions across all platforms
**Updated by:** Python service (full sync) + Node.js listener (real-time add/remove)
**Used for:** "Perps Live", "Prediction Active" sections in UI

**Key Fields:**
```typescript
{
  walletAddress: string,       // Trader address
  type: 'PERP' | 'LP' | 'PREDICTION',
  platform: 'Avantis' | 'Hyperliquid' | 'Aero' | ...,
  positionId: string | number, // tradeIndex for Avantis (KEY for matching CLOSE)
  status: 'active' | 'closed',

  // PERP fields
  pair: string,                // BTC, ETH, SOL, etc.
  direction: 'LONG' | 'SHORT',
  leverage: number,
  positionSize: number,        // Total position size (USDC)
  margin: number,              // Collateral (USDC)
  entryPrice: number,
  currentPrice: number,
  pnl: number,
  roi: number,

  // LP fields
  pool: string,
  liquidity: number,

  // Metadata
  createdAt: Date,
  updatedAt: Date,
  txHash: string,
}
```

**Indexes:**
- `{ walletAddress: 1, platform: 1 }`
- `{ walletAddress: 1, type: 1 }`
- `{ platform: 1, positionId: 1 }` ← **Critical for CLOSE event matching**
- `{ walletAddress: 1, status: 1 }`

---

### 2. **`historicaltrades`** (Universal - Event Log)
**Purpose:** Immutable event log of ALL trade events (OPEN + CLOSE) across all platforms
**Updated by:** Node.js listener (real-time) + Python service (backfill)
**Used for:** "Perps Closed", "Prediction Closed", analytics, PnL history

**Key Fields:**
```typescript
{
  orderId: string,             // Unique for each event (OPEN has different orderId than CLOSE)
  eventType: 'OPEN' | 'CLOSE',
  trader: string,
  platform: 'Avantis' | 'Hyperliquid' | ...,
  tradeType: 'PERP' | 'PREDICTION',

  pairSymbol: string,
  tradeIndex: number,          // Links OPEN/CLOSE for same position
  direction: 'LONG' | 'SHORT',

  // Common
  timestamp: Date,
  txHash: string,
  collateralUsdc: number,
  positionSizeUsdc: number,
  leverage: number,

  // OPEN-specific
  openPrice: number,
  tp: number,
  sl: number,

  // CLOSE-specific
  closePrice: number,
  pnlUsdc: number,
  roi: number,
}
```

**Indexes:**
- `{ orderId: 1 }` (unique) ← Prevents duplicate events
- `{ trader: 1, timestamp: -1 }`
- `{ trader: 1, eventType: 1 }`
- `{ platform: 1, trader: 1 }`

---

### 3. **`pendingorders`** (Universal - Pending Limit Orders)
**Purpose:** Store ALL pending limit orders (not yet executed) across all platforms
**Updated by:** Python service (full sync) + Node.js listener (remove on execute)
**Used for:** "Pending Orders" section in UI

**Key Fields:**
```typescript
{
  platform: 'Avantis' | 'Hyperliquid' | ...,
  trader: string,
  orderType: 'LIMIT_OPEN' | 'TP' | 'SL' | 'LIQUIDATION',

  asset: string,
  direction: 'LONG' | 'SHORT',
  triggerPrice: number,

  // For LIMIT_OPEN
  orderSize: number,
  leverage: number,

  // Platform-specific identifiers
  orderId: string,             // Avantis orderId
  tradeIndex: number,          // Avantis tradeIndex (for TP/SL matching)

  // Metadata
  createdAt: Date,
  lastSyncedAt: Date,          // When Python service last confirmed it exists
}
```

**Indexes:**
- `{ trader: 1, platform: 1 }`
- `{ platform: 1, orderType: 1 }`
- `{ orderId: 1 }` (unique, sparse) ← For Avantis
- `{ trader: 1, tradeIndex: 1 }` (sparse) ← For matching TP/SL

---

## Key Implementation Details

### Event Matching Strategy

**CRITICAL:** We cannot correlate OPEN and CLOSE events by `orderId` because each event has a unique orderId. Instead:

- **For OPEN events:** Store position with `positionId = tradeIndex`
- **For CLOSE events:** Match by `{ walletAddress: trader, platform: 'Avantis', positionId: tradeIndex }`

**Why this works:**
- Each position on Avantis has a unique `tradeIndex` per trader
- OPEN event: `{ orderId: "400001", tradeIndex: 5, open: true }`
- CLOSE event: `{ orderId: "400099", tradeIndex: 5, open: false }`
- We match by `tradeIndex`, not `orderId`!

### Event Processing Logic

```typescript
// EventCorrelator.ts - processMarketExecuted()

if (event.open) {
  // OPEN EVENT
  // 1. Save to historicaltrades
  await TradeEvent.save({
    orderId: event.orderId,
    eventType: 'OPEN',
    tradeIndex: event.tradeIndex,
    ...
  });

  // 2. Add to positions
  await Position.save({
    walletAddress: event.trader,
    platform: 'Avantis',
    positionId: event.tradeIndex,  // KEY!
    ...
  });

} else {
  // CLOSE EVENT
  // 1. Save to historicaltrades (with PnL)
  await TradeEvent.save({
    orderId: event.orderId,
    eventType: 'CLOSE',
    tradeIndex: event.tradeIndex,
    pnlUsdc: event.pnlUsdc,
    ...
  });

  // 2. Remove from positions (match by trader + tradeIndex)
  await Position.deleteOne({
    walletAddress: event.trader,
    platform: 'Avantis',
    positionId: event.tradeIndex,  // Match by tradeIndex!
  });
}
```

---

## Service Responsibilities

### Node.js Real-Time Listener (24/7)
✅ Watch blockchain for `MarketExecuted` + `LimitExecuted` events
✅ Process events within ~2-4 seconds
✅ Update `historicaltrades` collection (all events)
✅ Manage `positions` collection (add OPEN, remove CLOSE)
✅ Future: Remove from `pendingorders` when limit order executes
✅ Future: Emit WebSocket events for UI updates

**Deploy as:** PM2 service or Docker container

### Python Service (On-Demand)
✅ Fetch all open positions from Avantis subgraph (on page refresh)
✅ Fetch all pending orders from Avantis subgraph
✅ Full sync `positions` collection (overwrites for wallet)
✅ Full sync `pendingorders` collection
✅ Acts as reconciliation backup (compare subgraph vs DB)
✅ Handles initial data loads for new manager wallets

**Keep on:** Railway (existing deployment)

### Coexistence Strategy

Both services write to `positions` collection:

1. **Python Service (Page Refresh):**
   - Deletes all positions for wallet: `deleteMany({ walletAddress })`
   - Fetches fresh data from subgraph
   - Inserts all current positions

2. **Node.js Listener (Real-Time):**
   - Adds position on OPEN event
   - Removes position on CLOSE event
   - May add/remove positions that Python service doesn't know about yet

3. **Result:**
   - Between page refreshes: Node.js keeps positions updated in real-time
   - On page refresh: Python service reconciles with subgraph (source of truth)
   - No conflicts: Node.js uses upsert logic to prevent duplicates

---

## Files Modified/Created

### New Models
- ✅ `models/Position.ts` - Universal position model (all platforms)
- ✅ `models/PendingOrder.ts` - Universal pending orders model
- ❌ `models/AvantisOpenPosition.ts` - REMOVED (replaced by Position)

### Modified Services
- ✅ `services/avantis-listener/EventCorrelator.ts` - Updated to use `Position` model
- ✅ `services/avantis-listener/EventListener.ts` - Added `LimitExecuted` event support

### Test Scripts
- ✅ `scripts/test-listener.ts` - Real-time monitoring script
- ✅ `scripts/query-positions.ts` - Updated to query universal `positions` collection

### Documentation
- ✅ `TESTING-GUIDE.md` - Comprehensive testing documentation
- ✅ `IMPLEMENTATION-SUMMARY.md` - This file

---

## Testing

### Test Wallet
```
0x780BB763e1463D2236FEC780b7BD6ADb40AAa120
```

### Quick Start
```bash
# 1. Pull latest code
git pull origin claude/fix-historical-trades-backfill-01Vhw2ZWbnQY6qpxLHrmzeNs

# 2. Start listener
npx tsx scripts/test-listener.ts 0x780BB763e1463D2236FEC780b7BD6ADb40AAa120

# 3. Make test trade on Avantis

# 4. Check results
npx tsx scripts/query-positions.ts 0x780BB763e1463D2236FEC780b7BD6ADb40AAa120
```

See `TESTING-GUIDE.md` for detailed testing instructions.

---

## UI Integration (Future)

### API Endpoints Needed

```typescript
// Get open positions for wallet (all platforms)
GET /api/positions?address=0x...&status=active
→ Returns: positions collection (Avantis, Hyperliquid, LP)

// Get closed trades for wallet (all platforms)
GET /api/trades/closed?address=0x...&limit=50
→ Returns: historicaltrades collection (eventType: CLOSE)

// Get pending orders for wallet (all platforms)
GET /api/orders/pending?address=0x...
→ Returns: pendingorders collection

// WebSocket for real-time updates
WS /ws/positions
→ Emits: { type: 'position_opened', data: {...} }
→ Emits: { type: 'position_closed', data: {...} }
```

### UI Structure

```
💼 Positions
├─ Perps Live (47)     → Query: positions (type=PERP, status=active)
├─ Perps Closed (247)  → Query: historicaltrades (tradeType=PERP, eventType=CLOSE)
├─ Prediction Active   → Query: positions (type=PREDICTION, status=active)
└─ Prediction Closed   → Query: historicaltrades (tradeType=PREDICTION, eventType=CLOSE)

📋 Pending Orders
└─ All Platforms       → Query: pendingorders
```

---

## Production Deployment Checklist

- [ ] Test listener with test wallet (multiple OPEN/CLOSE cycles)
- [ ] Verify positions are added/removed correctly
- [ ] Test coexistence with Python service (page refresh during listening)
- [ ] Load all manager wallets from database
- [ ] Deploy Node.js listener as PM2 service
- [ ] Configure process manager (auto-restart, logs)
- [ ] Monitor for 24 hours on staging
- [ ] Set up alerts for errors/disconnections
- [ ] Gradually migrate UI from old `positions` logic to new queries
- [ ] Implement WebSocket for real-time UI updates

---

## Benefits of This Architecture

✅ **Universal Collections:** One collection per data type (positions, historicaltrades, pendingorders)
✅ **Platform Agnostic:** Easy to add Hyperliquid, Predictions, etc.
✅ **Real-Time + Reconciliation:** Node.js for speed, Python for accuracy
✅ **No Duplication:** Clear separation of responsibilities
✅ **Backward Compatible:** Python service continues working as-is
✅ **Event Sourcing:** Complete event history in `historicaltrades`
✅ **Fast Queries:** Optimized indexes for UI queries
✅ **Scalable:** Add more wallets/platforms without architectural changes

---

## Known Limitations

⚠️ **Cannot correlate OPEN/CLOSE by orderId:** Each event has unique orderId, must use tradeIndex
⚠️ **Python service overwrites positions:** On page refresh, deletes all positions for wallet
⚠️ **Partial closes:** May need special handling if Avantis supports them
⚠️ **Initial state:** Listener only captures new events, Python service provides initial state
⚠️ **WebSocket not implemented:** UI still needs polling or manual refresh for now

---

## Next Steps

1. **Test with test wallet** - Verify OPEN/CLOSE cycle works
2. **Implement pending orders removal** - When LimitExecuted fires, remove from pendingorders
3. **Add WebSocket support** - Real-time UI updates
4. **Load manager wallets** - Monitor all active trading wallets
5. **Production deployment** - Deploy as PM2 service
6. **UI migration** - Update frontend to use new collections

---

**Last Updated:** 2025-11-24
**Branch:** `claude/fix-historical-trades-backfill-01Vhw2ZWbnQY6qpxLHrmzeNs`
**Status:** ✅ Ready for Testing
