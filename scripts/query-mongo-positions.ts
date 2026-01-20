/**
 * Query MongoDB to verify closed positions data
 */

import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import connectDB from '../lib/mongoose.js';
import PolymarketClosedPosition from '../models/PolymarketClosedPosition.js';

const WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('📊 MONGODB CLOSED POSITIONS QUERY');
  console.log('='.repeat(80) + '\n');

  await connectDB();

  try {
    // Total count
    const totalCount = await PolymarketClosedPosition.countDocuments({
      walletAddress: WALLET.toLowerCase()
    });

    console.log(`✅ Total positions in MongoDB: ${totalCount}\n`);

    // Get date range
    const oldest = await PolymarketClosedPosition
      .findOne({ walletAddress: WALLET.toLowerCase() })
      .sort({ closedAt: 1 })
      .select('closedAt');

    const newest = await PolymarketClosedPosition
      .findOne({ walletAddress: WALLET.toLowerCase() })
      .sort({ closedAt: -1 })
      .select('closedAt');

    console.log('📅 Date Range:');
    console.log(`   Oldest: ${oldest?.closedAt.toISOString()}`);
    console.log(`   Newest: ${newest?.closedAt.toISOString()}\n`);

    // Calculate PnL
    const allPositions = await PolymarketClosedPosition
      .find({ walletAddress: WALLET.toLowerCase() })
      .lean();

    const totalPnL = allPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
    const totalBet = allPositions.reduce((sum, p) => sum + p.totalBet, 0);
    const roi = totalBet > 0 ? (totalPnL / totalBet) * 100 : 0;

    console.log('💰 PNL SUMMARY:');
    console.log('─'.repeat(80));
    console.log(`Total Bet:        $${totalBet.toFixed(2)}`);
    console.log(`Total PnL:        $${totalPnL.toFixed(2)}`);
    console.log(`ROI:              ${roi.toFixed(2)}%`);
    console.log('─'.repeat(80) + '\n');

    // Time-based PnL
    const now = Date.now();
    const cutoff1d = now - (24 * 60 * 60 * 1000);
    const cutoff7d = now - (7 * 24 * 60 * 60 * 1000);

    const positions1d = allPositions.filter(p => new Date(p.closedAt).getTime() >= cutoff1d);
    const positions7d = allPositions.filter(p => new Date(p.closedAt).getTime() >= cutoff7d);

    const pnl1d = positions1d.reduce((sum, p) => sum + p.realizedPnl, 0);
    const pnl7d = positions7d.reduce((sum, p) => sum + p.realizedPnl, 0);

    console.log('📊 TIME-BASED PNL:');
    console.log('─'.repeat(80));
    console.log(`1d  (last 24h):   ${positions1d.length} positions | PnL: $${pnl1d.toFixed(2)}`);
    console.log(`7d  (last 7d):    ${positions7d.length} positions | PnL: $${pnl7d.toFixed(2)}`);
    console.log(`30d (last 30d):   ${allPositions.length} positions | PnL: $${totalPnL.toFixed(2)}`);
    console.log('─'.repeat(80) + '\n');

    // Show sample positions
    console.log('📋 SAMPLE POSITIONS (most recent 5):');
    console.log('─'.repeat(80) + '\n');

    const samplePositions = await PolymarketClosedPosition
      .find({ walletAddress: WALLET.toLowerCase() })
      .sort({ closedAt: -1 })
      .limit(5)
      .lean();

    samplePositions.forEach((pos, idx) => {
      console.log(`${idx + 1}. ${pos.title}`);
      console.log(`   Outcome: ${pos.outcome}`);
      console.log(`   Closed: ${new Date(pos.closedAt).toISOString()}`);
      console.log(`   Bet: $${pos.totalBet.toFixed(2)} | PnL: $${pos.realizedPnl.toFixed(2)} | ROI: ${pos.roi.toFixed(2)}%`);
      console.log(`   TradeID: ${pos.tradeId}\n`);
    });

    // Check for duplicates
    console.log('🔍 CHECKING FOR DUPLICATE TRADES:');
    console.log('─'.repeat(80) + '\n');

    const tradeIds = allPositions.map(p => p.tradeId);
    const uniqueTradeIds = new Set(tradeIds);

    console.log(`Total positions:  ${allPositions.length}`);
    console.log(`Unique tradeIds:  ${uniqueTradeIds.size}`);
    console.log(`Duplicates:       ${allPositions.length - uniqueTradeIds.size}`);

    if (uniqueTradeIds.size === allPositions.length) {
      console.log(`\n✅ No duplicates - all tradeIds are unique!\n`);
    } else {
      console.log(`\n⚠️  Found ${allPositions.length - uniqueTradeIds.size} duplicate tradeIds\n`);
    }

    console.log('='.repeat(80) + '\n');

    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
