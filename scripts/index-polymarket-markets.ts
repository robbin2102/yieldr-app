#!/usr/bin/env ts-node

/**
 * Polymarket Markets Indexer Script
 *
 * Fetches all Polymarket markets ending within 30 days with $50k+ volume,
 * then fetches top 15 holders for each market side.
 *
 * Usage:
 *   npm run polymarket:index-markets
 *   npm run polymarket:fetch-holders
 *   npm run polymarket:full-index
 *
 * Options:
 *   --markets-only      Only index markets, skip holders
 *   --holders-only      Only fetch holders for existing markets
 *   --days=N            Days ahead to look for markets (default: 30)
 *   --min-volume=N      Minimum volume filter (default: 50000)
 *   --categories=x,y    Filter by tags (default: sports, politics, economics, finance)
 *   --all-categories    Fetch all categories (no tag filtering)
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' }); // Load .env.local first (Railway MongoDB)
dotenv.config(); // Fallback to .env if .env.local doesn't have the var
import mongoose from 'mongoose';
import {
  indexMarketsEndingWithinDays,
  getMarketsSummary,
} from '../services/polymarket-tracker/services/marketIndexer';
import {
  fetchHoldersForAllMarkets,
  getTopHoldersAcrossAllMarkets,
} from '../services/polymarket-tracker/services/holdersFetcher';

// Default target categories for copy trading
const DEFAULT_CATEGORIES = ['sports', 'politics', 'economics', 'finance'];

// Parse command line arguments
function parseArgs(): {
  marketsOnly: boolean;
  holdersOnly: boolean;
  days: number;
  minVolume: number;
  categories: string[];
  allCategories: boolean;
} {
  const args = process.argv.slice(2);
  let marketsOnly = false;
  let holdersOnly = false;
  let days = 30;
  let minVolume = 50000;
  let categories = DEFAULT_CATEGORIES;
  let allCategories = false;

  args.forEach((arg) => {
    if (arg === '--markets-only') marketsOnly = true;
    if (arg === '--holders-only') holdersOnly = true;
    if (arg === '--all-categories') allCategories = true;
    if (arg.startsWith('--days=')) days = parseInt(arg.split('=')[1], 10);
    if (arg.startsWith('--min-volume=')) minVolume = parseInt(arg.split('=')[1], 10);
    if (arg.startsWith('--categories=')) {
      categories = arg.split('=')[1].split(',').map(s => s.trim());
    }
  });

  // If --all-categories, don't filter
  if (allCategories) {
    categories = [];
  }

  return { marketsOnly, holdersOnly, days, minVolume, categories, allCategories };
}

async function connectToMongo(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    console.error('❌ MONGODB_URI not found in environment');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');

  try {
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');
  } catch (error) {
    console.error('❌ Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { marketsOnly, holdersOnly, days, minVolume, categories, allCategories } = parseArgs();

  console.log('\n');
  console.log('████████████████████████████████████████████████████████████████');
  console.log('█                                                              █');
  console.log('█              POLYMARKET MARKETS INDEXER                      █');
  console.log('█                                                              █');
  console.log('████████████████████████████████████████████████████████████████');
  console.log('\n');
  console.log(`  Days: ${days}`);
  console.log(`  Min Volume: $${minVolume.toLocaleString()}`);
  console.log(`  Tags: ${allCategories ? 'ALL (no tag filter)' : categories.join(', ')}`);
  console.log(`  Top Holders per side: 15`);
  console.log('\n');

  // Connect to MongoDB
  await connectToMongo();

  try {
    // Step 1: Index markets (unless holders-only)
    if (!holdersOnly) {
      console.log('📊 STEP 1: Indexing markets ending within', days, 'days...\n');

      const marketResult = await indexMarketsEndingWithinDays(days, minVolume, categories);

      console.log('\n📈 Market Index Results:');
      console.log(`   Total fetched: ${marketResult.totalFetched}`);
      console.log(`   Inserted: ${marketResult.inserted}`);
      console.log(`   Updated: ${marketResult.updated}`);
      console.log(`   Failed: ${marketResult.failed}`);
      console.log(`   Duration: ${(marketResult.durationMs / 1000).toFixed(2)}s`);
      console.log('\n');
    }

    // Step 2: Fetch holders (unless markets-only)
    if (!marketsOnly) {
      console.log('👥 STEP 2: Fetching top 15 holders for each market side...\n');

      const holdersResult = await fetchHoldersForAllMarkets();

      console.log('\n📈 Holders Fetch Results:');
      console.log(`   Markets processed: ${holdersResult.marketsProcessed}`);
      console.log(`   Holders inserted: ${holdersResult.holdersInserted}`);
      console.log(`   Holders updated: ${holdersResult.holdersUpdated}`);
      console.log(`   Failed: ${holdersResult.failed}`);
      console.log(`   Unique wallets: ${holdersResult.uniqueWallets}`);
      console.log(`   Duration: ${(holdersResult.durationMs / 1000).toFixed(2)}s`);
      console.log('\n');
    }

    // Step 3: Summary
    console.log('📊 FINAL SUMMARY:\n');

    const summary = await getMarketsSummary();

    console.log('Markets in database:');
    console.log(`   Total: ${summary.total}`);
    console.log(`   Ending in 7 days: ${summary.endingIn7Days}`);
    console.log(`   Ending in 30 days: ${summary.endingIn30Days}`);
    console.log(`   Holders indexed: ${summary.holdersIndexed}`);
    console.log(`   Holders not indexed: ${summary.holdersNotIndexed}`);

    console.log('\nBy Category:');
    Object.entries(summary.byCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([cat, count]) => {
        console.log(`   ${cat}: ${count}`);
      });

    // Show top holders if we fetched them
    if (!marketsOnly) {
      console.log('\n🏆 Top 10 Holders Across All Markets:');

      const topHolders = await getTopHoldersAcrossAllMarkets(10);

      topHolders.forEach((holder, i) => {
        console.log(`   ${i + 1}. ${holder.wallet.substring(0, 10)}...`);
        console.log(`      Total: ${holder.totalAmount.toLocaleString()} shares`);
        console.log(`      Markets: ${holder.marketCount}`);
      });
    }

    console.log('\n');
    console.log('████████████████████████████████████████████████████████████████');
    console.log('█                     INDEXING COMPLETE                        █');
    console.log('████████████████████████████████████████████████████████████████');
    console.log('\n');
  } catch (error) {
    console.error('❌ Error during indexing:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  }
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
