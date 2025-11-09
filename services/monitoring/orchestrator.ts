/**
 * Monitoring Orchestrator
 *
 * Coordinates the entire monitoring cycle:
 * 1. Fetches all active managers
 * 2. Fetches positions from all platforms
 * 3. Creates snapshots
 * 4. Detects changes
 * 5. Logs closed positions
 * 6. Updates analytics
 */

import clientPromise from '@/lib/mongodb';
import { fetchAllPositions } from './position-fetcher';
import { detectPositionChanges } from './change-detector';
import { createSnapshot, getLastSnapshot, getLastSnapshotPositions } from './snapshot-service';
import { bulkLogClosedPositions } from './closed-position-logger';
import { computeAndSaveAnalytics } from '../analytics/compute-analytics';
import { decidePlatformFetches, formatInterval } from './interval-manager';

interface Manager {
  _id: string;
  username: string;
  walletAddress: string;
  wallets?: string[];
  lastLPFetch?: Date;
  lastFillsFetchTime?: number;
}

interface MonitoringResult {
  success: boolean;
  managersProcessed: number;
  totalPositions: number;
  closedPositions: number;
  analyticsUpdated: number;
  duration: number;
  errors: string[];
}

/**
 * Main monitoring cycle - runs every 60 seconds
 */
export async function runMonitoringCycle(): Promise<MonitoringResult> {
  const startTime = Date.now();
  const result: MonitoringResult = {
    success: true,
    managersProcessed: 0,
    totalPositions: 0,
    closedPositions: 0,
    analyticsUpdated: 0,
    duration: 0,
    errors: [],
  };

  try {
    console.log('==================================================');
    console.log('🔄 Starting monitoring cycle...');
    console.log('==================================================');

    // Step 1: Get all active managers
    const managers = await getActiveManagers();
    console.log(`📊 Found ${managers.length} active managers`);

    if (managers.length === 0) {
      console.log('⚠️  No active managers found, skipping cycle');
      result.duration = Date.now() - startTime;
      return result;
    }

    // Step 2: Fire ALL API calls independently (manager × platform)
    console.log(`\n🚀 Firing all API calls independently...\n`);

    // Build list of all API calls to make
    type PlatformCall = {
      manager: Manager;
      platform: 'avantis' | 'hyperliquid' | 'hyperliquid-fills' | 'hyperliquid-orders' | 'lp';
    };

    const allCalls: PlatformCall[] = [];
    for (const manager of managers) {
      const fetchDecisions = await decidePlatformFetches(manager._id);

      if (fetchDecisions.shouldFetchAvantis) {
        allCalls.push({ manager, platform: 'avantis' });
      }
      if (fetchDecisions.shouldFetchHyperliquid) {
        allCalls.push({ manager, platform: 'hyperliquid' });
        // Also fetch fills and orders for Hyperliquid
        allCalls.push({ manager, platform: 'hyperliquid-fills' });
        allCalls.push({ manager, platform: 'hyperliquid-orders' });
      }
      if (fetchDecisions.shouldFetchLP) {
        allCalls.push({ manager, platform: 'lp' });
      }
    }

    console.log(`📊 Total API calls to make: ${allCalls.length}\n`);

    // Fire all calls with 300ms stagger to avoid overwhelming connection pool
    await Promise.all(
      allCalls.map(async (call, index) => {
        // 300ms stagger between each API call (prevents connection pool exhaustion)
        if (index > 0) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }

        try {
          await processSinglePlatformCall(call.manager, call.platform, result);
        } catch (error: any) {
          console.error(`❌ ${call.manager.username}/${call.platform}: ${error.message}`);
          result.errors.push(`${call.manager.username}/${call.platform}: ${error.message}`);
        }
      })
    );

    // Step 3: Compute analytics for all managers (after all data is in)
    console.log(`\n📊 Computing analytics for ${managers.length} managers...\n`);

    await Promise.all(
      managers.map(async (manager) => {
        try {
          // Detect changes and log closed positions
          // NOTE: Hyperliquid uses fills API for closed positions, not snapshot detection
          const previousPositions = await getLastSnapshotPositions(manager._id);
          const currentSnapshots = await Promise.all([
            getLastSnapshot(manager._id, 'avantis'),
            // Skip hyperliquid - we use fills API for exact closed position data
            getLastSnapshot(manager._id, 'aerodrome'),
          ]);

          const currentPositions = currentSnapshots
            .filter(s => s !== null)
            .flatMap(s => s!.positions || []);

          // Filter out Hyperliquid from previous positions (we have fills API for that)
          const previousPositionsFiltered = previousPositions.filter(p => p.platform !== 'hyperliquid');

          const changes = detectPositionChanges(previousPositionsFiltered, currentPositions);

          // Log closed positions
          if (changes.closedPositions.length > 0) {
            const closedCount = await bulkLogClosedPositions(changes.closedPositions, manager._id);
            result.closedPositions += closedCount;
          }

          // Update analytics
          if (changes.hasChanges || currentPositions.length > 0) {
            const analyticsUpdated = await computeAndSaveAnalytics(manager._id, manager.username);
            if (analyticsUpdated) {
              result.analyticsUpdated++;
            }
          }
        } catch (error: any) {
          console.error(`❌ Analytics for ${manager.username}: ${error.message}`);
        }
      })
    );

    result.duration = Date.now() - startTime;

    console.log('\n==================================================');
    console.log('✅ Monitoring cycle completed');
    console.log('==================================================');
    console.log(`   Managers: ${managers.length}`);
    console.log(`   API calls made: ${allCalls.length}`);
    console.log(`   Total positions: ${result.totalPositions}`);
    console.log(`   Closed positions: ${result.closedPositions}`);
    console.log(`   Analytics updated: ${result.analyticsUpdated}`);
    console.log(`   Duration: ${(result.duration / 1000).toFixed(2)}s`);
    console.log(`   Errors: ${result.errors.length}`);
    console.log('==================================================\n');

    return result;
  } catch (error: any) {
    console.error('❌ Fatal error in monitoring cycle:', error);
    result.success = false;
    result.errors.push(`Fatal: ${error.message}`);
    result.duration = Date.now() - startTime;
    return result;
  }
}

