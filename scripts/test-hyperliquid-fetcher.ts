/**
 * Hyperliquid Fetcher Test Script
 * Tests fetching positions, trades, and computing metrics for a wallet
 *
 * Usage:
 *   npx tsx scripts/test-hyperliquid-fetcher.ts <wallet_address>
 *
 * Example:
 *   npx tsx scripts/test-hyperliquid-fetcher.ts 0x8af700ba841f30e0a3fcb0ee4c4a9d223e1efa05
 */

import dotenv from 'dotenv';
import path from 'path';

// Load environment
const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import mongoose from 'mongoose';
import { getClearinghouseState, getUserFills, getPortfolio } from '../services/monitors/hyperliquid/api';
import { fetchAndSavePositions, fetchAndSave30DayHistory } from '../services/monitors/hyperliquid/fetcher';
import { computeAndSaveMetrics } from '../services/monitors/hyperliquid/metrics';
import HyperliquidFill from '../models/HyperliquidFill';
import HyperliquidPosition from '../models/HyperliquidPosition';
import HyperliquidMetrics from '../models/HyperliquidMetrics';

async function main() {
  const wallet = process.argv[2];

  if (!wallet) {
    console.log('Usage: npx tsx scripts/test-hyperliquid-fetcher.ts <wallet_address>');
    console.log('Example: npx tsx scripts/test-hyperliquid-fetcher.ts 0x8af700ba841f30e0a3fcb0ee4c4a9d223e1efa05');
    process.exit(1);
  }

  const normalizedWallet = wallet.toLowerCase();

  console.log('\n' + '═'.repeat(60));
  console.log('       HYPERLIQUID FETCHER TEST');
  console.log('═'.repeat(60));
  console.log(`Wallet: ${normalizedWallet}`);
  console.log('═'.repeat(60) + '\n');

  // Step 1: Test API connectivity (no MongoDB)
  console.log('📡 STEP 1: Testing Hyperliquid API...');
  console.log('-'.repeat(60));

  try {
    // Test clearinghouse state
    console.log('  Fetching clearinghouse state...');
    const state = await getClearinghouseState(normalizedWallet);
    console.log(`  ✅ Account Value: $${state.marginSummary.accountValue}`);
    console.log(`  ✅ Total Margin Used: $${state.marginSummary.totalMarginUsed}`);
    console.log(`  ✅ Open Positions: ${state.assetPositions.length}`);

    if (state.assetPositions.length > 0) {
      console.log('\n  📊 Current Positions:');
      state.assetPositions.forEach((ap: any, i: number) => {
        const pos = ap.position;
        const side = parseFloat(pos.szi) > 0 ? 'LONG' : 'SHORT';
        console.log(`     ${i + 1}. ${pos.coin} ${side} | Size: ${pos.szi} | Entry: $${pos.entryPx} | PnL: $${pos.unrealizedPnl}`);
      });
    }

    // Test fills
    console.log('\n  Fetching recent fills...');
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const fills = await getUserFills(normalizedWallet, thirtyDaysAgo);
    console.log(`  ✅ Fills (30d): ${fills.length}`);

    if (fills.length > 0) {
      console.log('\n  📊 Last 5 Fills:');
      fills.slice(0, 5).forEach((f: any, i: number) => {
        const date = new Date(f.time).toISOString().slice(0, 16);
        console.log(`     ${i + 1}. [${date}] ${f.side} ${f.coin} | Size: ${f.sz} @ $${f.px} | PnL: $${f.closedPnl || '0'}`);
      });
    }

  } catch (error: any) {
    console.error('  ❌ API Error:', error.message);
    process.exit(1);
  }

  // Step 2: Connect to MongoDB and save data
  console.log('\n📦 STEP 2: Saving to MongoDB...');
  console.log('-'.repeat(60));

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.log('  ⚠️  MONGODB_URI not set - skipping MongoDB tests');
    console.log('  Set MONGODB_URI in .env.local to test full flow');
    process.exit(0);
  }

  try {
    await mongoose.connect(mongoUri);
    console.log('  ✅ Connected to MongoDB');

    // Fetch and save positions
    console.log('\n  Saving positions...');
    const posResult = await fetchAndSavePositions(normalizedWallet);
    console.log(`  ✅ Saved ${posResult.currentPositions} positions`);
    if (posResult.closedCoins.length > 0) {
      console.log(`  📊 Closed positions detected: ${posResult.closedCoins.join(', ')}`);
    }

    // Fetch and save 30-day fills
    console.log('\n  Saving 30-day trade history...');
    const fillsResult = await fetchAndSave30DayHistory(normalizedWallet);
    console.log(`  ✅ Fetched: ${fillsResult.totalFetched} | Saved: ${fillsResult.totalSaved} new | Duplicates: ${fillsResult.totalDuplicates}`);

    // Compute and save metrics
    console.log('\n  Computing metrics...');
    const metrics = await computeAndSaveMetrics(normalizedWallet);
    console.log(`  ✅ Metrics computed and saved`);

  } catch (error: any) {
    console.error('  ❌ MongoDB Error:', error.message);
  }

  // Step 3: Verify data in MongoDB
  console.log('\n📊 STEP 3: Verifying MongoDB Data...');
  console.log('-'.repeat(60));

  try {
    const fillCount = await HyperliquidFill.countDocuments({ walletAddress: normalizedWallet });
    const posCount = await HyperliquidPosition.countDocuments({ walletAddress: normalizedWallet });
    const metricsDoc = await HyperliquidMetrics.findOne({ walletAddress: normalizedWallet });

    console.log(`  📁 Fills in DB: ${fillCount}`);
    console.log(`  📁 Positions in DB: ${posCount}`);

    if (metricsDoc) {
      console.log('\n  📊 Computed Metrics:');
      console.log(`     Total Trades: ${metricsDoc.totalTrades}`);
      console.log(`     Win Rate: ${metricsDoc.winRate?.toFixed(1)}%`);
      console.log(`     Sharpe Ratio: ${metricsDoc.sharpeRatio?.toFixed(2)}`);
      console.log(`     Max Drawdown: ${metricsDoc.maxDrawdown?.toFixed(2)}%`);
      console.log(`     PnL (1d): $${metricsDoc.pnl?.day1?.toFixed(2)}`);
      console.log(`     PnL (7d): $${metricsDoc.pnl?.day7?.toFixed(2)}`);
      console.log(`     PnL (30d): $${metricsDoc.pnl?.day30?.toFixed(2)}`);
      console.log(`     PnL (All Time): $${metricsDoc.pnl?.allTime?.toFixed(2)}`);
    } else {
      console.log('  ⚠️  No metrics found');
    }

    // Show last 5 fills from DB
    const recentFills = await HyperliquidFill.find({ walletAddress: normalizedWallet })
      .sort({ time: -1 })
      .limit(5);

    if (recentFills.length > 0) {
      console.log('\n  📊 Last 5 Fills (from MongoDB):');
      recentFills.forEach((f: any, i: number) => {
        const date = new Date(f.time).toISOString().slice(0, 16);
        console.log(`     ${i + 1}. [${date}] ${f.side} ${f.coin} | Size: ${f.sz} @ $${f.px}`);
      });
    }

  } catch (error: any) {
    console.error('  ❌ Verification Error:', error.message);
  }

  await mongoose.disconnect();

  console.log('\n' + '═'.repeat(60));
  console.log('✅ HYPERLIQUID FETCHER TEST COMPLETE');
  console.log('═'.repeat(60) + '\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
