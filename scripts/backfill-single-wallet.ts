/**
 * Backfill a single wallet address
 * Usage: npx tsx scripts/backfill-single-wallet.ts <walletAddress> [daysBack]
 * Example: npx tsx scripts/backfill-single-wallet.ts 0x780BB763e1463D2236FEC780b7BD6ADb40AAa120 90
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  console.log('='.repeat(60));
  console.log('Avantis Trade Backfill - Single Wallet');
  console.log('='.repeat(60));

  try {
    const { backfillWalletHistory } = await import('../services/avantis-listener');
    const { verifyConnection } = await import('../services/avantis-listener/core/ViemClient');
    const { default: connectDB } = await import('../lib/mongoose');

    // Get wallet and days from command line
    const wallet = process.argv[2];
    const daysBack = process.argv[3] ? parseInt(process.argv[3]) : 90;

    if (!wallet) {
      console.error('❌ Error: Wallet address required');
      console.log('Usage: npx tsx scripts/backfill-single-wallet.ts <walletAddress> [daysBack]');
      console.log('Example: npx tsx scripts/backfill-single-wallet.ts 0x780BB763e1463D2236FEC780b7BD6ADb40AAa120 90');
      process.exit(1);
    }

    console.log('\n📅 Wallet: ' + wallet);
    console.log('📅 Days back: ' + daysBack + '\n');

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

    console.log('='.repeat(60));
    console.log('Starting backfill...');
    console.log('='.repeat(60) + '\n');

    // Perform backfill
    const startTime = Date.now();
    const result = await backfillWalletHistory(wallet, daysBack);
    const duration = Date.now() - startTime;

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('Backfill Complete!');
    console.log('='.repeat(60));

    console.log('\n✓ Duration: ' + (duration / 1000).toFixed(1) + 's');
    console.log('✓ Events found: ' + result.eventsFound);
    console.log('✓ Block range: ' + result.startBlock + ' → ' + result.endBlock);
    console.log('✓ Status: ' + (result.success ? 'SUCCESS' : 'FAILED'));

    if (result.success) {
      console.log('\n✅ Backfill completed successfully!\n');
    } else {
      console.log('\n❌ Backfill failed\n');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Backfill failed:');
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
