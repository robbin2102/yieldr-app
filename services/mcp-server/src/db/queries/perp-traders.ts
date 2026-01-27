/**
 * Perp Trader Queries
 * Queries the indexed hyperliquidmetrics collection for HL
 * Queries the managers collection for Avantis
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

  // Position-based win rate (open + closed positions)
  positionWinRate: number;
  positionWins: number;
  positionLosses: number;
  totalPositions: number;

  // Profit factor (grossProfit / grossLoss)
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;

  // Open position stats
  openPositionsCount: number;
  profitablePositionsCount: number;
  unrealizedPnlTotal: number;

  // Closed position stats
  closedPositionsCount: number;
  closedPositionWins: number;
  closedPositionLosses: number;

  // Risk metrics
  sharpeRatio: number;
  maxDrawdown: number;
  avgLeverage: number;
  maxLeverageUsed: number;
  updatedAt: Date;
}

// Unified output format for both protocols
export interface PerpTraderOutput {
  wallet: string;
  username?: string;
  accountValue?: string;
  pnl: {
    day?: number;
    week?: number;
    month: number;
    allTime?: number;
  };
  stats: {
    // Position-based win rate (from actual positions, not fills)
    positionWinRate: number;
    totalPositions: number;
    // Profit factor (grossProfit / grossLoss) - >1 means profitable
    profitFactor: number;
    sharpeRatio?: number;
    maxDrawdown?: number;
    roi30d?: number;
    totalAUM?: number;
  };
  // Open position stats
  openPositions?: {
    count: number;
    profitable: number;
    unrealizedPnl: number;
  };
  // Closed position stats
  closedPositions?: {
    count: number;
    wins: number;
    losses: number;
  };
  volume24h?: string;
}

export interface GetTopPerpTradersParams {
  protocol: 'hyperliquid' | 'avantis';
  asset?: string;
  sortBy?: 'pnl' | 'winRate' | 'sharpe' | 'volume' | 'roi' | 'aum';
  timeframe?: '7d' | '30d' | '90d';
  limit?: number;
}

export async function getTopPerpTraders(params: GetTopPerpTradersParams): Promise<{
  protocol: string;
  traders: PerpTraderOutput[];
  totalFound: number;
}> {
  const db = await getDB();

  const {
    protocol,
    sortBy = 'pnl',
    timeframe = '30d',
    limit = 10,
  } = params;

  if (protocol === 'hyperliquid') {
    return getTopHyperliquidTraders({ sortBy, timeframe, limit });
  } else {
    return getTopAvantisManagerTraders({ sortBy, limit });
  }
}

async function getTopHyperliquidTraders(params: {
  sortBy: string;
  timeframe: string;
  limit: number;
}): Promise<{ protocol: string; traders: PerpTraderOutput[]; totalFound: number }> {
  const db = await getDB();
  const collection = db.collection(COLLECTIONS.HL_METRICS);

  const { sortBy, timeframe, limit } = params;

  // Map sortBy to field
  const sortFieldMap: Record<string, string> = {
    pnl: timeframe === '7d' ? 'pnl_7d' : timeframe === '30d' ? 'pnl_30d' : 'pnl_allTime',
    winRate: 'positionWinRate',
    sharpe: 'sharpeRatio',
    volume: 'volume_24h',
  };

  const sortField = sortFieldMap[sortBy] || 'pnl_30d';
  const sort: Record<string, 1 | -1> = { [sortField]: -1 };

  const traders = await collection
    .find({})
    .sort(sort)
    .limit(limit)
    .toArray() as unknown as HLTraderMetrics[];

  const totalFound = await collection.countDocuments({});

  // Transform to unified output format
  const output: PerpTraderOutput[] = traders.map(t => ({
    wallet: t.walletAddress,
    accountValue: t.accountValue,
    pnl: {
      day: t.pnl_1d,
      week: t.pnl_7d,
      month: t.pnl_30d,
      allTime: t.pnl_allTime,
    },
    stats: {
      positionWinRate: t.positionWinRate || 0,
      totalPositions: t.totalPositions || 0,
      profitFactor: t.profitFactor || 0,
      sharpeRatio: t.sharpeRatio,
      maxDrawdown: t.maxDrawdown,
    },
    openPositions: {
      count: t.openPositionsCount || 0,
      profitable: t.profitablePositionsCount || 0,
      unrealizedPnl: t.unrealizedPnlTotal || 0,
    },
    closedPositions: {
      count: t.closedPositionsCount || 0,
      wins: t.closedPositionWins || 0,
      losses: t.closedPositionLosses || 0,
    },
    volume24h: t.volume_24h,
  }));

  return { protocol: 'hyperliquid', traders: output, totalFound };
}

async function getTopAvantisManagerTraders(params: {
  sortBy: string;
  limit: number;
}): Promise<{ protocol: string; traders: PerpTraderOutput[]; totalFound: number }> {
  const db = await getDB();
  const collection = db.collection('managers');

  const { sortBy, limit } = params;

  // Map sortBy to managers collection fields
  const sortFieldMap: Record<string, string> = {
    pnl: 'metrics.totalPnL30d',
    winRate: 'metrics.winRate',
    roi: 'metrics.roi30d',
    aum: 'metrics.totalAUM',
  };

  const sortField = sortFieldMap[sortBy] || 'metrics.totalPnL30d';
  const sort: Record<string, 1 | -1> = { [sortField]: -1 };

  // Try with Avantis filter first (case-insensitive regex)
  let filter: Record<string, unknown> = {
    platforms: { $regex: /avantis/i },
  };

  interface ManagerDoc {
    walletAddress: string;
    username?: string;
    metrics?: {
      totalPnL30d?: number;
      roi30d?: number;
      winRate?: number;
      totalAUM?: number;
      totalTrades?: number;
    };
    positions?: Array<unknown>;
  }

  let traders = await collection
    .find(filter)
    .sort(sort)
    .limit(limit)
    .toArray() as unknown as ManagerDoc[];

  let totalFound = await collection.countDocuments(filter);

  // If no results with Avantis filter, try without filter (return all managers)
  if (traders.length === 0) {
    filter = {};
    traders = await collection
      .find(filter)
      .sort(sort)
      .limit(limit)
      .toArray() as unknown as ManagerDoc[];
    totalFound = await collection.countDocuments(filter);
  }

  // Transform to unified output format
  const output: PerpTraderOutput[] = traders.map(t => ({
    wallet: t.walletAddress || 'unknown',
    username: t.username,
    pnl: {
      month: t.metrics?.totalPnL30d || 0,
    },
    stats: {
      positionWinRate: t.metrics?.winRate || 0,
      totalPositions: t.metrics?.totalTrades || 0,
      profitFactor: 0, // Not available for Avantis
      roi30d: t.metrics?.roi30d || 0,
      totalAUM: t.metrics?.totalAUM || 0,
    },
    openPositions: {
      count: t.positions?.length || 0,
      profitable: 0,
      unrealizedPnl: 0,
    },
  }));

  return { protocol: 'avantis', traders: output, totalFound };
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
