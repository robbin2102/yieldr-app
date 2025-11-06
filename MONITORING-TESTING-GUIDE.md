# Monitoring Service - Testing Guide

## 🎯 What You're Testing

The monitoring service that:
1. Fetches positions from Avantis, Hyperliquid, and LP platforms
2. Creates snapshots every 60 seconds
3. Detects new, closed, and modified positions
4. Logs closed positions to database for history
5. Computes analytics (Performance, Risk, Consistency metrics)

---

## 📋 Prerequisites

### 1. Environment Variables

Create `.env.local` file in project root:

```bash
# MongoDB connection
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/yieldr?retryWrites=true&w=majority

# Railway Python service (for Avantis)
AVANTIS_SERVICE_URL=https://your-railway-service.up.railway.app

# Cron secret (for security)
CRON_SECRET=your-secret-key-here

# Optional: If using Railway/external MongoDB
# NEXT_PUBLIC_API_URL=https://your-app.vercel.app
```

### 2. Ensure Dependencies Installed

```bash
npm install
```

---

## 🧪 Testing Locally

### **Option 1: Test Full Monitoring Cycle**

Runs monitoring for ALL managers in database:

```bash
npm run test:monitor
```

**Expected Output:**
```
╔════════════════════════════════════════════════════╗
║  Yieldr Monitoring Service - Test Script          ║
╚════════════════════════════════════════════════════╝

🔄 Running full monitoring cycle...

==================================================
🔄 Starting monitoring cycle...
==================================================
📊 Found 5 active managers

📦 Processing batch 1/1 (5 managers)
  ↳ your_username...
    ├─ Fetched 26 positions (4523ms)
    ├─ Changes: 2 new, 1 closed, 5 modified
    ├─ Logged 1 closed positions
    ✓ Analytics updated
    └─ Completed in 6847ms

==================================================
✅ Monitoring cycle completed
==================================================
   Managers processed: 5
   Total positions: 123
   Closed positions: 3
   Analytics updated: 5
   Duration: 18.42s
   Errors: 0
==================================================

╔════════════════════════════════════════════════════╗
║  Monitoring Cycle Complete                         ║
╚════════════════════════════════════════════════════╝
  ✓ Managers processed: 5
  ✓ Total positions: 123
  ✓ Closed positions logged: 3
  ✓ Analytics updated: 5 managers
  ✓ Duration: 18.42s
  ✓ Errors: 0

✅ Test completed successfully!
```

---

### **Option 2: Test Specific Manager**

Runs monitoring for ONLY one manager:

```bash
npm run test:monitor -- your_username
```

Replace `your_username` with an actual manager username from your database.

**Expected Output:**
```
╔════════════════════════════════════════════════════╗
║  Yieldr Monitoring Service - Test Script          ║
╚════════════════════════════════════════════════════╝

🎯 Testing monitoring for manager: @your_username

  ↳ your_username...
    ├─ Fetched 26 positions (4523ms)
    ├─ Changes: 2 new, 1 closed, 5 modified
    ├─ Logged 1 closed positions
    ✓ Analytics updated
    └─ Completed in 6847ms

╔════════════════════════════════════════════════════╗
║  Test Results                                      ║
╚════════════════════════════════════════════════════╝
  ✓ Positions found: 26
  ✓ Closed positions logged: 1
  ✓ Analytics updated: Yes
  ✓ Duration: 6.85s

✅ Test completed successfully!
```

---

## 🔍 Verifying Results in MongoDB

After running the test, check if data was saved correctly:

### **Using MongoDB Compass (GUI)**

1. Connect to your MongoDB instance
2. Navigate to `yieldr` database
3. Check these collections:

**positionsnapshots:**
- Should see new documents with `snapshotTime` = current time
- Each document has `positions` array with position data

**closedpositions:**
- Should see closed positions logged
- Check `pnl`, `roi`, `exitReason` fields

**manageranalytics:**
- Should see updated analytics for each manager
- Check `performance`, `risk`, `consistency` fields

### **Using MongoDB Shell**

```bash
# Connect to MongoDB
mongosh "mongodb+srv://cluster.mongodb.net/yieldr"

# Check snapshots
db.positionsnapshots.find().sort({ snapshotTime: -1 }).limit(3).pretty()

# Check closed positions
db.closedpositions.find().sort({ closedAt: -1 }).limit(5).pretty()

# Check analytics
db.manageranalytics.findOne({ username: "your_username" })

# Count documents
db.positionsnapshots.countDocuments()
db.closedpositions.countDocuments()
db.manageranalytics.countDocuments()
```

---

## ✅ What to Verify

### **1. Position Fetching**
- [ ] Avantis positions fetched successfully (no timeout errors)
- [ ] Hyperliquid positions fetched successfully
- [ ] LP positions fetched (if 5 minutes passed since last fetch)
- [ ] Position data looks correct (has `pnl`, `roi`, `asset`, etc.)

### **2. Snapshot Creation**
- [ ] Snapshots created in `positionsnapshots` collection
- [ ] `snapshotTime` is current
- [ ] Positions array has correct data
- [ ] Summary metrics calculated correctly

