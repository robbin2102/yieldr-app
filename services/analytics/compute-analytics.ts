/**
 * Analytics Computation Service
 *
 * Computes all dashboard metrics for a manager:
 * - Performance metrics (PnL, ROI, win rate)
 * - Risk metrics (Sharpe, Sortino, Calmar, drawdown)
 * - Consistency metrics (streaks, daily performance)
 * - Trading statistics (hold time, position sizing, etc.)
 */

import clientPromise from '@/lib/mongodb';
import type { ObjectId } from 'mongodb';
import { getClosedPositions, getWinRate, getTotalPnL } from '../monitoring/closed-position-logger';
import { getLastSnapshotPositions } from '../monitoring/snapshot-service';

/**
 * Main function: Computes all analytics for a manager
 */
export async function computeAndSaveAnalytics(
  managerId: ObjectId | string,
  username: string
): Promise<boolean> {
  const startTime = Date.now();

  try {
    console.log(`[Analytics] Computing analytics for ${username}...`);

    // Fetch required data
    const [closedPositions, livePositions] = await Promise.all([
      getClosedPositions(managerId, { limit: 1000 }), // Last 1000 closed positions
      getLastSnapshotPositions(managerId),
    ]);

    if (closedPositions.length === 0 && livePositions.length === 0) {
      console.log(`[Analytics] No data available for ${username}, skipping`);
      return false;
    }

    // Compute all metrics
    const performance = await computePerformanceMetrics(managerId, closedPositions, livePositions);
    const risk = computeRiskMetrics(closedPositions, livePositions);
    const consistency = computeConsistencyMetrics(closedPositions);
    const trading = computeTradingStats(closedPositions, livePositions);
    const dailyPerformance = computeDailyPerformance(closedPositions);

    // Build analytics document
    const analytics = {
      managerId: typeof managerId === 'string' ? managerId : managerId.toString(),
      username,
      performance,
      risk,
      consistency,
      trading,
      dailyPerformance,
      lastCalculated: new Date(),
      calculationDuration: Date.now() - startTime,
      dataQuality: {
        completeness: calculateDataCompleteness(closedPositions, livePositions),
        lastDataGap: null,
        missingDataPoints: 0,
      },
      updatedAt: new Date(),
    };

    // Save to database
    const client = await clientPromise;
    const db = client.db('yieldr');

    await db.collection('manageranalytics').updateOne(
      { managerId: analytics.managerId },
      { $set: analytics },
      { upsert: true }
    );

    console.log(
      `[Analytics] ✓ Saved analytics for ${username} (${Date.now() - startTime}ms)`
    );

    return true;
  } catch (error) {
    console.error('[Analytics] Error computing analytics:', error);
    return false;
  }
}

/**
 * Computes performance metrics
 */
