/**
 * Closed Position Logger Service
 *
 * Logs closed positions to MongoDB for historical tracking.
 * Used for analytics, performance calculations, and win rate tracking.
 */

import clientPromise from '@/lib/mongodb';
import type { ObjectId } from 'mongodb';
import { enrichClosedPosition } from './change-detector';

interface ClosedPositionData {
  positionId: string;
  managerId: ObjectId | string;
  walletAddress: string;
  platform: string;
  asset: string;
  pair?: string;
  type: string;
  direction?: string;
  leverage?: number;
  entryPrice?: number;
  exitPrice?: number;
  positionSize?: number;
  margin?: number;
  pnl: number;
  roi: number;
  openedAt?: Date;
  closedAt: Date;
  [key: string]: any;
}

/**
 * Logs a single closed position to database
 */
export async function logClosedPosition(
  position: any,
  managerId: ObjectId | string
): Promise<boolean> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    // Enrich position with metadata
    const enrichedPosition = enrichClosedPosition(position, new Date());

    // Add managerId if not present
    const positionData = {
      ...enrichedPosition,
      managerId: typeof managerId === 'string' ? managerId : managerId.toString(),
    };

    // Check if position already logged (prevent duplicates)
    const existing = await db.collection('closedpositions').findOne({
      positionId: positionData.positionId,
      managerId: positionData.managerId,
    });

    if (existing) {
      console.log(
        `[ClosedPositionLogger] Position ${positionData.positionId} already logged, skipping`
      );
      return false;
    }

    // Insert closed position
    await db.collection('closedpositions').insertOne(positionData);

    console.log(
      `[ClosedPositionLogger] Logged closed position: ${positionData.asset} - PnL: ${positionData.pnl.toFixed(2)}`
    );

    return true;
  } catch (error) {
    console.error('[ClosedPositionLogger] Error logging closed position:', error);
    return false;
  }
}

/**
 * Logs multiple closed positions in bulk (more efficient)
 */
export async function bulkLogClosedPositions(
  positions: any[],
  managerId: ObjectId | string
): Promise<number> {
  if (positions.length === 0) {
    return 0;
  }

  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const managerIdStr = typeof managerId === 'string' ? managerId : managerId.toString();

    // Enrich all positions
    const enrichedPositions = positions.map((pos) => ({
      ...enrichClosedPosition(pos, new Date()),
      managerId: managerIdStr,
    }));

    // Get position IDs to check for duplicates
    const positionIds = enrichedPositions.map((p) => p.positionId);

    // Find existing positions
    const existing = await db
      .collection('closedpositions')
      .find({
        positionId: { $in: positionIds },
        managerId: managerIdStr,
      })
      .toArray();

    const existingIds = new Set(existing.map((p) => p.positionId));

    // Filter out duplicates
    const newPositions = enrichedPositions.filter(
      (p) => !existingIds.has(p.positionId)
    );

    if (newPositions.length === 0) {
      console.log('[ClosedPositionLogger] All positions already logged, skipping');
      return 0;
    }

    // Bulk insert
    const result = await db.collection('closedpositions').insertMany(newPositions);

    console.log(
      `[ClosedPositionLogger] Logged ${result.insertedCount} closed positions (${positions.length - newPositions.length} duplicates skipped)`
    );

    return result.insertedCount;
  } catch (error) {
    console.error('[ClosedPositionLogger] Error bulk logging positions:', error);
    return 0;
  }
}

/**
 * Gets closed positions for a manager
 */
export async function getClosedPositions(
  managerId: ObjectId | string,
  options?: {
    limit?: number;
    skip?: number;
    startDate?: Date;
    endDate?: Date;
    asset?: string;
    platform?: string;
  }
): Promise<any[]> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const managerIdStr = typeof managerId === 'string' ? managerId : managerId.toString();

    // Build query
    const query: any = { managerId: managerIdStr };

    if (options?.startDate || options?.endDate) {
      query.closedAt = {};
      if (options.startDate) query.closedAt.$gte = options.startDate;
      if (options.endDate) query.closedAt.$lte = options.endDate;
    }

    if (options?.asset) {
      query.asset = options.asset;
    }

    if (options?.platform) {
      query.platform = options.platform;
    }

    // Execute query
    let cursor = db
      .collection('closedpositions')
      .find(query)
      .sort({ closedAt: -1 });

    if (options?.skip) {
      cursor = cursor.skip(options.skip);
    }

    if (options?.limit) {
      cursor = cursor.limit(options.limit);
    }

    const positions = await cursor.toArray();

    return positions;
  } catch (error) {
    console.error('[ClosedPositionLogger] Error getting closed positions:', error);
    return [];
  }
}