### **3. Change Detection**
- [ ] New positions detected correctly
- [ ] Closed positions detected correctly
- [ ] Modified positions detected (if any)

### **4. Closed Position Logging**
- [ ] Closed positions saved to `closedpositions` collection
- [ ] Has all required fields (`pnl`, `roi`, `closedAt`, etc.)
- [ ] No duplicate positions logged

### **5. Analytics Computation**
- [ ] Analytics saved to `manageranalytics` collection
- [ ] Performance metrics calculated (PnL, ROI, win rate)
- [ ] Risk metrics calculated (Sharpe ratio, max drawdown)
- [ ] Consistency metrics calculated (streaks, daily win rate)
- [ ] Trading stats calculated (avg hold time, position sizing)

---

## 🐛 Common Issues & Solutions

### **Issue 1: MongoDB Connection Failed**

**Error:**
```
MongoServerError: Authentication failed
```

**Solution:**
- Check `MONGODB_URI` in `.env.local`
- Ensure IP address is whitelisted in MongoDB Atlas
- Verify username/password are correct

---

### **Issue 2: Avantis Service Timeout**

**Error:**
```
[Avantis] Error fetching wallet 0xf9e9...: Request timeout
```

**Solution:**
- Check Railway Python service is running
- Verify `AVANTIS_SERVICE_URL` in `.env.local`
- Railway service might be sleeping (free tier) - try again in 30s

---

### **Issue 3: No Managers Found**

**Error:**
```
⚠️  No active managers found, skipping cycle
```

**Solution:**
- Check managers exist in database: `db.managers.find()`
- Ensure managers have `status !== 'inactive'`
- Create a test manager if needed

---

### **Issue 4: Hyperliquid API Fails**

**Error:**
```
[Hyperliquid] Failed for wallet 0xf9e9...: HTTP 500
```

**Solution:**
- Hyperliquid API might be temporarily down
- Check: https://hyperliquid.xyz/ status
- Monitoring will retry on next cycle

---

### **Issue 5: Analytics Not Computed**

**Error:**
```
[Analytics] No data available for username, skipping
```

**Solution:**
- Manager needs at least 1 position (live or closed)
- Run monitoring again after positions are fetched
- Check `closedpositions` and `positionsnapshots` collections

---

## 📊 Sample Data Verification

### **Check Snapshot Data:**
```javascript
// MongoDB Shell
db.positionsnapshots.findOne({}, {
  managerId: 1,
  platform: 1,
  snapshotTime: 1,
  'positions.0': 1,  // First position
  'summary': 1
})

// Should return:
{
  _id: ObjectId("..."),
  managerId: "673ab12345...",
  platform: "avantis",
  snapshotTime: ISODate("2025-11-06T14:30:00Z"),
  positions: [
    {
      positionId: "avantis-0xf9e9...-123",
      asset: "BTC/USD",
      direction: "LONG",
      pnl: 1250.50,
      roi: 15.6,
      ...
    }
  ],
  summary: {
    totalPositions: 15,
    totalAUM: 120000,
    totalPnL: 8450.25
  }
}
```

### **Check Closed Position Data:**
```javascript
db.closedpositions.findOne({}, {
  positionId: 1,
  asset: 1,
  pnl: 1,
  roi: 1,
  exitReason: 1,
  holdDuration: 1
})

// Should return:
{
  _id: ObjectId("..."),
  positionId: "avantis-0xf9e9...-123",
  asset: "BTC/USD",
  pnl: 1250.50,
  roi: 15.6,
  exitReason: "take_profit",
  holdDuration: 172800  // 2 days in seconds
}
```

### **Check Analytics Data:**
```javascript
db.manageranalytics.findOne({ username: "your_username" }, {
  username: 1,
  'performance.roi30d': 1,
  'performance.winRate': 1,
  'risk.sharpeRatio': 1,
  'consistency.currentStreak': 1,
  lastCalculated: 1
})

// Should return:
{
  _id: ObjectId("..."),
  username: "your_username",
  performance: {
    roi30d: 15.6,
    winRate: 67.5
  },
  risk: {
    sharpeRatio: 1.85
  },
  consistency: {
    currentStreak: {
      type: "win",
      count: 7
    }
  },
  lastCalculated: ISODate("2025-11-06T14:30:05Z")
}
```

---

## 🚀 Next Steps After Testing

Once local testing passes:

1. ✅ **Verify all data in MongoDB** looks correct
2. ✅ **Test multiple times** to ensure consistency
3. ✅ **Check analytics calculations** are accurate
4. ✅ **Deploy to production** (push to main branch)
5. ✅ **Set up Vercel Cron** to run every 60 seconds
6. ✅ **Monitor logs** for first 24-48 hours

---

## 📞 Need Help?

If you encounter issues:
1. Check the error message in console
2. Review the "Common Issues" section above
3. Check MongoDB logs
4. Verify all environment variables are set
5. Ensure Railway Python service is running

---

## 🎉 Success Indicators

You'll know it's working when:
- ✅ No errors in console
- ✅ Snapshots created in database
- ✅ Closed positions logged
- ✅ Analytics computed correctly
- ✅ Execution completes in <30 seconds
- ✅ Data matches what you see in Avantis/Hyperliquid
