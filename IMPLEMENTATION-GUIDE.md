# Step-by-Step Implementation Guide

## 🎯 Overview

This guide walks you through implementing the Bloomberg-style dashboard with historical data tracking and monitoring service.

**Total Estimated Time:** 10-12 days
**Today's Focus:** Backend monitoring service (Days 1-3)

---

## 📋 Prerequisites

- [x] Database schemas created (`models/` directory)
- [x] Architecture plan reviewed
- [ ] MongoDB Atlas or local MongoDB running
- [ ] All existing API routes working
- [ ] Railway Python service operational

---

## 🚀 Phase 1: Core Monitoring Service (Days 1-3)

### **Step 1.1: Install Dependencies**

```bash
cd /home/user/yieldr-app

# Add monitoring dependencies
npm install --save \
  node-cron \
  ws \
  bull \
  ioredis \
  p-limit \
  date-fns

# Add chart library for frontend (later)
npm install --save \
  apexcharts \
  react-apexcharts

# Development tools
npm install --save-dev \
  @types/node-cron \
  @types/ws
```

### **Step 1.2: Create Service Directory Structure**

```bash
mkdir -p services/monitoring
mkdir -p services/analytics
mkdir -p services/websocket
mkdir -p app/api/monitoring
mkdir -p app/api/analytics
```

### **Step 1.3: Build Position Fetcher Service**

Create `services/monitoring/position-fetcher.ts` - this will be the core service that fetches positions from all platforms.

### **Step 1.4: Build Change Detector**

Create `services/monitoring/change-detector.ts` - compares snapshots and detects position changes.

### **Step 1.5: Build Snapshot Service**

Create `services/monitoring/snapshot-service.ts` - manages creating and storing snapshots.

### **Step 1.6: Create Monitoring Orchestrator**

Create `services/monitoring/orchestrator.ts` - coordinates all monitoring tasks.

### **Step 1.7: Create Cron Job Entry Point**

Create `app/api/cron/monitor-positions/route.ts` - API endpoint triggered by Vercel Cron.

### **Step 1.8: Test Locally**

```bash
# Run monitoring manually for testing
npm run monitor:test

# Should see:
# ✓ Fetched positions for 5 managers
# ✓ Created 5 snapshots
# ✓ Detected 3 closed positions
# ✓ Completed in 4.2s
```

---

## 📊 Phase 2: Analytics Engine (Days 4-5)

### **Step 2.1: Build Metrics Calculators**

Create separate modules for each metric type:
- `services/analytics/performance-metrics.ts`
- `services/analytics/risk-metrics.ts`
- `services/analytics/consistency-metrics.ts`
- `services/analytics/trading-stats.ts`

### **Step 2.2: Build Analytics Orchestrator**

Create `services/analytics/compute-analytics.ts` - computes all metrics for a manager.

### **Step 2.3: Create API Routes**

- `app/api/analytics/[managerId]/route.ts` - Get computed analytics
- `app/api/analytics/compute/route.ts` - Trigger computation

### **Step 2.4: Test Metric Accuracy**

```bash
npm run test:metrics

# Verify Sharpe ratio, win rate, etc. are correct
```

---

## 🔌 Phase 3: WebSocket Integration (Days 6-7)

### **Step 3.1: Build Hyperliquid WebSocket Client**

Create `services/websocket/hyperliquid-client.ts`.

### **Step 3.2: Create WebSocket Manager**

Create `services/websocket/connection-manager.ts` - manages multiple WS connections.

### **Step 3.3: Add Order Handlers**

Create `services/websocket/order-handlers.ts` - processes WS messages.

### **Step 3.4: Test WebSocket**

```bash
npm run test:ws

# Should maintain connection and receive order updates
```

---

## 🎨 Phase 4: Frontend Migration (Days 8-10)

### **Step 4.1: Create Next.js Manager Page**

```bash
# Create the new page
mkdir -p app/manager/\[username\]
touch app/manager/\[username\]/page.tsx
```

### **Step 4.2: Build Page Components**

Create reusable components:
- `components/manager/PerformanceSection.tsx`
- `components/manager/RiskSection.tsx`
- `components/manager/ConsistencySection.tsx`
- `components/manager/PositionsTable.tsx`
- `components/manager/PnLChart.tsx`
- `components/manager/PerformanceCalendar.tsx`

### **Step 4.3: Integrate ApexCharts**

Add charts to dashboard:
- PnL line chart (area with gradient)
- Asset distribution pie chart
- Daily performance calendar (heatmap)

### **Step 4.4: Add Auto-Refresh**

