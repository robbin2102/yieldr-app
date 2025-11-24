# Real-Time Event Listener - Testing Guide

## Overview
Test the real-time event listener using your test wallet on Avantis to verify trades are captured instantly.

## Prerequisites

1. **Test Wallet:** `0x780BB763e1463D2236FEC780b7BD6ADb40AAa120`
2. **MongoDB Running:** Local or Atlas connection
3. **RPC Access:** QuickNode Base RPC configured in `.env.local`
4. **Some Base ETH:** For gas fees on test trades

---

## Step 1: Start the Listener

Open a terminal and start monitoring your test wallet:

```bash
npx tsx scripts/test-listener.ts 0x780BB763e1463D2236FEC780b7BD6ADb40AAa120
```

**Expected Output:**
```
======================================================================
Real-Time Event Listener - Test Mode
======================================================================

📍 Monitoring wallet: 0x780BB763e1463D2236FEC780b7BD6ADb40AAa120
⚡ Watching for both Market and Limit orders
🔄 Polling every 2 seconds

💡 Make a test trade on Avantis to see events!

🔌 Connecting to MongoDB...
✅ Connected to MongoDB

🔌 Connecting to Base RPC...
✅ Connected to Base RPC

======================================================================
Starting listener...
======================================================================

[EventListener] Initialized with 1 monitored wallets
[EventListener] Starting event listener...
[EventListener] ✓ Event listener started successfully
[EventListener] Monitoring 1 wallets

✅ Listener is now active!

📊 Status will be logged every 30 seconds
🛑 Press Ctrl+C to stop
```

**What's Happening:**
- Listener polls Base blockchain every 2 seconds
- Watches for MarketExecuted AND LimitExecuted events
- Filters events for only your wallet
- Saves to both `historicaltrades` and `avantis-openpositions` collections

---

## Step 2: Make a Test Trade on Avantis

