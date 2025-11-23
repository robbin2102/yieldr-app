/**
 * Backfill specific block ranges to recover missing events
 * Usage: npx tsx scripts/backfill-specific-blocks.ts <walletAddress>
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

// Missing block ranges identified from analysis
const MISSING_BLOCK_RANGES = [
  { name: 'Nov 18', startBlock: 38349000, endBlock: 38350000 },  // ~1000 blocks around 38349323
  { name: 'Nov 19', startBlock: 38393000, endBlock: 38420000 },  // Entire Nov 19 + buffer
  { name: 'Nov 21', startBlock: 38460000, endBlock: 38461000 },  // ~1000 blocks around 38460543
  { name: 'Nov 22', startBlock: 38493500, endBlock: 38494000 },  // Recent transactions
];

async function main() {
  console.log('='.repeat(70));
  console.log('Targeted Backfill for Missing Block Ranges');
  console.log('='.repeat(70));

  try {
    const { backfillWallet } = await import('../services/avantis-listener/Backfiller');
    const { verifyConnection } = await import('../services/avantis-listener/core/ViemClient');
    const { default: connectDB } = await import('../lib/mongoose');
    const { default: TradeEvent } = await import('../models/TradeEvent');

    // Get wallet from command line
    const wallet = process.argv[2];

    if (!wallet) {
      console.error('❌ Error: Wallet address required');
      console.log('Usage: npx tsx scripts/backfill-specific-blocks.ts <walletAddress>');
      console.log('Example: npx tsx scripts/backfill-specific-blocks.ts 0x9c40c5c236bc2d67e07d9781196050d53fe78908');
      process.exit(1);
    }

    console.log('\n📅 Wallet: ' + wallet);
    console.log('📅 Target ranges:', MISSING_BLOCK_RANGES.length, '\n');

    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await connectDB();
    console.log('✓ Connected to MongoDB\n');

    // Verify RPC connection
    console.log('🔌 Connecting to Base RPC...');
    const connected = await verifyConnection();
    if (!connected) {
      throw new Error('Failed to connect to Base RPC');
    }
    console.log('✓ Connected to Base RPC\n');

    console.log('='.repeat(70));
    console.log('Starting targeted backfill for missing blocks...');
    console.log('='.repeat(70) + '\n');

    let totalNewEvents = 0;
    let totalDuplicates = 0;

    // Process each missing range
    for (const range of MISSING_BLOCK_RANGES) {
      console.log(`\n${'='.repeat(70)}`);
      console.log(`Processing ${range.name}: Blocks ${range.startBlock} → ${range.endBlock}`);
      console.log(`${'='.repeat(70)}\n`);

      // Get count before backfill
      const countBefore = await TradeEvent.countDocuments({
        trader: wallet.toLowerCase(),
        blockNumber: { $gte: range.startBlock, $lte: range.endBlock },
      });

      console.log(`Existing events in range: ${countBefore}`);

      const startTime = Date.now();

      // Perform targeted backfill
      const result = await backfillWallet({
        wallet,
        startBlock: range.startBlock,
        endBlock: range.endBlock,
        chunkSize: 500, // Smaller chunks for reliability
        parallelChunks: 2, // Less parallelism for reliability
      });

      const duration = Date.now() - startTime;

      // Get count after backfill
      const countAfter = await TradeEvent.countDocuments({
        trader: wallet.toLowerCase(),
        blockNumber: { $gte: range.startBlock, $lte: range.endBlock },
      });

      const newEvents = countAfter - countBefore;
      const duplicates = result.eventsFound - newEvents;

      totalNewEvents += newEvents;
      totalDuplicates += duplicates;

      console.log(`\n✓ ${range.name} complete:`);
      console.log(`  - Duration: ${(duration / 1000).toFixed(1)}s`);
      console.log(`  - Events found by RPC: ${result.eventsFound}`);
      console.log(`  - New events saved: ${newEvents}`);
      console.log(`  - Duplicates skipped: ${duplicates}`);
      console.log(`  - Total events in range: ${countAfter}`);
    }

    // Final summary
    console.log('\n' + '='.repeat(70));
    console.log('Targeted Backfill Complete!');
    console.log('='.repeat(70));

    console.log(`\n✓ Total new events recovered: ${totalNewEvents}`);
    console.log(`✓ Total duplicates skipped: ${totalDuplicates}`);

    // Get final statistics
    const finalStats = await TradeEvent.aggregate([
      { $match: { trader: wallet.toLowerCase() } },
      {
        $group: {
          _id: '$eventType',
          count: { $sum: 1 },
          totalPnl: { $sum: { $ifNull: ['$pnlUsdc', 0] } },
        },
      },
    ]);

    console.log('\n📊 Final Database Statistics:');
    for (const stat of finalStats) {
      console.log(`  - ${stat._id}: ${stat.count} events${stat._id === 'CLOSE' ? `, PnL: ${stat.totalPnl.toFixed(2)} USDC` : ''}`);
    }

    const totalEvents = finalStats.reduce((sum, stat) => sum + stat.count, 0);
    const totalPnl = finalStats.find((s) => s._id === 'CLOSE')?.totalPnl || 0;

    console.log(`  - Total events: ${totalEvents}`);
    console.log(`  - Total PnL: ${totalPnl.toFixed(2)} USDC`);

    console.log('\n✅ Recovery complete! Check if PnL now matches Avantis dashboard.\n');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Targeted backfill failed:');
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
