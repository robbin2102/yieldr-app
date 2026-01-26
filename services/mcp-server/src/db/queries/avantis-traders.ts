/**
 * Avantis Trader Queries
 * Queries the managers collection for Avantis traders
 */

import { getDB } from '../mongodb.js';

// Collection name - managers collection stores Avantis traders
const MANAGERS_COLLECTION = 'managers';

export interface AvantisTraderProfile {
  _id: string;
  username: string;
  walletAddress: string;
  profilePicture?: string;
  platforms: string[];
  metrics: {
    totalPnL30d: number;
    roi30d: number;
    winRate: number;
    totalAUM: number;
    totalTrades: number;
    avgPositionSize: number;
  };
  positions: Array<{
    asset: string;
    platform: string;
    type: string;
    size: number;
    margin: number;
    entry: number;
    current: number;
    pnl: number;
    roi: number;
    leverage: number;
  }>;
  verified: boolean;
  lastPositionSync: Date | null;
  avantisBackfillStatus: string;
  updatedAt: Date;
}

export interface GetTopAvantisTradersParams {
  sortBy?: 'pnl' | 'roi' | 'winRate' | 'aum';
  limit?: number;
}

export async function getTopAvantisTraders(params: GetTopAvantisTradersParams): Promise<{
  traders: AvantisTraderProfile[];
  totalFound: number;
}> {
  const db = await getDB();
  const collection = db.collection(MANAGERS_COLLECTION);

  const {
    sortBy = 'pnl',
    limit = 10,
  } = params;

  // Map sortBy to field
  const sortFieldMap: Record<string, string> = {
    pnl: 'metrics.totalPnL30d',
    roi: 'metrics.roi30d',
    winRate: 'metrics.winRate',
    aum: 'metrics.totalAUM',
  };

  const sortField = sortFieldMap[sortBy] || 'metrics.totalPnL30d';
  const sort: Record<string, 1 | -1> = { [sortField]: -1 };

  // Try with Avantis filter first (case-insensitive regex)
  let filter: Record<string, unknown> = {
    platforms: { $regex: /avantis/i },
  };

  let traders = await collection
    .find(filter)
    .sort(sort)
    .limit(limit)
    .toArray() as unknown as AvantisTraderProfile[];

  let totalFound = await collection.countDocuments(filter);

  // If no results with Avantis filter, return all managers
  if (traders.length === 0) {
    filter = {};
    traders = await collection
      .find(filter)
      .sort(sort)
      .limit(limit)
      .toArray() as unknown as AvantisTraderProfile[];
    totalFound = await collection.countDocuments(filter);
  }

  return { traders, totalFound };
}

export async function getAvantisTraderByWallet(wallet: string): Promise<AvantisTraderProfile | null> {
  const db = await getDB();
  const collection = db.collection(MANAGERS_COLLECTION);

  const trader = await collection.findOne({
    walletAddress: { $regex: new RegExp(`^${wallet}$`, 'i') },
  }) as unknown as AvantisTraderProfile | null;

  return trader;
}

export async function getAvantisTraderByUsername(username: string): Promise<AvantisTraderProfile | null> {
  const db = await getDB();
  const collection = db.collection(MANAGERS_COLLECTION);

  const trader = await collection.findOne({
    username: username.toLowerCase(),
  }) as unknown as AvantisTraderProfile | null;

  return trader;
}
