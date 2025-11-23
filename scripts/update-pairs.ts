/**
 * Update Avantis pairs in MongoDB
 * Run this to populate the pairs cache with known + newly discovered pairs
 */

import { initializePairsCache, updatePairsCache } from '../services/avantis-listener/PairsFetcher';
import connectDB from '../lib/mongoose';

async function main() {
  try {
    console.log('🔧 Updating Avantis pairs cache...\n');

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
