/**
 * Clear only open positions to fix duplicate index error
 */

import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import connectDB from '../lib/mongoose.js';
import PolymarketOpenPosition from '../models/PolymarketOpenPosition.js';

const WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('🗑️  CLEARING OPEN POSITIONS');
  console.log('='.repeat(80) + '\n');

  await connectDB();

  try {
    const count = await PolymarketOpenPosition.countDocuments({
      walletAddress: WALLET.toLowerCase()
    });

    console.log(`Found ${count} open positions\n`);

    if (count === 0) {
      console.log('✅ No positions to clear\n');
      process.exit(0);
    }

    const result = await PolymarketOpenPosition.deleteMany({
      walletAddress: WALLET.toLowerCase()
    });

    console.log(`✅ Deleted ${result.deletedCount} open positions\n`);
    console.log('='.repeat(80));
    console.log('✨ Open positions cleared!');
    console.log('   Restart the tracker to fetch fresh open positions');
    console.log('='.repeat(80) + '\n');

    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
