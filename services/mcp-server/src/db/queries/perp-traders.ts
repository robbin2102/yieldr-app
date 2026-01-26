/**
 * Perp Trader Queries
 * Queries the indexed hyperliquidmetrics collection
 */

import { getDB, COLLECTIONS } from '../mongodb.js';

export interface HLTraderMetrics {
  walletAddress: string;
  accountValue: string;
  totalMarginUsed: string;
  totalNtlPos: string;
  withdrawable: string;
  pnl_1d: number;
  pnl_7d: number;
  pnl_30d: number;
  pnl_allTime: number;
  volume_24h: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  bestTrade: number;
  worstTrade: number;
  sharpeRatio: number;
  maxDrawdown: number;
  avgLeverage: number;
  maxLeverageUsed: number;
  updatedAt: Date;
}

export interface GetTopPerpTradersParams {
  protocol: 'hyperliquid' | 'avantis';
  asset?: string;
  sortBy?: 'pnl' | 'winRate' | 'sharpe' | 'volume';
  timeframe?: '7d' | '30d' | '90d';
  limit?: number;
}

export async function getTopPerpTraders(params: GetTopPerpTradersParams): Promise<{
  protocol: string;
  traders: HLTraderMetrics[];
  totalFound: number;
}> {
  const db = await getDB();

  const {
    protocol,
    sortBy = 'pnl',
    timeframe = '30d',
    limit = 10,
  } = params;

  // Select collection based on protocol
  const collectionName = protocol === 'hyperliquid'
    ? COLLECTIONS.HL_METRICS
    : COLLECTIONS.AV_METRICS;

  const collection = db.collection(collectionName);

  // Map sortBy to field
  const sortFieldMap: Record<string, string> = {
    pnl: timeframe === '7d' ? 'pnl_7d' : timeframe === '30d' ? 'pnl_30d' : 'pnl_allTime',
    winRate: 'winRate',
    sharpe: 'sharpeRatio',
    volume: 'volume_24h',
  };

  const sortField = sortFieldMap[sortBy] || 'pnl_30d';
  const sort: Record<string, 1 | -1> = { [sortField]: -1 };

  // Execute query
  const traders = await collection
    .find({})
    .sort(sort)
    .limit(limit)
    .toArray() as unknown as HLTraderMetrics[];

  const totalFound = await collection.countDocuments({});

  return { protocol, traders, totalFound };
}

export async function getPerpTraderByWallet(
  wallet: string,
  protocol: 'hyperliquid' | 'avantis' = 'hyperliquid'
): Promise<HLTraderMetrics | null> {
  const db = await getDB();

  const collectionName = protocol === 'hyperliquid'
    ? COLLECTIONS.HL_METRICS
    : COLLECTIONS.AV_METRICS;

  const collection = db.collection(collectionName);

  const trader = await collection.findOne({
    walletAddress: wallet.toLowerCase(),
  }) as unknown as HLTraderMetrics | null;

  return trader;
}

export async function comparePerpTraders(
  wallets: string[],
  protocol: 'hyperliquid' | 'avantis' = 'hyperliquid'
): Promise<HLTraderMetrics[]> {
  const db = await getDB();

  const collectionName = protocol === 'hyperliquid'
    ? COLLECTIONS.HL_METRICS
    : COLLECTIONS.AV_METRICS;

  const collection = db.collection(collectionName);

  const traders = await collection
    .find({
      walletAddress: { $in: wallets.map(w => w.toLowerCase()) },
    })
    .toArray() as unknown as HLTraderMetrics[];

  return traders;
}
