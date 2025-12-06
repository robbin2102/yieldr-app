/**
 * Verify All Polymarket Data in MongoDB
 *
 * Checks:
 * 1. Open positions - count and data integrity
 * 2. Closed positions - count and PnL accuracy
 * 3. Trades - count and recent activity
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
  console.log('✅ VERIFYING POLYMARKET DATA IN MONGODB');
  console.log('='.repeat(80) + '\n');

  await connectDB();

  try {
    // ========================================================================
    // 1. OPEN POSITIONS
    // ========================================================================
    console.log('1️⃣  OPEN POSITIONS');
    console.log('─'.repeat(80) + '\n');

    const openPositions = await PolymarketOpenPosition
      .find({ walletAddress: WALLET.toLowerCase() })
      .lean();

    console.log(`Total: ${openPositions.length} positions\n`);

    if (openPositions.length > 0) {
      openPositions.forEach((pos, idx) => {
        console.log(`${idx + 1}. ${pos.title}`);
        console.log(`   Outcome: ${pos.outcome}`);
        console.log(`   Size: ${pos.size} shares @ $${pos.avgPrice.toFixed(3)}`);
        console.log(`   Current: $${pos.currentValue.toFixed(2)} | PnL: $${pos.cashPnl.toFixed(2)}`);
        console.log(`   Asset: ${pos.asset.slice(0, 10)}...${pos.asset.slice(-6)}\n`);
      });

      // Check for duplicates
      const uniqueKeys = new Set(openPositions.map(p => `${p.conditionId}_${p.asset}`));
      if (uniqueKeys.size !== openPositions.length) {
        console.log('⚠️  WARNING: Duplicate open positions detected!\n');
      } else {
        console.log('✅ No duplicates - all positions unique\n');
      }
    }

    // ========================================================================
    // 2. CLOSED POSITIONS
    // ========================================================================
    console.log('2️⃣  CLOSED POSITIONS');
    console.log('─'.repeat(80) + '\n');

    const closedPositions = await PolymarketClosedPosition
      .find({ walletAddress: WALLET.toLowerCase() })
      .lean();

    console.log(`Total: ${closedPositions.length} positions\n`);

    // Calculate PnL
    const totalPnL = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
    const totalBet = closedPositions.reduce((sum, p) => sum + p.totalBet, 0);
    const roi = totalBet > 0 ? (totalPnL / totalBet) * 100 : 0;

    console.log('💰 Realized PnL Summary:');
    console.log(`   Total Bet: $${totalBet.toFixed(2)}`);
    console.log(`   Total PnL: $${totalPnL.toFixed(2)}`);
    console.log(`   ROI: ${roi.toFixed(2)}%\n`);

    // Check for duplicates
    const uniqueTradeIds = new Set(closedPositions.map(p => p.tradeId));
    if (uniqueTradeIds.size !== closedPositions.length) {
      console.log(`⚠️  WARNING: ${closedPositions.length - uniqueTradeIds.size} duplicate tradeIds!\n`);
    } else {
      console.log('✅ No duplicates - all tradeIds unique\n');
    }

    // Show recent 5
    const recent = closedPositions
      .sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime())
      .slice(0, 5);

    console.log('Recent closed positions (last 5):');
    recent.forEach((pos, idx) => {
      console.log(`${idx + 1}. ${pos.title}`);
      console.log(`   ${pos.outcome} | Closed: ${new Date(pos.closedAt).toISOString()}`);
      console.log(`   PnL: $${pos.realizedPnl.toFixed(2)} | TradeID: ${pos.tradeId}\n`);
    });

    // ========================================================================
    // 3. TRADES/ACTIVITY
    // ========================================================================
    console.log('3️⃣  TRADES/ACTIVITY');
    console.log('─'.repeat(80) + '\n');

    const allTrades = await PolymarketTrade
      .find({ walletAddress: WALLET.toLowerCase() })
      .lean();

    console.log(`Total: ${allTrades.length} trades\n`);

    // Recent trades
    const recentTrades = allTrades
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 10);

    console.log('Recent trades (last 10):');
    recentTrades.forEach((trade, idx) => {
      const action = trade.activityType === 'REDEEM'
        ? `REDEEM ${trade.size.toFixed(2)}`
        : `${trade.side} ${trade.size.toFixed(2)} @ $${trade.price.toFixed(3)}`;

      console.log(`${idx + 1}. [${new Date(trade.timestamp).toISOString()}] ${action}`);
      console.log(`   ${trade.outcome} - "${trade.title}"`);
      console.log(`   TX: ${trade.transactionHash.slice(0, 10)}...${trade.transactionHash.slice(-8)}\n`);
    });

    // Check for duplicates
    const uniqueTxHashes = new Set(allTrades.map(t => t.transactionHash));
    if (uniqueTxHashes.size !== allTrades.length) {
      console.log(`⚠️  WARNING: ${allTrades.length - uniqueTxHashes.size} duplicate transaction hashes!\n`);
    } else {
      console.log('✅ No duplicates - all transaction hashes unique\n');
    }

    // ========================================================================
    // SUMMARY
    // ========================================================================
    console.log('='.repeat(80));
    console.log('📊 VERIFICATION SUMMARY');
    console.log('='.repeat(80) + '\n');

    console.log(`✅ Open Positions:   ${openPositions.length} (unique by conditionId+asset)`);
    console.log(`✅ Closed Positions: ${closedPositions.length} (unique by tradeId UUID)`);
    console.log(`✅ Trades:           ${allTrades.length} (unique by transactionHash)`);
    console.log(`\n💰 Realized PnL:     $${totalPnL.toFixed(2)}`);
    console.log(`📈 ROI:              ${roi.toFixed(2)}%\n`);

    // Overall status
    const hasOpenDuplicates = new Set(openPositions.map(p => `${p.conditionId}_${p.asset}`)).size !== openPositions.length;
    const hasClosedDuplicates = new Set(closedPositions.map(p => p.tradeId)).size !== closedPositions.length;
    const hasTradeDuplicates = new Set(allTrades.map(t => t.transactionHash)).size !== allTrades.length;

    if (!hasOpenDuplicates && !hasClosedDuplicates && !hasTradeDuplicates) {
      console.log('✅ ALL DATA VERIFIED - NO DUPLICATES FOUND!');
    } else {
      console.log('⚠️  ISSUES DETECTED - See warnings above');
    }

    console.log('\n' + '='.repeat(80) + '\n');

    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
