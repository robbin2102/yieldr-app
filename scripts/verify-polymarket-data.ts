/**
 * Quick script to verify Polymarket data in MongoDB
 */

import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import connectDB from '../lib/mongoose';
import PolymarketOpenPosition from '../models/PolymarketOpenPosition';
import PolymarketClosedPosition from '../models/PolymarketClosedPosition';
import PolymarketTrade from '../models/PolymarketTrade';

const walletAddress = '0xcde6e9587582e568041e1aa0ea0b01793e1311d7';

async function verifyData() {
  await connectDB();

  console.log('\n' + '='.repeat(80));
  console.log('POLYMARKET DATA VERIFICATION');
  console.log('='.repeat(80));
  console.log(`Wallet: ${walletAddress}\n`);

  // Open Positions
  const openPositions = await PolymarketOpenPosition.find({
    walletAddress: walletAddress.toLowerCase(),
  })
    .sort({ cashPnl: -1 })
    .lean();

  console.log(`📊 OPEN POSITIONS: ${openPositions.length}`);
  console.log('─'.repeat(80));

  openPositions.slice(0, 10).forEach((pos, i) => {
    console.log(`${i + 1}. ${pos.title}`);
    console.log(`   Outcome: ${pos.outcome} | Size: ${pos.size.toFixed(2)} | Avg: $${pos.avgPrice.toFixed(3)} | Cur: $${pos.curPrice.toFixed(3)}`);
    console.log(`   PnL: $${pos.cashPnl.toFixed(2)} (${pos.percentPnl.toFixed(1)}%) | ROI: ${pos.roi.toFixed(1)}%`);
  });

  if (openPositions.length > 10) {
    console.log(`   ... and ${openPositions.length - 10} more`);
  }

  // Closed Positions
  const closedPositions = await PolymarketClosedPosition.find({
    walletAddress: walletAddress.toLowerCase(),
  })
    .sort({ closedAt: -1 })
    .lean();

  console.log(`\n📈 CLOSED POSITIONS: ${closedPositions.length} (last 30 days)`);
  console.log('─'.repeat(80));

  closedPositions.slice(0, 10).forEach((pos, i) => {
    const wonIcon = pos.won ? '✅' : '❌';
    console.log(`${i + 1}. ${wonIcon} ${pos.title}`);
    console.log(`   Outcome: ${pos.outcome} | Bought: ${pos.totalBought.toFixed(2)} @ $${pos.avgPrice.toFixed(3)}`);
    console.log(`   PnL: $${pos.realizedPnl.toFixed(2)} | ROI: ${pos.roi.toFixed(1)}% | Closed: ${new Date(pos.closedAt).toLocaleDateString()}`);
  });

  if (closedPositions.length > 10) {
    console.log(`   ... and ${closedPositions.length - 10} more`);
  }

  // Trades/Activity
  const trades = await PolymarketTrade.find({
    walletAddress: walletAddress.toLowerCase(),
  })
    .sort({ timestamp: -1 })
    .lean();

  console.log(`\n🔄 TRADES/ACTIVITY: ${trades.length}`);
  console.log('─'.repeat(80));

  if (trades.length === 0) {
    console.log('   No trade activity found (this might be expected if no trades in last 30 days)');
  } else {
    trades.slice(0, 10).forEach((trade, i) => {
      console.log(`${i + 1}. [${trade.activityType}] ${trade.title}`);
      console.log(`   ${trade.side || 'N/A'} ${trade.size.toFixed(2)} @ $${trade.price.toFixed(3)} = $${trade.usdcSize.toFixed(2)}`);
      console.log(`   Time: ${new Date(trade.timestamp).toLocaleString()}`);
    });
  }

  // Summary Stats
  const totalUnrealizedPnl = openPositions.reduce((sum, p) => sum + p.cashPnl, 0);
  const totalRealizedPnl = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
  const wins = closedPositions.filter(p => p.won).length;
  const losses = closedPositions.filter(p => !p.won).length;

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Open Positions: ${openPositions.length}`);
  console.log(`Closed Positions: ${closedPositions.length} (${wins}W / ${losses}L)`);
  console.log(`Win Rate: ${closedPositions.length > 0 ? ((wins / closedPositions.length) * 100).toFixed(1) : 0}%`);
  console.log(`Unrealized PnL: $${totalUnrealizedPnl.toFixed(2)}`);
  console.log(`Realized PnL: $${totalRealizedPnl.toFixed(2)}`);
  console.log(`Total PnL: $${(totalUnrealizedPnl + totalRealizedPnl).toFixed(2)}`);
  console.log('='.repeat(80) + '\n');

  console.log('✅ Compare these numbers with Polymarket UI:');
  console.log('   https://polymarket.com/@Lospapa?tab=positions\n');

  process.exit(0);
}

verifyData().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
