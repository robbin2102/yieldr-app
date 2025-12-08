/**
 * Hyperliquid Metrics Computation
 * Uses portfolio API for PnL and fills for trade statistics
 */

import HyperliquidFill from '@/models/HyperliquidFill';
import HyperliquidPosition from '@/models/HyperliquidPosition';
import HyperliquidMetrics from '@/models/HyperliquidMetrics';
import HyperliquidPnlSnapshot from '@/models/HyperliquidPnlSnapshot';
import { getPortfolio } from './api';

interface MarginSummary {
  accountValue: string;
  totalMarginUsed: string;
  totalNtlPos: string;
  totalRawUsd: string;
}

/**
 * Compute comprehensive metrics from portfolio API and fills
 */
export async function computeMetrics(
  walletAddress: string,
  marginSummary: MarginSummary
) {
  console.log(`[Metrics] 🧮 Computing metrics for ${walletAddress}...`);

  // Fetch portfolio data (PnL from API)
  const portfolio = await getPortfolio(walletAddress);

  // Extract PnL values from portfolio
  const pnl_1d = parseFloat(portfolio.day.pnlHistory[portfolio.day.pnlHistory.length - 1]?.[1] || '0');
  const pnl_7d = parseFloat(portfolio.week.pnlHistory[portfolio.week.pnlHistory.length - 1]?.[1] || '0');
  const pnl_30d = parseFloat(portfolio.month.pnlHistory[portfolio.month.pnlHistory.length - 1]?.[1] || '0');
  const pnl_allTime = parseFloat(portfolio.allTime.pnlHistory[portfolio.allTime.pnlHistory.length - 1]?.[1] || '0');
  const volume_24h = portfolio.day.vlm || '0';
  const accountValue = portfolio.day.accountValueHistory[portfolio.day.accountValueHistory.length - 1]?.[1] || marginSummary.accountValue;

  console.log(`[Metrics] 📊 PnL - 1d: $${pnl_1d}, 7d: $${pnl_7d}, 30d: $${pnl_30d}, All: $${pnl_allTime}`);

  // Save PnL snapshot for Sharpe ratio calculation
  await HyperliquidPnlSnapshot.create({
    walletAddress,
    timestamp: new Date(),
    accountValue,
    pnl_1d,
    pnl_7d,
    pnl_30d,
    pnl_allTime,
    volume_24h
  });
  console.log(`[Metrics] 💾 Saved PnL snapshot`);

  // Fetch all fills to compute trade statistics
  const allFills = await HyperliquidFill.find({ walletAddress }).sort({ time: 1 });

  if (allFills.length === 0) {
    console.log(`[Metrics] ⚠️  No fills found, saving basic metrics`);
    await saveBasicMetrics(walletAddress, {
      accountValue,
      totalMarginUsed: marginSummary.totalMarginUsed,
      totalNtlPos: marginSummary.totalNtlPos,
      pnl_1d,
      pnl_7d,
      pnl_30d,
      pnl_allTime,
      volume_24h
    });
    return;
  }

  // Filter for closing trades (trades with realized PnL)
  const closingTrades = allFills.filter(f => f.closedPnl && parseFloat(f.closedPnl) !== 0);
  const wins = closingTrades.filter(t => parseFloat(t.closedPnl) > 0);
  const losses = closingTrades.filter(t => parseFloat(t.closedPnl) < 0);

  console.log(`[Metrics] 📈 Total fills: ${allFills.length}, Closing trades: ${closingTrades.length}, Wins: ${wins.length}, Losses: ${losses.length}`);

  // Calculate win rate and trade statistics
  const winRate = closingTrades.length > 0 ? wins.length / closingTrades.length : 0;
  const avgWin = wins.length > 0
    ? wins.reduce((s, t) => s + parseFloat(t.closedPnl), 0) / wins.length
    : 0;
  const avgLoss = losses.length > 0
    ? losses.reduce((s, t) => s + parseFloat(t.closedPnl), 0) / losses.length
    : 0;
  const bestTrade = wins.length > 0
    ? Math.max(...wins.map(t => parseFloat(t.closedPnl)))
    : 0;
  const worstTrade = losses.length > 0
    ? Math.min(...losses.map(t => parseFloat(t.closedPnl)))
    : 0;

  // Calculate Sharpe ratio from snapshots
  const sharpeRatio = await calculateSharpeRatio(walletAddress);

  // Calculate max drawdown from snapshots
  const maxDrawdown = await calculateMaxDrawdown(walletAddress);

  // Get current positions for leverage calc
  const currentPositions = await HyperliquidPosition.find({ walletAddress });
  const avgLeverage = currentPositions.length > 0
    ? currentPositions.reduce((s, p) => s + p.leverage.value, 0) / currentPositions.length
    : 0;
  const maxLeverageUsed = currentPositions.length > 0
    ? Math.max(...currentPositions.map(p => p.leverage.value))
    : 0;

  // Save metrics
  await HyperliquidMetrics.findOneAndUpdate(
    { walletAddress },
    {
      walletAddress,
      accountValue,
      totalMarginUsed: marginSummary.totalMarginUsed,
      totalNtlPos: marginSummary.totalNtlPos,
      withdrawable: '0',

      pnl_1d,
      pnl_7d,
      pnl_30d,
      pnl_allTime,
      volume_24h,

      totalTrades: closingTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate,
      avgWin,
      avgLoss,
      bestTrade,
      worstTrade,

      sharpeRatio,
      maxDrawdown,
      avgLeverage,
      maxLeverageUsed,

      byAsset: [], // Not computing per-asset for now
      updatedAt: new Date()
    },
    { upsert: true, new: true }
  );

  console.log(`[Metrics] ✅ Metrics saved - Win rate: ${(winRate * 100).toFixed(2)}%, Sharpe: ${sharpeRatio.toFixed(2)}, Max DD: ${(maxDrawdown * 100).toFixed(2)}%`);
}

