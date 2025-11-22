/**
 * Standalone Script: Backfill All Managers
 * Fetch historical Avantis trades for all verified managers
 *
 * Usage:
 *   npx tsx scripts/backfill-all-managers.ts [daysBack]
 *
 * Example:
 *   npx tsx scripts/backfill-all-managers.ts 90
 */

import dotenv from 'dotenv';
import { join } from 'path';

// Load environment variables from .env.local
dotenv.config({ path: join(process.cwd(), '.env.local') });

import { backfillMultipleWalletsHistory } from '../services/avantis-listener';
import { verifyConnection } from '../services/avantis-listener/core/ViemClient';
import connectDB from '../lib/mongodb';
import Manager from '../models/manager';

async function main() {
  console.log('='.repeat(60));
  console.log('Avantis Trade Backfill - All Managers');
  console.log('='.repeat(60));

  try {
    // Get days back from command line argument
    const daysBack = process.argv[2] ? parseInt(process.argv[2]) : 90;

    console.log(`\n📅 Backfilling last ${daysBack} days\n`);

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

    // Get all verified managers
    console.log('👥 Fetching verified managers...');
    const managers = await Manager.find({
      verified: true,
    }).select('username walletAddress avantisBackfillStatus');

    console.log(`✓ Found ${managers.length} verified managers\n`);

    if (managers.length === 0) {
      console.log('⚠️  No verified managers found. Exiting.');
      return;
    }

    // Extract wallet addresses
    const wallets = managers.map((m) => m.walletAddress);

    console.log('Managers to backfill:');
    managers.forEach((m, i) => {
      console.log(
        `  ${i + 1}. ${m.username} (${m.walletAddress}) - Status: ${m.avantisBackfillStatus || 'NOT_STARTED'}`
      );
    });

    console.log('\n' + '='.repeat(60));
    console.log('Starting backfill process...');
    console.log('='.repeat(60) + '\n');

    // Update backfill status to IN_PROGRESS
    for (const manager of managers) {
      manager.avantisBackfillStatus = 'IN_PROGRESS';
      manager.avantisBackfillStartedAt = new Date();
      manager.avantisBackfillError = null;
      await manager.save();
    }

    // Perform backfill
    const startTime = Date.now();
    const results = await backfillMultipleWalletsHistory(wallets, daysBack);
    const duration = Date.now() - startTime;

    // Update backfill status based on results
    for (let i = 0; i < managers.length; i++) {
      const manager = managers[i];
      const result = results[i];

      if (result.success) {
        manager.avantisBackfillStatus = 'COMPLETED';
        manager.avantisBackfillCompletedAt = new Date();
        manager.avantisLastBackfillBlock = result.endBlock;
      } else {
        manager.avantisBackfillStatus = 'FAILED';
        manager.avantisBackfillError = 'Backfill failed - check logs';
      }

      await manager.save();
    }

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('Backfill Complete!');
    console.log('='.repeat(60));

    const successful = results.filter((r) => r.success).length;
    const totalEvents = results.reduce((sum, r) => sum + r.eventsFound, 0);

    console.log(`\n✓ Processed ${managers.length} managers in ${(duration / 1000).toFixed(1)}s`);
    console.log(`✓ Successful: ${successful}/${managers.length}`);
    console.log(`✓ Total events found: ${totalEvents}`);

    console.log('\nDetailed Results:');
    results.forEach((result, i) => {
      const manager = managers[i];
      const icon = result.success ? '✓' : '✗';
      console.log(
        `  ${icon} ${manager.username}: ${result.eventsFound} events (${(result.durationMs / 1000).toFixed(1)}s)`
      );
    });

    console.log('\n✅ Backfill script completed successfully!\n');
  } catch (error) {
    console.error('\n❌ Backfill script failed:');
    console.error(error);
    process.exit(1);
  }
}

// Run the script
main()
  .then(() => {
    console.log('Exiting...');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
