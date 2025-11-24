# Avantis Event System - Implementation Guide

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    USER ACTION                               │
│         (Page Refresh / Click Refresh Button)                │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│            Python Service (Railway)                          │
│  ─────────────────────────────────────────────────────────   │
│  • Fetches from Avantis subgraph (source of truth)          │
│  • Updates `positions` collection (overwrite for wallet)     │
│  • Removes stale positions automatically                     │
│  • Returns: Open positions, pending orders, metrics          │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│              MongoDB: positions                              │
│           (Current open positions - all platforms)           │
└──────────────────────────────────────────────────────────────┘


┌──────────────────────────────────────────────────────────────┐
│       Avantis Event Logger (Vercel Cron - Every 5 mins)      │
│  ─────────────────────────────────────────────────────────   │
│  • Loads wallets from `positions` (Avantis, active)         │
│  • Checks last 10 minutes of blockchain events              │
│  • Logs MarketExecuted + LimitExecuted to historicaltrades  │
│  • Does NOT touch positions collection                       │
│  • Exits cleanly after each run                              │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│           MongoDB: historicaltrades                          │
│        (Complete event log - immutable audit trail)          │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                    NEW UI                                    │
│  ─────────────────────────────────────────────────────────   │
│  Live Positions:  Query `positions` collection              │
│  Closed Trades:   Query `historicaltrades` (eventType=CLOSE)│
│  Trade History:   Query `historicaltrades` (all events)     │
│  Analytics:       Aggregate `historicaltrades`              │
└──────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### ✅ Python Service = Single Source of Truth for Positions

**Why:**
- Avantis reuses `tradeIndex` numbers → Cannot uniquely identify positions
- Example: tradeIndex 1 can be:
  - SOL/USD position opened Nov 16
  - BTC/USD position opened Nov 24
  - Both exist simultaneously!
- Attempting to match CLOSE events by tradeIndex causes wrong position to be deleted

**Solution:**
- Python service fetches complete state from Avantis subgraph
- Overwrites entire `positions` collection for that wallet on each refresh
- Self-healing: Any inconsistencies are fixed on next refresh

---

### ✅ Event Logger = Audit Trail Only

**Why:**
- Simple, reliable, no sync complexity
- Avoids tradeIndex collision entirely
- Complete historical record preserved

**What it does:**
- Logs OPEN and CLOSE events to `historicaltrades`
- Never modifies `positions` collection
- Up to 5-minute lag acceptable for historical data

---

## Files & Scripts

### 1. **Avantis Event Logger** (`scripts/avantis-event-logger.ts`)

**Purpose:** 5-minute cron job to log recent trade events

**Features:**
- Dynamically loads wallets with active Avantis positions
- Checks last 10 minutes of blockchain events
- Logs both MarketExecuted + LimitExecuted events
- Handles duplicates gracefully (orderId unique index)
- Exits cleanly (perfect for cron)

**Usage:**
```bash
npx tsx scripts/avantis-event-logger.ts
```

**Expected Output:**
```
======================================================================
Avantis Event Logger
======================================================================
Started at: 11/24/2025, 1:30:00 PM

🔌 Connecting to MongoDB...
✅ Connected to MongoDB

📍 Loading wallets with active Avantis positions...
Found 5 wallets to monitor:

  1. 0x780bb763e1463d2236fec780b7bd6adb40aaa120
  2. 0x...
  3. 0x...

🔌 Connected to Base RPC

📦 Block Range:
  Latest: 38590685
  From: 38590085 (last ~10 minutes)
  Range: 600 blocks

🔍 Fetching MarketExecuted events...
  Found 3 MarketExecuted events
🔍 Fetching LimitExecuted events...
  Found 1 LimitExecuted events

📊 Filtered Events:
  Relevant MarketExecuted: 2
  Relevant LimitExecuted: 1
  Total to process: 3

💾 Processing and saving events...

  [1/3] CLOSE - 0x780bb763... - orderId: 4007038
  [2/3] OPEN - 0x... - orderId: 4007040
  [3/3] CLOSE (LIMIT) - 0x... - orderId: 4007041

======================================================================
✅ Event Logger Complete
======================================================================
Monitored Wallets: 5
Events Found: 3
Successfully Processed: 3
Skipped: 0
Errors: 0
Finished at: 11/24/2025, 1:30:05 PM
======================================================================
```

---

### 2. **Batch Backfiller** (`scripts/backfill-all-managers.ts`)

**Purpose:** One-time script to backfill 30 days of historical data

