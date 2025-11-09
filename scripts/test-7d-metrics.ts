/**
 * Test Hyperliquid metrics with 7-day analysis and daily segmentation
 * Usage: npm run test:7d-metrics
 */

import clientPromise from '@/lib/mongodb';

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';
const TEST_WALLET = '0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36';

interface DailyMetrics {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  volume: number;
  largestWin: number;
  largestLoss: number;
}

interface Metrics7d {
  // Headline
  aum: number;
  totalPnL: number;
  roiPercent: number;
  winRate: number;

  // Performance
  pnl7d: number;
  roi7d: number;

  // Trading
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  largestWin: number;
  largestWinAsset: string | null;
  largestLoss: number;
  largestLossAsset: string | null;

  // Daily breakdown
  dailyMetrics: DailyMetrics[];

  // Consistency
  profitableDays: number;
  unprofitableDays: number;
  longestWinStreak: number;
  longestLossStreak: number;
  dailyWinRate: number;

  // Risk
  volatility: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;

  // Position
  openPositionsCount: number;
  totalOpenPositionValue: number;
  avgPositionSize: number;
}

async function fetchUserFills7d(walletAddress: string): Promise<any[]> {
  const now = Date.now();
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

  console.log(`\n📊 Fetching fills for last 7 days...`);
  console.log(`   Start: ${new Date(sevenDaysAgo).toISOString()}`);
  console.log(`   End:   ${new Date(now).toISOString()}\n`);

  let allFills: any[] = [];
  let currentEndTime = now;
  let batchNumber = 0;
  const maxBatches = 20; // Increased for high-frequency traders

  while (batchNumber < maxBatches) {
    batchNumber++;

    console.log(`   Fetching batch ${batchNumber}...`);

    const response = await fetch(HYPERLIQUID_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'userFillsByTime',
        user: walletAddress,
        startTime: sevenDaysAgo,
        endTime: currentEndTime,
        aggregateByTime: false, // Get raw fills, not aggregated
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const fills = await response.json();

    if (!fills || fills.length === 0) {
      console.log(`   ✓ No more fills\n`);
      break;
    }

    // Filter to only fills with closedPnl
    const closingFills = fills.filter((f: any) => {
      const pnl = parseFloat(f.closedPnl || '0');
      return pnl !== 0;
    });

    console.log(`   ✓ Batch ${batchNumber}: ${fills.length} fills (${closingFills.length} closing)`);

    // Add to collection
    allFills.push(...closingFills);

    // Check if we got less than 2000 - means we got all data in this range
    if (fills.length < 2000) {
      console.log(`   ✓ Got all fills in range\n`);
      break;
    }

    // Get the oldest fill's timestamp
    const oldestFillTime = Math.min(...fills.map((f: any) => f.time));
    const oldestFillDate = new Date(oldestFillTime);
    console.log(`   → Oldest fill in batch: ${oldestFillDate.toISOString()}`);

    // If oldest fill is before our target start time, we're done
    if (oldestFillTime <= sevenDaysAgo) {
      console.log(`   ✓ Reached 7-day boundary\n`);
      break;
    }

    // Continue from before the oldest fill
    currentEndTime = oldestFillTime - 1;
    console.log(`   → Next batch will fetch up to: ${new Date(currentEndTime).toISOString()}\n`);

    // Rate limit
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  if (batchNumber >= maxBatches) {
    console.log(`   ⚠️  Warning: Hit maximum batch limit (${maxBatches})\n`);
  }

  console.log(`✅ Total fills fetched: ${allFills.length}\n`);
  return allFills;
}

async function fetchPortfolio(walletAddress: string): Promise<any> {
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

  return await response.json();
}

async function fetchOpenPositions(walletAddress: string): Promise<any[]> {
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
  return data.assetPositions || [];
}

function computeMetrics(
  fills: any[],
  portfolioData: any,
  openPositions: any[]
): Metrics7d {
  console.log('📈 Computing metrics...\n');

  // Parse portfolio data
  const weekData = portfolioData.find((p: any) => p[0] === 'week')?.[1];
  const allTimeData = portfolioData.find((p: any) => p[0] === 'allTime')?.[1];

  // Account value
  const aum = weekData?.accountValueHistory?.length > 0
    ? parseFloat(weekData.accountValueHistory[weekData.accountValueHistory.length - 1][1])
    : 0;

  // 7d PnL from portfolio API
  const pnl7d = weekData?.pnlHistory?.length > 0
    ? parseFloat(weekData.pnlHistory[weekData.pnlHistory.length - 1][1]) - parseFloat(weekData.pnlHistory[0][1])
    : 0;

  const pnlAllTime = allTimeData?.pnlHistory?.length > 0
    ? parseFloat(allTimeData.pnlHistory[allTimeData.pnlHistory.length - 1][1])
    : 0;

  // ROI calculation using initial value from all-time history
  const initialAccountValue = allTimeData?.accountValueHistory?.length > 0
    ? parseFloat(allTimeData.accountValueHistory[0][1])
    : 0;

  const initialValue = initialAccountValue > 0 ? initialAccountValue : Math.max(aum - pnlAllTime, 1000); // Use at least $1000 as baseline
  const roi7d = initialValue > 0 ? (pnl7d / initialValue) * 100 : 0;
  const roiAllTime = initialValue > 0 ? (pnlAllTime / initialValue) * 100 : 0;

  // Segment fills by day
  const dailyFills = new Map<string, any[]>();
  for (const fill of fills) {
    const date = new Date(fill.time).toISOString().split('T')[0];
    if (!dailyFills.has(date)) {
      dailyFills.set(date, []);
    }
    dailyFills.get(date)!.push(fill);
  }

  // Compute daily metrics
  const dailyMetrics: DailyMetrics[] = [];
  for (const [date, dayFills] of Array.from(dailyFills.entries()).sort()) {
    let wins = 0;
    let losses = 0;
    let pnl = 0;
    let volume = 0;
    let largestWin = 0;
    let largestLoss = 0;

    for (const fill of dayFills) {
      const fillPnl = parseFloat(fill.closedPnl || '0');
      const fillSize = parseFloat(fill.sz || '0') * parseFloat(fill.px || '0');

      pnl += fillPnl;
      volume += fillSize;

      if (fillPnl > 0) {
        wins++;
        largestWin = Math.max(largestWin, fillPnl);
      } else if (fillPnl < 0) {
        losses++;
        largestLoss = Math.min(largestLoss, fillPnl);
      }
    }

    dailyMetrics.push({
      date,
      trades: dayFills.length,
      wins,
      losses,
      pnl,
      volume,
      largestWin,
      largestLoss,
    });
  }

  // Overall trading metrics
  let totalTrades = 0;
  let winTrades = 0;
  let lossTrades = 0;
  let largestWin = 0;
  let largestWinAsset: string | null = null;
  let largestLoss = 0;
  let largestLossAsset: string | null = null;

  for (const fill of fills) {
    totalTrades++;
    const pnl = parseFloat(fill.closedPnl || '0');

    if (pnl > 0) {
      winTrades++;
      if (pnl > largestWin) {
        largestWin = pnl;
        largestWinAsset = fill.coin;
      }
    } else if (pnl < 0) {
      lossTrades++;
      if (pnl < largestLoss) {
        largestLoss = pnl;
        largestLossAsset = fill.coin;
      }
    }
  }

  const winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;

  // Consistency metrics
  let profitableDays = 0;
  let unprofitableDays = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let currentWinStreak = 0;
  let currentLossStreak = 0;

  for (const day of dailyMetrics) {
    if (day.pnl > 0) {
      profitableDays++;
      currentWinStreak++;
      currentLossStreak = 0;
      longestWinStreak = Math.max(longestWinStreak, currentWinStreak);
    } else if (day.pnl < 0) {
      unprofitableDays++;
      currentLossStreak++;
      currentWinStreak = 0;
      longestLossStreak = Math.max(longestLossStreak, currentLossStreak);
    }
  }

  const activeDays = profitableDays + unprofitableDays;
  const dailyWinRate = activeDays > 0 ? (profitableDays / activeDays) * 100 : 0;

  // Risk metrics
  const dailyReturns = dailyMetrics.map(d => d.pnl);
  const avgDailyReturn = dailyReturns.length > 0
    ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
    : 0;

  const variance = dailyReturns.length > 0
    ? dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgDailyReturn, 2), 0) / dailyReturns.length
    : 0;

  const volatility = Math.sqrt(variance);
  const sharpeRatio = volatility > 0 ? (avgDailyReturn / volatility) * Math.sqrt(252) : 0;

  const downsideReturns = dailyReturns.filter(r => r < 0);
  const downsideVariance = downsideReturns.length > 0
    ? downsideReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / downsideReturns.length
    : 0;
  const downsideDeviation = Math.sqrt(downsideVariance);
  const sortinoRatio = downsideDeviation > 0 ? (avgDailyReturn / downsideDeviation) * Math.sqrt(252) : 0;

  // Max drawdown
  let peak = 0;
  let maxDrawdown = 0;
  let runningPnl = 0;

  for (const dailyPnl of dailyReturns) {
    runningPnl += dailyPnl;
    peak = Math.max(peak, runningPnl);
    const drawdown = peak > 0 ? ((peak - runningPnl) / peak) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  // Open positions
  const openPositionsCount = openPositions.length;
  let totalOpenPositionValue = 0;
  for (const pos of openPositions) {
    const positionValue = Math.abs(parseFloat(pos.position?.szi || '0')) * parseFloat(pos.position?.entryPx || '0');
    totalOpenPositionValue += positionValue;
  }
  const avgPositionSize = openPositionsCount > 0 ? totalOpenPositionValue / openPositionsCount : 0;

  return {
    aum,
    totalPnL: pnlAllTime,
    roiPercent: roiAllTime,
    winRate,
    pnl7d,
    roi7d,
    totalTrades,
    winTrades,
    lossTrades,
    largestWin,
    largestWinAsset,
    largestLoss,
    largestLossAsset,
    dailyMetrics,
    profitableDays,
    unprofitableDays,
    longestWinStreak,
    longestLossStreak,
    dailyWinRate,
    volatility,
    sharpeRatio,
    sortinoRatio,
    maxDrawdown,
    openPositionsCount,
    totalOpenPositionValue,
    avgPositionSize,
  };
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  7-Day Hyperliquid Metrics Analysis                       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\nWallet: ${TEST_WALLET}\n`);

  try {
    // Fetch data
    const [fills, portfolioData, openPositions] = await Promise.all([
      fetchUserFills7d(TEST_WALLET),
      fetchPortfolio(TEST_WALLET),
      fetchOpenPositions(TEST_WALLET),
    ]);

    // Compute metrics
    const metrics = computeMetrics(fills, portfolioData, openPositions);

    // Display results
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  📈 HEADLINE METRICS                                       ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`   AUM:              $${metrics.aum.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`   Total PnL:        $${metrics.totalPnL.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`   ROI (All Time):   ${metrics.roiPercent.toFixed(2)}%`);
    console.log(`   Win Rate (7d):    ${metrics.winRate.toFixed(1)}%`);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  💰 PERFORMANCE (7 Days)                                   ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`   PnL (7d):         $${metrics.pnl7d.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${metrics.roi7d.toFixed(2)}%)`);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  📊 TRADING METRICS (7 Days)                               ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`   Total Trades:           ${metrics.totalTrades}`);
    console.log(`   Win Trades:             ${metrics.winTrades} (${metrics.winRate.toFixed(1)}%)`);
    console.log(`   Loss Trades:            ${metrics.lossTrades} (${(100 - metrics.winRate).toFixed(1)}%)`);
    console.log(`   Largest Win:            $${metrics.largestWin.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${metrics.largestWinAsset || 'N/A'})`);
    console.log(`   Largest Loss:           $${metrics.largestLoss.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${metrics.largestLossAsset || 'N/A'})`);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  📅 DAILY BREAKDOWN                                        ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    for (const day of metrics.dailyMetrics.slice().reverse()) {
      const winRate = day.trades > 0 ? ((day.wins / day.trades) * 100).toFixed(1) : '0.0';
      const emoji = day.pnl > 0 ? '✅' : day.pnl < 0 ? '❌' : '➖';
      console.log(`   ${emoji} ${day.date} | Trades: ${day.trades.toString().padStart(4)} | Wins: ${day.wins.toString().padStart(4)} (${winRate}%) | PnL: $${day.pnl.toFixed(2)}`);
    }

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  🎯 CONSISTENCY METRICS                                    ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`   Profitable Days:        ${metrics.profitableDays} / ${metrics.profitableDays + metrics.unprofitableDays}`);
    console.log(`   Daily Win Rate:         ${metrics.dailyWinRate.toFixed(1)}%`);
    console.log(`   Longest Win Streak:     ${metrics.longestWinStreak} days`);
    console.log(`   Longest Loss Streak:    ${metrics.longestLossStreak} days`);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  ⚠️  RISK METRICS                                          ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`   Volatility (Daily):     $${metrics.volatility.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`   Sharpe Ratio:           ${metrics.sharpeRatio.toFixed(2)}`);
    console.log(`   Sortino Ratio:          ${metrics.sortinoRatio.toFixed(2)}`);
    console.log(`   Max Drawdown:           ${metrics.maxDrawdown.toFixed(2)}%`);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  📍 POSITION METRICS                                       ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`   Open Positions:         ${metrics.openPositionsCount}`);
    console.log(`   Total Position Value:   $${metrics.totalOpenPositionValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`   Avg Position Size:      $${metrics.avgPositionSize.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  ✅ Analysis Complete                                      ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main().catch(console.error);
