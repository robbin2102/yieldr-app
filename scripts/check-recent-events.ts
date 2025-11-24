/**
 * Check Recent Avantis Events - Based on Proven Backfiller
 *
 * Checks last 10 minutes of blockchain events for all wallets
 * with open Avantis positions.
 *
 * Uses the same proven logic as backfill-single-wallet.ts
 *
 * Usage: npx tsx scripts/check-recent-events.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

const MINUTES_TO_CHECK = 10;
const BLOCKS_PER_MINUTE = 120; // Base chain: 2 blocks/sec = 120 blocks/min
const BLOCKS_TO_CHECK = MINUTES_TO_CHECK * BLOCKS_PER_MINUTE; // 1200 blocks

// Exclude test wallet from monitoring
const EXCLUDE_WALLETS = [
  '0x780bb763e1463d2236fec780b7bd6adb40aaa120', // Test wallet
];

async function checkRecentEventsForWallet(
  wallet: string,
  startBlock: bigint,
  endBlock: bigint
): Promise<{ wallet: string; eventsFound: number; success: boolean }> {
  try {
    const { backfillWallet } = await import('../services/avantis-listener/Backfiller');
    const { initializePairsCache } = await import('../services/avantis-listener/config/pairs');

    console.log(`\n📍 Checking wallet: ${wallet.substring(0, 10)}...`);
    console.log(`   Block range: ${startBlock} to ${endBlock}`);

    // Initialize pairs cache (required for processing)
    await initializePairsCache();

    // Use the proven backfillWallet function with specific block range
    const result = await backfillWallet({
      wallet,
      startBlock: Number(startBlock),
      endBlock: Number(endBlock),
      chunkSize: 2000, // Small chunk size for recent data
      parallelChunks: 2,
    });

    console.log(`   ✓ Found ${result.eventsFound} events`);

    return {
      wallet,
      eventsFound: result.eventsFound,
      success: result.success,
    };
  } catch (error: any) {
    console.error(`   ❌ Error checking wallet ${wallet}:`, error.message);
    return {
      wallet,
      eventsFound: 0,
      success: false,
    };
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('Check Recent Avantis Events (Last 10 Minutes)');
  console.log('='.repeat(70));
  console.log(`Started at: ${new Date().toLocaleString()}\n`);

  try {
    // Import modules
    const { default: connectDB } = await import('../lib/mongoose');
    const { default: Position } = await import('../models/Position');
    const { getLatestBlockNumber } = await import('../services/avantis-listener/core/ViemClient');
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

    console.log(`Found ${wallets.length} wallets to check (${allWallets.length - wallets.length} excluded):\n`);
    wallets.forEach((wallet, i) => {
      console.log(`  ${i + 1}. ${wallet}`);
    });
    console.log();

    if (wallets.length === 0) {
      console.log('⚠️  No active Avantis positions found. Exiting.');
      process.exit(0);
    }

    // Calculate block range (last 10 minutes)
    const latestBlock = await getLatestBlockNumber();
    const startBlock = latestBlock - BigInt(BLOCKS_TO_CHECK);

    console.log('📦 Block Range:');
    console.log(`  Latest: ${latestBlock}`);
    console.log(`  From: ${startBlock} (last ~${MINUTES_TO_CHECK} minutes)`);
    console.log(`  Range: ${BLOCKS_TO_CHECK} blocks\n`);

    console.log('='.repeat(70));
    console.log('Processing all wallets in parallel...');
    console.log('='.repeat(70));

    // Process all wallets in parallel
    const results = await Promise.all(
      wallets.map(wallet =>
        checkRecentEventsForWallet(wallet, startBlock, latestBlock)
      )
    );

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('✅ Recent Events Check Complete');
    console.log('='.repeat(70));

    const successful = results.filter(r => r.success).length;
    const totalEvents = results.reduce((sum, r) => sum + r.eventsFound, 0);
    const walletsWithEvents = results.filter(r => r.eventsFound > 0);

    console.log(`Total Wallets Checked: ${wallets.length}`);
    console.log(`Successful: ${successful}`);
    console.log(`Failed: ${wallets.length - successful}`);
    console.log(`Total Events Found: ${totalEvents}\n`);

    if (walletsWithEvents.length > 0) {
      console.log('Wallets with new events:');
      walletsWithEvents.forEach(r => {
        console.log(`  • ${r.wallet.substring(0, 10)}... - ${r.eventsFound} events`);
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
