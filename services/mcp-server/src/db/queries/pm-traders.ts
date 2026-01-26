/**
 * Polymarket Trader Queries
 * Queries the indexed polymarket-traderProfiles collection
 *
 * Schema matches polymarket-indexer/src/monitors/metrics.ts TraderProfile
 */

import { getDB, COLLECTIONS } from '../mongodb.js';

export interface PMTraderProfile {
  wallet: string;
  profiledAt: Date;
  periodDays: number;

  // Activity stats
  totalActivities: number;
  buyCount: number;
  sellCount: number;

  // Volume classification
  tradesPerDay: number;
  volumeLabel: 'LOW' | 'MEDIUM' | 'HIGH';

  // Strategy classification
  buyRatio: number;
  strategyLabel: 'BUY_AND_HOLD' | 'ACTIVE_TRADER' | 'SWING_TRADER';

  // Performance
  closedPositionsCount: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  profitFactor: number;

  // Open positions
  openPositionsCount: number;
  openValue: number;
  unrealizedPnl: number;

  // Trade sizing
  avgTradeSize: number;
  medianTradeSize: number;
  maxTradeSize: number;

  // Market specialization
  strengths?: Array<{ category: string; trades: number; totalPnl: number; winRate: number }>;
  weaknesses?: Array<{ category: string; trades: number; totalPnl: number; winRate: number }>;

  // Trader label
  label: string;

  lastUpdatedAt: Date;
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
    minTrades = 0,  // Default to 0 to return all traders
    limit = 10,
  } = params;

  // Build query filter - schema uses flat fields, not nested metrics
  // Total trades = buyCount + sellCount, but we filter on closedPositionsCount
  const filter: Record<string, unknown> = {};

  if (minTrades > 0) {
    filter.closedPositionsCount = { $gte: minTrades };
  }

  // Filter by category/specialty if provided (check strengths array)
  if (category) {
    filter['strengths.category'] = { $regex: category, $options: 'i' };
  }

  // Build sort - fields are at root level, not nested
  const sortFieldMap: Record<string, string> = {
    netPnl: 'netPnl',
    winRate: 'winRate',
    profitFactor: 'profitFactor',
    totalTrades: 'closedPositionsCount',
  };
  const sortField = sortFieldMap[sortBy] || 'netPnl';
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
