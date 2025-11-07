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

    // Step 2: Process managers in batches (10 at a time for optimal performance)
    const BATCH_SIZE = 10;
    for (let i = 0; i < managers.length; i += BATCH_SIZE) {
      const batch = managers.slice(i, i + BATCH_SIZE);

      console.log(`\n📦 Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(managers.length / BATCH_SIZE)} (${batch.length} managers)`);

      await Promise.all(
        batch.map(async (manager) => {
          try {
            const managerResult = await processManager(manager);
            result.totalPositions += managerResult.totalPositions;
            result.closedPositions += managerResult.closedPositions;
            if (managerResult.analyticsUpdated) {
              result.analyticsUpdated++;
            }
            result.managersProcessed++;
          } catch (error: any) {
            console.error(`❌ Error processing manager ${manager.username}:`, error.message);
            result.errors.push(`${manager.username}: ${error.message}`);
          }
        })
      );
    }

    result.duration = Date.now() - startTime;

    console.log('\n==================================================');
    console.log('✅ Monitoring cycle completed');
    console.log('==================================================');
    console.log(`   Managers processed: ${result.managersProcessed}`);
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
 * Processes a single manager
 */
async function processManager(manager: Manager): Promise<{
  totalPositions: number;
  closedPositions: number;
  analyticsUpdated: boolean;
}> {
  const startTime = Date.now();

  console.log(`  ↳ ${manager.username}...`);

  try {
    // Build wallet list (primary + scouted wallets)
    const wallets = {
      primary: manager.walletAddress,
      scouted: manager.wallets || [],
    };

    // Step 1: Determine which platforms need fetching based on intervals
    const fetchDecisions = await decidePlatformFetches(manager._id);

    console.log(`    ├─ Fetch plan: Avantis=${fetchDecisions.shouldFetchAvantis} (${formatInterval(fetchDecisions.avantisInterval)}), Hyperliquid=${fetchDecisions.shouldFetchHyperliquid} (${formatInterval(fetchDecisions.hyperliquidInterval)}), LP=${fetchDecisions.shouldFetchLP} (${formatInterval(fetchDecisions.lpInterval)})`);

    // Step 2: Fetch positions for selected platforms
    const { avantis, hyperliquid, lp, summary } = await fetchAllPositions(
      wallets,
      {
        fetchAvantis: fetchDecisions.shouldFetchAvantis,
        fetchHyperliquid: fetchDecisions.shouldFetchHyperliquid,
        fetchLP: fetchDecisions.shouldFetchLP,
      }
    );

    const allPositions = [...avantis, ...hyperliquid, ...lp];

    console.log(`    ├─ Fetched ${allPositions.length} positions (${summary.duration}ms)`);

    // Step 3: Create snapshots for platforms that were fetched
    const snapshotPromises = [];

    if (fetchDecisions.shouldFetchAvantis && avantis.length > 0) {
      snapshotPromises.push(
        createSnapshot(manager._id, manager.walletAddress, 'avantis', avantis)
      );
    }

    if (fetchDecisions.shouldFetchHyperliquid && hyperliquid.length > 0) {
      snapshotPromises.push(
        createSnapshot(manager._id, manager.walletAddress, 'hyperliquid', hyperliquid)
      );
    }

    if (fetchDecisions.shouldFetchLP && lp.length > 0) {
      snapshotPromises.push(
        createSnapshot(manager._id, manager.walletAddress, 'aerodrome', lp)
      );
    }

    await Promise.all(snapshotPromises);

    // Step 4: Detect changes by comparing with previous snapshot
    const previousPositions = await getLastSnapshotPositions(manager._id);
    const changes = detectPositionChanges(previousPositions, allPositions);

    console.log(
      `    ├─ Changes: ${changes.summary.new} new, ${changes.summary.closed} closed, ${changes.summary.modified} modified`
    );

    // Step 5: Log closed positions
    let closedCount = 0;
    if (changes.closedPositions.length > 0) {
      closedCount = await bulkLogClosedPositions(changes.closedPositions, manager._id);
      console.log(`    ├─ Logged ${closedCount} closed positions`);
    }

    // Step 6: Update analytics if positions changed
    let analyticsUpdated = false;
    if (changes.hasChanges || allPositions.length > 0) {
      analyticsUpdated = await computeAndSaveAnalytics(manager._id, manager.username);
      if (analyticsUpdated) {
        console.log(`    ✓ Analytics updated`);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`    └─ Completed in ${duration}ms`);

    return {
      totalPositions: allPositions.length,
      closedPositions: closedCount,
      analyticsUpdated,
    };
  } catch (error: any) {
    console.error(`    ❌ Error: ${error.message}`);
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
