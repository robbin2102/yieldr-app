# Real-Time Trade Event Listening - Implementation Plan

## Overview
Implement real-time event listening for all manager wallets to automatically track trades as they happen on Avantis.

## Architecture

```
┌─────────────────┐
│  Manager Model  │
│  (MongoDB)      │ ──► Load active manager wallets
└─────────────────┘
         │
         ▼
┌─────────────────┐
│ EventListener   │ ──► Subscribe to blockchain events
│ (WebSocket/Poll)│     - MarketExecuted ✅
└─────────────────┘     - LimitExecuted ✅ (NEW)
         │
         ▼
┌─────────────────┐
│  EventParser    │ ──► Parse raw blockchain logs
└─────────────────┘
         │
         ▼
┌─────────────────┐
│ EventCorrelator │ ──► Store to HistoricalTrades
└─────────────────┘     Emit events to frontend
         │
         ▼
┌─────────────────┐
│   Frontend      │ ──► Real-time UI updates
│   (WebSocket)   │
└─────────────────┘
```

## Required Changes

### 1. Update EventListener to Support LimitExecuted Events

**File:** `services/avantis-listener/EventListener.ts`

**Changes:**
```typescript
import {
  MARKET_EXECUTED_EVENT,
  LIMIT_EXECUTED_EVENT,  // ADD
} from './config';

import {
  parseMarketExecuted,
  parseLimitExecuted,    // ADD
} from './EventParser';

export class EventListener {
  private unwatchLimitExecuted: (() => void) | null = null;  // ADD

  async start(): Promise<void> {
    // ... existing MarketExecuted watch ...

    // ADD: Watch LimitExecuted events
    this.unwatchLimitExecuted = watchEvent({
      address: CONTRACTS.EVENTS,
      event: LIMIT_EXECUTED_EVENT,
      onLogs: (logs) => this.handleLimitExecutedLogs(logs),
      onError: (error) => this.handleError('LimitExecuted', error),
      poll: true,
      pollingInterval: RPC_CONFIG.RECONNECT_DELAY_MS,
    });
  }

  // ADD: Handle LimitExecuted logs
  private async handleLimitExecutedLogs(logs: Log[]): Promise<void> {
    if (logs.length === 0) return;

    console.log(`[EventListener] Received ${logs.length} LimitExecuted events`);

    for (const log of logs) {
      try {
        const parsed = parseLimitExecuted(log);
        if (!parsed) continue;
        if (!this.isMonitored(parsed.trader)) continue;

        console.log(`[EventListener] LimitExecuted - orderId: ${parsed.orderId}`);
        await processMarketExecuted(parsed); // Same processor as MarketExecuted

        this.eventsProcessed++;
        this.lastEventTime = new Date();
      } catch (error) {
        console.error('[EventListener] Error handling LimitExecuted:', error);
        this.errorsCount++;
      }
    }
  }

  stop(): void {
    // ... existing cleanup ...

    // ADD: Cleanup LimitExecuted watcher
    if (this.unwatchLimitExecuted) {
      this.unwatchLimitExecuted();
      this.unwatchLimitExecuted = null;
    }
  }
}
```

### 2. Load Manager Wallets from Database

**File:** `services/avantis-listener/ManagerWalletLoader.ts` (NEW)

**Purpose:** Load active manager wallets from MongoDB

```typescript
import Manager from '../../models/Manager';

export interface ManagerWallet {
  address: string;
  name: string;
  isActive: boolean;
  platform: string;
}

/**
 * Load all active Avantis manager wallets
 */
export async function loadActiveManagerWallets(): Promise<ManagerWallet[]> {
  try {
    const managers = await Manager.find({
      platform: 'Avantis',
      isActive: true,
    }).select('walletAddress name platform');

    return managers.map(m => ({
      address: m.walletAddress.toLowerCase(),
      name: m.name || 'Unknown',
      isActive: true,
      platform: m.platform,
    }));
  } catch (error) {
    console.error('[ManagerWalletLoader] Error loading managers:', error);
    return [];
  }
}

/**
 * Watch for new managers being added to DB
 */
export function watchManagerChanges(
  onManagerAdded: (wallet: ManagerWallet) => void,
  onManagerRemoved: (address: string) => void
): () => void {
  // Use MongoDB change streams to watch for updates
  const changeStream = Manager.watch([], { fullDocument: 'updateLookup' });

  changeStream.on('change', (change) => {
    if (change.operationType === 'insert' && change.fullDocument.platform === 'Avantis') {
      onManagerAdded({
        address: change.fullDocument.walletAddress.toLowerCase(),
        name: change.fullDocument.name || 'Unknown',
        isActive: change.fullDocument.isActive,
        platform: change.fullDocument.platform,
      });
    } else if (change.operationType === 'delete') {
      // Extract wallet address from deleted document
      onManagerRemoved(change.documentKey._id);
    } else if (change.operationType === 'update' && change.fullDocument) {
      // Handle activation/deactivation
      if (!change.fullDocument.isActive) {
        onManagerRemoved(change.fullDocument.walletAddress.toLowerCase());
      }
    }
  });

  // Return cleanup function
  return () => changeStream.close();
}
```

### 3. Update Main Listener Server

**File:** `services/avantis-listener/server.ts`

