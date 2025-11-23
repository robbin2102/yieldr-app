/**
 * Verify that missing trades have been recovered
 * Usage: npx tsx scripts/verify-recovery.ts <walletAddress>
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

const EXPECTED_PNL_FROM_AVANTIS = 14600; // 14.6k USDC from Avantis dashboard
const PNL_TOLERANCE = 500; // Allow 500 USDC difference

async function main() {
  console.log('='.repeat(70));
  console.log('Trade Recovery Verification');
  console.log('='.repeat(70));

  try {
    const { default: connectDB } = await import('../lib/mongoose');
    const { default: TradeEvent } = await import('../models/TradeEvent');

    const wallet = process.argv[2];

    if (!wallet) {
      console.error('❌ Error: Wallet address required');
      console.log('Usage: npx tsx scripts/verify-recovery.ts <walletAddress>');
      process.exit(1);
    }

    console.log('\n📅 Wallet: ' + wallet);
    console.log('📊 Expected PnL: ' + EXPECTED_PNL_FROM_AVANTIS.toFixed(2) + ' USDC\n');

    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await connectDB();
    console.log('✓ Connected to MongoDB\n');

    // Get overall statistics
    const stats = await TradeEvent.aggregate([
      { $match: { trader: wallet.toLowerCase() } },
      {
        $group: {
          _id: '$eventType',
          count: { $sum: 1 },
          totalPnl: { $sum: { $ifNull: ['$pnlUsdc', 0] } },
        },
      },
    ]);

    console.log('='.repeat(70));
    console.log('DATABASE STATISTICS');
    console.log('='.repeat(70));

    let totalPnl = 0;
    let openCount = 0;
    let closeCount = 0;

    for (const stat of stats) {
      console.log(`\n${stat._id} Events:`);
      console.log(`  Count: ${stat.count}`);
      if (stat._id === 'CLOSE') {
        console.log(`  Total PnL: ${stat.totalPnl.toFixed(2)} USDC`);
        totalPnl = stat.totalPnl;
        closeCount = stat.count;
      }
      if (stat._id === 'OPEN') {
        openCount = stat.count;
      }
    }

    const totalEvents = openCount + closeCount;

    console.log(`\nTotal Events: ${totalEvents}`);
    console.log(`  - OPEN: ${openCount}`);
    console.log(`  - CLOSE: ${closeCount}`);

    // Check Nov 19 specifically
    console.log('\n' + '='.repeat(70));
    console.log('CHECKING PREVIOUSLY MISSING DATES');
    console.log('='.repeat(70));

    const nov19Start = 38393000;
    const nov19End = 38420000;

    const nov19Events = await TradeEvent.find({
      trader: wallet.toLowerCase(),
      blockNumber: { $gte: nov19Start, $lte: nov19End },
    }).sort({ blockNumber: 1 });

    console.log(`\nNov 19 (blocks ${nov19Start}-${nov19End}):`);
    if (nov19Events.length === 0) {
      console.log('  ❌ Still EMPTY - recovery may have failed');
    } else {
      console.log(`  ✓ Found ${nov19Events.length} events`);
      let nov19Pnl = 0;
      for (const event of nov19Events) {
        if (event.eventType === 'CLOSE') {
          console.log(
            `    - Block ${event.blockNumber}: ${event.pairSymbol} ${event.direction} CLOSE, PnL: ${event.pnlUsdc?.toFixed(2)} USDC`
          );
          nov19Pnl += event.pnlUsdc || 0;
        }
      }
      console.log(`  Total PnL for Nov 19: ${nov19Pnl.toFixed(2)} USDC`);
    }

    // Check Nov 21 BTC trade
    const nov21Block = 38460543;
    const nov21Events = await TradeEvent.find({
      trader: wallet.toLowerCase(),
      blockNumber: { $gte: nov21Block - 500, $lte: nov21Block + 500 },
    }).sort({ blockNumber: 1 });

    console.log(`\nNov 21 around block ${nov21Block} (±500 blocks):`);
    if (nov21Events.length === 0) {
      console.log('  ❌ No events found - BTC trade may still be missing');
    } else {
      console.log(`  ✓ Found ${nov21Events.length} events`);
      for (const event of nov21Events) {
        if (event.eventType === 'CLOSE' && event.pairSymbol?.includes('BTC')) {
          console.log(
            `    - Block ${event.blockNumber}: ${event.pairSymbol} ${event.direction} CLOSE, PnL: ${event.pnlUsdc?.toFixed(2)} USDC ← Likely the missing 971 USDC trade`
          );
        }
      }
    }

    // PnL comparison
    console.log('\n' + '='.repeat(70));
    console.log('PNL COMPARISON');
    console.log('='.repeat(70));

    console.log(`\nExpected PnL (Avantis): ${EXPECTED_PNL_FROM_AVANTIS.toFixed(2)} USDC`);
    console.log(`Actual PnL (MongoDB):   ${totalPnl.toFixed(2)} USDC`);
    console.log(`Difference:             ${(EXPECTED_PNL_FROM_AVANTIS - totalPnl).toFixed(2)} USDC`);

    const percentDiff = Math.abs(EXPECTED_PNL_FROM_AVANTIS - totalPnl) / EXPECTED_PNL_FROM_AVANTIS * 100;
    console.log(`Percent Difference:     ${percentDiff.toFixed(2)}%`);

    console.log('\n' + '='.repeat(70));
    console.log('RECOVERY STATUS');
    console.log('='.repeat(70) + '\n');

    if (Math.abs(EXPECTED_PNL_FROM_AVANTIS - totalPnl) <= PNL_TOLERANCE) {
      console.log('✅ SUCCESS! PnL matches Avantis dashboard (within tolerance)');
      console.log('   Recovery complete - all missing trades have been recovered.\n');
      process.exit(0);
    } else if (totalPnl > EXPECTED_PNL_FROM_AVANTIS - PNL_TOLERANCE * 2) {
      console.log('⚠️  PARTIAL SUCCESS - PnL is close but not exact');
      console.log('   Some trades may still be missing. Consider:');
      console.log('   1. Expanding the block ranges in backfill-specific-blocks.ts');
      console.log('   2. Running a wider date range backfill');
      console.log('   3. Checking if Avantis dashboard PnL has changed\n');
      process.exit(0);
    } else {
      console.log('❌ RECOVERY INCOMPLETE - Significant PnL still missing');
      console.log(`   Missing: ${(EXPECTED_PNL_FROM_AVANTIS - totalPnl).toFixed(2)} USDC`);
      console.log('\n   Recommended actions:');
      console.log('   1. Expand block ranges in backfill-specific-blocks.ts');
      console.log('   2. Check RPC provider reliability');
      console.log('   3. Try running full 90-day backfill with smaller chunks');
      console.log('   4. Verify Avantis dashboard data is still 14.6k USDC\n');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Verification failed:');
    console.error(error);
    process.exit(1);
  }
}

main()
  .then(() => {
    console.log('Exiting...');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
