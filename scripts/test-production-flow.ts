/**
 * Production Flow Test
 *
 * This script performs a complete end-to-end test of the Polymarket tracker:
 * 1. Clears all existing data
 * 2. Fetches fresh data from API
 * 3. Verifies data integrity
 * 4. Displays comprehensive summary
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
import { fetchOpenPositionsQuick, fetchClosedPositionsBackground } from '../services/polymarket-tracker/services/initialFetch';
import { computeMetrics } from '../services/polymarket-tracker/services/metrics';

const WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('POLYMARKET TRACKER - PRODUCTION FLOW TEST');
  console.log('='.repeat(80) + '\n');

  try {
    // Connect to MongoDB
    console.log('📡 Connecting to MongoDB...');
    await connectDB();
    console.log('✅ Connected to MongoDB\n');

    // Step 1: Clear all existing data
    console.log('🗑️  Step 1: Clearing all existing data...');
    const [openDeleted, closedDeleted, tradesDeleted] = await Promise.all([
      PolymarketOpenPosition.deleteMany({ walletAddress: WALLET.toLowerCase() }),
      PolymarketClosedPosition.deleteMany({ walletAddress: WALLET.toLowerCase() }),
      PolymarketTrade.deleteMany({ walletAddress: WALLET.toLowerCase() })
    ]);

    console.log(`   - Deleted ${openDeleted.deletedCount} open positions`);
    console.log(`   - Deleted ${closedDeleted.deletedCount} closed positions`);
    console.log(`   - Deleted ${tradesDeleted.deletedCount} trades`);
    console.log('✅ Data cleared\n');

    // Step 2: Fetch fresh data
    console.log('📥 Step 2: Fetching fresh data from Polymarket API...\n');

    console.log('   📊 Fetching open positions...');
    await fetchOpenPositionsQuick(WALLET);
    console.log('   ✅ Open positions fetched\n');

    console.log('   📊 Fetching closed positions...');
    await fetchClosedPositionsBackground(WALLET);
    console.log('   ✅ Closed positions fetched\n');

    // Step 3: Verify data integrity
    console.log('🔍 Step 3: Verifying data integrity...\n');

    // Get all data
    const [openPositions, closedPositions, trades] = await Promise.all([
      PolymarketOpenPosition.find({ walletAddress: WALLET.toLowerCase() }),
      PolymarketClosedPosition.find({ walletAddress: WALLET.toLowerCase() }),
      PolymarketTrade.find({ walletAddress: WALLET.toLowerCase() })
    ]);

    // Check for duplicates
    console.log('   🔎 Checking for duplicates...');

    // Open positions: unique by conditionId + asset
    const openKeys = openPositions.map(p => `${p.conditionId}_${p.asset}`);
    const uniqueOpenKeys = new Set(openKeys);
    const openDuplicates = openKeys.length - uniqueOpenKeys.size;

    // Closed positions: unique by tradeId
    const tradeIds = closedPositions.map(p => p.tradeId);
    const uniqueTradeIds = new Set(tradeIds);
    const closedDuplicates = tradeIds.length - uniqueTradeIds.size;

    // Trades: unique by transactionHash
    const txHashes = trades.map(t => t.transactionHash);
    const uniqueTxHashes = new Set(txHashes);
    const tradeDuplicates = txHashes.length - uniqueTxHashes.size;

    if (openDuplicates > 0) {
      console.log(`   ⚠️  Found ${openDuplicates} duplicate open positions!`);
    } else {
      console.log('   ✅ No duplicate open positions');
    }

    if (closedDuplicates > 0) {
      console.log(`   ⚠️  Found ${closedDuplicates} duplicate closed positions!`);
    } else {
      console.log('   ✅ No duplicate closed positions');
    }

    if (tradeDuplicates > 0) {
      console.log(`   ⚠️  Found ${tradeDuplicates} duplicate trades!`);
    } else {
      console.log('   ✅ No duplicate trades');
    }

    // Step 4: Compute metrics
    console.log('\n📊 Step 4: Computing metrics...\n');
    const metrics = await computeMetrics(WALLET);

    // Step 5: Display comprehensive summary
    console.log('\n' + '='.repeat(80));
    console.log('PRODUCTION TEST RESULTS');
    console.log('='.repeat(80) + '\n');

    console.log('📈 DATA COUNTS:');
    console.log(`   Open Positions:   ${openPositions.length}`);
    console.log(`   Closed Positions: ${closedPositions.length}`);
    console.log(`   Trades:           ${trades.length}`);

    console.log('\n💰 PERFORMANCE METRICS:');
    console.log(`   Total PnL:        $${metrics.totalPnl.toFixed(2)}`);
    console.log(`   Total Bet:        $${metrics.totalBet.toFixed(2)}`);
    console.log(`   ROI:              ${metrics.roi.toFixed(2)}%`);
    console.log(`   Win Rate:         ${metrics.winRate.toFixed(2)}%`);
    console.log(`   Total Trades:     ${metrics.totalTrades}`);
    console.log(`   Wins:             ${metrics.wins}`);
    console.log(`   Losses:           ${metrics.losses}`);

    console.log('\n📊 PNL BY PERIOD:');
    console.log(`   1 Day:            $${metrics.pnl1d.toFixed(2)}`);
    console.log(`   7 Days:           $${metrics.pnl7d.toFixed(2)}`);
    console.log(`   30 Days:          $${metrics.pnl30d.toFixed(2)}`);
    console.log(`   All Time:         $${metrics.totalPnl.toFixed(2)}`);

    console.log('\n✅ DATA INTEGRITY:');
    console.log(`   Open Positions:   ${openDuplicates === 0 ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`   Closed Positions: ${closedDuplicates === 0 ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`   Trades:           ${tradeDuplicates === 0 ? '✅ PASSED' : '❌ FAILED'}`);

    const allPassed = openDuplicates === 0 && closedDuplicates === 0 && tradeDuplicates === 0;

    console.log('\n' + '='.repeat(80));
    if (allPassed) {
      console.log('🎉 ALL TESTS PASSED - PRODUCTION READY!');
    } else {
      console.log('⚠️  SOME TESTS FAILED - PLEASE REVIEW');
    }
    console.log('='.repeat(80) + '\n');

    process.exit(allPassed ? 0 : 1);

  } catch (error: any) {
    console.error('\n❌ Error during production test:', error.message);
    console.error(error);
    process.exit(1);
  }
}

main();
