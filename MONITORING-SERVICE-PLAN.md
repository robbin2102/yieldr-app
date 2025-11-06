# Monitoring Service Architecture Plan

## 🎯 Goals
1. Track position changes every 60 seconds for Avantis & Hyperliquid
2. Track LP positions every 300 seconds
3. Detect new, closed, and modified positions
4. Compute analytics metrics in real-time
5. Scale to 1000 users (MVP target)

---

## 🏗️ Recommended Architecture

### **Hybrid Approach: Node.js + Python**

```
┌─────────────────────────────────────────────────────────────┐
│                     YIELDR MONITORING STACK                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐     ┌─────────────────────────────┐  │
│  │  Next.js App     │     │  Node.js Monitor Service    │  │
│  │  (Vercel)        │────▶│  (Vercel Cron / Railway)    │  │
│  │                  │     │                              │  │
│  │  • Dashboard UI  │     │  • Position monitoring       │  │
│  │  • API routes    │     │  • Change detection          │  │
│  │  • WebSocket mgmt│     │  • Analytics computation     │  │
│  └──────────────────┘     └─────────────────────────────┘  │
│           │                            │                    │
│           │                            ▼                    │
│           │                  ┌──────────────────┐          │
│           │                  │   MongoDB Atlas  │          │
│           └─────────────────▶│                  │          │
│                              │  • Positions     │          │
│                              │  • Snapshots     │          │
│                              │  • Analytics     │          │
│                              └──────────────────┘          │
│                                       │                     │
│                                       │                     │
│  ┌────────────────────────────────────┼──────────────────┐ │
│  │         EXTERNAL DATA SOURCES      │                  │ │
│  ├────────────────────────────────────┴──────────────────┤ │
│  │                                                        │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │ │
│  │  │  Avantis    │  │ Hyperliquid │  │  Krystal LP  │  │ │
│  │  │  (Python)   │  │    API +    │  │     API      │  │ │
│  │  │  Railway    │  │  WebSocket  │  │              │  │ │
│  │  │             │  │             │  │              │  │ │
│  │  │  60s poll   │  │  WS + 60s   │  │   300s poll  │  │ │
│  │  └─────────────┘  └─────────────┘  └──────────────┘  │ │
│  │                                                        │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 📊 Monitoring Service Components

### 1. **Position Monitor** (`services/position-monitor.ts`)
- Runs every 60 seconds via cron job
- Fetches current positions from all platforms
- Compares with last snapshot
- Detects changes (new, closed, modified)
- Logs changes to database

### 2. **Change Detector** (`services/change-detector.ts`)
- Compares current vs previous snapshots
- Identifies:
  - New positions (not in previous snapshot)
  - Closed positions (in previous, not in current)
  - Modified positions (same ID, different values)
- Creates `ClosedPosition` records

### 3. **Analytics Computer** (`services/analytics-computer.ts`)
- Triggered after position updates
- Computes all metrics for dashboard
- Calculates:
  - Performance metrics (PnL, ROI, win rate)
  - Risk metrics (Sharpe, Sortino, drawdown)
  - Consistency metrics (streaks, daily performance)
- Updates `ManagerAnalytics` collection

### 4. **Hyperliquid WebSocket Client** (`services/hyperliquid-ws.ts`)
- Maintains WebSocket connections for active managers
- Subscribes to user fills and orders
- Updates `OpenOrders` in real-time
- Falls back to polling if WS disconnects

---

## ⚡ Scalability Strategy for 1000 Users

### **Load Distribution**

**Current State:**
- 1000 managers
- 60s polling interval
- 3 platforms per manager (Avantis, Hyperliquid, LP)

**Request Load:**
```
Avantis:     1000 managers × 1 request / 60s = 16.7 req/s
Hyperliquid: 1000 managers × 1 request / 60s = 16.7 req/s (backup)
LP:          1000 managers × 1 request / 300s = 3.3 req/s
──────────────────────────────────────────────────────────
Total:       ~37 req/s
```

**✅ This is VERY manageable** for MVP scale.

### **Optimization Strategies**

#### **Strategy 1: Batching (Immediate Implementation)**
```typescript
// Instead of processing 1 manager at a time:
for (const manager of managers) {
  await fetchAndUpdate(manager);
}

// Process in batches of 10:
const BATCH_SIZE = 10;
for (let i = 0; i < managers.length; i += BATCH_SIZE) {
  const batch = managers.slice(i, i + BATCH_SIZE);
  await Promise.all(batch.map(fetchAndUpdate));
}
```

**Result:** 10x faster processing

#### **Strategy 2: Smart Polling (Phase 2)**
- Poll active managers (positions > 0) every 60s
- Poll inactive managers (no positions) every 300s
- Reduces load by ~40-50%

#### **Strategy 3: Priority Queue (Phase 2)**
- High priority: Managers with co-investors (must be real-time)
- Medium priority: Active managers without co-investors
- Low priority: Scout-only managers

#### **Strategy 4: Caching (Immediate)**
- Cache live position data for 10 seconds
- If frontend requests within 10s, serve cached data
- Reduces redundant API calls

### **Infrastructure Recommendations**

| Component | Provider | Reason |
|-----------|----------|--------|
| Next.js App | **Vercel Pro** | Best Next.js performance, edge functions |
| Monitoring Service | **Vercel Cron** (primary)<br>Railway (backup) | Vercel cron is free up to 100/day, perfect for 60s jobs |
| Python Service | **Railway** (keep current) | Already working, only used for Avantis |
| Database | **MongoDB Atlas M10** | $57/mo, handles 1000 users easily |
| WebSocket Mgmt | **Vercel Edge Functions** | Low latency, auto-scaling |

**Monthly Cost Estimate:** ~$150-200 for 1000 users MVP

---

## 🔄 Monitoring Flow

### **Every 60 Seconds:**

```typescript
// 1. Fetch all active managers
const managers = await getActiveManagers();

