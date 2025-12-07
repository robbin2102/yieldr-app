/**
 * Clear all closed positions from MongoDB
 *
 * This is needed after fixing the upsert filter bug to remove
 * the positions that were overwritten due to missing 'asset' field
 */

import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import connectDB from '../lib/mongoose.js';
import PolymarketClosedPosition from '../models/PolymarketClosedPosition.js';

const TEST_WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function main() {
  console.log('\n🗑️  CLEARING CLOSED POSITIONS FROM MONGODB\n');
  console.log('='.repeat(80) + '\n');

  await connectDB();

  try {
    // Count existing positions
    const count = await PolymarketClosedPosition.countDocuments({
      walletAddress: TEST_WALLET.toLowerCase()
    });

    console.log(`Found ${count} closed positions for wallet ${TEST_WALLET}\n`);

    if (count === 0) {
      console.log('✅ No positions to clear\n');
      process.exit(0);
    }

    // Delete all closed positions
    const result = await PolymarketClosedPosition.deleteMany({
      walletAddress: TEST_WALLET.toLowerCase()
    });

    console.log(`✅ Deleted ${result.deletedCount} closed positions\n`);
    console.log('='.repeat(80));
    console.log('✨ Ready to re-fetch with fixed upsert logic!');
    console.log('   Run: npm run polymarket:refresh');
    console.log('='.repeat(80) + '\n');

    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
