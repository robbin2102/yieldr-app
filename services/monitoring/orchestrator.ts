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
      platform: 'avantis' | 'hyperliquid' | 'lp';
    };

    const allCalls: PlatformCall[] = [];
    for (const manager of managers) {
      const fetchDecisions = await decidePlatformFetches(manager._id);

      if (fetchDecisions.shouldFetchAvantis) {
        allCalls.push({ manager, platform: 'avantis' });
      }
      if (fetchDecisions.shouldFetchHyperliquid) {
        allCalls.push({ manager, platform: 'hyperliquid' });
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
  platform: 'avantis' | 'hyperliquid' | 'lp',
  result: MonitoringResult
): Promise<void> {
  const callStart = Date.now();

  try {
    // Build wallet list
    const wallets = {
      primary: manager.walletAddress,
      scouted: manager.wallets || [],
    };

    // Fetch positions from this ONE platform
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
      })
      .toArray();

    return managers.map((m) => ({
      _id: m._id.toString(),
      username: m.username,
      walletAddress: m.walletAddress,
      wallets: m.wallets || [],
      lastLPFetch: m.lastLPFetch,
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
