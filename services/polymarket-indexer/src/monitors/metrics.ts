/**
 * Polymarket Metrics Computation
 * Computes trader profile metrics from trades and positions
 */

import { getCollections } from '../lib/db';
import { fetchOpenPositions, fetchActivities, fetchClosedPositions } from '../lib/api';

const LOSS_THRESHOLD = 0.001;
const WIN_THRESHOLD = 0.99;

interface CategoryMetrics {
  category: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
}

export interface TraderMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  profitFactor: number;
  avgTradeSize: number;
  avgWin: number;
  avgLoss: number;
  bestTrade: number;
  worstTrade: number;
  totalVolume: number;
}

export interface TraderProfile {
  wallet: string;
  label?: string;
  metrics: TraderMetrics;
  specialty: string;
  strategyLabel: string;
  categoryBreakdown: CategoryMetrics[];
  openPositionsCount: number;
  openValue: number;
  topOpenPositions: any[];
  recentHighConvictionTrades: any[];
  lastUpdatedAt: Date;
}

/**
 * Compute comprehensive metrics for a trader
 */
export async function computeTraderMetrics(walletAddress: string): Promise<TraderProfile> {
  console.log(`[Metrics] Computing metrics for ${walletAddress}...`);

  // Fetch all data from API
  const [positions, activities, closedPositions] = await Promise.all([
    fetchOpenPositions(walletAddress),
    fetchActivities(walletAddress, 90), // 90 days
    fetchClosedPositions(walletAddress, 90),
  ]);

  // Separate active from resolved positions
  const activePositions = positions.filter(
    (p) => p.curPrice >= LOSS_THRESHOLD && p.curPrice <= WIN_THRESHOLD
  );
  const resolvedLosses = positions.filter(
    (p) => p.curPrice < LOSS_THRESHOLD && p.size > 0
  );
  const resolvedWins = positions.filter(
    (p) => p.curPrice > WIN_THRESHOLD && p.size > 0
  );

  // Calculate trade stats
  const trades = activities.filter((a) => a.type === 'TRADE');
  const buys = trades.filter((t) => t.side === 'BUY');
  const sells = trades.filter((t) => t.side === 'SELL');
  const redeems = activities.filter((a) => a.type === 'REDEEM');

  // Calculate open position metrics
  const openValue = activePositions.reduce((sum, p) => sum + p.currentValue, 0);
  const unrealizedPnl = activePositions.reduce((sum, p) => sum + p.cashPnl, 0);

  // Calculate realized PnL from closed positions
  const realizedPnl = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);

  // Win/Loss from closed positions
  const wins = closedPositions.filter((p) => p.realizedPnl > 0).length;
  const losses = closedPositions.filter((p) => p.realizedPnl < 0).length;

  // Total trades (unique positions)
  const totalTrades = closedPositions.length + resolvedWins.length + resolvedLosses.length;
  const winCount = wins + resolvedWins.length;
  const lossCount = losses + resolvedLosses.length;

  const winRate = totalTrades > 0 ? winCount / totalTrades : 0;

  // Calculate profit factor
  const grossProfit = closedPositions
    .filter((p) => p.realizedPnl > 0)
    .reduce((sum, p) => sum + p.realizedPnl, 0);
  const grossLoss = Math.abs(
    closedPositions
      .filter((p) => p.realizedPnl < 0)
      .reduce((sum, p) => sum + p.realizedPnl, 0)
  );
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Average trade metrics
  const totalVolume = trades.reduce((sum, t) => sum + t.usdcSize, 0);
  const avgTradeSize = trades.length > 0 ? totalVolume / trades.length : 0;

  const winningTrades = closedPositions.filter((p) => p.realizedPnl > 0);
  const losingTrades = closedPositions.filter((p) => p.realizedPnl < 0);

  const avgWin =
    winningTrades.length > 0
      ? winningTrades.reduce((sum, p) => sum + p.realizedPnl, 0) / winningTrades.length
      : 0;
  const avgLoss =
    losingTrades.length > 0
      ? losingTrades.reduce((sum, p) => sum + p.realizedPnl, 0) / losingTrades.length
      : 0;

  const bestTrade =
    winningTrades.length > 0 ? Math.max(...winningTrades.map((p) => p.realizedPnl)) : 0;
  const worstTrade =
    losingTrades.length > 0 ? Math.min(...losingTrades.map((p) => p.realizedPnl)) : 0;

  // Identify high conviction trades (asymmetric bets)
  const highConvictionTrades = buys
    .filter((t) => {
      const isLowPrice = t.price <= 0.25;
      const isLargeSize = t.usdcSize >= 50;
      return isLowPrice && isLargeSize;
    })
    .sort((a, b) => b.usdcSize - a.usdcSize)
    .slice(0, 50)
    .map((t) => ({
      market: t.title,
      outcome: t.outcome,
      price: t.price,
      size: t.size,
      usdcValue: t.usdcSize,
      timestamp: t.timestamp,
      transactionHash: t.transactionHash,
    }));

  // Top open positions
  const topOpenPositions = activePositions
    .sort((a, b) => b.currentValue - a.currentValue)
    .slice(0, 20)
    .map((p) => ({
      conditionId: p.conditionId,
      title: p.title,
      outcome: p.outcome,
      size: p.size,
      avgPrice: p.avgPrice,
      curPrice: p.curPrice,
      initialValue: p.initialValue,
      currentValue: p.currentValue,
      cashPnl: p.cashPnl,
      percentPnl: p.percentPnl,
    }));

  // Determine specialty (most active category)
  const categoryMap = new Map<string, { trades: number; pnl: number }>();
  for (const trade of trades) {
    const category = extractCategory(trade.title);
    const existing = categoryMap.get(category) || { trades: 0, pnl: 0 };
    existing.trades++;
    categoryMap.set(category, existing);
  }

  let specialty = 'General';
  let maxTrades = 0;
  for (const [cat, stats] of categoryMap) {
    if (stats.trades > maxTrades) {
      maxTrades = stats.trades;
      specialty = cat;
    }
  }

  // Determine strategy label
  let strategyLabel = 'Unknown';
  if (profitFactor > 2 && winRate > 0.6) {
    strategyLabel = 'High Conviction';
  } else if (highConvictionTrades.length > 10) {
    strategyLabel = 'Asymmetric Bettor';
  } else if (avgTradeSize > 500) {
    strategyLabel = 'Whale';
  } else if (trades.length > 100) {
    strategyLabel = 'Active Trader';
  } else {
    strategyLabel = 'Selective';
  }

  const metrics: TraderMetrics = {
    totalTrades,
    wins: winCount,
    losses: lossCount,
    winRate,
    netPnl: realizedPnl + unrealizedPnl,
    realizedPnl,
    unrealizedPnl,
    profitFactor: isFinite(profitFactor) ? profitFactor : 999,
    avgTradeSize,
    avgWin,
    avgLoss,
    bestTrade,
    worstTrade,
    totalVolume,
  };

  const profile: TraderProfile = {
    wallet: walletAddress.toLowerCase(),
    metrics,
    specialty,
    strategyLabel,
    categoryBreakdown: Array.from(categoryMap.entries()).map(([category, stats]) => ({
      category,
      trades: stats.trades,
      wins: 0,
      losses: 0,
      winRate: 0,
      netPnl: 0,
    })),
    openPositionsCount: activePositions.length,
    openValue,
    topOpenPositions,
    recentHighConvictionTrades: highConvictionTrades,
    lastUpdatedAt: new Date(),
  };

  console.log(
    `[Metrics] ${walletAddress}: Win Rate: ${(winRate * 100).toFixed(1)}%, Net PnL: $${(realizedPnl + unrealizedPnl).toFixed(2)}, Profit Factor: ${profitFactor.toFixed(2)}`
  );

  return profile;
}

