/**
 * Metrics Computation Service
 * Computes trader performance metrics
 */

import PolymarketOpenPosition from '../../../models/PolymarketOpenPosition';
import PolymarketClosedPosition from '../../../models/PolymarketClosedPosition';
import PolymarketMetrics from '../../../models/PolymarketMetrics';
import { createLogger } from '../utils/logger';
import type { TraderMetrics } from '../types/polymarket';

const logger = createLogger('Metrics');

/**
 * Compute comprehensive trader metrics
 */
export async function computeMetrics(walletAddress: string): Promise<TraderMetrics> {
  logger.info(`Computing metrics for ${walletAddress}`);

  // Fetch all open positions
  const openPositions = await PolymarketOpenPosition.find({
    walletAddress: walletAddress.toLowerCase(),
  }).lean();

  // Fetch all closed positions (last 30 days)
  const allClosedPositions = await PolymarketClosedPosition.find({
    walletAddress: walletAddress.toLowerCase(),
  })
    .sort({ closedAt: -1 })
    .lean();

  // Split open positions into active vs redeemable
  // Redeemable positions are markets that resolved but haven't been redeemed yet
  // They should be treated as "closed" for PnL purposes
  const activeOpenPositions = openPositions.filter((p) => !p.redeemable);
  const redeemablePositions = openPositions.filter((p) => p.redeemable);

  // Time-based filters
  const now = Date.now();
  const day1Ago = new Date(now - 1 * 24 * 60 * 60 * 1000);
  const day7Ago = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const day30Ago = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const closedPositions1d = allClosedPositions.filter((p) => p.closedAt >= day1Ago);
  const closedPositions7d = allClosedPositions.filter((p) => p.closedAt >= day7Ago);
  const closedPositions30d = allClosedPositions.filter((p) => p.closedAt >= day30Ago);

  // === ACTIVE OPEN POSITIONS ===
  const currentPositionValue = activeOpenPositions.reduce((sum, p) => sum + p.currentValue, 0);
  const initialInvestment = activeOpenPositions.reduce((sum, p) => sum + p.initialValue, 0);
  const totalUnrealizedPnl = activeOpenPositions.reduce((sum, p) => sum + p.cashPnl, 0);

  // === REDEEMABLE POSITIONS (treat as realized) ===
  const redeemablePnl = redeemablePositions.reduce((sum, p) => sum + p.cashPnl, 0);
  const redeemableInvested = redeemablePositions.reduce((sum, p) => sum + p.initialValue, 0);

  // === CLOSED POSITIONS (ALL) ===
  const closedRealizedPnl = allClosedPositions.reduce(
    (sum, p) => sum + p.realizedPnl,
    0
  );
  const closedInvested = allClosedPositions.reduce(
    (sum, p) => sum + p.totalBet,
    0
  );

  // Total realized PnL includes both closed positions and redeemable positions
  const totalRealizedPnl = closedRealizedPnl + redeemablePnl;

  const wins = allClosedPositions.filter((p) => p.won).length + redeemablePositions.filter((p) => p.cashPnl > 0).length;
  const losses = allClosedPositions.filter((p) => !p.won).length + redeemablePositions.filter((p) => p.cashPnl <= 0).length;

  // === TIME-BASED PnL ===
  const pnl1d = closedPositions1d.reduce((sum, p) => sum + p.realizedPnl, 0);
  const pnl7d = closedPositions7d.reduce((sum, p) => sum + p.realizedPnl, 0);
  const pnl30d = closedPositions30d.reduce((sum, p) => sum + p.realizedPnl, 0);

  const invested1d = closedPositions1d.reduce((sum, p) => sum + p.totalBet, 0);
  const invested7d = closedPositions7d.reduce((sum, p) => sum + p.totalBet, 0);
  const invested30d = closedPositions30d.reduce((sum, p) => sum + p.totalBet, 0);

  const roi1d = invested1d > 0 ? (pnl1d / invested1d) * 100 : 0;
  const roi7d = invested7d > 0 ? (pnl7d / invested7d) * 100 : 0;
  const roi30d = invested30d > 0 ? (pnl30d / invested30d) * 100 : 0;

  // === COMBINED ===
  const totalPnl = totalUnrealizedPnl + totalRealizedPnl;
  const totalInvested = initialInvestment + closedInvested + redeemableInvested;
  const overallRoi = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

  // === SHARPE RATIO ===
  // Include redeemable positions in Sharpe calculation
  const allRealizedPositions = [
    ...allClosedPositions.map(p => ({ realizedPnl: p.realizedPnl, totalBet: p.totalBet })),
    ...redeemablePositions.map(p => ({ realizedPnl: p.cashPnl, totalBet: p.initialValue }))
  ];
  const sharpeRatio = computeSharpeRatio(allRealizedPositions);

  const totalClosedAndRedeemableCount = allClosedPositions.length + redeemablePositions.length;

  const metrics: TraderMetrics = {
    // Open positions (only active, not redeemable)
    openPositionsCount: activeOpenPositions.length,
    currentPositionValue,
    initialInvestment,
    totalUnrealizedPnl,

    // Closed positions (includes redeemable)
    closedPositionsCount: totalClosedAndRedeemableCount,
    closedInvestment: closedInvested + redeemableInvested,
    totalRealizedPnl,
    wins,
    losses,
    winRate: totalClosedAndRedeemableCount > 0
      ? (wins / totalClosedAndRedeemableCount) * 100
      : 0,

    // Combined
    totalPnl,
    totalInvested,
    overallRoi,

    // Time-based
    pnl1d,
    pnl7d,
    pnl30d,
    roi1d,
    roi7d,
    roi30d,

    // Risk metrics
    sharpeRatio,
  };

  logger.success('Metrics computed successfully');

  return metrics;
}

