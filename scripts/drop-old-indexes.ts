/**
 * Drop old MongoDB indexes that are blocking inserts
 */

import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import connectDB from '../lib/mongoose.js';
import PolymarketClosedPosition from '../models/PolymarketClosedPosition.js';
import PolymarketOpenPosition from '../models/PolymarketOpenPosition.js';

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('🗑️  DROPPING OLD MONGODB INDEXES');
  console.log('='.repeat(80) + '\n');

  await connectDB();

  try {
    // ========================================================================
    // CLOSED POSITIONS
    // ========================================================================
    console.log('📋 CLOSED POSITIONS:\n');
    const closedIndexes = await PolymarketClosedPosition.collection.getIndexes();

    console.log('Current indexes:');
    Object.keys(closedIndexes).forEach(indexName => {
      console.log(`  - ${indexName}`);
    });
    console.log('');

    const closedIndexToDrop = 'walletAddress_1_conditionId_1_closedAt_1';

    if (closedIndexes[closedIndexToDrop]) {
      console.log(`🗑️  Dropping: ${closedIndexToDrop}...\n`);
      await PolymarketClosedPosition.collection.dropIndex(closedIndexToDrop);
      console.log(`✅ Dropped ${closedIndexToDrop}\n`);
    } else {
      console.log(`ℹ️  ${closedIndexToDrop} already dropped\n`);
    }

    // ========================================================================
    // OPEN POSITIONS
    // ========================================================================
    console.log('📋 OPEN POSITIONS:\n');
    const openIndexes = await PolymarketOpenPosition.collection.getIndexes();

    console.log('Current indexes:');
    Object.keys(openIndexes).forEach(indexName => {
      console.log(`  - ${indexName}`);
    });
    console.log('');

    const openIndexToDrop = 'walletAddress_1_conditionId_1';

    if (openIndexes[openIndexToDrop]) {
      console.log(`🗑️  Dropping: ${openIndexToDrop}...\n`);
      await PolymarketOpenPosition.collection.dropIndex(openIndexToDrop);
      console.log(`✅ Dropped ${openIndexToDrop}\n`);
    } else {
      console.log(`ℹ️  ${openIndexToDrop} already dropped\n`);
    }

    console.log('='.repeat(80));
    console.log('✅ Index cleanup complete!');
    console.log('='.repeat(80) + '\n');

    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
