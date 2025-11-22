/**
 * Metrics Computer
 * Calculate trading performance metrics from trade data
 */

import TradeEvent from '../../models/TradeEvent';
import type { TradeStatistics } from './types/trades';

/**
 * Compute trade statistics for a wallet
 * @param wallet - Wallet address
 * @returns Trade statistics
 */
export async function computeWalletStatistics(wallet: string): Promise<TradeStatistics> {
  const normalizedWallet = wallet.toLowerCase();

  console.log(`[MetricsComputer] Computing statistics for ${normalizedWallet}...`);

  // Fetch all trades for this wallet
  const allTrades = await TradeEvent.find({
    trader: normalizedWallet,
  }).sort({ initiatedAt: 1 });

  const openTrades = allTrades.filter((t) => t.status === 'EXECUTED');
  const closedTrades = allTrades.filter((t) => t.status === 'CLOSED');

  // Basic counts
  const totalTrades = allTrades.length;
  const openTradesCount = openTrades.length;
  const closedTradesCount = closedTrades.length;

  // Calculate time-based PnL
  const now = new Date();
  const pnl24h = calculatePnLForPeriod(closedTrades, now, 1);
  const pnl7d = calculatePnLForPeriod(closedTrades, now, 7);
  const pnl30d = calculatePnLForPeriod(closedTrades, now, 30);

  // Total PnL (all time)
  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnlUsdc || 0), 0);

  // Win rate
  const winningTrades = closedTrades.filter((t) => (t.pnlUsdc || 0) > 0).length;
  const losingTrades = closedTrades.filter((t) => (t.pnlUsdc || 0) <= 0).length;
  const winRate = closedTradesCount > 0 ? (winningTrades / closedTradesCount) * 100 : 0;

  // Average ROI
  const avgRoi =
    closedTradesCount > 0
      ? closedTrades.reduce((sum, t) => sum + (t.roi || 0), 0) / closedTradesCount
      : 0;

  // Total volume (sum of position sizes)
  const totalVolume = allTrades.reduce((sum, t) => sum + (t.positionSizeUsdc || 0), 0);

  // Average position size
  const avgPositionSize =
    allTrades.length > 0
      ? allTrades.reduce((sum, t) => sum + (t.positionSizeUsdc || 0), 0) / allTrades.length
      : 0;

  // Average leverage
  const avgLeverage =
    allTrades.length > 0
      ? allTrades.reduce((sum, t) => sum + (t.leverage || 0), 0) / allTrades.length
      : 0;

  // Average duration (for closed trades)
  const avgDurationSeconds =
    closedTradesCount > 0
      ? closedTrades.reduce((sum, t) => sum + (t.durationSeconds || 0), 0) /
        closedTradesCount
      : 0;

  // Last trade timestamp
  const lastTradeAt = allTrades.length > 0 ? allTrades[allTrades.length - 1].initiatedAt : undefined;

  const statistics: TradeStatistics = {
    trader: normalizedWallet,
    totalTrades,
    openTrades: openTradesCount,
    closedTrades: closedTradesCount,
    totalPnl,
    winningTrades,
    losingTrades,
    winRate,
    avgRoi,
    totalVolume,
    avgPositionSize,
    avgLeverage,
    avgDurationSeconds,
    pnl24h,
    pnl7d,
    pnl30d,
    lastTradeAt,
    computedAt: new Date(),
  };

  console.log(`[MetricsComputer] ✓ Statistics computed:`, {
    totalTrades,
    totalPnl: totalPnl.toFixed(2),
    winRate: winRate.toFixed(2) + '%',
    pnl30d: pnl30d.toFixed(2),
  });

  return statistics;
}

/**
 * Calculate PnL for a specific time period
 * @param closedTrades - Array of closed trades
 * @param now - Current timestamp
 * @param days - Number of days back
 * @returns PnL for the period
 */
function calculatePnLForPeriod(
  closedTrades: any[],
  now: Date,
  days: number
): number {
  const cutoffDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const relevantTrades = closedTrades.filter(
    (t) => t.closedAt && new Date(t.closedAt) >= cutoffDate
  );

  return relevantTrades.reduce((sum, t) => sum + (t.pnlUsdc || 0), 0);
}

/**
 * Get daily PnL breakdown for a wallet
 * @param wallet - Wallet address
 * @param days - Number of days to include
 * @returns Array of daily PnL
 */