/**
 * Compute Sharpe Ratio
 * Measures risk-adjusted returns
 */
function computeSharpeRatio(
  closedPositions: Array<{ realizedPnl: number; totalBet: number }>
): number {
  if (closedPositions.length === 0) {
    return 0;
  }

  // Calculate returns for each position
  const returns = closedPositions.map((p) => {
    return p.totalBet > 0 ? p.realizedPnl / p.totalBet : 0;
  });

  // Calculate average return
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

  // Calculate standard deviation
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
    returns.length;

  const stdDev = Math.sqrt(variance);

  // Sharpe ratio (assuming risk-free rate = 0 for simplicity)
  const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

  return sharpeRatio;
}

/**
 * Save metrics to MongoDB
 */
export async function saveMetrics(
  walletAddress: string,
  metrics: TraderMetrics
): Promise<void> {
  try {
    await PolymarketMetrics.create({
      walletAddress: walletAddress.toLowerCase(),
      ...metrics,
    });
    logger.debug('Metrics saved to MongoDB');
  } catch (error: any) {
    logger.error(`Failed to save metrics: ${error.message}`);
  }
}

/**
 * Display metrics in console
 */
export function displayMetrics(metrics: TraderMetrics): void {
  console.log('\n' + '='.repeat(80));
  console.log('TRADER PERFORMANCE METRICS');
  console.log('='.repeat(80));

  console.log('\n📊 POSITIONS:');
  console.log(`   Open Positions: ${metrics.openPositionsCount}`);
  console.log(`   Closed Positions: ${metrics.closedPositionsCount}`);
  console.log(`   Win Rate: ${metrics.winRate.toFixed(1)}% (${metrics.wins}W / ${metrics.losses}L)`);

  console.log('\n💼 POSITION VALUE:');
  console.log(`   Current Position Value: $${metrics.currentPositionValue.toFixed(2)}`);
  console.log(`   Initial Investment:     $${metrics.initialInvestment.toFixed(2)}`);
  console.log(`   Closed Investment:      $${metrics.closedInvestment.toFixed(2)}`);
  console.log(`   ─────────────────────────────────────────────`);
  console.log(`   Total Invested:         $${metrics.totalInvested.toFixed(2)}`);

  console.log('\n💰 PnL:');
  console.log(`   Unrealized PnL: $${metrics.totalUnrealizedPnl.toFixed(2)}`);
  console.log(`   Realized PnL:   $${metrics.totalRealizedPnl.toFixed(2)}`);
  console.log(`   Total PnL:      $${metrics.totalPnl.toFixed(2)}`);

  console.log('\n📈 TIME-BASED PERFORMANCE:');
  console.log(`   1d  PnL: $${metrics.pnl1d.toFixed(2)}  |  ROI: ${metrics.roi1d.toFixed(2)}%`);
  console.log(`   7d  PnL: $${metrics.pnl7d.toFixed(2)}  |  ROI: ${metrics.roi7d.toFixed(2)}%`);
  console.log(`   30d PnL: $${metrics.pnl30d.toFixed(2)}  |  ROI: ${metrics.roi30d.toFixed(2)}%`);

  console.log('\n🎯 OVERALL:');
  console.log(`   Overall ROI:    ${metrics.overallRoi.toFixed(2)}%`);
  console.log(`   Sharpe Ratio:   ${metrics.sharpeRatio.toFixed(3)}`);

  console.log('\n' + '='.repeat(80) + '\n');
}