/**
 * Processes a single platform call for a manager
 * This is the atomic unit - one API call, immediate processing
 */
async function processSinglePlatformCall(
  manager: Manager,
  platform: 'avantis' | 'hyperliquid' | 'hyperliquid-fills' | 'hyperliquid-orders' | 'lp',
  result: MonitoringResult
): Promise<void> {
  const callStart = Date.now();

  try {
    // Build wallet list
    const wallets = {
      primary: manager.walletAddress,
      scouted: manager.wallets || [],
    };

    // Handle different call types
    if (platform === 'hyperliquid-fills') {
      // Fetch user fills (closed positions)
      const { fetchHyperliquidUserFills } = await import('./position-fetcher');
      const lastFetchTime = await getLastFillsFetchTime(manager._id);
      const fillsResult = await fetchHyperliquidUserFills(wallets, lastFetchTime);

      const callDuration = Date.now() - callStart;

      // Process and save fills to closed-positions collection
      if (fillsResult.positions.length > 0) {
        const savedCount = await saveHyperliquidFills(fillsResult.positions, manager._id);
        console.log(`✓ ${manager.username}/fills: ${savedCount} new fills (${callDuration}ms)`);
        result.closedPositions += savedCount;
      } else {
        console.log(`✓ ${manager.username}/fills: 0 new fills (${callDuration}ms)`);
      }

      // Update last fetch time
      await updateLastFillsFetchTime(manager._id, Date.now());
      return;
    }

    if (platform === 'hyperliquid-orders') {
      // Fetch open orders
      const { fetchHyperliquidOpenOrders } = await import('./position-fetcher');
      const ordersResult = await fetchHyperliquidOpenOrders(wallets);

      const callDuration = Date.now() - callStart;

      // Save/update open orders
      if (ordersResult.positions.length > 0) {
        const savedCount = await saveHyperliquidOrders(ordersResult.positions, manager._id);
        console.log(`✓ ${manager.username}/orders: ${savedCount} orders (${callDuration}ms)`);
      } else {
        console.log(`✓ ${manager.username}/orders: 0 orders (${callDuration}ms)`);
      }
      return;
    }

    // Standard position fetches (for snapshots)
    let positions: any[] = [];
    let fetchResult;

    if (platform === 'avantis') {
      const { fetchAvantisPositions } = await import('./position-fetcher');
      fetchResult = await fetchAvantisPositions(wallets);
      positions = fetchResult.positions;
    } else if (platform === 'hyperliquid') {
      const { fetchHyperliquidPositions } = await import('./position-fetcher');
      fetchResult = await fetchHyperliquidPositions(wallets);
      positions = fetchResult.positions;
    } else if (platform === 'lp') {
      const { fetchLPPositions } = await import('./position-fetcher');
      fetchResult = await fetchLPPositions(wallets);
      positions = fetchResult.positions;
    }

    const callDuration = Date.now() - callStart;

    // Create snapshot immediately (if we got positions)
    if (positions.length > 0) {
      const snapshotPlatform = platform === 'lp' ? 'aerodrome' : platform;
      await createSnapshot(manager._id, manager.walletAddress, snapshotPlatform, positions);
    }

    console.log(`✓ ${manager.username}/${platform}: ${positions.length} positions (${callDuration}ms)`);

    // Update result
    result.totalPositions += positions.length;
    result.managersProcessed++; // Count each platform call

  } catch (error: any) {
    const callDuration = Date.now() - callStart;
    console.error(`✗ ${manager.username}/${platform}: ${error.message} (${callDuration}ms)`);
    throw error;
  }
}

