/**
 * Quick script to check wallet activity types
 * Usage: npx tsx scripts/check-wallet-activity.ts [wallet_address]
 */

const wallet = process.argv[2] || '0x6a72f61820b26b1fe4d956e17b6dc2a1ea3033ee';

async function fetchActivity(offset = 0): Promise<any[]> {
  const url = `https://data-api.polymarket.com/activity?user=${wallet}&limit=500&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('              WALLET ACTIVITY ANALYZER                          ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Wallet: ${wallet}\n`);

  // Fetch all activities (paginate if needed)
  let allActivities: any[] = [];
  let offset = 0;

  while (true) {
    console.log(`Fetching activities (offset ${offset})...`);
    const batch = await fetchActivity(offset);
    if (batch.length === 0) break;
    allActivities = allActivities.concat(batch);
    if (batch.length < 500) break;
    offset += 500;
  }

  console.log(`\nTotal activities fetched: ${allActivities.length}\n`);

  if (allActivities.length === 0) {
    console.log('No activities found for this wallet');
    return;
  }

  // Count by type
  const byType: Record<string, number> = {};
  const byTypeSide: Record<string, number> = {};

  allActivities.forEach(a => {
    // Count by type
    byType[a.type] = (byType[a.type] || 0) + 1;

    // Count by type + side (for TRADE)
    if (a.type === 'TRADE' && a.side) {
      const key = `TRADE-${a.side}`;
      byTypeSide[key] = (byTypeSide[key] || 0) + 1;
    }
  });

  // Date range
  const timestamps = allActivities.map(a => a.timestamp).filter(Boolean);
  const minDate = new Date(Math.min(...timestamps) * 1000);
  const maxDate = new Date(Math.max(...timestamps) * 1000);

  // Print summary
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    ACTIVITY SUMMARY                            ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Date range: ${minDate.toISOString().split('T')[0]} to ${maxDate.toISOString().split('T')[0]}\n`);

  console.log('By Type:');
  Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
      console.log(`  ${type.padEnd(15)} ${count}`);
    });

  if (Object.keys(byTypeSide).length > 0) {
    console.log('\nTRADE Breakdown (BUY vs SELL):');
    Object.entries(byTypeSide)
      .sort((a, b) => b[1] - a[1])
      .forEach(([type, count]) => {
        console.log(`  ${type.padEnd(15)} ${count}`);
      });
  }

  // Check if only BUY and REDEEM
  const hasSell = byTypeSide['TRADE-SELL'] > 0;
  const hasBuy = byTypeSide['TRADE-BUY'] > 0;
  const hasRedeem = byType['REDEEM'] > 0;

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                      ANALYSIS                                  ');
  console.log('═══════════════════════════════════════════════════════════════');

  if (!hasSell && hasBuy && hasRedeem) {
    console.log('✅ This trader ONLY BUYS and REDEEMS (no SELL trades)');
    console.log('   Strategy: Buy and hold until market resolution');
  } else if (!hasSell && hasBuy) {
    console.log('✅ This trader ONLY BUYS (no SELL trades, no redeems yet)');
  } else if (hasSell) {
    console.log(`⚠️  This trader also SELLS (${byTypeSide['TRADE-SELL']} sell trades found)`);
  }

  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