/**
 * Calculate Sharpe ratio from PnL snapshots
 * Sharpe = (mean return) / (std dev of returns)
 */
async function calculateSharpeRatio(walletAddress: string): Promise<number> {
  // Get last 30 days of snapshots (at 5-min intervals, ~8640 snapshots)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const snapshots = await HyperliquidPnlSnapshot.find({
    walletAddress,
    timestamp: { $gte: thirtyDaysAgo }
  }).sort({ timestamp: 1 });

  if (snapshots.length < 2) {
    return 0; // Need at least 2 snapshots to calculate returns
  }

  // Calculate returns between snapshots
  const returns: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prevPnl = snapshots[i - 1].pnl_allTime;
    const currPnl = snapshots[i].pnl_allTime;
    const pnlChange = currPnl - prevPnl;

    // Normalize by account value to get percentage return
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
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Sharpe ratio (annualized: multiply by sqrt of periods per year)
  // 5-min intervals = 288 per day, 105,120 per year
  // sqrt(105120) ≈ 324
  const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(105120) : 0;

  return sharpe;
}

/**
 * Calculate max drawdown from PnL snapshots
 */
async function calculateMaxDrawdown(walletAddress: string): Promise<number> {
  const snapshots = await HyperliquidPnlSnapshot.find({
    walletAddress
  }).sort({ timestamp: 1 });

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
  await HyperliquidMetrics.findOneAndUpdate(
    { walletAddress },
    {
      walletAddress,
      accountValue: data.accountValue,
      totalMarginUsed: data.totalMarginUsed,
      totalNtlPos: data.totalNtlPos,
      withdrawable: '0',
      pnl_1d: data.pnl_1d,
      pnl_7d: data.pnl_7d,
      pnl_30d: data.pnl_30d,
      pnl_allTime: data.pnl_allTime,
      volume_24h: data.volume_24h,
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