/**
 * Gets all active managers from database
 */
async function getActiveManagers(): Promise<Manager[]> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const managers = await db
      .collection('managers')
      .find({
        status: { $ne: 'inactive' }, // Exclude inactive managers
      })
      .project({
        _id: 1,
        username: 1,
        walletAddress: 1,
        wallets: 1,
        lastLPFetch: 1,
        lastFillsFetchTime: 1,
      })
      .toArray();

    return managers.map((m) => ({
      _id: m._id.toString(),
      username: m.username,
      walletAddress: m.walletAddress,
      wallets: m.wallets || [],
      lastLPFetch: m.lastLPFetch,
      lastFillsFetchTime: m.lastFillsFetchTime,
    }));
  } catch (error) {
    console.error('Error fetching active managers:', error);
    return [];
  }
}

/**
 * Runs monitoring for a single manager (used for testing)
 */
export async function runMonitoringForManager(
  username: string
): Promise<{
  success: boolean;
  positions: number;
  closedPositions: number;
  analyticsUpdated: boolean;
  duration: number;
  error?: string;
}> {
  const startTime = Date.now();

  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const manager = await db.collection('managers').findOne({ username });

    if (!manager) {
      return {
        success: false,
        positions: 0,
        closedPositions: 0,
        analyticsUpdated: false,
        duration: Date.now() - startTime,
        error: 'Manager not found',
      };
    }

    const managerData: Manager = {
      _id: manager._id.toString(),
      username: manager.username,
      walletAddress: manager.walletAddress,
      wallets: manager.wallets || [],
      lastLPFetch: manager.lastLPFetch,
    };

    const result = await processManager(managerData);

    return {
      success: true,
      positions: result.totalPositions,
      closedPositions: result.closedPositions,
      analyticsUpdated: result.analyticsUpdated,
      duration: Date.now() - startTime,
    };
  } catch (error: any) {
    return {
      success: false,
      positions: 0,
      closedPositions: 0,
      analyticsUpdated: false,
      duration: Date.now() - startTime,
      error: error.message,
    };
  }
}

/**
 * Helper Functions for Hyperliquid Fills & Orders
 */

/**
 * Get the last time we fetched fills for a manager
 */
