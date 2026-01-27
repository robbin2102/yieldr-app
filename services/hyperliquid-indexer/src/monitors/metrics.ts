/**
 * Hyperliquid Metrics Computation
 * Uses portfolio API for PnL and fills for trade statistics
 */

import { getCollections } from '../lib/db';
import { getPortfolio } from '../lib/api';

interface MarginSummary {
  accountValue: string;
  totalMarginUsed: string;
  totalNtlPos: string;
  totalRawUsd: string;
}

export interface MetricsDocument {
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

/**
 * Compute comprehensive metrics from portfolio API and fills
 */
export async function computeMetrics(
  walletAddress: string,
  marginSummary: MarginSummary
): Promise<void> {
  console.log(`[Metrics] Computing metrics for ${walletAddress}...`);

  const { fills, positions, metrics, pnlSnapshots } = await getCollections();

  // Fetch portfolio data (PnL from API)
  const portfolio = await getPortfolio(walletAddress);

  // Extract PnL values from portfolio
  const pnl_1d = parseFloat(
    portfolio.day.pnlHistory[portfolio.day.pnlHistory.length - 1]?.[1] || '0'
  );
  const pnl_7d = parseFloat(
    portfolio.week.pnlHistory[portfolio.week.pnlHistory.length - 1]?.[1] || '0'
  );
  const pnl_30d = parseFloat(
    portfolio.month.pnlHistory[portfolio.month.pnlHistory.length - 1]?.[1] || '0'
  );
  const pnl_allTime = parseFloat(
    portfolio.allTime.pnlHistory[portfolio.allTime.pnlHistory.length - 1]?.[1] || '0'
  );
  const volume_24h = portfolio.day.vlm || '0';
  const accountValue =
    portfolio.day.accountValueHistory[
      portfolio.day.accountValueHistory.length - 1
    ]?.[1] || marginSummary.accountValue;

  console.log(
    `[Metrics] PnL - 1d: $${pnl_1d.toFixed(2)}, 7d: $${pnl_7d.toFixed(2)}, 30d: $${pnl_30d.toFixed(2)}, All: $${pnl_allTime.toFixed(2)}`
  );

  // Save PnL snapshot for Sharpe ratio calculation
  await pnlSnapshots.insertOne({
    walletAddress: walletAddress.toLowerCase(),
    timestamp: new Date(),
    accountValue,
    pnl_1d,
    pnl_7d,
    pnl_30d,
    pnl_allTime,
    volume_24h,
  });

  const { closedPositions } = await getCollections();

  // Get current OPEN positions
  const currentPositions = await positions
    .find({ walletAddress: walletAddress.toLowerCase() })
    .toArray();

  // Open position stats
  const openPositionsCount = currentPositions.length;
  const profitableOpenPositions = currentPositions.filter(
    (p: any) => p.unrealizedPnl && parseFloat(p.unrealizedPnl) > 0
  );
  const profitablePositionsCount = profitableOpenPositions.length;
  const losingOpenPositions = currentPositions.filter(
    (p: any) => p.unrealizedPnl && parseFloat(p.unrealizedPnl) < 0
  );
  const unrealizedPnlTotal = currentPositions.reduce(
    (sum: number, p: any) => sum + (parseFloat(p.unrealizedPnl) || 0),
    0
  );

  // Get CLOSED positions from our new collection
  const closedPositionDocs = await closedPositions
    .find({ walletAddress: walletAddress.toLowerCase() })
    .toArray();

  const closedPositionsCount = closedPositionDocs.length;
  const closedPositionWins = closedPositionDocs.filter((p: any) => p.isWin === true).length;
  const closedPositionLosses = closedPositionDocs.filter((p: any) => p.isWin === false).length;

  // Calculate POSITION-BASED win rate (open profitable + closed wins) / (total positions)
  const positionWins = profitablePositionsCount + closedPositionWins;
  const positionLosses = losingOpenPositions.length + closedPositionLosses;
  const totalPositions = positionWins + positionLosses;
  const positionWinRate = totalPositions > 0 ? positionWins / totalPositions : 0;

  // Calculate PROFIT FACTOR from fills (grossProfit / grossLoss)
  const allFills = await fills
    .find({ walletAddress: walletAddress.toLowerCase() })
    .toArray();

  const closingTrades = allFills.filter(
    (f: any) => f.closedPnl && parseFloat(f.closedPnl) !== 0
  );

  const grossProfit = closingTrades
    .filter((t: any) => parseFloat(t.closedPnl) > 0)
    .reduce((sum: number, t: any) => sum + parseFloat(t.closedPnl), 0);

  const grossLoss = Math.abs(
    closingTrades
      .filter((t: any) => parseFloat(t.closedPnl) < 0)
      .reduce((sum: number, t: any) => sum + parseFloat(t.closedPnl), 0)
  );

  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  console.log(
    `[Metrics] Open: ${openPositionsCount} (${profitablePositionsCount}W/${losingOpenPositions.length}L), Closed: ${closedPositionsCount} (${closedPositionWins}W/${closedPositionLosses}L)`
  );
  console.log(
    `[Metrics] Position Win Rate: ${(positionWinRate * 100).toFixed(1)}% (${positionWins}/${totalPositions}), Profit Factor: ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}`
  );

  // Calculate Sharpe ratio from snapshots
  const sharpeRatio = await calculateSharpeRatio(walletAddress);

  // Calculate max drawdown from snapshots
  const maxDrawdown = await calculateMaxDrawdown(walletAddress);

  // Leverage calc (currentPositions already fetched above)
  const avgLeverage =
    currentPositions.length > 0
      ? currentPositions.reduce((s: number, p: any) => s + (p.leverage?.value || 0), 0) /
        currentPositions.length
      : 0;
  const maxLeverageUsed =
    currentPositions.length > 0
      ? Math.max(...currentPositions.map((p: any) => p.leverage?.value || 0))
      : 0;

  // Save metrics
  await metrics.updateOne(
    { walletAddress: walletAddress.toLowerCase() },
    {
      $set: {
        walletAddress: walletAddress.toLowerCase(),
        accountValue,
        totalMarginUsed: marginSummary.totalMarginUsed,
        totalNtlPos: marginSummary.totalNtlPos,
        withdrawable: '0',

        pnl_1d,
        pnl_7d,
        pnl_30d,
        pnl_allTime,
        volume_24h,

        // Position-based win rate
        positionWinRate,
        positionWins,
        positionLosses,
        totalPositions,

        // Profit factor
        profitFactor: profitFactor === Infinity ? 999 : profitFactor,
        grossProfit,
        grossLoss,

        // Open position stats
        openPositionsCount,
        profitablePositionsCount,
        unrealizedPnlTotal,

        // Closed position stats
        closedPositionsCount,
        closedPositionWins,
        closedPositionLosses,

        // Risk metrics
        sharpeRatio,
        maxDrawdown,
        avgLeverage,
        maxLeverageUsed,

        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  console.log(
    `[Metrics] Saved - Position WR: ${(positionWinRate * 100).toFixed(1)}%, PF: ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}, Sharpe: ${sharpeRatio.toFixed(2)}`
  );
}

/**
 * Calculate Sharpe ratio from PnL snapshots
 */
async function calculateSharpeRatio(walletAddress: string): Promise<number> {
  const { pnlSnapshots } = await getCollections();

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const snapshots = await pnlSnapshots
    .find({
      walletAddress: walletAddress.toLowerCase(),
      timestamp: { $gte: thirtyDaysAgo },
    })
    .sort({ timestamp: 1 })
    .toArray();

  if (snapshots.length < 2) {
    return 0;
  }

  // Calculate returns between snapshots
  const returns: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prevPnl = snapshots[i - 1].pnl_allTime;
    const currPnl = snapshots[i].pnl_allTime;
    const pnlChange = currPnl - prevPnl;

    const prevAccountValue = parseFloat(snapshots[i - 1].accountValue);
    if (prevAccountValue > 0) {
      const returnPct = pnlChange / prevAccountValue;
      returns.push(returnPct);
    }
  }

  if (returns.length === 0) {
    return 0;
  }

  // Calculate mean and std dev
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Sharpe ratio (annualized)
  const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(105120) : 0;

  return sharpe;
}

/**
 * Calculate max drawdown from PnL snapshots
 */
async function calculateMaxDrawdown(walletAddress: string): Promise<number> {
  const { pnlSnapshots } = await getCollections();

  const snapshots = await pnlSnapshots
    .find({ walletAddress: walletAddress.toLowerCase() })
    .sort({ timestamp: 1 })
    .toArray();

  if (snapshots.length < 2) {
    return 0;
  }

  let peak = snapshots[0].pnl_allTime;
  let maxDrawdown = 0;

  for (const snapshot of snapshots) {
    const currentPnl = snapshot.pnl_allTime;
    peak = Math.max(peak, currentPnl);

    if (peak > 0) {
      const drawdown = (peak - currentPnl) / peak;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }
  }

  return maxDrawdown;
}

/**
 * Save basic metrics when no fills are available
 */
async function saveBasicMetrics(
  walletAddress: string,
  data: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
    pnl_1d: number;
    pnl_7d: number;
    pnl_30d: number;
    pnl_allTime: number;
    volume_24h: string;
  }
) {
  const { metrics } = await getCollections();

  await metrics.updateOne(
    { walletAddress: walletAddress.toLowerCase() },
    {
      $set: {
        walletAddress: walletAddress.toLowerCase(),
        accountValue: data.accountValue,
        totalMarginUsed: data.totalMarginUsed,
        totalNtlPos: data.totalNtlPos,
        withdrawable: '0',
        pnl_1d: data.pnl_1d,
        pnl_7d: data.pnl_7d,
        pnl_30d: data.pnl_30d,
        pnl_allTime: data.pnl_allTime,
        volume_24h: data.volume_24h,

        // Position-based win rate
        positionWinRate: 0,
        positionWins: 0,
        positionLosses: 0,
        totalPositions: 0,

        // Profit factor
        profitFactor: 0,
        grossProfit: 0,
        grossLoss: 0,

        // Open position stats
        openPositionsCount: 0,
        profitablePositionsCount: 0,
        unrealizedPnlTotal: 0,

        // Closed position stats
        closedPositionsCount: 0,
        closedPositionWins: 0,
        closedPositionLosses: 0,

        // Risk metrics
        sharpeRatio: 0,
        maxDrawdown: 0,
        avgLeverage: 0,
        maxLeverageUsed: 0,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}
