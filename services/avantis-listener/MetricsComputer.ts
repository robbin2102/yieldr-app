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

  // Fetch all events for this wallet
  const allEvents = await TradeEvent.find({
    trader: normalizedWallet,
  }).sort({ timestamp: 1 });

  const openEvents = allEvents.filter((e) => e.eventType === 'OPEN');
  const closeEvents = allEvents.filter((e) => e.eventType === 'CLOSE');

  // Basic counts
  const totalTrades = allEvents.length;
  const openTradesCount = openEvents.length;
  const closedTradesCount = closeEvents.length;

  // Calculate time-based PnL using CLOSE events
  const now = new Date();
  const pnl24h = calculatePnLForPeriod(closeEvents, now, 1);
  const pnl7d = calculatePnLForPeriod(closeEvents, now, 7);
  const pnl30d = calculatePnLForPeriod(closeEvents, now, 30);

  // Total PnL (all time) - only from CLOSE events
  const totalPnl = closeEvents.reduce((sum, e) => sum + (e.pnlUsdc || 0), 0);

  // Win rate
  const winningTrades = closeEvents.filter((e) => (e.pnlUsdc || 0) > 0).length;
  const losingTrades = closeEvents.filter((e) => (e.pnlUsdc || 0) <= 0).length;
  const winRate = closedTradesCount > 0 ? (winningTrades / closedTradesCount) * 100 : 0;

  // Average ROI (from CLOSE events)
  const avgRoi =
    closedTradesCount > 0
      ? closeEvents.reduce((sum, e) => sum + (e.roi || 0), 0) / closedTradesCount
      : 0;

  // Total volume (sum of position sizes from all events)
  const totalVolume = allEvents.reduce((sum, e) => sum + (e.positionSizeUsdc || 0), 0);

  // Average position size
  const avgPositionSize =
    allEvents.length > 0
      ? allEvents.reduce((sum, e) => sum + (e.positionSizeUsdc || 0), 0) / allEvents.length
      : 0;

  // Average leverage
  const avgLeverage =
    allEvents.length > 0
      ? allEvents.reduce((sum, e) => sum + (e.leverage || 0), 0) / allEvents.length
      : 0;

  // Average duration - NOTE: With simplified schema, duration must be calculated from matching OPEN/CLOSE pairs
  // For now, set to 0 as we don't have durationSeconds field anymore
  const avgDurationSeconds = 0;

  // Last trade timestamp
  const lastTradeAt = allEvents.length > 0 ? allEvents[allEvents.length - 1].timestamp : undefined;

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
 * @param closeEvents - Array of CLOSE events
 * @param now - Current timestamp
 * @param days - Number of days back
 * @returns PnL for the period
 */
function calculatePnLForPeriod(
  closeEvents: any[],
  now: Date,
  days: number
): number {
  const cutoffDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const relevantEvents = closeEvents.filter(
    (e) => e.timestamp && new Date(e.timestamp) >= cutoffDate
  );

  return relevantEvents.reduce((sum, e) => sum + (e.pnlUsdc || 0), 0);
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

  const closeEvents = await TradeEvent.find({
    trader: normalizedWallet,
    eventType: 'CLOSE',
    timestamp: { $gte: cutoffDate },
  }).sort({ timestamp: 1 });

  // Group by day
  const dailyPnL = new Map<string, { pnl: number; count: number }>();

  for (const event of closeEvents) {
    if (!event.timestamp) continue;

    const dateKey = event.timestamp.toISOString().split('T')[0]; // YYYY-MM-DD

    const existing = dailyPnL.get(dateKey) || { pnl: 0, count: 0 };
    dailyPnL.set(dateKey, {
      pnl: existing.pnl + (event.pnlUsdc || 0),
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

  const closeEvents = await TradeEvent.find({
    trader: normalizedWallet,
    eventType: 'CLOSE',
    timestamp: { $gte: cutoffDate },
  }).sort({ timestamp: 1 });

  // Group by week
  const weeklyPnL = new Map<string, { pnl: number; count: number }>();

  for (const event of closeEvents) {
    if (!event.timestamp) continue;

    const weekStart = getWeekStart(event.timestamp);

    const existing = weeklyPnL.get(weekStart) || { pnl: 0, count: 0 };
    weeklyPnL.set(weekStart, {
      pnl: existing.pnl + (event.pnlUsdc || 0),
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

  const closeEvents = await TradeEvent.find({
    trader: normalizedWallet,
    eventType: 'CLOSE',
  });

  // Group by pair
  const pairStats = new Map<number, { trades: number; wins: number; pnl: number }>();

  for (const event of closeEvents) {
    const existing = pairStats.get(event.pairIndex) || { trades: 0, wins: 0, pnl: 0 };

    pairStats.set(event.pairIndex, {
      trades: existing.trades + 1,
      wins: existing.wins + ((event.pnlUsdc || 0) > 0 ? 1 : 0),
      pnl: existing.pnl + (event.pnlUsdc || 0),
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
