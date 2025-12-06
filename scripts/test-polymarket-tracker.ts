/**
 * Comprehensive Test Script for Polymarket Tracker
 *
 * Tests all 3 components:
 * 1. Open positions
 * 2. Closed positions (with correct PnL)
 * 3. Trades/activity
 */

import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import connectDB from '../lib/mongoose.js';
import { fetchOpenPositions } from '../services/polymarket-tracker/api/positions.js';
import { fetchClosedPositions } from '../services/polymarket-tracker/api/closedPositions.js';
import { fetchNewActivity } from '../services/polymarket-tracker/api/activity.js';
import PolymarketOpenPosition from '../models/PolymarketOpenPosition.js';
import PolymarketClosedPosition from '../models/PolymarketClosedPosition.js';
import PolymarketTrade from '../models/PolymarketTrade.js';

const WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 POLYMARKET TRACKER COMPREHENSIVE TEST');
  console.log('='.repeat(80) + '\n');

  await connectDB();

  try {
    // ========================================================================
    // TEST 1: OPEN POSITIONS
    // ========================================================================
    console.log('1️⃣  TESTING OPEN POSITIONS');
    console.log('─'.repeat(80) + '\n');

    const apiOpenPositions = await fetchOpenPositions(WALLET);
    console.log(`✅ API returned ${apiOpenPositions.length} open positions\n`);

    const mongoOpenCount = await PolymarketOpenPosition.countDocuments({
      walletAddress: WALLET.toLowerCase()
    });
    console.log(`📊 MongoDB has ${mongoOpenCount} open positions\n`);

    if (apiOpenPositions.length > 0) {
      console.log('Sample open position:');
      const pos = apiOpenPositions[0];
      console.log(`  Title: ${pos.title}`);
      console.log(`  Outcome: ${pos.outcome}`);
      console.log(`  Size: ${pos.size}`);
      console.log(`  Current Value: $${pos.currentValue.toFixed(2)}`);
      console.log(`  Unrealized PnL: $${pos.cashPnl.toFixed(2)}\n`);
    }

    // ========================================================================
    // TEST 2: CLOSED POSITIONS
    // ========================================================================
    console.log('2️⃣  TESTING CLOSED POSITIONS');
    console.log('─'.repeat(80) + '\n');

    const apiClosedPositions = await fetchClosedPositions(WALLET, 30);
    console.log(`✅ API returned ${apiClosedPositions.length} closed positions (30d)\n`);

    const mongoClosedCount = await PolymarketClosedPosition.countDocuments({
      walletAddress: WALLET.toLowerCase()
    });
    console.log(`📊 MongoDB has ${mongoClosedCount} closed positions\n`);

    // Calculate PnL from MongoDB
    const allClosed = await PolymarketClosedPosition
      .find({ walletAddress: WALLET.toLowerCase() })
      .lean();

    const totalPnL = allClosed.reduce((sum, p) => sum + p.realizedPnl, 0);
    const totalBet = allClosed.reduce((sum, p) => sum + p.totalBet, 0);

    console.log('💰 MongoDB PnL:');
    console.log(`  Total Bet: $${totalBet.toFixed(2)}`);
    console.log(`  Total PnL: $${totalPnL.toFixed(2)}`);
    console.log(`  ROI: ${totalBet > 0 ? ((totalPnL / totalBet) * 100).toFixed(2) : 0}%\n`);

    // ========================================================================
    // TEST 3: TRADES/ACTIVITY
    // ========================================================================
    console.log('3️⃣  TESTING TRADES/ACTIVITY');
    console.log('─'.repeat(80) + '\n');

    // Fetch last 24 hours of activity
    const oneDayAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
    const apiActivities = await fetchNewActivity(WALLET, oneDayAgo);
    console.log(`✅ API returned ${apiActivities.length} activities (last 24h)\n`);

    const mongoTradesCount = await PolymarketTrade.countDocuments({
      walletAddress: WALLET.toLowerCase()
    });
    console.log(`📊 MongoDB has ${mongoTradesCount} total trades\n`);

    // Get recent trades from MongoDB
    const recentTrades = await PolymarketTrade
      .find({ walletAddress: WALLET.toLowerCase() })
      .sort({ timestamp: -1 })
      .limit(5)
      .lean();

    if (recentTrades.length > 0) {
      console.log('Recent trades in MongoDB (last 5):');
      recentTrades.forEach((trade, idx) => {
        const action = trade.activityType === 'REDEEM'
          ? `REDEEM ${trade.size.toFixed(2)}`
          : `${trade.side} ${trade.size.toFixed(2)} @ $${trade.price.toFixed(3)}`;

        console.log(`  ${idx + 1}. [${new Date(trade.timestamp).toISOString()}] ${action}`);
        console.log(`     ${trade.outcome} - "${trade.title}"`);
        console.log(`     TX: ${trade.transactionHash.slice(0, 10)}...${trade.transactionHash.slice(-8)}\n`);
      });
    } else {
      console.log('⚠️  No trades found in MongoDB\n');
    }

    // ========================================================================
    // SUMMARY
    // ========================================================================
    console.log('='.repeat(80));
    console.log('📊 SUMMARY');
    console.log('='.repeat(80) + '\n');

    const openMatch = apiOpenPositions.length === mongoOpenCount;
    const closedMatch = apiClosedPositions.length === mongoClosedCount;

    console.log(`Open Positions:   ${openMatch ? '✅' : '❌'} API: ${apiOpenPositions.length} | MongoDB: ${mongoOpenCount}`);
    console.log(`Closed Positions: ${closedMatch ? '✅' : '❌'} API: ${apiClosedPositions.length} | MongoDB: ${mongoClosedCount}`);
    console.log(`Trades:           📊 Total in MongoDB: ${mongoTradesCount}`);
    console.log(`                  📊 Last 24h from API: ${apiActivities.length}\n`);

    if (openMatch && closedMatch) {
      console.log('✅ All data synced correctly!\n');
    } else {
      console.log('⚠️  Data mismatch detected. Run:');
      console.log('   - npm run polymarket:fetch-all (to fix closed positions)');
      console.log('   - npm run polymarket:start (to start real-time tracking)\n');
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