// 2. Process in batches
const BATCH_SIZE = 10;
for (const batch of chunks(managers, BATCH_SIZE)) {
  await Promise.all(batch.map(async (manager) => {

    // 3. Fetch current positions (parallel)
    const [avantis, hyperliquid, lp] = await Promise.all([
      fetchAvantisPositions(manager.wallets),
      fetchHyperliquidPositions(manager.wallets),
      manager.shouldPollLP() ? fetchLPPositions(manager.wallets) : null
    ]);

    // 4. Create snapshot
    const snapshot = await createSnapshot({
      managerId: manager._id,
      positions: [...avantis, ...hyperliquid, ...lp]
    });

    // 5. Detect changes
    const changes = await detectChanges(manager._id, snapshot);

    // 6. Log closed positions
    if (changes.closedPositions.length > 0) {
      await logClosedPositions(changes.closedPositions);
    }

    // 7. Update analytics (debounced - only if positions changed)
    if (changes.hasChanges) {
      await queueAnalyticsUpdate(manager._id);
    }
  }));
}

// 8. Process analytics queue (after all position updates)
await processAnalyticsQueue();
```

**Total Time:** ~10-20 seconds for 1000 users (with batching)

---

## 🚀 Implementation Phases

### **Phase 1: Core Monitoring (Days 1-3)**
✅ Set up database models (DONE)
- [ ] Create monitoring service structure
- [ ] Implement position fetching for all platforms
- [ ] Build snapshot creation logic
- [ ] Implement change detection
- [ ] Test with 1-5 managers locally

**Deliverables:**
- Working monitoring service
- Snapshots being created every 60s
- Closed positions being logged

### **Phase 2: Analytics Engine (Days 4-5)**
- [ ] Build analytics computation functions
- [ ] Implement all risk metrics (Sharpe, Sortino, etc.)
- [ ] Calculate consistency metrics
- [ ] Test computation accuracy
- [ ] Optimize for performance

**Deliverables:**
- Full analytics in `ManagerAnalytics` collection
- Metrics updating every 60s

### **Phase 3: WebSocket Integration (Days 6-7)**
- [ ] Build Hyperliquid WebSocket client
- [ ] Implement connection management
- [ ] Handle user fills and orders
- [ ] Add reconnection logic
- [ ] Test real-time updates

**Deliverables:**
- Real-time order updates for Hyperliquid
- Open orders table populated

### **Phase 4: Frontend Migration (Days 8-10)**
- [ ] Create Next.js page at `/app/manager/[username]/page.tsx`
- [ ] Integrate ApexCharts
- [ ] Build all dashboard sections
- [ ] Add auto-refresh with countdown
- [ ] Mobile responsiveness

**Deliverables:**
- New Bloomberg-style dashboard live
- Charts rendering with real data
- Auto-refresh working

### **Phase 5: Profile Updates & Polish (Days 11-12)**
- [ ] Move wallet management to profile
- [ ] Add empty state banner
- [ ] Update navigation
- [ ] Performance optimization
- [ ] Bug fixes

**Deliverables:**
- Complete feature set
- Production-ready

---

## 🧪 Testing Strategy

### **Local Testing**
```bash
# 1. Start MongoDB locally or use Atlas
# 2. Set up test manager accounts (3-5 wallets)
# 3. Run monitoring service manually:
node services/run-monitor.js

# 4. Verify:
# - Snapshots created in DB
# - Changes detected
# - Analytics computed
```

### **Load Testing** (Before Production)
```bash
# Simulate 100 managers
npm run test:load -- --managers=100

# Simulate 1000 managers (if resources allow)
npm run test:load -- --managers=1000
```

### **Monitoring Observability**
```typescript
// Add logging for production monitoring
console.log({
  timestamp: new Date(),
  managersProcessed: 1000,
  duration: '12.3s',
  errors: 0,
  closedPositions: 47,
  analyticsUpdated: 152
});
```

---

## ⚠️ Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| API rate limits | High | Add rate limiting, retry logic, multiple API keys |
| Avantis Python service slow | Medium | Keep requests lightweight, add timeout |
| MongoDB write contention | Low | Batch writes, use bulk operations |
| WebSocket disconnections | Low | Auto-reconnect, fallback to polling |
| Vercel cron limits | Medium | Move to Railway if >100 jobs/day needed |

---

## 📝 Next Steps

1. **Review & Approve** this architecture plan
2. **Start Phase 1** - Build core monitoring service
3. **Test locally** with your wallets
4. **Deploy** monitoring service
5. **Monitor** for 24-48 hours to ensure stability
6. **Phase 2-5** - Continue implementation

**Estimated Total Time:** 10-12 days for full implementation

---

## 💡 Alternative: Start with Manual Refresh

If you want to ship faster and de-risk:

**Option: No Background Monitoring Initially**
- Keep manual refresh button
- Compute analytics on-demand when user visits dashboard
- Start monitoring service after users validate the UI
- Faster to market, lower initial complexity

Let me know if you want to explore this approach!
