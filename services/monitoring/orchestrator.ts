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
      platform: 'avantis' | 'hyperliquid' | 'hyperliquid-portfolio' | 'hyperliquid-fills' | 'hyperliquid-orders' | 'lp';
    };

    const allCalls: PlatformCall[] = [];
    for (const manager of managers) {
      const fetchDecisions = await decidePlatformFetches(manager._id);

      if (fetchDecisions.shouldFetchAvantis) {
        allCalls.push({ manager, platform: 'avantis' });
      }
      if (fetchDecisions.shouldFetchHyperliquid) {
        allCalls.push({ manager, platform: 'hyperliquid' });
        // Also fetch portfolio, fills, and orders for Hyperliquid
        allCalls.push({ manager, platform: 'hyperliquid-portfolio' });
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
          // Detect changes and log closed positions using snapshot comparison
          const previousPositions = await getLastSnapshotPositions(manager._id);
          const currentSnapshots = await Promise.all([
            getLastSnapshot(manager._id, manager.walletAddress, 'avantis'),
            getLastSnapshot(manager._id, manager.walletAddress, 'hyperliquid'),
            getLastSnapshot(manager._id, manager.walletAddress, 'aerodrome'),
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
  platform: 'avantis' | 'hyperliquid' | 'hyperliquid-portfolio' | 'hyperliquid-fills' | 'hyperliquid-orders' | 'lp',
  result: MonitoringResult
): Promise<void> {
  const callStart = Date.now();

  try {
    // Build wallet list
    const wallets = {
      primary: manager.walletAddress,
      scouted: manager.wallets || [],
    };

    // Handle Hyperliquid portfolio data
    if (platform === 'hyperliquid-portfolio') {
      const { fetchHyperliquidPortfolio } = await import('./position-fetcher');
      const portfolioResult = await fetchHyperliquidPortfolio(wallets);
      const callDuration = Date.now() - callStart;

      if (portfolioResult.success && portfolioResult.portfolios.length > 0) {
        const savedCount = await saveHyperliquidPortfolios(portfolioResult.portfolios, manager._id);
        console.log(`✓ ${manager.username}/portfolio: ${savedCount} snapshots saved (${callDuration}ms)`);
      } else {
        console.log(`✓ ${manager.username}/portfolio: 0 snapshots (${callDuration}ms)`);
      }
      return;
    }

    // Handle Hyperliquid fills data
    if (platform === 'hyperliquid-fills') {
      const { fetchHyperliquidUserFills } = await import('./position-fetcher');
      const lastFetchTime = manager.lastFillsFetchTime;
      const fillsResult = await fetchHyperliquidUserFills(wallets, lastFetchTime);
      const callDuration = Date.now() - callStart;

      if (fillsResult.positions.length > 0) {
        const savedCount = await saveHyperliquidFillsSimple(fillsResult.positions, manager._id);
        console.log(`✓ ${manager.username}/fills: ${savedCount} new fills (${callDuration}ms)`);
        result.closedPositions += savedCount;

        // Update last fetch time
        await updateLastFillsFetchTime(manager._id, Date.now());
      } else {
        console.log(`✓ ${manager.username}/fills: 0 new fills (${callDuration}ms)`);
      }
      return;
    }

    // Handle Hyperliquid open orders
    if (platform === 'hyperliquid-orders') {
      const { fetchHyperliquidOpenOrders } = await import('./position-fetcher');
      const ordersResult = await fetchHyperliquidOpenOrders(wallets);
      const callDuration = Date.now() - callStart;

      if (ordersResult.positions.length > 0) {
        const savedCount = await saveHyperliquidOrdersSimple(ordersResult.positions, manager._id);
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
 * Helper Functions for Hyperliquid Data
 */

/**
 * Save Hyperliquid portfolio snapshots to MongoDB
 */
async function saveHyperliquidPortfolios(portfolios: any[], managerId: string): Promise<number> {
  try {
    if (portfolios.length === 0) return 0;

    const client = await clientPromise;
    const db = client.db('yieldr');

    const documents = portfolios.map(portfolio => ({
      managerId,
      walletAddress: portfolio.walletAddress,
      platform: 'hyperliquid',
      timestamp: portfolio.timestamp,
      accountValue: portfolio.accountValue || 0,
      pnl: portfolio.pnl || 0,
      dayData: portfolio.dayData || {},
      weekData: portfolio.weekData || {},
      monthData: portfolio.monthData || {},
      allTimeData: portfolio.allTimeData || {},
      perpDayData: portfolio.perpDayData,
      perpWeekData: portfolio.perpWeekData,
      perpMonthData: portfolio.perpMonthData,
      perpAllTimeData: portfolio.perpAllTimeData,
      createdAt: new Date(),
    }));

    // Use insertMany with ordered:false to skip duplicates
    const result = await db.collection('portfoliohistory').insertMany(documents, { ordered: false });
    return result.insertedCount;
  } catch (error: any) {
    // Handle duplicate key errors gracefully
    if (error.code === 11000) {
      return error.result?.nInserted || 0;
    }
    console.error('[Orchestrator] Error saving portfolios:', error);
    return 0;
  }
}

/**
 * Save Hyperliquid fills (simplified - no OID grouping)
 * Just saves raw fills for UI display
 */
async function saveHyperliquidFillsSimple(fills: any[], managerId: string): Promise<number> {
  try {
    if (fills.length === 0) return 0;

    const client = await clientPromise;
    const db = client.db('yieldr');

    // Filter to only save fills with PnL (actual closes)
    const closingFills = fills.filter(fill => {
      const closedPnl = parseFloat(fill.closedPnl || '0');
      return closedPnl !== 0;
    });

    if (closingFills.length === 0) return 0;

    const documents = closingFills.map(fill => {
      const closedPnl = parseFloat(fill.closedPnl || '0');
      const direction = fill.dir?.includes('Long') ? 'LONG' : fill.dir?.includes('Short') ? 'SHORT' : 'UNKNOWN';

      return {
        positionId: `hyperliquid-${fill.walletAddress}-${fill.coin}-${fill.oid}-${fill.time}`,
        walletAddress: fill.walletAddress.toLowerCase(),
        managerId,
        platform: 'hyperliquid',
        dataSource: 'api_fills',
        asset: fill.coin,
        pair: fill.coin,
        type: 'PERP',
        direction,
        exitPrice: parseFloat(fill.px || '0'),
        positionSize: parseFloat(fill.sz || '0') * parseFloat(fill.px || '0'),
        pnl: closedPnl,
        roi: 0,
        closedAt: new Date(fill.time),
        openedAt: new Date(fill.time), // Approximate
        holdDuration: 0,
        exitReason: 'manual',
        rawData: fill,
        createdAt: new Date(),
      };
    });

    // Check for duplicates
    const positionIds = documents.map(doc => doc.positionId);
    const existingDocs = await db
      .collection('closedpositions')
      .find({ positionId: { $in: positionIds } })
      .project({ positionId: 1 })
      .toArray();

    const existingIds = new Set(existingDocs.map(doc => doc.positionId));
    const newDocuments = documents.filter(doc => !existingIds.has(doc.positionId));

    if (newDocuments.length === 0) return 0;

    const result = await db.collection('closedpositions').insertMany(newDocuments, { ordered: false });
    return result.insertedCount;
  } catch (error: any) {
    if (error.code === 11000) {
      return error.result?.nInserted || 0;
    }
    console.error('[Orchestrator] Error saving fills:', error);
    return 0;
  }
}

/**
 * Save Hyperliquid open orders (simplified)
 */
async function saveHyperliquidOrdersSimple(orders: any[], managerId: string): Promise<number> {
  try {
    if (orders.length === 0) return 0;

    const client = await clientPromise;
    const db = client.db('yieldr');

    const bulkOps = orders.map(order => {
      const orderId = `hyperliquid-${order.walletAddress}-${order.oid}`;

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
              orderType: 'limit',
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

    const result = await db.collection('openorders').bulkWrite(bulkOps, { ordered: false });
    return result.upsertedCount + result.modifiedCount;
  } catch (error) {
    console.error('[Orchestrator] Error saving orders:', error);
    return 0;
  }
}

/**
 * Update last fills fetch time for a manager
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

    // Run full monitoring cycle (will process all managers, but we only care about this one)
    const result = await runMonitoringCycle();

    return {
      success: result.success,
      positions: result.totalPositions,
      closedPositions: result.closedPositions,
      analyticsUpdated: result.analyticsUpdated > 0,
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

