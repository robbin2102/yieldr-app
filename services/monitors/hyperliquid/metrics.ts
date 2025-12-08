/**
 * Hyperliquid Metrics Computation
 */

import HyperliquidFill from '@/models/HyperliquidFill';
import HyperliquidPosition from '@/models/HyperliquidPosition';
import HyperliquidMetrics from '@/models/HyperliquidMetrics';

interface MarginSummary {
  accountValue: string;
  totalMarginUsed: string;
  totalNtlPos: string;
  totalRawUsd: string;
}

/**
 * Compute comprehensive metrics from fills and positions
 */
export async function computeMetrics(
  walletAddress: string,
  marginSummary: MarginSummary
) {
  // Fetch all fills
  const allFills = await HyperliquidFill.find({ walletAddress }).sort({ time: 1 });

  if (allFills.length === 0) {
    // No trades yet, save empty metrics
    await saveEmptyMetrics(walletAddress, marginSummary);
    return;
  }

  // Calculate time-based PnL by summing closedPnl
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const pnl_1d = allFills
    .filter(f => f.time >= oneDayAgo && f.closedPnl && f.closedPnl !== '0.0')
    .reduce((sum, f) => sum + parseFloat(f.closedPnl), 0);

  const pnl_7d = allFills
    .filter(f => f.time >= sevenDaysAgo && f.closedPnl && f.closedPnl !== '0.0')
    .reduce((sum, f) => sum + parseFloat(f.closedPnl), 0);

  const pnl_30d = allFills
    .filter(f => f.time >= thirtyDaysAgo && f.closedPnl && f.closedPnl !== '0.0')
    .reduce((sum, f) => sum + parseFloat(f.closedPnl), 0);

  const pnl_allTime = allFills
    .filter(f => f.closedPnl && f.closedPnl !== '0.0')
    .reduce((sum, f) => sum + parseFloat(f.closedPnl), 0);

  // Group fills by closing trades (closedPnl != 0)
  const closedTrades = allFills.filter(
    f => f.closedPnl && parseFloat(f.closedPnl) !== 0
  );

  const wins = closedTrades.filter(t => parseFloat(t.closedPnl) > 0);
  const losses = closedTrades.filter(t => parseFloat(t.closedPnl) < 0);

  // Current positions for leverage calc
  const currentPositions = await HyperliquidPosition.find({ walletAddress });

  // Per-asset breakdown
  const byAssetMap: Record<string, any> = {};

  closedTrades.forEach(trade => {
    if (!byAssetMap[trade.coin]) {
      byAssetMap[trade.coin] = { fills: [], wins: [], losses: [] };
    }
    byAssetMap[trade.coin].fills.push(trade);

    if (parseFloat(trade.closedPnl) > 0) {
      byAssetMap[trade.coin].wins.push(trade);
    } else {
      byAssetMap[trade.coin].losses.push(trade);
    }
  });

  const assetMetrics = Object.entries(byAssetMap).map(([coin, data]: [string, any]) => ({
    coin,
    trades: data.fills.length,
    winRate: data.fills.length > 0 ? data.wins.length / data.fills.length : 0,
    bestWin: data.wins.length > 0
      ? Math.max(...data.wins.map((t: any) => parseFloat(t.closedPnl)))
      : 0,
    worstLoss: data.losses.length > 0
      ? Math.min(...data.losses.map((t: any) => parseFloat(t.closedPnl)))
      : 0,
    totalPnl: data.fills.reduce((s: number, t: any) => s + parseFloat(t.closedPnl), 0)
  }));

  // Sharpe ratio (simplified: returns per trade)
  const returns = closedTrades.map(t => parseFloat(t.closedPnl));
  const avgReturn = returns.length > 0
    ? returns.reduce((a, b) => a + b, 0) / returns.length
    : 0;
  const variance = returns.length > 0
    ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

  // Max drawdown
  let peak = 0;
  let maxDrawdown = 0;
  let cumPnl = 0;

  allFills.forEach(fill => {
    if (fill.closedPnl) {
      cumPnl += parseFloat(fill.closedPnl);
      peak = Math.max(peak, cumPnl);
      if (peak > 0) {
        const drawdown = (peak - cumPnl) / peak;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
      }
    }
  });

  // Save metrics
  await HyperliquidMetrics.findOneAndUpdate(
    { walletAddress },
    {
      walletAddress,
      accountValue: marginSummary.accountValue,
      totalMarginUsed: marginSummary.totalMarginUsed,
      totalNtlPos: marginSummary.totalNtlPos,
      withdrawable: '0', // Not provided in marginSummary

      pnl_1d,
      pnl_7d,
      pnl_30d,
      pnl_allTime,

      totalTrades: closedTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closedTrades.length > 0 ? wins.length / closedTrades.length : 0,
      avgWin: wins.length > 0
        ? wins.reduce((s, t) => s + parseFloat(t.closedPnl), 0) / wins.length
        : 0,
      avgLoss: losses.length > 0
        ? losses.reduce((s, t) => s + parseFloat(t.closedPnl), 0) / losses.length
        : 0,
      bestTrade: wins.length > 0
        ? Math.max(...wins.map(t => parseFloat(t.closedPnl)))
        : 0,
      worstTrade: losses.length > 0
        ? Math.min(...losses.map(t => parseFloat(t.closedPnl)))
        : 0,

      sharpeRatio,
      maxDrawdown,
      avgLeverage: currentPositions.length > 0
        ? currentPositions.reduce((s, p) => s + p.leverage.value, 0) / currentPositions.length
        : 0,
      maxLeverageUsed: currentPositions.length > 0
        ? Math.max(...currentPositions.map(p => p.leverage.value))
        : 0,

      byAsset: assetMetrics,
      updatedAt: new Date()
    },
    { upsert: true, new: true }
  );

  console.log(`✓ Metrics computed for ${walletAddress}`);
}

/**
 * Save empty metrics for wallets with no trades
 */
async function saveEmptyMetrics(walletAddress: string, marginSummary: MarginSummary) {
  await HyperliquidMetrics.findOneAndUpdate(
    { walletAddress },
    {
      walletAddress,
      accountValue: marginSummary.accountValue,
      totalMarginUsed: marginSummary.totalMarginUsed,
      totalNtlPos: marginSummary.totalNtlPos,
      withdrawable: '0',
      pnl_1d: 0,
      pnl_7d: 0,
      pnl_30d: 0,
      pnl_allTime: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      bestTrade: 0,
      worstTrade: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      avgLeverage: 0,
      maxLeverageUsed: 0,
      byAsset: [],
      updatedAt: new Date()
    },
    { upsert: true, new: true }
  );
}