async function computePerformanceMetrics(
  managerId: ObjectId | string,
  closedPositions: any[],
  livePositions: any[]
): Promise<any> {
  // Calculate live position metrics
  let liveAUM = 0;
  let livePnL = 0;

  for (const pos of livePositions) {
    if (pos.type === 'PERP' && pos.margin) {
      liveAUM += pos.margin;
    } else if (pos.type === 'LP' && pos.liquidity) {
      liveAUM += pos.liquidity;
    }
    if (pos.pnl) {
      livePnL += pos.pnl;
    }
  }

  // Calculate closed position metrics by time period
  const now = new Date();
  const pnl24h = getTotalPnLForPeriod(closedPositions, 1);
  const pnl7d = getTotalPnLForPeriod(closedPositions, 7);
  const pnl30d = getTotalPnLForPeriod(closedPositions, 30);
  const pnlAllTime = closedPositions.reduce((sum, p) => sum + (p.pnl || 0), 0) + livePnL;

  // Win rate calculations
  const winRate = await getWinRate(managerId);
  const winRate30d = await getWinRate(managerId, 30);

  // Win/Loss breakdown
  const winners = closedPositions.filter((p) => p.pnl > 0);
  const losers = closedPositions.filter((p) => p.pnl < 0);

  const avgWinAmount = winners.length > 0
    ? winners.reduce((sum, p) => sum + p.pnl, 0) / winners.length
    : 0;

  const avgLossAmount = losers.length > 0
    ? Math.abs(losers.reduce((sum, p) => sum + p.pnl, 0) / losers.length)
    : 0;

  const avgWinPercentage = winners.length > 0
    ? winners.reduce((sum, p) => sum + (p.roi || 0), 0) / winners.length
    : 0;

  const avgLossPercentage = losers.length > 0
    ? Math.abs(losers.reduce((sum, p) => sum + (p.roi || 0), 0) / losers.length)
    : 0;

  // Largest win/loss
  const largestWin = winners.length > 0
    ? Math.max(...winners.map((p) => p.pnl))
    : 0;

  const largestLoss = losers.length > 0
    ? Math.min(...losers.map((p) => p.pnl))
    : 0;

  const largestWinPos = winners.find((p) => p.pnl === largestWin);
  const largestLossPos = losers.find((p) => p.pnl === largestLoss);

  return {
    totalPnL: pnlAllTime,
    totalROI: liveAUM > 0 ? (pnlAllTime / liveAUM) * 100 : 0,
    totalAUM: liveAUM,
    totalPositions: livePositions.length,

    pnl24h,
    roi24h: liveAUM > 0 ? (pnl24h / liveAUM) * 100 : 0,
    pnl7d,
    roi7d: liveAUM > 0 ? (pnl7d / liveAUM) * 100 : 0,
    pnl30d,
    roi30d: liveAUM > 0 ? (pnl30d / liveAUM) * 100 : 0,
    pnlAllTime,
    roiAllTime: liveAUM > 0 ? (pnlAllTime / liveAUM) * 100 : 0,

    winRate: winRate.winRate,
    winRate30d: winRate30d.winRate,
    totalTrades: closedPositions.length,
    winningTrades: winRate.wins,
    losingTrades: winRate.losses,

    avgWinAmount,
    avgLossAmount,
    avgWinPercentage,
    avgLossPercentage,
    winLossRatio: avgLossAmount > 0 ? avgWinAmount / avgLossAmount : 0,

    largestWin,
    largestWinAsset: largestWinPos?.asset || null,
    largestLoss,
    largestLossAsset: largestLossPos?.asset || null,

    bestPeriod30d: { roi: 0, date: null }, // TODO: Implement 30d rolling periods
    worstPeriod30d: { roi: 0, date: null },
  };
}

/**
 * Computes risk metrics
 */