export async function getDailyPnLBreakdown(
  wallet: string,
  days: number = 30
): Promise<Array<{ date: string; pnl: number; tradesCount: number }>> {
  const normalizedWallet = wallet.toLowerCase();
  const now = new Date();
  const cutoffDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const closedTrades = await TradeEvent.find({
    trader: normalizedWallet,
    status: 'CLOSED',
    closedAt: { $gte: cutoffDate },
  }).sort({ closedAt: 1 });

  // Group by day
  const dailyPnL = new Map<string, { pnl: number; count: number }>();

  for (const trade of closedTrades) {
    if (!trade.closedAt) continue;

    const dateKey = trade.closedAt.toISOString().split('T')[0]; // YYYY-MM-DD

    const existing = dailyPnL.get(dateKey) || { pnl: 0, count: 0 };
    dailyPnL.set(dateKey, {
      pnl: existing.pnl + (trade.pnlUsdc || 0),
      count: existing.count + 1,
    });
  }

  // Convert to array
  const result = Array.from(dailyPnL.entries())
    .map(([date, data]) => ({
      date,
      pnl: data.pnl,
      tradesCount: data.count,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return result;
}

/**
 * Get weekly PnL breakdown
 * @param wallet - Wallet address
 * @param weeks - Number of weeks
 * @returns Array of weekly PnL
 */
export async function getWeeklyPnLBreakdown(
  wallet: string,
  weeks: number = 12
): Promise<Array<{ weekStart: string; pnl: number; tradesCount: number }>> {
  const normalizedWallet = wallet.toLowerCase();
  const now = new Date();
  const cutoffDate = new Date(now.getTime() - weeks * 7 * 24 * 60 * 60 * 1000);

  const closedTrades = await TradeEvent.find({
    trader: normalizedWallet,
    status: 'CLOSED',
    closedAt: { $gte: cutoffDate },
  }).sort({ closedAt: 1 });

  // Group by week
  const weeklyPnL = new Map<string, { pnl: number; count: number }>();

  for (const trade of closedTrades) {
    if (!trade.closedAt) continue;

    const weekStart = getWeekStart(trade.closedAt);

    const existing = weeklyPnL.get(weekStart) || { pnl: 0, count: 0 };
    weeklyPnL.set(weekStart, {
      pnl: existing.pnl + (trade.pnlUsdc || 0),
      count: existing.count + 1,
    });
  }

  // Convert to array
  const result = Array.from(weeklyPnL.entries())
    .map(([weekStart, data]) => ({
      weekStart,
      pnl: data.pnl,
      tradesCount: data.count,
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  return result;
}

/**
 * Get week start date (Monday)
 * @param date - Date
 * @returns Week start date string (YYYY-MM-DD)
 */
function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust to Monday
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().split('T')[0];
}

/**
 * Get trading pair breakdown (PnL by pair)
 * @param wallet - Wallet address
 * @returns Array of pair statistics
 */
export async function getPairBreakdown(
  wallet: string
): Promise<Array<{ pairIndex: number; trades: number; pnl: number; winRate: number }>> {
  const normalizedWallet = wallet.toLowerCase();

  const closedTrades = await TradeEvent.find({
    trader: normalizedWallet,
    status: 'CLOSED',
  });

  // Group by pair
  const pairStats = new Map<number, { trades: number; wins: number; pnl: number }>();

  for (const trade of closedTrades) {
    const existing = pairStats.get(trade.pairIndex) || { trades: 0, wins: 0, pnl: 0 };

    pairStats.set(trade.pairIndex, {
      trades: existing.trades + 1,
      wins: existing.wins + ((trade.pnlUsdc || 0) > 0 ? 1 : 0),
      pnl: existing.pnl + (trade.pnlUsdc || 0),
    });
  }

  // Convert to array
  const result = Array.from(pairStats.entries())
    .map(([pairIndex, data]) => ({
      pairIndex,
      trades: data.trades,
      pnl: data.pnl,
      winRate: (data.wins / data.trades) * 100,
    }))
    .sort((a, b) => b.pnl - a.pnl); // Sort by PnL descending

  return result;
}

/**
 * Get performance summary
 * @param wallet - Wallet address
 * @returns Summary object
 */
export async function getPerformanceSummary(wallet: string) {
  const [stats, daily, weekly, pairs] = await Promise.all([
    computeWalletStatistics(wallet),
    getDailyPnLBreakdown(wallet, 30),
    getWeeklyPnLBreakdown(wallet, 12),
    getPairBreakdown(wallet),
  ]);

  return {
    statistics: stats,
    dailyPnL: daily,
    weeklyPnL: weekly,
    pairBreakdown: pairs,
  };
}