Implement 60s auto-refresh with countdown timer.

### **Step 4.5: Test Responsiveness**

Verify mobile and desktop views.

---

## 👤 Phase 5: Profile & Onboarding Updates (Days 11-12)

### **Step 5.1: Update Profile Page**

Move wallet management from dashboard to profile:
- Add wallet input
- Show primary + scouted wallets
- Add/remove wallet buttons

### **Step 5.2: Add Empty State Banner**

Show banner when manager has no positions.

### **Step 5.3: Update Navigation**

Add profile link to dropdown menu.

### **Step 5.4: Final Testing**

Complete end-to-end user flow testing.

---

## 🧪 Testing Checklist

### **Backend Testing**
- [ ] Monitoring runs every 60s without errors
- [ ] Snapshots created correctly
- [ ] Closed positions detected accurately
- [ ] Analytics computed correctly
- [ ] WebSocket maintains connections
- [ ] Open orders updated in real-time

### **Frontend Testing**
- [ ] Dashboard loads with real data
- [ ] Charts render correctly
- [ ] Auto-refresh works (60s countdown)
- [ ] Tabs switch properly (Live/Closed/Orders)
- [ ] Mobile responsive
- [ ] No console errors

### **Integration Testing**
- [ ] End-to-end user journey works
- [ ] Profile updates reflect on dashboard
- [ ] Position changes show immediately
- [ ] Analytics update after position changes

---

## 🚀 Deployment Plan

### **Step D1: Deploy Database Changes**

```bash
# MongoDB migrations are automatic with Mongoose
# Just deploy the new models
```

### **Step D2: Deploy Monitoring Service**

**Option A: Vercel Cron (Recommended)**
```json
// vercel.json
{
  "crons": [{
    "path": "/api/cron/monitor-positions",
    "schedule": "*/1 * * * *"  // Every minute
  }]
}
```

**Option B: Railway Cron**
```bash
# Deploy monitoring service to Railway
railway up

# Add cron job in Railway dashboard
```

### **Step D3: Deploy Frontend**

```bash
git add .
git commit -m "feat: Add Bloomberg-style dashboard with monitoring"
git push origin main

# Vercel auto-deploys
```

### **Step D4: Monitor Logs**

```bash
# Watch Vercel logs
vercel logs --follow

# Check for errors
grep "ERROR" logs.txt
```

---

## 📊 Success Metrics

After deployment, verify:

✅ **Monitoring Service**
- [ ] Runs every 60 seconds
- [ ] Processes all managers within 20 seconds
- [ ] <1% error rate
- [ ] Database writes completing

✅ **Dashboard**
- [ ] Page loads in <2 seconds
- [ ] Charts render smoothly
- [ ] Auto-refresh works
- [ ] Mobile-friendly

✅ **Data Quality**
- [ ] No missing snapshots
- [ ] Closed positions logged correctly
- [ ] Analytics accurate (spot-check)
- [ ] Real-time updates working

---

## 🐛 Common Issues & Solutions

### **Issue: Monitoring takes >60s**
**Solution:** Increase batch size, add caching, or reduce polling frequency for inactive managers.

### **Issue: Railway Python service timeout**
**Solution:** Increase timeout in API call, add retry logic, or split requests.

### **Issue: MongoDB write contention**
**Solution:** Use bulk writes, add indexing, or use MongoDB transactions.

### **Issue: Vercel cron limit exceeded**
**Solution:** Move to Railway or reduce cron frequency to every 2 minutes.

### **Issue: WebSocket disconnects frequently**
**Solution:** Add exponential backoff reconnection, increase timeout, or fall back to polling.

---

## 💰 Cost Breakdown (1000 Users MVP)

| Service | Plan | Monthly Cost |
|---------|------|--------------|
| Vercel | Pro | $20 |
| Railway (Python) | Starter | $5 |
| MongoDB Atlas | M10 | $57 |
| **Total** | | **$82/month** |

**Note:** This assumes Vercel cron stays under free tier limits. If exceeded, add Railway cron for $10/mo.

---

## 🎯 Quick Start (Right Now)

If you want to start immediately:

```bash
# 1. Review the schemas created
cd /home/user/yieldr-app
ls -la models/

# 2. Test MongoDB connection with new schemas
node -e "
  const mongoose = require('mongoose');
  require('./models/position-snapshot');
  require('./models/closed-position');
  require('./models/open-order');
  require('./models/manager-analytics');
  console.log('✅ All schemas loaded successfully');
"

# 3. Ready to build monitoring service!
```

Let me know when you're ready to start implementing the services!
