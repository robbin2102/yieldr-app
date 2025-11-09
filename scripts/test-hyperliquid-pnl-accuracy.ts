/**
 * Test script to verify Hyperliquid PnL accuracy
 * Compares userFills PnL (last 24h) with portfolio API PnL
 */

import clientPromise from '@/lib/mongodb';

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';

interface FillsAnalysis {
  totalFills: number;
  winTrades: number;
  lossTrades: number;
  neutralTrades: number;
  totalPnL: number;
  startTime: number;
  endTime: number;
}

interface PortfolioData {
  accountValue: number;
  pnl24h: number;
  pnl7d: number;
  pnl30d: number;
  pnlAllTime: number;
}

async function fetchUserFills24h(walletAddress: string): Promise<{ fills: any[]; analysis: FillsAnalysis }> {
  const now = Date.now();
  const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);

  const response = await fetch(HYPERLIQUID_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'userFillsByTime',
      user: walletAddress,
      startTime: twentyFourHoursAgo,
      endTime: now,
      aggregateByTime: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const fills = await response.json();

  // Analyze fills
  let winTrades = 0;
  let lossTrades = 0;
  let neutralTrades = 0;
  let totalPnL = 0;

  // Filter fills with closedPnl (actual closes)
  const closingFills = fills.filter((f: any) => {
    const closedPnl = parseFloat(f.closedPnl || '0');
    return closedPnl !== 0;
  });

  for (const fill of closingFills) {
    const closedPnl = parseFloat(fill.closedPnl || '0');
    totalPnL += closedPnl;

    if (closedPnl > 0) {
      winTrades++;
    } else if (closedPnl < 0) {
      lossTrades++;
    } else {
      neutralTrades++;
    }
  }

  return {
    fills: closingFills,
    analysis: {
      totalFills: closingFills.length,
      winTrades,
      lossTrades,
      neutralTrades,
      totalPnL,
      startTime: twentyFourHoursAgo,
      endTime: now,
    },
  };
}

