import { OpenPosition, ClosedPosition, PolymarketMetrics } from '../types/polymarket';
import { ClosedPosition as ClosedPositionModel } from '../db/models/ClosedPosition';
import { Metrics as MetricsModel } from '../db/models/Metrics';
import { createLogger } from '../utils/logger';

const logger = createLogger('Metrics');

export async function computeMetrics(
  walletAddress: string,
  openPositions: OpenPosition[],
  closedPositions: ClosedPosition[]
): Promise<PolymarketMetrics> {
  logger.info(`Computing metrics for ${walletAddress}...`);

  // Open positions metrics
  const totalUnrealizedPnl = openPositions.reduce((sum, p) => sum + p.cashPnl, 0);
  const openInvested = openPositions.reduce((sum, p) => sum + p.initialValue, 0);

  // Closed positions metrics
  const totalRealizedPnl = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
  const closedInvested = closedPositions.reduce((sum, p) => sum + p.totalBet, 0);
  const wins = closedPositions.filter((p) => p.realizedPnl > 0).length;
  const losses = closedPositions.filter((p) => p.realizedPnl < 0).length;

  // Combined metrics
  const totalPnl = totalUnrealizedPnl + totalRealizedPnl;
  const totalInvested = openInvested + closedInvested;
  const overallRoi = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

  // Time-based PnL
  const pnl1d = await computeTimePnl(walletAddress, 1);
  const pnl7d = await computeTimePnl(walletAddress, 7);
  const pnl30d = await computeTimePnl(walletAddress, 30);

  // Sharpe Ratio calculation
  const sharpeRatio = computeSharpeRatio(closedPositions);

  const metrics: PolymarketMetrics = {
    walletAddress: walletAddress.toLowerCase(),
    openPositionsCount: openPositions.length,
    totalUnrealizedPnl,
    closedPositionsCount: closedPositions.length,
    totalRealizedPnl,
    wins,
    losses,
    winRate: closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0,
    totalPnl,
    totalInvested,
    overallRoi,
    sharpeRatio,
    pnl1d,
    pnl7d,
    pnl30d,
    lastUpdated: new Date(),
  };

  logger.success(`Metrics computed:`, {
    totalPnl: metrics.totalPnl.toFixed(2),
    roi: metrics.overallRoi.toFixed(2) + '%',
    winRate: metrics.winRate.toFixed(1) + '%',
    sharpe: metrics.sharpeRatio.toFixed(2),
  });

  return metrics;
}

/**
 * Compute PnL for a specific time period (realized only from closed positions)
 */
async function computeTimePnl(walletAddress: string, days: number): Promise<number> {
  const cutoffTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const recentClosedPositions = await ClosedPositionModel.find({
    walletAddress: walletAddress.toLowerCase(),
    closedAt: { $gte: cutoffTime },
  }).lean();

  return recentClosedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
}

/**
 * Compute Sharpe Ratio (risk-adjusted return)
 * Formula: (Average Return - Risk-Free Rate) / Standard Deviation of Returns
 * Assumes risk-free rate = 0 for simplicity
 */
function computeSharpeRatio(closedPositions: ClosedPosition[]): number {
  if (closedPositions.length < 2) {
    return 0; // Need at least 2 positions to compute std dev
  }

  // Calculate returns for each position (ROI as decimal)
  const returns = closedPositions.map((p) => p.roi / 100);

  // Average return
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

  // Standard deviation of returns
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Sharpe ratio (annualized - assuming daily positions)
  const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

  // Annualize by multiplying by sqrt(365) for daily data
  return sharpeRatio * Math.sqrt(365);
}

/**
 * Save or update metrics in MongoDB
 */
export async function saveMetrics(metrics: PolymarketMetrics): Promise<void> {
  await MetricsModel.findOneAndUpdate(
    { walletAddress: metrics.walletAddress.toLowerCase() },
    metrics,
    { upsert: true, new: true }
  );

  logger.success(`Metrics saved for ${metrics.walletAddress}`);
}
