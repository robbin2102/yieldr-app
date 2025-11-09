/**
 * Test Hyperliquid metrics for a specific wallet
 * Usage: npm run test:single-wallet
 */

import clientPromise from '@/lib/mongodb';

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';
const TEST_WALLET = '0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36';

interface MetricsData {
  // Headline Metrics
  aum: number;
  totalPnL: number;
  roiPercent: number;
  winRate30d: number;

  // Performance Metrics
  pnl24h: number;
  pnl7d: number;
  pnl30d: number;
  pnlAllTime: number;
  roi24h: number;
  roi7d: number;
  roi30d: number;
  roiAllTime: number;

  // Trading Metrics
  totalTrades: number;
  totalTradesAllTime: number;
  winTrades30d: number;
  lossTrades30d: number;
  winRate: number;
  largestWin: number;
  largestWinAsset: string | null;
  largestLoss: number;
  largestLossAsset: string | null;

  // Position Metrics
  avgPositionSize: number;
  openPositionsCount: number;
  totalOpenPositionValue: number;

  // Consistency Metrics
  longestWinStreak: number;
  longestLossStreak: number;
  currentStreak: { type: 'win' | 'loss' | 'none'; count: number };
  dailyWinRate: number;
  profitableDays: number;
  unprofitableDays: number;
  breakEvenDays: number;
  activeDays: number;

  // Risk Metrics
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  volatility: number;
}

