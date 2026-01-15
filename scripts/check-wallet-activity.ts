/**
 * Wallet Activity Analyzer - Check activity types for any Polymarket wallet
 *
 * Usage:
 *   npx tsx scripts/check-wallet-activity.ts [wallet_address] [days]
 *
 * Examples:
 *   npx tsx scripts/check-wallet-activity.ts                              # Default wallet, last 7 days
 *   npx tsx scripts/check-wallet-activity.ts 0x123...                     # Custom wallet, last 7 days
 *   npx tsx scripts/check-wallet-activity.ts 0x123... 30                  # Custom wallet, last 30 days
 */

const wallet = process.argv[2] || '0x6a72f61820b26b1fe4d956e17b6dc2a1ea3033ee';
const days = parseInt(process.argv[3] || '7');

// Calculate time range
const now = Math.floor(Date.now() / 1000);
const startTs = now - (days * 24 * 60 * 60);

async function fetchActivity(offset = 0): Promise<any[]> {
  const url = `https://data-api.polymarket.com/activity?user=${wallet}&limit=500&offset=${offset}&startTs=${startTs}&endTs=${now}&sortBy=TIMESTAMP&sortDirection=DESC`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

async function main() {
  const startDate = new Date(startTs * 1000).toISOString().split('T')[0];
  const endDate = new Date(now * 1000).toISOString().split('T')[0];

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('              WALLET ACTIVITY ANALYZER                          ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Wallet:  ${wallet}`);
  console.log(`Period:  Last ${days} days (${startDate} to ${endDate})`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Fetch activities with pagination (stop when we hit activities older than startTs)
  let allActivities: any[] = [];
  let offset = 0;
  let done = false;

  while (!done) {
    const batch = await fetchActivity(offset);
    if (batch.length === 0) break;

    // Debug: Check first activity to understand timestamp format
    if (offset === 0 && batch[0]) {
      console.log(`\n[DEBUG] First activity sample:`);
      console.log(`  timestamp field: ${batch[0].timestamp}`);
      console.log(`  As date: ${new Date(batch[0].timestamp * 1000).toISOString()}`);
      console.log(`  startTs: ${startTs} (${new Date(startTs * 1000).toISOString()})`);
      console.log(`  Keys: ${Object.keys(batch[0]).join(', ')}\n`);
    }

    // Check last activity in batch
    const lastActivity = batch[batch.length - 1];
    const lastTs = lastActivity?.timestamp;
    console.log(`Fetching offset ${offset}... last_ts=${lastTs} (${lastTs ? new Date(lastTs * 1000).toISOString().split('T')[0] : 'N/A'})`);

    // Filter batch to only include activities within time range
    for (const activity of batch) {
      if (activity.timestamp >= startTs) {
        allActivities.push(activity);
      } else {
        // Activities are sorted DESC, so once we hit one older than startTs, we're done
        console.log(`\n[DEBUG] Found activity older than cutoff:`);
        console.log(`  activity.timestamp: ${activity.timestamp} (${new Date(activity.timestamp * 1000).toISOString()})`);
        console.log(`  startTs cutoff: ${startTs} (${new Date(startTs * 1000).toISOString()})`);
        done = true;
        break;
      }
    }

    if (batch.length < 500) break;
    offset += 500;
  }

  console.log(`\nTotal activities in period: ${allActivities.length}\n`);

  if (allActivities.length === 0) {
    console.log('No activities found for this wallet in the specified period');
    return;
  }

  // Count TRADE by side
  let buyCount = 0;
  let sellCount = 0;
  let redeemCount = 0;
  const otherTypes: Record<string, number> = {};

  allActivities.forEach(a => {
    if (a.type === 'TRADE') {
      if (a.side === 'BUY') buyCount++;
      else if (a.side === 'SELL') sellCount++;
    } else if (a.type === 'REDEEM') {
      redeemCount++;
    } else {
      otherTypes[a.type] = (otherTypes[a.type] || 0) + 1;
    }
  });

  // Print results
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    ACTIVITY BREAKDOWN                          ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  TRADE (BUY)      ${buyCount}`);
  console.log(`  TRADE (SELL)     ${sellCount}`);
  console.log(`  REDEEM           ${redeemCount}`);

  if (Object.keys(otherTypes).length > 0) {
    console.log('  ─────────────────────');
    Object.entries(otherTypes)
      .sort((a, b) => b[1] - a[1])
      .forEach(([type, count]) => {
        console.log(`  ${type.padEnd(16)} ${count}`);
      });
  }

  console.log('═══════════════════════════════════════════════════════════════');

  // Analysis
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                      ANALYSIS                                  ');
  console.log('═══════════════════════════════════════════════════════════════');

  if (sellCount === 0 && buyCount > 0 && redeemCount > 0) {
    console.log('✅ This trader ONLY BUYS and REDEEMS (no SELL trades)');
    console.log('   Strategy: Buy and hold until market resolution');
  } else if (sellCount === 0 && buyCount > 0) {
    console.log('✅ This trader ONLY BUYS (no SELL trades, no redeems yet)');
  } else if (sellCount > 0) {
    const sellPct = ((sellCount / (buyCount + sellCount)) * 100).toFixed(1);
    console.log(`⚠️  This trader SELLS (${sellCount} sells = ${sellPct}% of trades)`);
  } else {
    console.log('ℹ️  No trade activity in this period');
  }

  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