async function fetchPortfolio(walletAddress: string): Promise<PortfolioData> {
  const response = await fetch(HYPERLIQUID_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'portfolio',
      user: walletAddress,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const portfolioData = await response.json();

  // Parse portfolio data
  const dayData = portfolioData.find((p: any) => p[0] === 'day')?.[1];
  const weekData = portfolioData.find((p: any) => p[0] === 'week')?.[1];
  const monthData = portfolioData.find((p: any) => p[0] === 'month')?.[1];
  const allTimeData = portfolioData.find((p: any) => p[0] === 'allTime')?.[1];

  // Get latest values
  const accountValue = dayData?.accountValueHistory?.length > 0
    ? parseFloat(dayData.accountValueHistory[dayData.accountValueHistory.length - 1][1])
    : 0;

  // Calculate PnL changes
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

  return {
    accountValue,
    pnl24h,
    pnl7d,
    pnl30d,
    pnlAllTime,
  };
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Hyperliquid PnL Accuracy Test (Last 24h)                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    // Get managers with Hyperliquid positions
    const client = await clientPromise;
    const db = client.db('yieldr');

    const managers = await db
      .collection('managers')
      .find({ status: { $ne: 'inactive' } })
      .project({
        _id: 1,
        username: 1,
        walletAddress: 1,
        wallets: 1,
      })
      .toArray();

    console.log(`Found ${managers.length} active managers\n`);

    for (const manager of managers) {
      const allWallets = [manager.walletAddress, ...(manager.wallets || [])];

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📊 Manager: @${manager.username}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      let totalWins = 0;
      let totalLosses = 0;
      let totalFills = 0;
      let totalFillsPnL = 0;
      let totalPortfolioPnL24h = 0;
      let totalAccountValue = 0;

      for (const wallet of allWallets) {
        console.log(`\n📍 Wallet: ${wallet}`);
        console.log('─────────────────────────────────────────────────────────────\n');

        try {
          // Fetch fills for last 24h
          const { fills, analysis } = await fetchUserFills24h(wallet);

          console.log('📈 User Fills Analysis (Last 24h):');
          console.log(`   Start Time:  ${new Date(analysis.startTime).toISOString()}`);
          console.log(`   End Time:    ${new Date(analysis.endTime).toISOString()}`);
          console.log(`   Total Fills: ${analysis.totalFills}`);
          console.log(`   Win Trades:  ${analysis.winTrades} (${analysis.totalFills > 0 ? ((analysis.winTrades / analysis.totalFills) * 100).toFixed(1) : 0}%)`);
          console.log(`   Loss Trades: ${analysis.lossTrades} (${analysis.totalFills > 0 ? ((analysis.lossTrades / analysis.lossTrades) * 100).toFixed(1) : 0}%)`);
          console.log(`   Total PnL:   $${analysis.totalPnL.toFixed(2)}`);

          // Fetch portfolio data
          const portfolio = await fetchPortfolio(wallet);

          console.log('\n💼 Portfolio API Data:');
          console.log(`   Account Value: $${portfolio.accountValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
          console.log(`   PnL (24h):     $${portfolio.pnl24h.toFixed(2)}`);
          console.log(`   PnL (7d):      $${portfolio.pnl7d.toFixed(2)}`);
          console.log(`   PnL (30d):     $${portfolio.pnl30d.toFixed(2)}`);
          console.log(`   PnL (All):     $${portfolio.pnlAllTime.toFixed(2)}`);

          // Compare fills PnL vs portfolio PnL
          const variance = Math.abs(analysis.totalPnL - portfolio.pnl24h);
          const percentVariance = portfolio.pnl24h !== 0
            ? (variance / Math.abs(portfolio.pnl24h)) * 100
            : (analysis.totalPnL !== 0 ? 100 : 0);

          console.log('\n🔍 Accuracy Check (24h):');
          console.log(`   Fills PnL:     $${analysis.totalPnL.toFixed(2)}`);
          console.log(`   Portfolio PnL: $${portfolio.pnl24h.toFixed(2)}`);
          console.log(`   Variance:      $${variance.toFixed(2)} (${percentVariance.toFixed(2)}%)`);

          if (percentVariance < 5) {
            console.log(`   Status:        ✅ Accurate (<5% variance)`);
          } else if (percentVariance < 10) {
            console.log(`   Status:        ⚠️  Good (5-10% variance)`);
          } else {
            console.log(`   Status:        ❌ High variance (>${percentVariance.toFixed(0)}%)`);
          }

          // Show recent fills
          if (fills.length > 0) {
            console.log('\n📋 Recent Fills (Last 5):');
            const recentFills = fills.slice(-5).reverse();
            for (const fill of recentFills) {
              const pnl = parseFloat(fill.closedPnl || '0');
              const pnlStr = pnl > 0 ? `+$${pnl.toFixed(2)}` : `$${pnl.toFixed(2)}`;
              const emoji = pnl > 0 ? '✅' : '❌';
              console.log(`   ${emoji} ${new Date(fill.time).toISOString()} | ${fill.coin} | ${fill.dir} | ${pnlStr}`);
            }
          }

          // Aggregate totals
          totalWins += analysis.winTrades;
          totalLosses += analysis.lossTrades;
          totalFills += analysis.totalFills;
          totalFillsPnL += analysis.totalPnL;
          totalPortfolioPnL24h += portfolio.pnl24h;
          totalAccountValue += portfolio.accountValue;

        } catch (error: any) {
          console.log(`   ⚠️  Error: ${error.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, 200)); // Rate limit
      }

      // Manager summary
      if (totalFills > 0) {
        const winRate = (totalWins / totalFills) * 100;
        const totalVariance = Math.abs(totalFillsPnL - totalPortfolioPnL24h);
        const totalPercentVariance = totalPortfolioPnL24h !== 0
          ? (totalVariance / Math.abs(totalPortfolioPnL24h)) * 100
          : 0;

        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log(`║  @${manager.username} - Summary`);
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log(`   Total Account Value: $${totalAccountValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
        console.log(`   Total Fills (24h):   ${totalFills}`);
        console.log(`   Win Trades:          ${totalWins} (${winRate.toFixed(1)}%)`);
        console.log(`   Loss Trades:         ${totalLosses}`);
        console.log(`   Fills PnL (24h):     $${totalFillsPnL.toFixed(2)}`);
        console.log(`   Portfolio PnL (24h): $${totalPortfolioPnL24h.toFixed(2)}`);
        console.log(`   Variance:            $${totalVariance.toFixed(2)} (${totalPercentVariance.toFixed(2)}%)`);
        console.log('');
      } else {
        console.log('\n   ℹ️  No fills in last 24h\n');
      }
    }

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  Test Complete                                             ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main().catch(console.error);