/**
 * Gets closed positions count for a manager
 */
export async function getClosedPositionsCount(
  managerId: ObjectId | string,
  options?: {
    startDate?: Date;
    endDate?: Date;
    asset?: string;
    platform?: string;
  }
): Promise<number> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const managerIdStr = typeof managerId === 'string' ? managerId : managerId.toString();

    // Build query
    const query: any = { managerId: managerIdStr };

    if (options?.startDate || options?.endDate) {
      query.closedAt = {};
      if (options.startDate) query.closedAt.$gte = options.startDate;
      if (options.endDate) query.closedAt.$lte = options.endDate;
    }

    if (options?.asset) {
      query.asset = options.asset;
    }

    if (options?.platform) {
      query.platform = options.platform;
    }

    const count = await db.collection('closedpositions').countDocuments(query);

    return count;
  } catch (error) {
    console.error('[ClosedPositionLogger] Error getting closed positions count:', error);
    return 0;
  }
}

/**
 * Gets win rate for a manager
 */
export async function getWinRate(
  managerId: ObjectId | string,
  days?: number
): Promise<{ winRate: number; wins: number; losses: number; total: number }> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const managerIdStr = typeof managerId === 'string' ? managerId : managerId.toString();

    // Build query
    const query: any = { managerId: managerIdStr };

    if (days) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      query.closedAt = { $gte: startDate };
    }

    // Get all closed positions
    const positions = await db.collection('closedpositions').find(query).toArray();

    if (positions.length === 0) {
      return { winRate: 0, wins: 0, losses: 0, total: 0 };
    }

    // Calculate wins and losses
    const wins = positions.filter((p) => p.pnl > 0).length;
    const losses = positions.filter((p) => p.pnl < 0).length;
    const total = positions.length;
    const winRate = (wins / total) * 100;

    return { winRate, wins, losses, total };
  } catch (error) {
    console.error('[ClosedPositionLogger] Error calculating win rate:', error);
    return { winRate: 0, wins: 0, losses: 0, total: 0 };
  }
}

/**
 * Gets total PnL for a manager
 */
export async function getTotalPnL(
  managerId: ObjectId | string,
  days?: number
): Promise<number> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const managerIdStr = typeof managerId === 'string' ? managerId : managerId.toString();

    // Build query
    const query: any = { managerId: managerIdStr };

    if (days) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      query.closedAt = { $gte: startDate };
    }

    // Aggregate PnL
    const result = await db
      .collection('closedpositions')
      .aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalPnL: { $sum: '$pnl' },
          },
        },
      ])
      .toArray();

    return result.length > 0 ? result[0].totalPnL : 0;
  } catch (error) {
    console.error('[ClosedPositionLogger] Error calculating total PnL:', error);
    return 0;
  }
}

/**
 * Gets largest win and loss for a manager
 */
export async function getLargestWinLoss(
  managerId: ObjectId | string
): Promise<{ largestWin: any; largestLoss: any }> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const managerIdStr = typeof managerId === 'string' ? managerId : managerId.toString();

    // Get largest win
    const largestWinResult = await db
      .collection('closedpositions')
      .find({ managerId: managerIdStr, pnl: { $gt: 0 } })
      .sort({ pnl: -1 })
      .limit(1)
      .toArray();

    // Get largest loss
    const largestLossResult = await db
      .collection('closedpositions')
      .find({ managerId: managerIdStr, pnl: { $lt: 0 } })
      .sort({ pnl: 1 })
      .limit(1)
      .toArray();

    return {
      largestWin: largestWinResult.length > 0 ? largestWinResult[0] : null,
      largestLoss: largestLossResult.length > 0 ? largestLossResult[0] : null,
    };
  } catch (error) {
    console.error('[ClosedPositionLogger] Error getting largest win/loss:', error);
    return { largestWin: null, largestLoss: null };
  }
}

/**
 * Deletes all closed positions for a manager (use with caution!)
 */
export async function deleteAllClosedPositions(
  managerId: ObjectId | string
): Promise<number> {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    const managerIdStr = typeof managerId === 'string' ? managerId : managerId.toString();

    const result = await db.collection('closedpositions').deleteMany({
      managerId: managerIdStr,
    });

    console.log(
      `[ClosedPositionLogger] Deleted ${result.deletedCount} closed positions for manager ${managerIdStr}`
    );

    return result.deletedCount;
  } catch (error) {
    console.error('[ClosedPositionLogger] Error deleting closed positions:', error);
    return 0;
  }
}