async function fetchUserFills(walletAddress: string, days: number = 30): Promise<any[]> {
  const now = Date.now();
  const startTime = now - (days * 24 * 60 * 60 * 1000);

  console.log(`   Fetching fills from ${new Date(startTime).toISOString()} to ${new Date(now).toISOString()}...`);

  const response = await fetch(HYPERLIQUID_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'userFillsByTime',
      user: walletAddress,
      startTime,
      endTime: now,
      aggregateByTime: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const fills = await response.json();
  const closingFills = fills.filter((f: any) => parseFloat(f.closedPnl || '0') !== 0);
  console.log(`   ✓ Fetched ${fills.length} fills (${closingFills.length} with PnL)\n`);
  return closingFills;
}

async function fetchPortfolio(walletAddress: string): Promise<any> {
  console.log(`   Fetching portfolio data...`);

  const response = await fetch(HYPERLIQUID_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'portfolio',
      user: walletAddress,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  console.log(`   ✓ Fetched portfolio data\n`);
  return data;
}

async function fetchOpenPositions(walletAddress: string): Promise<any[]> {
  console.log(`   Fetching open positions...`);

  const response = await fetch(HYPERLIQUID_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'clearinghouseState',
      user: walletAddress,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const positions = data.assetPositions || [];
  console.log(`   ✓ Fetched ${positions.length} open positions\n`);
  return positions;
}

function computeMetrics(
  fills30d: any[],
  fillsAllTime: any[],
  portfolioData: any,
  openPositions: any[]
): MetricsData {
  console.log('Computing metrics...\n');

  // Parse portfolio data
  const dayData = portfolioData.find((p: any) => p[0] === 'day')?.[1];
  const weekData = portfolioData.find((p: any) => p[0] === 'week')?.[1];
  const monthData = portfolioData.find((p: any) => p[0] === 'month')?.[1];
  const allTimeData = portfolioData.find((p: any) => p[0] === 'allTime')?.[1];

  // Account value (AUM)
  const aum = dayData?.accountValueHistory?.length > 0
    ? parseFloat(dayData.accountValueHistory[dayData.accountValueHistory.length - 1][1])
    : 0;

  // PnL from portfolio API
  const pnl24h = dayData?.pnlHistory?.length > 0
    ? parseFloat(dayData.pnlHistory[dayData.pnlHistory.length - 1][1]) - parseFloat(dayData.pnlHistory[0][1])
    : 0;

  const pnl7d = weekData?.pnlHistory?.length > 0
    ? parseFloat(weekData.pnlHistory[weekData.pnlHistory.length - 1][1]) - parseFloat(weekData.pnlHistory[0][1])
    : 0;

  const pnl30d = monthData?.pnlHistory?.length > 0
    ? parseFloat(monthData.pnlHistory[monthData.pnlHistory.length - 1][1]) - parseFloat(monthData.pnlHistory[0][1])
    : 0;

  const pnlAllTime = allTimeData?.pnlHistory?.length > 0
    ? parseFloat(allTimeData.pnlHistory[allTimeData.pnlHistory.length - 1][1])
    : 0;

  // ROI calculations (using account value as base)
  const initialValue = aum - pnlAllTime;
  const roi24h = initialValue > 0 ? (pnl24h / initialValue) * 100 : 0;
  const roi7d = initialValue > 0 ? (pnl7d / initialValue) * 100 : 0;
  const roi30d = initialValue > 0 ? (pnl30d / initialValue) * 100 : 0;
  const roiAllTime = initialValue > 0 ? (pnlAllTime / initialValue) * 100 : 0;

  // Trading metrics from fills
  let winTrades30d = 0;
  let lossTrades30d = 0;
  let largestWin = 0;
  let largestWinAsset: string | null = null;
  let largestLoss = 0;
  let largestLossAsset: string | null = null;

  for (const fill of fills30d) {
    const pnl = parseFloat(fill.closedPnl || '0');
    if (pnl > 0) {
      winTrades30d++;
      if (pnl > largestWin) {
        largestWin = pnl;
        largestWinAsset = fill.coin;
      }
    } else if (pnl < 0) {
      lossTrades30d++;
      if (pnl < largestLoss) {
        largestLoss = pnl;
        largestLossAsset = fill.coin;
      }
    }
  }

  const totalTrades = winTrades30d + lossTrades30d;
  const winRate = totalTrades > 0 ? (winTrades30d / totalTrades) * 100 : 0;

  // Daily performance for streaks
  const dailyPnl = new Map<string, number>();
  for (const fill of fillsAllTime) {
    const date = new Date(fill.time).toISOString().split('T')[0];
    const pnl = parseFloat(fill.closedPnl || '0');
    dailyPnl.set(date, (dailyPnl.get(date) || 0) + pnl);
  }

  const sortedDays = Array.from(dailyPnl.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let currentWinStreak = 0;
  let currentLossStreak = 0;
  let profitableDays = 0;
  let unprofitableDays = 0;
  let breakEvenDays = 0;

  for (const [date, pnl] of sortedDays) {
    if (pnl > 0) {
      profitableDays++;
      currentWinStreak++;
      currentLossStreak = 0;
      longestWinStreak = Math.max(longestWinStreak, currentWinStreak);
    } else if (pnl < 0) {
      unprofitableDays++;
      currentLossStreak++;
      currentWinStreak = 0;
      longestLossStreak = Math.max(longestLossStreak, currentLossStreak);
    } else {
      breakEvenDays++;
      currentWinStreak = 0;
      currentLossStreak = 0;
    }
  }

  // Current streak
  const lastDayPnl = sortedDays.length > 0 ? sortedDays[sortedDays.length - 1][1] : 0;
  const currentStreak = {
    type: (lastDayPnl > 0 ? 'win' : lastDayPnl < 0 ? 'loss' : 'none') as 'win' | 'loss' | 'none',
    count: lastDayPnl > 0 ? currentWinStreak : lastDayPnl < 0 ? currentLossStreak : 0,
  };

  const activeDays = profitableDays + unprofitableDays + breakEvenDays;
  const dailyWinRate = activeDays > 0 ? (profitableDays / activeDays) * 100 : 0;

  // Open positions metrics
  const openPositionsCount = openPositions.length;
  let totalOpenPositionValue = 0;
  for (const pos of openPositions) {
    const positionValue = Math.abs(parseFloat(pos.position?.szi || '0')) * parseFloat(pos.position?.entryPx || '0');
    totalOpenPositionValue += positionValue;
  }
  const avgPositionSize = openPositionsCount > 0 ? totalOpenPositionValue / openPositionsCount : 0;

  // Risk metrics (simplified for now)
  const returns = sortedDays.map(d => d[1]);
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 0
    ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    : 0;
  const volatility = Math.sqrt(variance);
  const sharpeRatio = volatility > 0 ? (avgReturn / volatility) * Math.sqrt(252) : 0;

  const downsideReturns = returns.filter(r => r < 0);
  const downsideVariance = downsideReturns.length > 0
    ? downsideReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / downsideReturns.length
    : 0;
  const downsideDeviation = Math.sqrt(downsideVariance);
  const sortinoRatio = downsideDeviation > 0 ? (avgReturn / downsideDeviation) * Math.sqrt(252) : 0;

  // Max drawdown
  let peak = 0;
  let maxDrawdown = 0;
  let runningValue = initialValue;
  for (const pnl of returns) {
    runningValue += pnl;
    peak = Math.max(peak, runningValue);
    const drawdown = peak > 0 ? ((peak - runningValue) / peak) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return {
    aum,
    totalPnL: pnlAllTime,
    roiPercent: roiAllTime,
    winRate30d: winRate,
    pnl24h,
    pnl7d,
    pnl30d,
    pnlAllTime,
    roi24h,
    roi7d,
    roi30d,
    roiAllTime,
    totalTrades,
    totalTradesAllTime: fillsAllTime.length,
    winTrades30d,
    lossTrades30d,
    winRate,
    largestWin,
    largestWinAsset,
    largestLoss,
    largestLossAsset,
    avgPositionSize,
    openPositionsCount,
    totalOpenPositionValue,
    longestWinStreak,
    longestLossStreak,
    currentStreak,
    dailyWinRate,
    profitableDays,
    unprofitableDays,
    breakEvenDays,
    activeDays,
    sharpeRatio,
    sortinoRatio,
    maxDrawdown,
    volatility,
  };
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Single Wallet Hyperliquid Metrics Test                   ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  console.log(`Testing wallet: ${TEST_WALLET}\n`);

  try {
    // Fetch all data
    const [fills30d, fillsAllTime, portfolioData, openPositions] = await Promise.all([
      fetchUserFills(TEST_WALLET, 30),
      fetchUserFills(TEST_WALLET, 90),
      fetchPortfolio(TEST_WALLET),
      fetchOpenPositions(TEST_WALLET),
    ]);

    // Compute metrics
    const metrics = computeMetrics(fills30d, fillsAllTime, portfolioData, openPositions);

    // Display results
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  📈 HEADLINE METRICS                                       ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`   AUM:              $${metrics.aum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    console.log(`   Total PnL:        $${metrics.totalPnL.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    console.log(`   ROI (All Time):   ${metrics.roiPercent.toFixed(2)}%`);
    console.log(`   Win Rate (30d):   ${metrics.winRate30d.toFixed(1)}%`);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  💰 PERFORMANCE METRICS                                    ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`   PnL (24h):        $${metrics.pnl24h.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${metrics.roi24h.toFixed(2)}%)`);
    console.log(`   PnL (7d):         $${metrics.pnl7d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${metrics.roi7d.toFixed(2)}%)`);
    console.log(`   PnL (30d):        $${metrics.pnl30d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${metrics.roi30d.toFixed(2)}%)`);
    console.log(`   PnL (All Time):   $${metrics.pnlAllTime.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${metrics.roiAllTime.toFixed(2)}%)`);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  📊 TRADING METRICS                                        ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`   Total Trades (30d):     ${metrics.totalTrades}`);
    console.log(`   Total Trades (All):     ${metrics.totalTradesAllTime}`);
    console.log(`   Win Trades:             ${metrics.winTrades30d} (${metrics.winRate.toFixed(1)}%)`);
    console.log(`   Loss Trades:            ${metrics.lossTrades30d} (${(100 - metrics.winRate).toFixed(1)}%)`);
    console.log(`   Largest Win:            $${metrics.largestWin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${metrics.largestWinAsset || 'N/A'})`);
    console.log(`   Largest Loss:           $${metrics.largestLoss.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${metrics.largestLossAsset || 'N/A'})`);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  📍 POSITION METRICS                                       ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`   Open Positions:         ${metrics.openPositionsCount}`);
    console.log(`   Total Position Value:   $${metrics.totalOpenPositionValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    console.log(`   Avg Position Size:      $${metrics.avgPositionSize.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  🎯 CONSISTENCY METRICS                                    ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`   Longest Win Streak:     ${metrics.longestWinStreak} days`);
    console.log(`   Longest Loss Streak:    ${metrics.longestLossStreak} days`);
    console.log(`   Current Streak:         ${metrics.currentStreak.count} ${metrics.currentStreak.type} days`);
    console.log(`   Daily Win Rate:         ${metrics.dailyWinRate.toFixed(1)}%`);
    console.log(`   Profitable Days:        ${metrics.profitableDays}`);
    console.log(`   Unprofitable Days:      ${metrics.unprofitableDays}`);
    console.log(`   Break Even Days:        ${metrics.breakEvenDays}`);
    console.log(`   Active Days:            ${metrics.activeDays}`);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  ⚠️  RISK METRICS                                          ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`   Sharpe Ratio:           ${metrics.sharpeRatio.toFixed(2)}`);
    console.log(`   Sortino Ratio:          ${metrics.sortinoRatio.toFixed(2)}`);
    console.log(`   Max Drawdown:           ${metrics.maxDrawdown.toFixed(2)}%`);
    console.log(`   Volatility:             $${metrics.volatility.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  ✅ Test Complete                                          ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main().catch(console.error);