**Features:**
- Loads all wallets with active Avantis positions
- Excludes test wallet: `0x780BB763e1463D2236FEC780b7BD6ADb40AAa120`
- Backfills last 30 days
- 3-second delay between wallets (rate limit protection)
- Comprehensive error handling and progress tracking

**Usage:**
```bash
npx tsx scripts/backfill-all-managers.ts
```

**Expected Output:**
```
======================================================================
Backfill All Manager Wallets - Historical Trades (30 Days)
======================================================================
Started at: 11/24/2025, 2:00:00 PM

🔌 Connecting to MongoDB...
✅ Connected to MongoDB

📍 Loading wallets with active Avantis positions...
Total wallets found: 6
Excluded wallets: 1
Wallets to backfill: 5

Wallets to process:
  1. 0x...
  2. 0x...
  3. 0x...
  4. 0x...
  5. 0x...

🔌 Connected to Base RPC

📦 Block Range:
  Latest: 38590685
  From: 33406685 (30 days ago)
  Total blocks: 5184000

[█    ] 1/5

──────────────────────────────────────────────────────────────────
📍 Backfilling: 0x...
──────────────────────────────────────────────────────────────────
🔍 Fetching MarketExecuted events...
  Found 45 MarketExecuted events for this wallet
🔍 Fetching LimitExecuted events...
  Found 12 LimitExecuted events for this wallet

💾 Processing 57 events...

  Processed 10/57 events...
  Processed 20/57 events...
  ...
  Processed 57/57 events...

✅ Wallet backfill complete: 57 events processed, 0 errors

⏳ Waiting 3s before next wallet...

[██   ] 2/5
...

======================================================================
✅ Batch Backfill Complete
======================================================================
Total Wallets: 5
Successful: 5
Failed: 0
Total Events Processed: 234
Total Errors: 0
Finished at: 11/24/2025, 2:02:15 PM
======================================================================
```

---

### 3. **Event Correlator** (`services/avantis-listener/EventCorrelator.ts`)

**Changes:**
- ❌ **REMOVED:** Position add/remove logic
- ✅ **ONLY:** Logs events to `historicaltrades`
- ✅ **BENEFIT:** No tradeIndex collision issues

**Before:**
```typescript
// OPEN event - Add to positions + historicaltrades
await addOpenPosition(event, timestamp);

// CLOSE event - Remove from positions
await removeOpenPosition(trader, tradeIndex);
```

**After:**
```typescript
// Note: Position management is handled by Python service
// This service only logs events to historicaltrades
```

---

## Testing Locally

### **Phase 1: Test Event Logger**

1. **Start the logger:**
   ```bash
   npx tsx scripts/avantis-event-logger.ts
   ```

2. **Expected result:**
   - Loads wallets from `positions` collection
   - Checks last 10 minutes of events
   - Should find recent events (if any trades happened)
   - Exits cleanly with summary

3. **Make a test trade** (optional):
   - Open position on Avantis with test wallet
   - Wait ~1 minute
   - Run logger again
   - Should detect the OPEN event

4. **Verify in MongoDB:**
   ```javascript
   // Check if event was logged
   db.historicaltrades.find({
     trader: "0x780bb763e1463d2236fec780b7bd6adb40aaa120",
     createdAt: { $gte: new Date(Date.now() - 10*60*1000) }
   }).sort({ createdAt: -1 })
   ```

---

### **Phase 2: Run Batch Backfill**

1. **Check which wallets will be backfilled:**
   ```javascript
   // In MongoDB
   db.positions.distinct('walletAddress', {
     platform: 'Avantis',
     status: 'active'
   })
   ```

2. **Run the backfiller:**
   ```bash
   npx tsx scripts/backfill-all-managers.ts
   ```

3. **Monitor progress:**
   - Watch console for progress bar
   - Each wallet shows event count
   - 3-second delay between wallets

4. **Verify results:**
   ```javascript
   // Check total events logged
   db.historicaltrades.countDocuments({})

   // Check events by wallet
   db.historicaltrades.aggregate([
     { $group: {
       _id: "$trader",
       totalEvents: { $sum: 1 },
       openEvents: { $sum: { $cond: [{ $eq: ["$eventType", "OPEN"] }, 1, 0] } },
       closeEvents: { $sum: { $cond: [{ $eq: ["$eventType", "CLOSE"] }, 1, 0] } }
     }}
   ])
   ```

---

## MongoDB Queries

### **Check Recent Events:**
```javascript
// Last 10 minutes
db.historicaltrades.find({
  createdAt: { $gte: new Date(Date.now() - 10*60*1000) }
}).sort({ createdAt: -1 })
```

