/**
 * Snapshot Service
 *
 * Manages position snapshots in MongoDB:
 * - Creates new snapshots
 * - Retrieves last snapshot for comparison
 * - Cleans up old snapshots (90+ days)
 */

import clientPromise from '@/lib/mongodb';
import type { ObjectId } from 'mongodb';

interface Position {
  positionId: string;
  walletAddress: string;
  platform: string;
  asset: string;
  type: string;
  [key: string]: any;
}

interface SnapshotData {
  managerId: ObjectId | string;
  walletAddress: string;
  platform: 'avantis' | 'hyperliquid' | 'aerodrome' | 'uniswap';
  positions: Position[];
  summary: {
    totalPositions: number;
    totalAUM: number;
    totalPnL: number;
    totalROI: number;
    perpPositions: number;
    lpPositions: number;
  };
}

/**
 * Creates a new snapshot for a manager's positions
 */
export async function createSnapshot(
  managerId: ObjectId | string,
  walletAddress: string,
  platform: 'avantis' | 'hyperliquid' | 'aerodrome' | 'uniswap',
  positions: Position[]
): Promise<any> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    // Calculate summary metrics
    const summary = calculateSummary(positions);

    const snapshot = {
      managerId: typeof managerId === 'string' ? managerId : managerId.toString(),
      walletAddress: walletAddress.toLowerCase(),
      platform,
      snapshotTime: new Date(),
      positions,
      summary,
      changes: {
        newPositions: [],
        closedPositions: [],
        modifiedPositions: [],
      },
      createdAt: new Date(),
    };

    const result = await db.collection('positionsnapshots').insertOne(snapshot);

    console.log(
      `[SnapshotService] Created snapshot for ${platform} - ${positions.length} positions`
    );

    return {
      ...snapshot,
      _id: result.insertedId,
    };
  } catch (error) {
    console.error('[SnapshotService] Error creating snapshot:', error);
    throw error;
  }
}

/**
 * Gets the last snapshot for a manager/wallet/platform
 */
export async function getLastSnapshot(
  managerId: ObjectId | string,
  walletAddress: string,
  platform: 'avantis' | 'hyperliquid' | 'aerodrome' | 'uniswap'
): Promise<any | null> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const managerIdStr = typeof managerId === 'string' ? managerId : managerId.toString();

    const snapshot = await db
      .collection('positionsnapshots')
      .findOne(
        {
          managerId: managerIdStr,
          walletAddress: walletAddress.toLowerCase(),
          platform,
        },
        {
          sort: { snapshotTime: -1 },
        }
      );

    return snapshot;
  } catch (error) {
    console.error('[SnapshotService] Error getting last snapshot:', error);
    return null;
  }
}

/**
 * Gets all snapshots for a manager (across all wallets/platforms)
 */
export async function getAllManagerSnapshots(
  managerId: ObjectId | string,
  limit: number = 100
): Promise<any[]> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const managerIdStr = typeof managerId === 'string' ? managerId : managerId.toString();

    const snapshots = await db
      .collection('positionsnapshots')
      .find({ managerId: managerIdStr })
      .sort({ snapshotTime: -1 })
      .limit(limit)
      .toArray();

    return snapshots;
  } catch (error) {
    console.error('[SnapshotService] Error getting manager snapshots:', error);
    return [];
  }
}

/**
 * Updates snapshot with detected changes
 */
export async function updateSnapshotChanges(
  snapshotId: ObjectId | string,
  changes: {
    newPositions: string[];
    closedPositions: string[];
    modifiedPositions: string[];
  }
): Promise<boolean> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    await db.collection('positionsnapshots').updateOne(
      { _id: snapshotId },
      {
        $set: {
          changes,
          updatedAt: new Date(),
        },
      }
    );

    return true;
  } catch (error) {
    console.error('[SnapshotService] Error updating snapshot changes:', error);
    return false;
  }
}

/**
 * Cleans up snapshots older than specified days
 */
export async function cleanOldSnapshots(daysToKeep: number = 90): Promise<number> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await db.collection('positionsnapshots').deleteMany({
      createdAt: { $lt: cutoffDate },
    });

    console.log(
      `[SnapshotService] Cleaned up ${result.deletedCount} snapshots older than ${daysToKeep} days`
    );

    return result.deletedCount;
  } catch (error) {
    console.error('[SnapshotService] Error cleaning old snapshots:', error);
    return 0;
  }
}

/**
 * Gets snapshot count for a manager
 */
export async function getSnapshotCount(managerId: ObjectId | string): Promise<number> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const managerIdStr = typeof managerId === 'string' ? managerId : managerId.toString();

    const count = await db.collection('positionsnapshots').countDocuments({
      managerId: managerIdStr,
    });

    return count;
  } catch (error) {
    console.error('[SnapshotService] Error getting snapshot count:', error);
    return 0;
  }
}

/**
 * Calculates summary metrics for a set of positions
 */
function calculateSummary(positions: Position[]): {
  totalPositions: number;
  totalAUM: number;
  totalPnL: number;
  totalROI: number;
  perpPositions: number;
  lpPositions: number;
} {
  const summary = {
    totalPositions: positions.length,
    totalAUM: 0,
    totalPnL: 0,
    totalROI: 0,
    perpPositions: 0,
    lpPositions: 0,
  };

  for (const pos of positions) {
    // Calculate AUM
    if (pos.type === 'PERP' && pos.margin) {
      summary.totalAUM += pos.margin;
      summary.perpPositions++;
    } else if (pos.type === 'LP' && pos.liquidity) {
      summary.totalAUM += pos.liquidity;
      summary.lpPositions++;
    }

    // Accumulate PnL
    if (pos.pnl) {
      summary.totalPnL += pos.pnl;
    }
  }

  // Calculate overall ROI
  if (summary.totalAUM > 0) {
    summary.totalROI = (summary.totalPnL / summary.totalAUM) * 100;
  }

  return summary;
}

/**
 * Gets all positions from the last snapshot (for a manager, combining all platforms)
 */
export async function getLastSnapshotPositions(
  managerId: ObjectId | string
): Promise<Position[]> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const managerIdStr = typeof managerId === 'string' ? managerId : managerId.toString();

    // Get all latest snapshots grouped by platform/wallet
    const snapshots = await db
      .collection('positionsnapshots')
      .aggregate([
        { $match: { managerId: managerIdStr } },
        { $sort: { snapshotTime: -1 } },
        {
          $group: {
            _id: { walletAddress: '$walletAddress', platform: '$platform' },
            latestSnapshot: { $first: '$$ROOT' },
          },
        },
      ])
      .toArray();

    // Combine all positions from latest snapshots
    const allPositions: Position[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.latestSnapshot?.positions) {
        allPositions.push(...snapshot.latestSnapshot.positions);
      }
    }

    return allPositions;
  } catch (error) {
    console.error('[SnapshotService] Error getting last snapshot positions:', error);
    return [];
  }
}
