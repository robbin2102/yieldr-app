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
          const previousPositions = await getLastSnapshotPositions(manager._id);
          const currentSnapshots = await Promise.all([
            getLastSnapshot(manager._id, 'avantis'),
            getLastSnapshot(manager._id, 'hyperliquid'),
            getLastSnapshot(manager._id, 'aerodrome'),
          ]);

          const currentPositions = currentSnapshots
            .filter(s => s !== null)
            .flatMap(s => s!.positions || []);

          const changes = detectPositionChanges(previousPositions, currentPositions);

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
 * Returns count of new fills saved
 */
async function saveHyperliquidFills(fills: any[], managerId: string): Promise<number> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');
    const ClosedPosition = (await import('@/models/closed-position')).default;

    let savedCount = 0;

    for (const fill of fills) {
      // Generate unique position ID from fill data
      const positionId = `hyperliquid-${fill.walletAddress}-${fill.coin}-${fill.time}`;

      // Check if already exists
      const existing = await db.collection('closedpositions').findOne({ positionId });
      if (existing) continue;

      // Create closed position document
      const closedPosition = new ClosedPosition({
        positionId,
        walletAddress: fill.walletAddress.toLowerCase(),
        managerId,
        platform: 'hyperliquid',
        dataSource: 'api_fills', // Real data from API
        asset: fill.coin,
        pair: fill.coin, // Hyperliquid uses coin name
        type: 'PERP',
        direction: fill.side === 'B' ? 'LONG' : 'SHORT',
        exitPrice: parseFloat(fill.px),
        positionSize: parseFloat(fill.sz) * parseFloat(fill.px), // size * price
        pnl: parseFloat(fill.closedPnl),
        roi: 0, // Will be calculated in analytics
        closedAt: new Date(fill.time),
        openedAt: new Date(fill.time), // Approximate, actual open time unknown
        holdDuration: 0, // Unknown from fill data alone
        exitReason: 'manual', // Default, could be refined
        rawData: fill, // Store raw fill data
      });

      await closedPosition.save();
      savedCount++;
    }

    return savedCount;
  } catch (error) {
    console.error('[Orchestrator] Error saving Hyperliquid fills:', error);
    return 0;
  }
}

/**
 * Save/update Hyperliquid open orders
 * Returns count of orders processed
 */
async function saveHyperliquidOrders(orders: any[], managerId: string): Promise<number> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');
    const OpenOrder = (await import('@/models/open-order')).default;

    let processedCount = 0;

    for (const order of orders) {
      // Generate unique order ID
      const orderId = `hyperliquid-${order.walletAddress}-${order.oid || order.coin}-${order.timestamp || Date.now()}`;

      // Upsert order (create or update)
      await OpenOrder.updateOne(
        { orderId },
        {
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
        { upsert: true }
      );

      processedCount++;
    }

    return processedCount;
  } catch (error) {
    console.error('[Orchestrator] Error saving Hyperliquid orders:', error);
    return 0;
  }
}
