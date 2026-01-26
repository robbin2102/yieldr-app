/**
 * Polymarket Trader Queries
 * Queries the indexed polymarket-traderProfiles collection
 */

import { getDB, COLLECTIONS } from '../mongodb.js';

export interface PMTraderProfile {
  wallet: string;
  label?: string;
  specialty?: string;
  labels?: string[];
  metrics: {
    totalTrades: number;
    winRate: number;
    netPnl: number;
    profitFactor: number;
    avgTradeSize?: number;
    totalVolume?: number;
  };
  categoryBreakdown?: Record<string, {
    trades: number;
    pnl: number;
    winRate: number;
  }>;
  updatedAt: Date;
}

export interface GetTopPMTradersParams {
  category?: string;
  sortBy?: 'winRate' | 'netPnl' | 'profitFactor' | 'totalTrades';
  minTrades?: number;
  limit?: number;
}

export async function getTopPMTraders(params: GetTopPMTradersParams): Promise<{
  traders: PMTraderProfile[];
  totalFound: number;
}> {
  const db = await getDB();
  const collection = db.collection(COLLECTIONS.PM_TRADER_PROFILES);

  const {
    category,
    sortBy = 'netPnl',
    minTrades = 10,
    limit = 10,
  } = params;

  // Build query filter
  const filter: Record<string, unknown> = {
    'metrics.totalTrades': { $gte: minTrades },
  };

  // Filter by category/specialty if provided
  if (category) {
    filter.$or = [
      { specialty: { $regex: category, $options: 'i' } },
      { labels: { $regex: category, $options: 'i' } },
    ];
  }

  // Build sort
  const sortField = `metrics.${sortBy}`;
  const sort: Record<string, 1 | -1> = { [sortField]: -1 };

  // Execute query
  const traders = await collection
    .find(filter)
    .sort(sort)
    .limit(limit)
    .toArray() as unknown as PMTraderProfile[];

  const totalFound = await collection.countDocuments(filter);

  return { traders, totalFound };
}

export async function getPMTraderByWallet(wallet: string): Promise<PMTraderProfile | null> {
  const db = await getDB();
  const collection = db.collection(COLLECTIONS.PM_TRADER_PROFILES);

  const trader = await collection.findOne({
    wallet: wallet.toLowerCase(),
  }) as unknown as PMTraderProfile | null;

  return trader;
}

export async function comparePMTraders(wallets: string[]): Promise<PMTraderProfile[]> {
  const db = await getDB();
  const collection = db.collection(COLLECTIONS.PM_TRADER_PROFILES);

  const traders = await collection
    .find({
      wallet: { $in: wallets.map(w => w.toLowerCase()) },
    })
    .toArray() as unknown as PMTraderProfile[];

  return traders;
}
