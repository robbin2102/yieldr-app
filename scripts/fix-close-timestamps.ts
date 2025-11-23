/**
 * Manual script to correct close timestamps for all closed trades
 * Run this to fix the negative duration issue
 */

import { correctCloseTimestamps } from '../services/avantis-listener/Backfiller';
import connectDB from '../lib/mongoose';

async function main() {
  try {
    console.log('🔧 Starting close timestamp correction...');

    // Connect to MongoDB
    await connectDB();
    console.log('✓ MongoDB connected');

    // Run correction for ALL closed trades (no wallet filter)
    const result = await correctCloseTimestamps();

    console.log('\n✅ Timestamp correction complete!');
    console.log(`   - Trades corrected: ${result.corrected}`);
    console.log(`   - Unique blocks fetched: ${result.uniqueBlocks}`);
    console.log(`   - Duration: ${(result.durationMs / 1000).toFixed(1)}s`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Timestamp correction failed:', error);
    process.exit(1);
  }
}

main();
