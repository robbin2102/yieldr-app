#!/usr/bin/env ts-node

/**
 * Cleanup Script - Delete SKIPPED trades from MongoDB
 *
 * This removes all trades with status='SKIPPED' from the database.
 * Run this before starting Phase 1 testing to clean up corrupt records.
 *
 * Usage:
 *   npx ts-node cleanup-skipped.ts
 */

import mongoose from 'mongoose';
import { config } from './src/config';
import { PolyAgentTrade } from './src/db/models/PolyAgentTrade';

async function cleanup() {
  console.log('[Cleanup] Connecting to MongoDB...');
  await mongoose.connect(config.mongoUri);

  console.log('[Cleanup] Finding SKIPPED trades...');
  const skippedTrades = await PolyAgentTrade.find({ status: 'SKIPPED' });

  console.log(`[Cleanup] Found ${skippedTrades.length} SKIPPED trade(s)`);

  if (skippedTrades.length > 0) {
    console.log('\nRecords to delete:');
    for (const trade of skippedTrades) {
      console.log(`  - ${trade._id} | ${trade.originalTxHash?.slice(0, 10)}... | Reason: ${trade.skipReason}`);
    }

    const result = await PolyAgentTrade.deleteMany({ status: 'SKIPPED' });
    console.log(`\n[Cleanup] ✅ Deleted ${result.deletedCount} record(s)`);
  } else {
    console.log('[Cleanup] No SKIPPED records found - database is clean');
  }

  await mongoose.connection.close();
  console.log('[Cleanup] Done! 👋');
}

cleanup().catch((error) => {
  console.error('[Cleanup] Error:', error);
  process.exit(1);
});
