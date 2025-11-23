/**
 * Update Avantis pairs in MongoDB
 * Run this to populate the pairs cache with known + newly discovered pairs
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .env.local BEFORE any other imports
config({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  try {
    console.log('🔧 Updating Avantis pairs cache...\n');

    // Dynamic imports to ensure env vars are loaded first
    const { initializePairsCache } = await import('../services/avantis-listener/PairsFetcher');
    const { default: connectDB } = await import('../lib/mongoose');

    // Connect to MongoDB
    await connectDB();
    console.log('✓ MongoDB connected\n');

    // Initialize and update pairs cache
    await initializePairsCache();

    console.log('\n✅ Pairs cache updated successfully!');
    console.log('   Check the "avantis_pairs" collection in MongoDB');

    process.exit(0);
  } catch (error) {
    console.error('❌ Pairs update failed:', error);
    process.exit(1);
  }
}

main();
