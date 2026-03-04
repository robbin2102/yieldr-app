import { getDB, COLLECTIONS } from './connection';

export type Platform = 'hyperliquid' | 'polymarket' | 'avantis';

export interface PositionEntry {
  asset: string;
  direction?: string;
  size?: number;
  pnl?: number;
  platform: string;
  entryPrice?: number;
  currentPrice?: number;
  leverage?: number;
  liquidationPrice?: number;
  marginUsed?: number;
  roi?: number;
  outcome?: string;
  avgPrice?: number;
  currentValue?: number;
  pnlPercent?: number;
}

export interface UserPositionDoc {
  userId: string;
  platform: Platform;
  positions: PositionEntry[];
  totalPnl?: number;
  accountValue?: number;
  lastUpdated: Date;
}

/**
 * Upsert positions for one user+platform. Replaces positions array entirely.
 */
export async function upsertUserPositions(doc: UserPositionDoc): Promise<void> {
  const db = await getDB();
  await db.collection(COLLECTIONS.USER_POSITIONS).updateOne(
    { userId: doc.userId.toLowerCase(), platform: doc.platform },
    {
      $set: {
        positions: doc.positions,
        totalPnl: doc.totalPnl,
        accountValue: doc.accountValue,
        lastUpdated: new Date(),
      },
    },
    { upsert: true }
  );
}

/**
 * Get all positions for a user across all platforms, flattened.
 * Returns empty array if no data or data is stale beyond maxAgeMs.
 */
export async function getUserPositions(
  userId: string,
  maxAgeMs: number = 10 * 60 * 1000
): Promise<PositionEntry[]> {
  const db = await getDB();
  const cutoff = new Date(Date.now() - maxAgeMs);

  const docs = await db
    .collection<UserPositionDoc>(COLLECTIONS.USER_POSITIONS)
    .find({ userId: userId.toLowerCase(), lastUpdated: { $gte: cutoff } })
    .toArray();

  return docs.flatMap((d) =>
    d.positions.map((p) => ({ ...p, platform: d.platform }))
  );
}

/**
 * Get all userIds that have active monitoring tasks.
 * Used by position refresh to know who to refresh.
 */
export async function getActiveMonitoringUserIds(): Promise<string[]> {
  const db = await getDB();
  const docs = await db
    .collection(COLLECTIONS.MONITORING_TASKS)
    .distinct('userId', { status: 'active' });
  return docs as string[];
}