function computeRiskMetrics(closedPositions: any[], livePositions: any[]): any {
  // Calculate returns for each closed position
  const returns = closedPositions.map((p) => p.roi || 0).filter((r) => r !== 0);

  if (returns.length === 0) {
    return {
      sharpeRatio: 0,
      sortinoRatio: 0,
      calmarRatio: 0,
      maxDrawdown: 0,
      avgDrawdown: 0,
      currentDrawdown: 0,
      avgRecoveryTime: 0,
      recoveryRate: 0,
      avgLeverage: 0,
      maxLeverage: 0,
      volatility: 0,
      downsideDeviation: 0,
      var95: 0,
      var99: 0,
    };
  }

  // Calculate standard deviation (volatility)
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const volatility = Math.sqrt(variance);

  // Sharpe Ratio (assuming 0% risk-free rate for crypto)
  const sharpeRatio = volatility > 0 ? mean / volatility : 0;

  // Downside deviation (only negative returns)
  const negativeReturns = returns.filter((r) => r < 0);
  const downsideDeviation =
    negativeReturns.length > 0
      ? Math.sqrt(
          negativeReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / negativeReturns.length
        )
      : 0;

  // Sortino Ratio
  const sortinoRatio = downsideDeviation > 0 ? mean / downsideDeviation : 0;

  // Calculate drawdowns
  let peak = 0;
  let maxDrawdown = 0;
  let cumulativeReturn = 0;
  const drawdowns: number[] = [];

  for (const ret of returns) {
    cumulativeReturn += ret;
    if (cumulativeReturn > peak) {
      peak = cumulativeReturn;
    }
    const drawdown = peak - cumulativeReturn;
    if (drawdown > 0) {
      drawdowns.push(drawdown);
    }
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  const avgDrawdown =
    drawdowns.length > 0 ? drawdowns.reduce((sum, d) => sum + d, 0) / drawdowns.length : 0;

  // Calmar Ratio (annual return / max drawdown)
  const annualReturn = mean * 365; // Assuming daily returns
  const calmarRatio = maxDrawdown > 0 ? annualReturn / maxDrawdown : 0;

  // Leverage stats
  const perpPositions = [...closedPositions, ...livePositions].filter(
    (p) => p.type === 'PERP' && p.leverage
  );
  const avgLeverage =
    perpPositions.length > 0
      ? perpPositions.reduce((sum, p) => sum + (p.leverage || 0), 0) / perpPositions.length
      : 0;
  const maxLeverage =
    perpPositions.length > 0 ? Math.max(...perpPositions.map((p) => p.leverage || 0)) : 0;

  // Value at Risk (VaR)
  const sortedReturns = [...returns].sort((a, b) => a - b);
  const var95Index = Math.floor(sortedReturns.length * 0.05);
  const var99Index = Math.floor(sortedReturns.length * 0.01);
  const var95 = sortedReturns[var95Index] || 0;
  const var99 = sortedReturns[var99Index] || 0;

  return {
    sharpeRatio: Number(sharpeRatio.toFixed(2)),
    sortinoRatio: Number(sortinoRatio.toFixed(2)),
    calmarRatio: Number(calmarRatio.toFixed(2)),
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    avgDrawdown: Number(avgDrawdown.toFixed(2)),
    currentDrawdown: 0, // TODO: Calculate current drawdown
    drawdownFrequency: 0,
    maxDrawdownsIn30d: 0,
    avgRecoveryTime: 0,
    recoveryRate: 0,
    currentRecoveryDays: 0,
    avgLeverage: Number(avgLeverage.toFixed(2)),
    maxLeverage: Number(maxLeverage.toFixed(2)),
    volatility: Number(volatility.toFixed(2)),
    downsideDeviation: Number(downsideDeviation.toFixed(2)),
    var95: Number(var95.toFixed(2)),
    var99: Number(var99.toFixed(2)),
  };
}

/**
 * Computes consistency metrics
 */
function computeConsistencyMetrics(closedPositions: any[]): any {
  if (closedPositions.length === 0) {
    return {
      currentStreak: { type: 'none', count: 0, startDate: null },
      longestWinStreak: 0,
      longestWinStreakDate: null,
      longestLossStreak: 0,
      longestLossStreakDate: null,
      activeDays: 0,
      activeDaysPercentage: 0,
      avgTradingFrequency: 0,
      positivePeriods30d: 0,
      positivePeriodsPercentage: 0,
      dailyWinRate: 0,
      profitableDays: 0,
      unprofitableDays: 0,
      breakEvenDays: 0,
    };
  }

  // Sort positions by close date
  const sorted = [...closedPositions].sort(
    (a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime()
  );

  // Calculate streaks
  let currentStreak = { type: 'none', count: 0, startDate: null };
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let currentWinStreak = 0;
  let currentLossStreak = 0;

  for (const pos of sorted) {
    if (pos.pnl > 0) {
      currentWinStreak++;
      currentLossStreak = 0;
      if (currentWinStreak > longestWinStreak) {
        longestWinStreak = currentWinStreak;
      }
    } else if (pos.pnl < 0) {
      currentLossStreak++;
      currentWinStreak = 0;
      if (currentLossStreak > longestLossStreak) {
        longestLossStreak = currentLossStreak;
      }
    }
  }

  // Current streak
  if (currentWinStreak > 0) {
    currentStreak = { type: 'win', count: currentWinStreak, startDate: sorted[sorted.length - currentWinStreak]?.closedAt };
  } else if (currentLossStreak > 0) {
    currentStreak = { type: 'loss', count: currentLossStreak, startDate: sorted[sorted.length - currentLossStreak]?.closedAt };
  }

  // Active days calculation
  const uniqueDays = new Set(
    sorted.map((p) => new Date(p.closedAt).toISOString().split('T')[0])
  );
  const activeDays = uniqueDays.size;

  // Calculate daily win rate
  const dailyPnL = new Map<string, number>();
  for (const pos of sorted) {
    const day = new Date(pos.closedAt).toISOString().split('T')[0];
    dailyPnL.set(day, (dailyPnL.get(day) || 0) + pos.pnl);
  }

  let profitableDays = 0;
  let unprofitableDays = 0;
  let breakEvenDays = 0;

  for (const [day, pnl] of dailyPnL) {
    if (pnl > 0) profitableDays++;
    else if (pnl < 0) unprofitableDays++;
    else breakEvenDays++;
  }

  const dailyWinRate =
    dailyPnL.size > 0 ? (profitableDays / dailyPnL.size) * 100 : 0;

  return {
    currentStreak,
    longestWinStreak,
    longestWinStreakDate: null,
    longestLossStreak,
    longestLossStreakDate: null,
    activeDays,
    activeDaysPercentage: 0,
    avgTradingFrequency: 0,
    positivePeriods30d: 0,
    positivePeriodsPercentage: 0,
    dailyWinRate: Number(dailyWinRate.toFixed(2)),
    profitableDays,
    unprofitableDays,
    breakEvenDays,
  };
}

/**
 * Computes trading statistics
 */
function computeTradingStats(closedPositions: any[], livePositions: any[]): any {
  if (closedPositions.length === 0) {
    return {
      avgHoldTime: 0,
      avgHoldTimeWinners: 0,
      avgHoldTimeLosers: 0,
      tradingStyle: 'unknown',
      topAssets: [],
      platformDistribution: {},
      perpPositions: 0,
      lpPositions: 0,
      longPositions: 0,
      shortPositions: 0,
    };
  }

  // Average hold time
  const holdTimes = closedPositions
    .map((p) => p.holdDuration)
    .filter((t) => t && t > 0);
  const avgHoldTime =
    holdTimes.length > 0 ? holdTimes.reduce((sum, t) => sum + t, 0) / holdTimes.length : 0;

  const winners = closedPositions.filter((p) => p.pnl > 0);
  const losers = closedPositions.filter((p) => p.pnl < 0);

  const avgHoldTimeWinners =
    winners.length > 0
      ? winners.reduce((sum, p) => sum + (p.holdDuration || 0), 0) / winners.length
      : 0;

  const avgHoldTimeLosers =
    losers.length > 0
      ? losers.reduce((sum, p) => sum + (p.holdDuration || 0), 0) / losers.length
      : 0;

  // Trading style based on avg hold time
  let tradingStyle = 'unknown';
  const avgHoldDays = avgHoldTime / 86400; // Convert to days
  if (avgHoldDays < 1) tradingStyle = 'scalper';
  else if (avgHoldDays < 2) tradingStyle = 'day-trader';
  else if (avgHoldDays < 7) tradingStyle = 'swing-trader';
  else tradingStyle = 'position-trader';

  // Top assets
  const assetStats = new Map<string, any>();
  for (const pos of closedPositions) {
    const asset = pos.asset;
    if (!assetStats.has(asset)) {
      assetStats.set(asset, {
        asset,
        aum: 0,
        trades: 0,
        wins: 0,
        pnl: 0,
      });
    }
    const stats = assetStats.get(asset);
    stats.trades++;
    stats.pnl += pos.pnl || 0;
    if (pos.pnl > 0) stats.wins++;
    if (pos.margin) stats.aum += pos.margin;
  }

  const topAssets = Array.from(assetStats.values())
    .map((stats) => ({
      ...stats,
      winRate: (stats.wins / stats.trades) * 100,
      roi: stats.aum > 0 ? (stats.pnl / stats.aum) * 100 : 0,
      sharpe: 0, // Simplified
    }))
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 10);

  // Position type counts
  const perpPositions = livePositions.filter((p) => p.type === 'PERP').length;
  const lpPositions = livePositions.filter((p) => p.type === 'LP').length;
  const longPositions = livePositions.filter((p) => p.direction === 'LONG').length;
  const shortPositions = livePositions.filter((p) => p.direction === 'SHORT').length;

  return {
    avgHoldTime: Math.round(avgHoldTime),
    avgHoldTimeWinners: Math.round(avgHoldTimeWinners),
    avgHoldTimeLosers: Math.round(avgHoldTimeLosers),
    tradingStyle,
    topAssets,
    platformDistribution: {},
    perpPositions,
    lpPositions,
    longPositions,
    shortPositions,
  };
}

/**
 * Computes daily performance for calendar view
 */
function computeDailyPerformance(closedPositions: any[]): any[] {
  const dailyPnL = new Map<string, { pnl: number; trades: number }>();

  for (const pos of closedPositions) {
    const day = new Date(pos.closedAt).toISOString().split('T')[0];
    if (!dailyPnL.has(day)) {
      dailyPnL.set(day, { pnl: 0, trades: 0 });
    }
    const stats = dailyPnL.get(day)!;
    stats.pnl += pos.pnl || 0;
    stats.trades++;
  }

  const dailyPerformance = [];
  for (const [day, stats] of dailyPnL) {
    let result = 'no_trading';
    if (stats.pnl > 0) result = 'win';
    else if (stats.pnl < 0) result = 'loss';
    else result = 'breakeven';

    dailyPerformance.push({
      date: new Date(day),
      pnl: stats.pnl,
      roi: 0, // Simplified
      trades: stats.trades,
      result,
    });
  }

  return dailyPerformance.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 90);
}

/**
 * Helper: Get total PnL for a time period (days)
 */
function getTotalPnLForPeriod(closedPositions: any[], days: number): number {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  return closedPositions
    .filter((p) => new Date(p.closedAt) >= cutoffDate)
    .reduce((sum, p) => sum + (p.pnl || 0), 0);
}

/**
 * Helper: Calculate data completeness score
 */
function calculateDataCompleteness(closedPositions: any[], livePositions: any[]): number {
  if (closedPositions.length === 0 && livePositions.length === 0) {
    return 0;
  }
  return 100; // Simplified - could check for missing fields
}