async function getLastFillsFetchTime(managerId: string): Promise<number | undefined> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const manager = await db.collection('managers').findOne(
      { _id: managerId },
      { projection: { lastFillsFetchTime: 1 } }
    );

    return manager?.lastFillsFetchTime;
  } catch (error) {
    console.warn(`[Orchestrator] Error getting last fills fetch time: ${error}`);
    return undefined;
  }
}

/**
 * Update the last fills fetch time for a manager
 */
async function updateLastFillsFetchTime(managerId: string, timestamp: number): Promise<void> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    await db.collection('managers').updateOne(
      { _id: managerId },
      { $set: { lastFillsFetchTime: timestamp } }
    );
  } catch (error) {
    console.warn(`[Orchestrator] Error updating last fills fetch time: ${error}`);
  }
}

/**
 * Save Hyperliquid fills to closed-positions collection
 * Returns count of new positions saved
 *
 * CRITICAL: Groups fills by OID (Order ID) to create ONE position per order
 * - Multiple fills with same oid = partial fills of one order execution
 * - Aggregates: sum PnL, sizes, weighted avg price
 *
 * Uses BULK operations to avoid MongoDB timeout
 */
async function saveHyperliquidFills(fills: any[], managerId: string): Promise<number> {
  try {
    if (fills.length === 0) return 0;

    const client = await clientPromise;
    const db = client.db('yieldr');

    // Step 1: Filter to only include fills that CLOSE positions
    const closeFills = fills.filter(fill => {
      const dir = fill.dir || '';
      const isClose = dir.includes('Close');
      const hasPnl = parseFloat(fill.closedPnl || '0') !== 0;
      return isClose || hasPnl;
    });

    if (closeFills.length === 0) {
      console.log(`[Orchestrator] No closing fills found (${fills.length} total fills were opens)`);
      return 0;
    }

    console.log(`[Orchestrator] Processing ${closeFills.length} closing fills (filtered from ${fills.length} total)`);

    // Step 2: GROUP fills by OID (Order ID)
    // Multiple fills with same oid = one order execution (partial fills)
    const fillsByOid = new Map<string, any[]>();

    for (const fill of closeFills) {
      const oid = fill.oid?.toString() || 'unknown';
      if (!fillsByOid.has(oid)) {
        fillsByOid.set(oid, []);
      }
      fillsByOid.get(oid)!.push(fill);
    }

    console.log(`[Orchestrator] Grouped ${closeFills.length} fills into ${fillsByOid.size} orders`);

    // Step 3: Aggregate each OID group into ONE position
    const aggregatedPositions = [];

    for (const [oid, orderFills] of fillsByOid) {
      // Sort fills by time to get first and last
      const sortedFills = orderFills.sort((a, b) => a.time - b.time);
      const firstFill = sortedFills[0];
      const lastFill = sortedFills[sortedFills.length - 1];

      // Aggregate metrics
      const totalSize = sortedFills.reduce((sum, f) => sum + parseFloat(f.sz || '0'), 0);
      const totalPnl = sortedFills.reduce((sum, f) => sum + parseFloat(f.closedPnl || '0'), 0);

      // Weighted average exit price
      let totalValue = 0;
      let totalQty = 0;
      for (const f of sortedFills) {
        const sz = parseFloat(f.sz || '0');
        const px = parseFloat(f.px || '0');
        totalValue += sz * px;
        totalQty += sz;
      }
      const avgExitPrice = totalQty > 0 ? totalValue / totalQty : parseFloat(firstFill.px || '0');

      // Determine direction from dir field
      let direction = 'UNKNOWN';
      if (firstFill.dir) {
        if (firstFill.dir.includes('Long')) direction = 'LONG';
        else if (firstFill.dir.includes('Short')) direction = 'SHORT';
      }
      // Fallback to side if dir not available
      if (direction === 'UNKNOWN') {
        direction = firstFill.side === 'B' ? 'LONG' : 'SHORT';
      }

      // Create aggregated position
      const positionId = `hyperliquid-${firstFill.walletAddress}-${firstFill.coin}-${oid}`;

      aggregatedPositions.push({
        positionId,
        walletAddress: firstFill.walletAddress.toLowerCase(),
        managerId,
        platform: 'hyperliquid',
        dataSource: 'api_fills',
        asset: firstFill.coin,
        pair: firstFill.coin,
        type: 'PERP',
        direction,
        exitPrice: avgExitPrice, // Weighted average of all fills
        positionSize: totalValue, // Total USD value
        pnl: totalPnl, // Sum of all fills
        roi: 0, // Will be calculated in analytics
        closedAt: new Date(lastFill.time), // Last fill timestamp
        openedAt: new Date(firstFill.time), // First fill timestamp (approximate)
        holdDuration: lastFill.time - firstFill.time, // Time between first and last fill
        exitReason: 'manual',

        // Metadata for debugging
        fillCount: sortedFills.length, // How many fills made up this order
        totalSize, // Total size across all fills
        rawData: {
          oid,
          firstFill,
          lastFill,
          fillCount: sortedFills.length,
          allFills: sortedFills, // Store all fills for reference
        },
        createdAt: new Date(),
      });
    }

    console.log(`[Orchestrator] Created ${aggregatedPositions.length} aggregated positions from ${closeFills.length} fills`);

    // Step 4: Check which positions already exist
    const positionIds = aggregatedPositions.map(doc => doc.positionId);
    const existingDocs = await db
      .collection('closedpositions')
      .find({ positionId: { $in: positionIds } })
      .project({ positionId: 1 })
      .toArray();

    const existingIds = new Set(existingDocs.map(doc => doc.positionId));

    // Step 5: Filter out duplicates
    const newPositions = aggregatedPositions.filter(doc => !existingIds.has(doc.positionId));

    if (newPositions.length === 0) {
      console.log(`[Orchestrator] All ${aggregatedPositions.length} positions already exist in database`);
      return 0;
    }

    // Step 6: Bulk insert
    const result = await db.collection('closedpositions').insertMany(newPositions, { ordered: false });

    console.log(`[Orchestrator] Saved ${result.insertedCount} new positions (${aggregatedPositions.length - result.insertedCount} duplicates skipped)`);

    return result.insertedCount;
  } catch (error: any) {
    // insertMany with ordered:false can throw on partial success
    if (error.code === 11000) {
      // Duplicate key errors - some fills already existed
      return error.result?.nInserted || 0;
    }
    console.error('[Orchestrator] Error saving Hyperliquid fills:', error);
    return 0;
  }
}

