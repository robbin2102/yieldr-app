/**
 * Manual script to correct close timestamps for all closed trades
 * Run this to fix the negative duration issue
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .env.local BEFORE any other imports
config({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  try {
    console.log('🔧 Starting close timestamp correction...');

    // Dynamic imports to ensure env vars are loaded first
    const { correctCloseTimestamps } = await import('../services/avantis-listener/Backfiller');
    const { default: connectDB } = await import('../lib/mongoose');

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