/**
 * Save trader profile to database
 */
export async function saveTraderProfile(profile: TraderProfile): Promise<void> {
  const { traderProfiles } = await getCollections();

  await traderProfiles.updateOne(
    { wallet: profile.wallet },
    { $set: profile },
    { upsert: true }
  );

  console.log(`[Metrics] Saved profile for ${profile.wallet}`);
}

/**
 * Extract category from market title
 */
function extractCategory(title: string): string {
  const lower = title.toLowerCase();

  if (lower.includes('nfl') || lower.includes('football') || lower.includes('super bowl')) {
    return 'NFL';
  }
  if (lower.includes('nba') || lower.includes('basketball')) {
    return 'NBA';
  }
  if (lower.includes('mlb') || lower.includes('baseball')) {
    return 'MLB';
  }
  if (lower.includes('soccer') || lower.includes('premier league') || lower.includes('world cup')) {
    return 'Soccer';
  }
  if (lower.includes('trump') || lower.includes('biden') || lower.includes('election') || lower.includes('president')) {
    return 'Politics';
  }
  if (lower.includes('bitcoin') || lower.includes('ethereum') || lower.includes('crypto') || lower.includes('btc') || lower.includes('eth')) {
    return 'Crypto';
  }
  if (lower.includes('fed') || lower.includes('inflation') || lower.includes('gdp') || lower.includes('economy')) {
    return 'Economics';
  }
  if (lower.includes('ai') || lower.includes('openai') || lower.includes('google') || lower.includes('tech')) {
    return 'Tech';
  }

  return 'Other';
}
