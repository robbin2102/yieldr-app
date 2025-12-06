/**
 * Drop old MongoDB indexes that are blocking inserts
 */

import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import connectDB from '../lib/mongoose.js';
import PolymarketClosedPosition from '../models/PolymarketClosedPosition.js';

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('🗑️  DROPPING OLD MONGODB INDEXES');
  console.log('='.repeat(80) + '\n');

  await connectDB();

  try {
    // Get all indexes
    const indexes = await PolymarketClosedPosition.collection.getIndexes();

    console.log('📋 Current indexes:\n');
    Object.keys(indexes).forEach(indexName => {
      console.log(`  - ${indexName}`);
      console.log(`    ${JSON.stringify(indexes[indexName])}\n`);
    });

    // Drop the problematic compound index
    const indexToDrop = 'walletAddress_1_conditionId_1_closedAt_1';

    if (indexes[indexToDrop]) {
      console.log(`🗑️  Dropping index: ${indexToDrop}...\n`);
      await PolymarketClosedPosition.collection.dropIndex(indexToDrop);
      console.log(`✅ Successfully dropped ${indexToDrop}\n`);
    } else {
      console.log(`ℹ️  Index ${indexToDrop} not found (already dropped or never existed)\n`);
    }

    // Show remaining indexes
    const remainingIndexes = await PolymarketClosedPosition.collection.getIndexes();

    console.log('📋 Remaining indexes:\n');
    Object.keys(remainingIndexes).forEach(indexName => {
      console.log(`  - ${indexName}`);
    });

    console.log('\n' + '='.repeat(80));
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