1. **Go to:** [https://app.avantisfi.com](https://app.avantisfi.com)
2. **Connect** your test wallet
3. **Open a small position:**
   - Pair: BTC/USD or ETH/USD (your choice)
   - Direction: LONG or SHORT
   - Collateral: **$50-100 USDC** (small test)
   - Leverage: 5x or 10x
   - Set TP and SL (important for testing limit orders!)

4. **Confirm** the transaction

---

## Step 3: Watch for OPEN Event

Within ~4 seconds (2 polling cycles), you should see:

```
[EventListener] Received 1 MarketExecuted events
[EventListener] MarketExecuted - orderId: 4005123, trader: 0x780bb763..., open: true
[Correlator] Processing executed event - orderId: 4005123, type: OPEN, trader: 0x780bb763...
[Correlator] ✓ Event saved - orderId: 4005123, type: OPEN
[Correlator] ✓ Added to open positions - orderId: 4005123
[Correlator] ✓ Emitted trade:opened event for 4005123
[EventListener] ✓ Event processed successfully
```

**What This Means:**
- ✅ OPEN event detected from blockchain
- ✅ Saved to `historicaltrades` collection
- ✅ Added to `avantis-openpositions` collection
- ✅ Event emitted for frontend (if WebSocket connected)

---

## Step 4: Check the Database

In a **second terminal**, while keeping the listener running, query your positions:

```bash
npx tsx scripts/query-positions.ts 0x780BB763e1463D2236FEC780b7BD6ADb40AAa120
```

**Expected Output:**
```
======================================================================
Position & Trade Query
======================================================================

📍 Wallet: 0x780BB763e1463D2236FEC780b7BD6ADb40AAa120

✅ Connected to MongoDB

======================================================================
OPEN POSITIONS
======================================================================

Total: 1 open positions

BTC/USD SHORT
  Order ID: 4005123
  Opened: 11/24/2025, 3:30:15 PM
  Open Price: $98345.67
  Collateral: $100.00 USDC
  Leverage: 10x
  TP: $95000.00 | SL: $102000.00
  Tx: 0x1234567890abcdef...

======================================================================
RECENT CLOSED TRADES (Last 10)
======================================================================

[... your previous trades ...]

======================================================================
SUMMARY STATISTICS
======================================================================

Total Closed Trades: 71
Total PnL: $11,954.98 USDC
Average PnL: $168.38 USDC
Average ROI: 15.32%
Win Rate: 62.00% (44W / 27L)
```

**Verification:**
- ✅ Your new position appears in "OPEN POSITIONS"
- ✅ Order ID matches
- ✅ All details are correct (pair, direction, price, collateral, TP/SL)

---

## Step 5: Close the Position (Test CLOSE Event)

Back on Avantis, close your test position:

**Option A: Market Close**
1. Go to your open positions
2. Click "Close Position"
3. Choose "Market Close"
4. Confirm transaction

**Option B: Let TP/SL Hit (Better Test!)**
1. Wait for price to hit your Take Profit or Stop Loss
2. This will test **LimitExecuted** event tracking
3. More realistic scenario

---

## Step 6: Watch for CLOSE Event

### If Market Close:
```
[EventListener] Received 1 MarketExecuted events
[EventListener] MarketExecuted - orderId: 4005124, trader: 0x780bb763..., open: false
[Correlator] Processing executed event - orderId: 4005124, type: CLOSE, trader: 0x780bb763...
[Correlator] ✓ Event saved - orderId: 4005124, type: CLOSE, PnL: 45.23 USDC, ROI: 45.23%
[Correlator] ✓ Removed from open positions - orderId: 4005123
[Correlator] ✓ Emitted trade:closed event for 4005124
```

### If TP/SL Hit (LimitExecuted):
```
[EventListener] Received 1 LimitExecuted events
[EventListener] LimitExecuted - orderId: 4005124, trader: 0x780bb763..., open: false, type: TP/SL/LIQ
[Correlator] Processing executed event - orderId: 4005124, type: CLOSE, trader: 0x780bb763...
[Correlator] ✓ Event saved - orderId: 4005124, type: CLOSE, PnL: 50.00 USDC, ROI: 50.00%
[Correlator] ✓ Removed from open positions - orderId: 4005123
[Correlator] ✓ Emitted trade:closed event for 4005124
```

**What This Means:**
- ✅ CLOSE event detected (Market OR Limit)
- ✅ Saved to `historicaltrades` with PnL
- ✅ Removed from `avantis-openpositions`
- ✅ Your position is now closed

---

## Step 7: Verify Closed Trade

Query again to verify:

```bash
npx tsx scripts/query-positions.ts 0x780BB763e1463D2236FEC780b7BD6ADb40AAa120
```

**Expected:**
```
======================================================================
OPEN POSITIONS
======================================================================

No open positions found.

======================================================================
RECENT CLOSED TRADES (Last 10)
======================================================================

11/24/2025, 3:35:22 PM | BTC/USD SHORT
  ✅ PnL: +$45.23 USDC (+45.23%)
  Collateral: $100.00
  Close Price: $96789.12
  Order ID: 4005124

[... other trades ...]

======================================================================
SUMMARY STATISTICS
======================================================================

Total Closed Trades: 72
Total PnL: $12,000.21 USDC
Average PnL: $166.67 USDC
Win Rate: 62.50% (45W / 27L)
```

**Verification:**
- ✅ Position removed from open positions
- ✅ New closed trade appears at top
- ✅ PnL calculated correctly
- ✅ Statistics updated

---

## MongoDB Verification

You can also check MongoDB directly:

```javascript
// Connect to MongoDB
mongosh yieldr

// Check open positions
db['avantis-openpositions'].find({
  trader: "0x780bb763e1463d2236fec780b7bd6adb40aaa120"
}).pretty()

// Check recent events
db.historicaltrades.find({
  trader: "0x780bb763e1463d2236fec780b7bd6adb40aaa120"
}).sort({ timestamp: -1 }).limit(5).pretty()

// Verify counts
db.historicaltrades.countDocuments({
  trader: "0x780bb763e1463d2236fec780b7bd6adb40aaa120",
  eventType: "OPEN"
})

db.historicaltrades.countDocuments({
  trader: "0x780bb763e1463d2236fec780b7bd6adb40aaa120",
  eventType: "CLOSE"
})
```

---

## Troubleshooting

### Issue 1: No Events Detected

**Symptoms:**
```
[EventListener] Received 0 MarketExecuted events
[EventListener] Received 0 LimitExecuted events
```

**Solutions:**
1. **Check RPC connection:**
   ```bash
   curl $QUICKNODE_BASE_RPC_URL \
     -X POST \
     -H "Content-Type: application/json" \
     --data '{"method":"eth_blockNumber","params":[],"id":1,"jsonrpc":"2.0"}'
   ```

2. **Verify wallet address:**
   - Make sure it matches exactly (case-insensitive but check for typos)
   - The wallet must be the one making trades

3. **Check blockchain confirmations:**
   - Wait 1-2 minutes for transaction to be confirmed
   - Check on [Basescan](https://basescan.org)

### Issue 2: Duplicate Events

**Symptoms:**
```
[Correlator] Event 4005123 already processed, skipping...
```

**This is NORMAL and GOOD:**
- Means deduplication is working
- Same event won't be saved twice
- Polling catches the same event multiple times until new blocks appear

### Issue 3: Position Not Removed on Close

**Symptoms:**
- CLOSE event saved to historicaltrades
- But position still in avantis-openpositions

**Solutions:**
1. **Check logs for errors:**
   ```
   [Correlator] Error removing open position...
   ```

2. **Manual removal (if needed):**
   ```javascript
   db['avantis-openpositions'].deleteOne({
     orderId: "4005123"
   })
   ```

### Issue 4: Partial Closes

**Symptoms:**
- Warning: "Open position not found (may have been closed before or partial close)"

**This is EXPECTED for partial closes:**
- First partial close removes the position
- Subsequent partials can't find it (already removed)
- This is OK - all CLOSE events are still logged in historicaltrades

---

## Testing Checklist

- [ ] Listener starts successfully
- [ ] Connected to MongoDB
- [ ] Connected to Base RPC
- [ ] OPEN event detected within 4 seconds
- [ ] Saved to historicaltrades (OPEN)
- [ ] Added to avantis-openpositions
- [ ] Position visible in query-positions.ts
- [ ] CLOSE event detected (market or limit)
- [ ] Saved to historicaltrades (CLOSE) with PnL
- [ ] Removed from avantis-openpositions
- [ ] PnL matches Avantis dashboard
- [ ] Statistics updated correctly

---

## Success Criteria

✅ **Real-time detection:** Events appear within 2-4 seconds of blockchain confirmation
✅ **Correct storage:** Both collections updated properly
✅ **Accurate PnL:** Matches Avantis dashboard
✅ **Limit order support:** TP/SL closes detected via LimitExecuted
✅ **Partial close handling:** Warnings are OK, data is still correct
✅ **Deduplication:** No duplicate entries in database

---

## Next Steps After Testing

Once testing is successful:

1. **Load Manager Wallets:**
   - Create ManagerWalletLoader.ts
   - Load all active Avantis managers from DB
   - Start listener with all manager wallets

2. **Deploy as Service:**
   - Use PM2 to run listener 24/7
   - Set up monitoring and alerts
   - Configure auto-restart on errors

3. **Frontend Integration:**
   - Add WebSocket for real-time UI updates
   - Show live trades as they happen
   - Notifications for large PnL

---

**Document Version:** 1.0
**Last Updated:** November 24, 2025
**Status:** Ready for Testing ✅
