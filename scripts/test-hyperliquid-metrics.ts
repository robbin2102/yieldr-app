/**
 * Comprehensive Hyperliquid Metrics Test
 * Computes all analytics metrics for managers with open Hyperliquid positions
 */

import clientPromise from '@/lib/mongodb';

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';

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

  // Risk Metrics (placeholders for now)
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  volatility: number;
}

async function fetchUserFills(walletAddress: string, days: number = 30): Promise<any[]> {
  const now = Date.now();
  const startTime = now - (days * 24 * 60 * 60 * 1000);

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
  return fills.filter((f: any) => parseFloat(f.closedPnl || '0') !== 0);
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
  fills30d: any[],
  fillsAllTime: any[],
  portfolioData: any,
  openPositions: any[]
): MetricsData {
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
    // Headline
    aum,
    totalPnL: pnlAllTime,
    roiPercent: roiAllTime,
    winRate30d: winRate,

    // Performance
    pnl24h,
    pnl7d,
    pnl30d,
    pnlAllTime,
    roi24h,
    roi7d,
    roi30d,
    roiAllTime,

    // Trading
    totalTrades,
    totalTradesAllTime: fillsAllTime.length,
    winTrades30d,
    lossTrades30d,
    winRate,
    largestWin,
    largestWinAsset,
    largestLoss,
    largestLossAsset,

    // Positions
    avgPositionSize,
    openPositionsCount,
    totalOpenPositionValue,

    // Consistency
    longestWinStreak,
    longestLossStreak,
    currentStreak,
    dailyWinRate,
    profitableDays,
    unprofitableDays,
    breakEvenDays,
    activeDays,

    // Risk
    sharpeRatio,
    sortinoRatio,
    maxDrawdown,
    volatility,
  };
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Comprehensive Hyperliquid Metrics Test                   ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    const client = await clientPromise;
    const db = client.db('yieldr');

    // Get managers with open Hyperliquid positions
    const managers = await db
      .collection('managers')
      .find({ status: { $ne: 'inactive' } })
      .project({ _id: 1, username: 1, walletAddress: 1, wallets: 1 })
      .toArray();

    console.log(`Testing ${managers.length} managers...\n`);

    for (const manager of managers) {
      const allWallets = [manager.walletAddress, ...(manager.wallets || [])];

      // Check if manager has open Hyperliquid positions
      let hasOpenPositions = false;
      for (const wallet of allWallets) {
        try {
          const positions = await fetchOpenPositions(wallet);
          if (positions.length > 0) {
            hasOpenPositions = true;
            break;
          }
        } catch (error) {
          // Skip wallet if error
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (!hasOpenPositions) {
        console.log(`⏭️  @${manager.username} - No open Hyperliquid positions, skipping\n`);
        continue;
      }

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📊 Manager: @${manager.username}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      let aggregatedMetrics: MetricsData | null = null;

      for (const wallet of allWallets) {
        try {
          console.log(`📍 Wallet: ${wallet.slice(0, 10)}...${wallet.slice(-8)}`);

          // Fetch all data
          const [fills30d, fillsAllTime, portfolioData, openPositions] = await Promise.all([
            fetchUserFills(wallet, 30),
            fetchUserFills(wallet, 90), // Get 90 days for better streak analysis
            fetchPortfolio(wallet),
            fetchOpenPositions(wallet),
          ]);

          if (openPositions.length === 0) {
            console.log('   No open positions\n');
            continue;
          }

          // Compute metrics
          const metrics = computeMetrics(fills30d, fillsAllTime, portfolioData, openPositions);

          // Aggregate metrics
          if (!aggregatedMetrics) {
            aggregatedMetrics = metrics;
          } else {
            // Aggregate across wallets
            aggregatedMetrics.aum += metrics.aum;
            aggregatedMetrics.totalPnL += metrics.totalPnL;
            aggregatedMetrics.pnl24h += metrics.pnl24h;
            aggregatedMetrics.pnl7d += metrics.pnl7d;
            aggregatedMetrics.pnl30d += metrics.pnl30d;
            aggregatedMetrics.pnlAllTime += metrics.pnlAllTime;
            aggregatedMetrics.totalTrades += metrics.totalTrades;
            aggregatedMetrics.totalTradesAllTime += metrics.totalTradesAllTime;
            aggregatedMetrics.winTrades30d += metrics.winTrades30d;
            aggregatedMetrics.lossTrades30d += metrics.lossTrades30d;
            aggregatedMetrics.openPositionsCount += metrics.openPositionsCount;
            aggregatedMetrics.totalOpenPositionValue += metrics.totalOpenPositionValue;
            aggregatedMetrics.profitableDays += metrics.profitableDays;
            aggregatedMetrics.unprofitableDays += metrics.unprofitableDays;
            aggregatedMetrics.breakEvenDays += metrics.breakEvenDays;
            aggregatedMetrics.activeDays = Math.max(aggregatedMetrics.activeDays, metrics.activeDays);

            if (metrics.largestWin > aggregatedMetrics.largestWin) {
              aggregatedMetrics.largestWin = metrics.largestWin;
              aggregatedMetrics.largestWinAsset = metrics.largestWinAsset;
            }
            if (metrics.largestLoss < aggregatedMetrics.largestLoss) {
              aggregatedMetrics.largestLoss = metrics.largestLoss;
              aggregatedMetrics.largestLossAsset = metrics.largestLossAsset;
            }

            aggregatedMetrics.longestWinStreak = Math.max(aggregatedMetrics.longestWinStreak, metrics.longestWinStreak);
            aggregatedMetrics.longestLossStreak = Math.max(aggregatedMetrics.longestLossStreak, metrics.longestLossStreak);
          }

          console.log(`   Open positions: ${metrics.openPositionsCount}`);
          console.log(`   Account value: $${metrics.aum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`);

        } catch (error: any) {
          console.log(`   ⚠️  Error: ${error.message}\n`);
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      if (aggregatedMetrics) {
        // Recalculate derived metrics
        const totalTrades = aggregatedMetrics.totalTrades;
        aggregatedMetrics.winRate = totalTrades > 0 ? (aggregatedMetrics.winTrades30d / totalTrades) * 100 : 0;
        aggregatedMetrics.avgPositionSize = aggregatedMetrics.openPositionsCount > 0
          ? aggregatedMetrics.totalOpenPositionValue / aggregatedMetrics.openPositionsCount
          : 0;

        const initialValue = aggregatedMetrics.aum - aggregatedMetrics.totalPnL;
        aggregatedMetrics.roi24h = initialValue > 0 ? (aggregatedMetrics.pnl24h / initialValue) * 100 : 0;
        aggregatedMetrics.roi7d = initialValue > 0 ? (aggregatedMetrics.pnl7d / initialValue) * 100 : 0;
        aggregatedMetrics.roi30d = initialValue > 0 ? (aggregatedMetrics.pnl30d / initialValue) * 100 : 0;
        aggregatedMetrics.roiAllTime = initialValue > 0 ? (aggregatedMetrics.pnlAllTime / initialValue) * 100 : 0;
        aggregatedMetrics.roiPercent = aggregatedMetrics.roiAllTime;
        aggregatedMetrics.winRate30d = aggregatedMetrics.winRate;
        aggregatedMetrics.dailyWinRate = aggregatedMetrics.activeDays > 0
          ? (aggregatedMetrics.profitableDays / aggregatedMetrics.activeDays) * 100
          : 0;

        // Display results
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║  📈 HEADLINE METRICS                                       ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log(`   AUM:              $${aggregatedMetrics.aum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
        console.log(`   Total PnL:        $${aggregatedMetrics.totalPnL.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
        console.log(`   ROI (All Time):   ${aggregatedMetrics.roiPercent.toFixed(2)}%`);
        console.log(`   Win Rate (30d):   ${aggregatedMetrics.winRate30d.toFixed(1)}%`);

        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║  💰 PERFORMANCE METRICS                                    ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log(`   PnL (24h):        $${aggregatedMetrics.pnl24h.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${aggregatedMetrics.roi24h.toFixed(2)}%)`);
        console.log(`   PnL (7d):         $${aggregatedMetrics.pnl7d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${aggregatedMetrics.roi7d.toFixed(2)}%)`);
        console.log(`   PnL (30d):        $${aggregatedMetrics.pnl30d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${aggregatedMetrics.roi30d.toFixed(2)}%)`);
        console.log(`   PnL (All Time):   $${aggregatedMetrics.pnlAllTime.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${aggregatedMetrics.roiAllTime.toFixed(2)}%)`);

        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║  📊 TRADING METRICS                                        ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log(`   Total Trades (30d):     ${aggregatedMetrics.totalTrades}`);
        console.log(`   Total Trades (All):     ${aggregatedMetrics.totalTradesAllTime}`);
        console.log(`   Win Trades:             ${aggregatedMetrics.winTrades30d} (${aggregatedMetrics.winRate.toFixed(1)}%)`);
        console.log(`   Loss Trades:            ${aggregatedMetrics.lossTrades30d} (${(100 - aggregatedMetrics.winRate).toFixed(1)}%)`);
        console.log(`   Largest Win:            $${aggregatedMetrics.largestWin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${aggregatedMetrics.largestWinAsset || 'N/A'})`);
        console.log(`   Largest Loss:           $${aggregatedMetrics.largestLoss.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${aggregatedMetrics.largestLossAsset || 'N/A'})`);

        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║  📍 POSITION METRICS                                       ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log(`   Open Positions:         ${aggregatedMetrics.openPositionsCount}`);
        console.log(`   Total Position Value:   $${aggregatedMetrics.totalOpenPositionValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
        console.log(`   Avg Position Size:      $${aggregatedMetrics.avgPositionSize.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║  🎯 CONSISTENCY METRICS                                    ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log(`   Longest Win Streak:     ${aggregatedMetrics.longestWinStreak} days`);
        console.log(`   Longest Loss Streak:    ${aggregatedMetrics.longestLossStreak} days`);
        console.log(`   Current Streak:         ${aggregatedMetrics.currentStreak.count} ${aggregatedMetrics.currentStreak.type} days`);
        console.log(`   Daily Win Rate:         ${aggregatedMetrics.dailyWinRate.toFixed(1)}%`);
        console.log(`   Profitable Days:        ${aggregatedMetrics.profitableDays}`);
        console.log(`   Unprofitable Days:      ${aggregatedMetrics.unprofitableDays}`);
        console.log(`   Break Even Days:        ${aggregatedMetrics.breakEvenDays}`);
        console.log(`   Active Days:            ${aggregatedMetrics.activeDays}`);

        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║  ⚠️  RISK METRICS                                          ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log(`   Sharpe Ratio:           ${aggregatedMetrics.sharpeRatio.toFixed(2)}`);
        console.log(`   Sortino Ratio:          ${aggregatedMetrics.sortinoRatio.toFixed(2)}`);
        console.log(`   Max Drawdown:           ${aggregatedMetrics.maxDrawdown.toFixed(2)}%`);
        console.log(`   Volatility:             ${aggregatedMetrics.volatility.toFixed(2)}`);

        console.log('\n');
      }
    }

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  ✅ Test Complete                                          ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main().catch(console.error);