**Changes:**
```typescript
import { EventListener } from './EventListener';
import { loadActiveManagerWallets, watchManagerChanges } from './ManagerWalletLoader';
import connectDB from '../../lib/mongoose';

let listener: EventListener | null = null;
let unwatchManagers: (() => void) | null = null;

async function startListener() {
  try {
    // Connect to MongoDB
    await connectDB();
    console.log('[Server] Connected to MongoDB');

    // Load all active manager wallets
    const managers = await loadActiveManagerWallets();
    console.log(`[Server] Loaded ${managers.length} active managers`);

    for (const manager of managers) {
      console.log(`  - ${manager.name}: ${manager.address}`);
    }

    // Create listener with manager wallets
    listener = new EventListener(managers.map(m => m.address));

    // Watch for manager changes
    unwatchManagers = watchManagerChanges(
      (manager) => {
        console.log(`[Server] New manager added: ${manager.name} (${manager.address})`);
        listener?.addWallet(manager.address);
      },
      (address) => {
        console.log(`[Server] Manager removed: ${address}`);
        listener?.removeWallet(address);
      }
    );

    // Start listening
    await listener.start();

    console.log('[Server] ✓ Real-time listener started successfully');

    // Log status every 5 minutes
    setInterval(() => {
      const status = listener?.getStatus();
      console.log('[Server] Status:', status);
    }, 5 * 60 * 1000);

  } catch (error) {
    console.error('[Server] Failed to start listener:', error);
    process.exit(1);
  }
}

async function stopListener() {
  console.log('[Server] Stopping listener...');

  listener?.stop();
  listener = null;

  if (unwatchManagers) {
    unwatchManagers();
    unwatchManagers = null;
  }

  console.log('[Server] ✓ Listener stopped');
  process.exit(0);
}

// Handle shutdown gracefully
process.on('SIGINT', stopListener);
process.on('SIGTERM', stopListener);

// Start the listener
startListener();
```

### 4. Environment Setup

**File:** `.env.local`

Add configuration:
```env
# Event Listener Configuration
ENABLE_REALTIME_LISTENER=true
LISTENER_POLLING_INTERVAL_MS=2000
LISTENER_MAX_RECONNECT_ATTEMPTS=10
```

### 5. Manager Model Updates (if needed)

Check if Manager model has required fields:
- `walletAddress` (string, required)
- `name` (string)
- `platform` (string, required)
- `isActive` (boolean, default: true)

## Testing Strategy

### 1. Unit Tests
```bash
# Test EventListener with multiple wallets
npm run test:event-listener

# Test manager wallet loading
npm run test:manager-loader
```

### 2. Integration Tests
```typescript
// Test real-time event detection
describe('EventListener Integration', () => {
  it('should detect MarketExecuted events for monitored wallet', async () => {
    const listener = new EventListener(['0x780BB763...']);
    await listener.start();

    // Wait for an event
    await waitForEvent('trade:opened', 30000);

    listener.stop();
  });

  it('should detect LimitExecuted events for monitored wallet', async () => {
    // Similar test for limit orders
  });
});
```

### 3. Manual Testing
```bash
# Start listener in development
npm run dev:listener

# Expected output:
# [Server] Loaded 5 active managers
# [EventListener] Started successfully
# [EventListener] Monitoring 5 wallets
```

## Deployment Steps

### Step 1: Code Changes
```bash
git checkout -b feature/realtime-listener
# Make changes above
git commit -m "feat: Add real-time event listening for managers"
git push origin feature/realtime-listener
```

### Step 2: Database Setup
```javascript
// Ensure managers are in database
db.managers.insertOne({
  walletAddress: "0x780BB763e1463D2236FEC780b7BD6ADb40AAa120",
  name: "Test Manager",
  platform: "Avantis",
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date()
});
```

### Step 3: Run Listener
```bash
# Development
npm run dev:listener

# Production (with PM2)
pm2 start services/avantis-listener/server.ts --name avantis-listener
pm2 save
```

### Step 4: Monitor
```bash
# Check PM2 logs
pm2 logs avantis-listener

# Check database for new trades
db.historicaltrades.find().sort({ createdAt: -1 }).limit(10)
```

## Success Criteria

- ✅ Listener starts successfully with all manager wallets
- ✅ Detects both MarketExecuted AND LimitExecuted events
- ✅ Filters events by monitored wallets only
- ✅ Stores trades to MongoDB in real-time
- ✅ Auto-reconnects on RPC errors
- ✅ Dynamically adds/removes wallets when managers change
- ✅ Processes partial closes correctly
- ✅ Emits events for frontend updates

## Monitoring & Alerts

### Health Checks
```typescript
// Add health check endpoint
app.get('/health/listener', (req, res) => {
  const status = listener?.getStatus();

  if (!status?.isActive) {
    return res.status(503).json({ error: 'Listener not active' });
  }

  if (status.errorsCount > 100) {
    return res.status(500).json({ error: 'Too many errors' });
  }

  res.json({
    status: 'healthy',
    ...status
  });
});
```

### Alerts
- Alert if listener stops unexpectedly
- Alert if no events processed in 24 hours (for active managers)
- Alert if error rate > 10%

## Rollback Plan

If issues occur:
```bash
# Stop listener
pm2 stop avantis-listener

# Revert code
git revert <commit-hash>

# Use backfill instead
npm run backfill:all-managers
```

## Future Enhancements

1. **WebSocket for Frontend**
   - Emit events via Socket.io for real-time UI updates
   - Show live trades as they happen

2. **Performance Monitoring**
   - Track event processing latency
   - Monitor RPC call success rates

3. **Multi-Chain Support**
   - Abstract listener to support other chains
   - Separate listeners per chain

4. **Event Replay**
   - Replay missed events on startup
   - Compare with backfill for data integrity

---

**Estimated Effort:** 4-6 hours
**Priority:** High
**Dependencies:** None (all dependencies already fixed)
