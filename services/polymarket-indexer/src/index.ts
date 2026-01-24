/**
 * Polymarket Trader Indexer - Railway Cron Service
 *
 * Indexes top traders' positions, trades, and profiles to MongoDB.
 * Designed to run as a cron job on Railway.
 *
 * Environment Variables:
 *   MONGODB_URI - MongoDB connection string (required)
 *   PM_WALLETS - Comma-separated list of wallets to index (optional)
 *   INDEX_INTERVAL_MS - Interval between wallet checks in ms (default: 5000)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Import from polymarket-tracker services
import { fetchOpenPositionsQuick, fetchClosedPositionsBackground } from '../../polymarket-tracker/services/initialFetch';
import { computeMetrics, saveMetrics } from '../../polymarket-tracker/services/metrics';

// Models
import PolymarketTrade from '../../../models/PolymarketTrade';
import PolymarketOpenPosition from '../../../models/PolymarketOpenPosition';
import PolymarketClosedPosition from '../../../models/PolymarketClosedPosition';
import { TraderProfile } from '../../../models/TraderProfile';

const INDEX_INTERVAL_MS = parseInt(process.env.INDEX_INTERVAL_MS || '5000');

interface IndexResult {
  wallet: string;
  success: boolean;
  openPositions?: number;
  closedPositions?: number;
  error?: string;
}

/**
 * Get wallets to index from:
 * 1. Environment variable (PM_WALLETS)
 * 2. TraderProfile collection in MongoDB (existing profiles)
 */
async function getWalletsToIndex(): Promise<string[]> {
  const wallets = new Set<string>();

  // From environment
  const envWallets = process.env.PM_WALLETS?.split(',').map(w => w.trim().toLowerCase()) || [];
  envWallets.forEach(w => {
    if (w) wallets.add(w);
  });

  // From MongoDB - existing trader profiles
  try {
    const profiles = await TraderProfile.find({}, { wallet: 1 });
    profiles.forEach((p: any) => {
      if (p.wallet) wallets.add(p.wallet.toLowerCase());
    });
  } catch (error: any) {
    console.error('[Indexer] Error fetching wallets from DB:', error.message);
  }

  return Array.from(wallets);
}

/**
 * Index a single wallet
 */
async function indexWallet(walletAddress: string): Promise<IndexResult> {
  console.log(`\n[Indexer] 📊 Indexing ${walletAddress}...`);

  try {
    // Step 1: Fetch open positions
    console.log(`[Indexer] Fetching open positions...`);
    await fetchOpenPositionsQuick(walletAddress);

    // Step 2: Fetch closed positions
    console.log(`[Indexer] Fetching closed positions...`);
    await fetchClosedPositionsBackground(walletAddress);

    // Step 3: Compute and save metrics
    console.log(`[Indexer] Computing metrics...`);
    const metrics = await computeMetrics(walletAddress);
    await saveMetrics(walletAddress, metrics);

    // Count results
    const openCount = await PolymarketOpenPosition.countDocuments({ walletAddress });
    const closedCount = await PolymarketClosedPosition.countDocuments({ walletAddress });

    console.log(`[Indexer] ✅ ${walletAddress}:`);
    console.log(`   Open positions: ${openCount}`);
    console.log(`   Closed positions: ${closedCount}`);
    console.log(`   Win rate: ${metrics.winRate?.toFixed(1)}%`);
    console.log(`   Net PnL: $${metrics.netPnl?.toFixed(2)}`);

    return {
      wallet: walletAddress,
      success: true,
      openPositions: openCount,
      closedPositions: closedCount
    };
  } catch (error: any) {
    console.error(`[Indexer] ❌ Error indexing ${walletAddress}:`, error.message);
    return {
      wallet: walletAddress,
      success: false,
      error: error.message
    };
  }
}

/**
 * Main indexer function
 */
async function runIndexer() {
  console.log('\n' + '═'.repeat(60));
  console.log('       POLYMARKET TRADER INDEXER');
  console.log('═'.repeat(60));
  console.log(`Started at: ${new Date().toISOString()}`);

  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('[Indexer] ❌ MONGODB_URI not set');
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri);
    console.log('[Indexer] ✅ Connected to MongoDB');
  } catch (error: any) {
    console.error('[Indexer] ❌ MongoDB connection failed:', error.message);
    process.exit(1);
  }

  // Get wallets to index
  const wallets = await getWalletsToIndex();

  if (wallets.length === 0) {
    console.log('[Indexer] ⚠️  No wallets to index');
    console.log('[Indexer] Add wallets via:');
    console.log('  1. PM_WALLETS env var (comma-separated)');
    console.log('  2. TraderProfile collection in MongoDB');
    await mongoose.disconnect();
    return;
  }

  console.log(`[Indexer] 📋 Found ${wallets.length} wallet(s) to index`);

  // Index each wallet
  const results: IndexResult[] = [];

  for (const wallet of wallets) {
    const result = await indexWallet(wallet);
    results.push(result);

    // Delay between wallets to avoid rate limiting
    if (wallets.indexOf(wallet) < wallets.length - 1) {
      await new Promise(r => setTimeout(r, INDEX_INTERVAL_MS));
    }
  }

  // Summary
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalOpen = results.reduce((sum, r) => sum + (r.openPositions || 0), 0);
  const totalClosed = results.reduce((sum, r) => sum + (r.closedPositions || 0), 0);

  console.log('\n' + '═'.repeat(60));
  console.log('       INDEXER COMPLETE');
  console.log('═'.repeat(60));
  console.log(`Wallets indexed: ${successful}/${wallets.length}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total open positions: ${totalOpen}`);
  console.log(`Total closed positions: ${totalClosed}`);
  console.log(`Completed at: ${new Date().toISOString()}`);
  console.log('═'.repeat(60) + '\n');

  await mongoose.disconnect();
}

// Run the indexer
runIndexer().catch(error => {
  console.error('[Indexer] Fatal error:', error);
  process.exit(1);
});