/**
 * Save/update Hyperliquid open orders
 * Returns count of orders processed
 * Uses BULK operations to avoid MongoDB timeout with many orders
 */
async function saveHyperliquidOrders(orders: any[], managerId: string): Promise<number> {
  try {
    if (orders.length === 0) return 0;

    const client = await clientPromise;
    const db = client.db('yieldr');

    // Build bulk upsert operations
    const bulkOps = orders.map(order => {
      const orderId = `hyperliquid-${order.walletAddress}-${order.oid || order.coin}-${order.timestamp || Date.now()}`;

      return {
        updateOne: {
          filter: { orderId },
          update: {
            $set: {
              orderId,
              walletAddress: order.walletAddress.toLowerCase(),
              managerId,
              platform: 'hyperliquid',
              asset: order.coin,
              pair: order.coin,
              orderType: 'limit', // Hyperliquid returns limit orders
              direction: order.side === 'B' ? 'BUY' : 'SELL',
              size: parseFloat(order.sz),
              price: parseFloat(order.limitPx),
              status: 'open',
              placedAt: new Date(order.timestamp || Date.now()),
              lastUpdatedAt: new Date(),
              rawData: order,
            }
          },
          upsert: true
        }
      };
    });

    // Execute ALL upserts in ONE bulk operation
    const result = await db.collection('openorders').bulkWrite(bulkOps, { ordered: false });

    return result.upsertedCount + result.modifiedCount;
  } catch (error) {
    console.error('[Orchestrator] Error saving Hyperliquid orders:', error);
    return 0;
  }
}