### **Check Closed Trades for Wallet:**
```javascript
db.historicaltrades.find({
  trader: "0x780bb763e1463d2236fec780b7bd6adb40aaa120",
  eventType: "CLOSE"
}).sort({ timestamp: -1 }).limit(10)
```

### **Calculate Total PnL:**
```javascript
db.historicaltrades.aggregate([
  { $match: {
      trader: "0x780bb763e1463d2236fec780b7bd6adb40aaa120",
      eventType: "CLOSE"
  }},
  { $group: {
      _id: null,
      totalPnl: { $sum: "$pnlUsdc" },
      totalTrades: { $sum: 1 },
      winners: { $sum: { $cond: [{ $gt: ["$pnlUsdc", 0] }, 1, 0] } }
  }}
])
```

### **Check Open vs Closed Count:**
```javascript
db.historicaltrades.aggregate([
  { $match: { trader: "0x780bb763e1463d2236fec780b7bd6adb40aaa120" } },
  { $group: {
      _id: "$eventType",
      count: { $sum: 1 }
  }}
])
```

---

## Deployment to Vercel

### **1. Create API Endpoint**

Create: `app/api/cron/avantis-events/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

export async function GET(request: NextRequest) {
  try {
    // Import and run the event logger
    const { default: connectDB } = await import('@/lib/mongoose');
    const { default: Position } = await import('@/models/Position');
    // ... rest of event logger logic ...

    return NextResponse.json({
      success: true,
      eventsProcessed: results.processed,
      errors: results.errors
    });

  } catch (error: any) {
    console.error('Cron job error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
```

### **2. Configure Vercel Cron**

In `vercel.json`:
```json
{
  "crons": [
    {
      "path": "/api/cron/avantis-events",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

### **3. Deploy**
```bash
git push
vercel --prod
```

### **4. Test Cron Endpoint**
```bash
curl https://your-app.vercel.app/api/cron/avantis-events
```

---

## Configuration

### **Environment Variables**

Required in `.env.local`:
```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/yieldr
QUICKNODE_BASE_RPC_URL=https://your-quicknode-base-rpc-url
```

### **Adjust Backfill Days**

In `scripts/backfill-all-managers.ts`:
```typescript
const DAYS_TO_BACKFILL = 30; // Change to 60, 90, etc.
```

### **Adjust Cron Frequency**

In `vercel.json`:
```json
"schedule": "*/5 * * * *"  // Every 5 minutes
"schedule": "*/10 * * * *" // Every 10 minutes
"schedule": "0 * * * *"    // Every hour
```

---

## Benefits of This Architecture

✅ **Simple:** No real-time sync complexity, no tradeIndex collision issues
✅ **Reliable:** Python service is source of truth for positions
✅ **Cost-effective:** 5-min cron much cheaper than 24/7 listener
✅ **Accurate:** Complete event log in historicaltrades
✅ **Scalable:** Easily add more wallets
✅ **Self-healing:** Python service reconciles on page refresh

---

## Limitations

⚠️ **Positions lag up to 5 minutes:** Between page refreshes, positions may be stale
⚠️ **Closed trades lag up to 5 minutes:** New closes won't show until cron runs
⚠️ **Vercel cron limits:** Pro plan = 100 invocations per day per cron job

---

## Troubleshooting

### **Event Logger finds 0 events**
- Check if wallets have active positions: `db.positions.countDocuments({ platform: 'Avantis', status: 'active' })`
- Verify no trades happened in last 10 minutes
- This is normal if no trading activity

### **Backfiller fails with rate limit error**
- Increase `DELAY_BETWEEN_WALLETS_MS` from 3000 to 5000+
- Reduce `DAYS_TO_BACKFILL` from 30 to 7 (do multiple smaller backfills)

### **Duplicate events in historicaltrades**
- Event logger has deduplication via unique `orderId` index
- Safe to run multiple times - duplicates are ignored

### **MongoDB connection timeout**
- Check `.env.local` has correct `MONGODB_URI`
- Verify Atlas IP whitelist includes your current IP

---

## Next Steps

1. ✅ **Test locally** - Run both scripts, verify MongoDB logs
2. ✅ **Backfill historical data** - Run batch backfiller for all managers
3. ⏳ **Deploy cron to Vercel** - Create API endpoint, configure vercel.json
4. ⏳ **Update UI** - Query historicaltrades for closed trades section
5. ⏳ **Add analytics** - Aggregate historicaltrades for insights

---

**Last Updated:** November 24, 2025
**Branch:** `claude/fix-historical-trades-backfill-01Vhw2ZWbnQY6qpxLHrmzeNs`
**Status:** ✅ Ready for Local Testing
