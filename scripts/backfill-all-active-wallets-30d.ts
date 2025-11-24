/**
 * Backfill 30 Days for All Active Avantis Wallets
 *
 * Runs the proven backfiller for all wallets with active Avantis positions.
 * This ensures complete historical data before deploying the cron job.
 *
 * Usage: npx tsx scripts/backfill-all-active-wallets-30d.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

const DAYS_TO_BACKFILL = 30;
const DELAY_BETWEEN_WALLETS_MS = 2000; // 2 seconds delay to avoid rate limits

// Exclude test wallet from backfill
const EXCLUDE_WALLETS = [
  '0x780bb763e1463d2236fec780b7bd6adb40aaa120', // Test wallet
];

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function backfillSingleWallet(
  wallet: string,
  walletIndex: number,
  totalWallets: number
): Promise<{ wallet: string; eventsFound: number; success: boolean; durationMs: number }> {
  const startTime = Date.now();

  try {
    const { backfillWalletHistory } = await import('../services/avantis-listener');

    console.log(`\n${'='.repeat(70)}`);
    console.log(`Wallet ${walletIndex}/${totalWallets}: ${wallet}`);
    console.log('='.repeat(70));

    const result = await backfillWalletHistory(wallet, DAYS_TO_BACKFILL);

    const durationMs = Date.now() - startTime;

    if (result.success) {
      console.log(`✅ Success: ${result.eventsFound} events found in ${(durationMs / 1000).toFixed(1)}s`);
    } else {
      console.log(`❌ Failed after ${(durationMs / 1000).toFixed(1)}s`);
    }

    return {
      wallet,
      eventsFound: result.eventsFound,
      success: result.success,
      durationMs,
    };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    console.error(`❌ Error: ${error.message}`);

    return {
      wallet,
      eventsFound: 0,
      success: false,
      durationMs,
    };
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('Backfill Last 30 Days - All Active Avantis Wallets');
  console.log('='.repeat(70));
  console.log(`Started at: ${new Date().toLocaleString()}\n`);

  const overallStartTime = Date.now();

  try {
    // Import modules
    const { default: connectDB } = await import('../lib/mongoose');
    const { default: Position } = await import('../models/Position');
    const { verifyConnection } = await import('../services/avantis-listener/core/ViemClient');

    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await connectDB();
    console.log('✅ Connected to MongoDB\n');

    // Verify RPC connection
    console.log('🔌 Connecting to Base RPC...');
    const connected = await verifyConnection();
    if (!connected) {
      throw new Error('Failed to connect to Base RPC');
    }
    console.log('✅ Connected to Base RPC\n');

    // Load all wallets with active Avantis positions
    console.log('📍 Loading wallets with active Avantis positions...');
    const allWallets = await Position.distinct('walletAddress', {
      platform: 'Avantis',
      status: 'active',
    });

    // Filter out excluded wallets
    const wallets = allWallets.filter(
      wallet => !EXCLUDE_WALLETS.includes(wallet.toLowerCase())
    );

    console.log(`\nFound ${wallets.length} wallets to backfill (${allWallets.length - wallets.length} excluded):\n`);
    wallets.forEach((wallet, i) => {
      console.log(`  ${i + 1}. ${wallet}`);
    });
    console.log();

    if (wallets.length === 0) {
      console.log('⚠️  No active Avantis positions found. Exiting.');
      process.exit(0);
    }

    console.log(`\n📅 Backfilling last ${DAYS_TO_BACKFILL} days per wallet`);
    console.log(`⏱️  ${DELAY_BETWEEN_WALLETS_MS}ms delay between wallets\n`);

    console.log('='.repeat(70));
    console.log('Starting Sequential Backfill...');
    console.log('='.repeat(70));

    // Process wallets sequentially with delays
    const results = [];

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];

      // Backfill this wallet
      const result = await backfillSingleWallet(wallet, i + 1, wallets.length);
      results.push(result);

      // Add delay between wallets (except after last one)
      if (i < wallets.length - 1) {
        console.log(`\n⏳ Waiting ${DELAY_BETWEEN_WALLETS_MS}ms before next wallet...`);
        await sleep(DELAY_BETWEEN_WALLETS_MS);
      }
    }

    // Overall Summary
    const overallDurationMs = Date.now() - overallStartTime;

    console.log('\n' + '='.repeat(70));
    console.log('✅ 30-Day Backfill Complete');
    console.log('='.repeat(70));

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const totalEvents = results.reduce((sum, r) => sum + r.eventsFound, 0);
    const walletsWithEvents = results.filter(r => r.eventsFound > 0);

    console.log(`\n📊 Summary:`);
    console.log(`   Total Wallets: ${wallets.length}`);
    console.log(`   Successful: ${successful}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Total Events Found: ${totalEvents}`);
    console.log(`   Total Duration: ${(overallDurationMs / 1000 / 60).toFixed(1)} minutes\n`);

    if (walletsWithEvents.length > 0) {
      console.log('📈 Wallets with events:');
      walletsWithEvents.forEach(r => {
        console.log(`   • ${r.wallet.substring(0, 10)}... - ${r.eventsFound} events (${(r.durationMs / 1000).toFixed(1)}s)`);
      });
      console.log();
    }

    if (failed > 0) {
      const failedWallets = results.filter(r => !r.success);
      console.log('⚠️  Failed wallets:');
      failedWallets.forEach(r => {
        console.log(`   • ${r.wallet.substring(0, 10)}...`);
      });
      console.log();
    }

    console.log(`Finished at: ${new Date().toLocaleString()}`);
    console.log('='.repeat(70) + '\n');

    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ Fatal Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
