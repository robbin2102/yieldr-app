/**
 * Clear ALL Polymarket data for a wallet
 * - Open positions
 * - Closed positions
 * - Trades/Activities
 */

import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import connectDB from '../lib/mongoose.js';
import PolymarketOpenPosition from '../models/PolymarketOpenPosition.js';
import PolymarketClosedPosition from '../models/PolymarketClosedPosition.js';
import PolymarketTrade from '../models/PolymarketTrade.js';

const WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('🗑️  CLEAR ALL POLYMARKET DATA');
  console.log('='.repeat(80) + '\n');

  await connectDB();

  try {
    console.log(`Wallet: ${WALLET}\n`);

    // Count existing data
    const openCount = await PolymarketOpenPosition.countDocuments({
      walletAddress: WALLET.toLowerCase()
    });

    const closedCount = await PolymarketClosedPosition.countDocuments({
      walletAddress: WALLET.toLowerCase()
    });

    const tradesCount = await PolymarketTrade.countDocuments({
      walletAddress: WALLET.toLowerCase()
    });

    console.log('📊 Current Data:');
    console.log('─'.repeat(80));
    console.log(`Open Positions:   ${openCount}`);
    console.log(`Closed Positions: ${closedCount}`);
    console.log(`Trades/Activity:  ${tradesCount}`);
    console.log('─'.repeat(80) + '\n');

    if (openCount + closedCount + tradesCount === 0) {
      console.log('✅ No data to clear\n');
      process.exit(0);
    }

    // Delete all data
    console.log('🗑️  Deleting data...\n');

    const [openResult, closedResult, tradesResult] = await Promise.all([
      PolymarketOpenPosition.deleteMany({ walletAddress: WALLET.toLowerCase() }),
      PolymarketClosedPosition.deleteMany({ walletAddress: WALLET.toLowerCase() }),
      PolymarketTrade.deleteMany({ walletAddress: WALLET.toLowerCase() })
    ]);

    console.log('✅ Deleted:');
    console.log('─'.repeat(80));
    console.log(`Open Positions:   ${openResult.deletedCount}`);
    console.log(`Closed Positions: ${closedResult.deletedCount}`);
    console.log(`Trades/Activity:  ${tradesResult.deletedCount}`);
    console.log('─'.repeat(80) + '\n');

    console.log('='.repeat(80));
    console.log('✨ All Polymarket data cleared!');
    console.log('='.repeat(80) + '\n');

    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
