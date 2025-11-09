/**
 * Test script to verify Hyperliquid data accuracy
 * Compares userFills PnL with portfolio API PnL
 */

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';
const TEST_USER = '0x162cc7c861ebd0c06b3d72319201150482518185';

async function fetchUserFills(user: string, startTime: number, endTime: number) {
  const response = await fetch(HYPERLIQUID_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'userFillsByTime',
      user,
      startTime,
      endTime,
      aggregateByTime: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

async function fetchPortfolio(user: string) {
  const response = await fetch(HYPERLIQUID_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'portfolio',
      user,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

async function main() {
  console.log('🧪 Testing Hyperliquid Data Accuracy\n');
  console.log(`User: ${TEST_USER}\n`);

  // Test 1: Fetch fills for last 1 hour
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);

  console.log('📊 Test 1: User Fills (Last 1 Hour)');
  console.log(`Time range: ${new Date(oneHourAgo).toISOString()} to ${new Date(now).toISOString()}\n`);

  try {
    const fills = await fetchUserFills(TEST_USER, oneHourAgo, now);

    console.log(`Total fills: ${fills.length}`);

    // Analyze fills
    let totalClosedPnl = 0;
    let winCount = 0;
    let lossCount = 0;
    let neutralCount = 0;

    const closingFills = fills.filter((f: any) => {
      const closedPnl = parseFloat(f.closedPnl || '0');
      return closedPnl !== 0 || (f.dir && f.dir.includes('Close'));
    });

    console.log(`Closing fills (with PnL): ${closingFills.length}\n`);

    for (const fill of closingFills) {
      const closedPnl = parseFloat(fill.closedPnl || '0');
      totalClosedPnl += closedPnl;

      if (closedPnl > 0) winCount++;
      else if (closedPnl < 0) lossCount++;
      else neutralCount++;

      console.log(`  ${new Date(fill.time).toISOString()} | ${fill.coin} | ${fill.dir} | PnL: $${closedPnl.toFixed(2)}`);
    }

    console.log('\n📈 Fill Analysis:');
    console.log(`  Total Trades: ${closingFills.length}`);
    console.log(`  Wins: ${winCount}`);
    console.log(`  Losses: ${lossCount}`);
    console.log(`  Neutral: ${neutralCount}`);
    console.log(`  Total PnL (from fills): $${totalClosedPnl.toFixed(2)}`);
    console.log(`  Win Rate: ${closingFills.length > 0 ? ((winCount / closingFills.length) * 100).toFixed(2) : 0}%`);

    // Test 2: Fetch portfolio data
    console.log('\n📊 Test 2: Portfolio API');
    const portfolio = await fetchPortfolio(TEST_USER);

    // Parse portfolio data
    const dayData = portfolio.find((p: any) => p[0] === 'day');
    const perpDayData = portfolio.find((p: any) => p[0] === 'perpDay');

    if (dayData) {
      const data = dayData[1];
      const pnlHistory = data.pnlHistory || [];
      const accountValueHistory = data.accountValueHistory || [];

      console.log(`\nDay PnL History (${pnlHistory.length} data points):`);
      if (pnlHistory.length > 0) {
        const latestPnl = pnlHistory[pnlHistory.length - 1];
        const firstPnl = pnlHistory[0];
        console.log(`  First: ${new Date(firstPnl[0]).toISOString()} | PnL: $${parseFloat(firstPnl[1]).toFixed(2)}`);
        console.log(`  Latest: ${new Date(latestPnl[0]).toISOString()} | PnL: $${parseFloat(latestPnl[1]).toFixed(2)}`);

        // Calculate PnL change in last hour
        const oneHourAgoPnl = pnlHistory.find((p: any) => p[0] >= oneHourAgo);
        if (oneHourAgoPnl) {
          const pnlChange = parseFloat(latestPnl[1]) - parseFloat(oneHourAgoPnl[1]);
          console.log(`  PnL Change (Last 1hr): $${pnlChange.toFixed(2)}`);
        }
      }

      console.log(`\nAccount Value History (${accountValueHistory.length} data points):`);
      if (accountValueHistory.length > 0) {
        const latestValue = accountValueHistory[accountValueHistory.length - 1];
        console.log(`  Latest: ${new Date(latestValue[0]).toISOString()} | Value: $${parseFloat(latestValue[1]).toFixed(2)}`);
      }
    }

    if (perpDayData) {
      const data = perpDayData[1];
      console.log(`\nPerp Day Data:`);
      console.log(`  Volume: $${parseFloat(data.vlm || '0').toFixed(2)}`);
    }

    // Test 3: Comparison
    console.log('\n📊 Test 3: Data Accuracy Comparison');
    console.log('Comparing fills PnL vs portfolio PnL change...');

    if (dayData && dayData[1].pnlHistory && dayData[1].pnlHistory.length > 0) {
      const pnlHistory = dayData[1].pnlHistory;
      const latestPnl = parseFloat(pnlHistory[pnlHistory.length - 1][1]);
      const oneHourAgoPnl = pnlHistory.find((p: any) => p[0] >= oneHourAgo);

      if (oneHourAgoPnl) {
        const portfolioPnlChange = latestPnl - parseFloat(oneHourAgoPnl[1]);
        const fillsPnl = totalClosedPnl;
        const difference = Math.abs(portfolioPnlChange - fillsPnl);
        const percentDiff = portfolioPnlChange !== 0 ? (difference / Math.abs(portfolioPnlChange)) * 100 : 0;

        console.log(`\n  Portfolio PnL Change (1hr): $${portfolioPnlChange.toFixed(2)}`);
        console.log(`  Fills Total PnL (1hr):      $${fillsPnl.toFixed(2)}`);
        console.log(`  Difference:                 $${difference.toFixed(2)} (${percentDiff.toFixed(2)}%)`);

        if (percentDiff < 5) {
          console.log(`  ✅ Data matches! (<5% difference)`);
        } else {
          console.log(`  ⚠️  Significant difference detected`);
        }
      }
    }

    // Test 4: Historical data availability
    console.log('\n📊 Test 4: Historical Data Availability');
    const allTimeData = portfolio.find((p: any) => p[0] === 'allTime');
    const monthData = portfolio.find((p: any) => p[0] === 'month');
    const weekData = portfolio.find((p: any) => p[0] === 'week');

    if (allTimeData) {
      const pnlHistory = allTimeData[1].pnlHistory || [];
      console.log(`  All Time: ${pnlHistory.length} data points`);
      if (pnlHistory.length > 0) {
        const firstPoint = pnlHistory[0];
        const lastPoint = pnlHistory[pnlHistory.length - 1];
        const daysCovered = (lastPoint[0] - firstPoint[0]) / (1000 * 60 * 60 * 24);
        console.log(`    Date range: ${new Date(firstPoint[0]).toISOString()} to ${new Date(lastPoint[0]).toISOString()}`);
        console.log(`    Days covered: ${daysCovered.toFixed(0)}`);
      }
    }

    if (monthData) {
      const pnlHistory = monthData[1].pnlHistory || [];
      console.log(`  Month: ${pnlHistory.length} data points`);
    }

    if (weekData) {
      const pnlHistory = weekData[1].pnlHistory || [];
      console.log(`  Week: ${pnlHistory.length} data points`);
    }

    console.log('\n✅ Test Complete!');

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    throw error;
  }
}

main().catch(console.error);
