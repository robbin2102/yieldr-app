/**
 * Hyperliquid Trader Indexer - Railway Cron Service
 *
 * Indexes top traders' positions, fills, and metrics to MongoDB.
 * Designed to run as a cron job on Railway.
 *
 * Environment Variables:
 *   MONGODB_URI - MongoDB connection string (required)
 *   HL_WALLETS - Comma-separated list of wallets to index (optional)
 *   INDEX_INTERVAL_MS - Interval between wallet checks in ms (default: 5000)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Import models
import MonitoredWallet from '../../../models/MonitoredWallet';
import HyperliquidFill from '../../../models/HyperliquidFill';
import HyperliquidPosition from '../../../models/HyperliquidPosition';
import HyperliquidMetrics from '../../../models/HyperliquidMetrics';

// Import monitor functions
import * as hyperliquidMonitor from '../../monitors/hyperliquid/monitor';

const INDEX_INTERVAL_MS = parseInt(process.env.INDEX_INTERVAL_MS || '5000');

interface IndexResult {
  wallet: string;
  success: boolean;
  newFills?: number;
  positions?: number;
  error?: string;
}

/**
 * Get wallets to index from:
 * 1. Environment variable (HL_WALLETS)
 * 2. MonitoredWallet collection in MongoDB
 */
async function getWalletsToIndex(): Promise<string[]> {
  const wallets = new Set<string>();

  // From environment
  const envWallets = process.env.HL_WALLETS?.split(',').map(w => w.trim().toLowerCase()) || [];
  envWallets.forEach(w => {
    if (w) wallets.add(w);
  });

  // From MongoDB
  try {
    const dbWallets = await MonitoredWallet.find({
      market: 'PERP',
      platform: 'HYPERLIQUID',
      status: 'active'
    });
    dbWallets.forEach(w => wallets.add(w.walletAddress.toLowerCase()));
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
    // Get or create MonitoredWallet entry
    let monitoredWallet = await MonitoredWallet.findOne({
      walletAddress,
      market: 'PERP',
      platform: 'HYPERLIQUID'
    });

    if (!monitoredWallet) {
      monitoredWallet = await MonitoredWallet.create({
        walletAddress,
        market: 'PERP',
        platform: 'HYPERLIQUID',
        status: 'active',
        monitorInterval: 300000, // 5 minutes
        lastChecked: new Date(0),
        nextCheck: new Date()
      });
      console.log(`[Indexer] ✅ Created MonitoredWallet entry for ${walletAddress}`);
    }

    // Call the monitor check function
    const result = await hyperliquidMonitor.checkWallet(monitoredWallet);

    console.log(`[Indexer] ✅ ${walletAddress}: ${result.newFills || 0} fills, ${result.openPositions || 0} positions`);

    return {
      wallet: walletAddress,
      success: true,
      newFills: result.newFills,
      positions: result.openPositions
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
  console.log('       HYPERLIQUID TRADER INDEXER');
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
    console.log('  1. HL_WALLETS env var (comma-separated)');
    console.log('  2. MonitoredWallet collection in MongoDB');
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
  const totalFills = results.reduce((sum, r) => sum + (r.newFills || 0), 0);

  console.log('\n' + '═'.repeat(60));
  console.log('       INDEXER COMPLETE');
  console.log('═'.repeat(60));
  console.log(`Wallets indexed: ${successful}/${wallets.length}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total new fills: ${totalFills}`);
  console.log(`Completed at: ${new Date().toISOString()}`);
  console.log('═'.repeat(60) + '\n');

  await mongoose.disconnect();
}

// Run the indexer
runIndexer().catch(error => {
  console.error('[Indexer] Fatal error:', error);
  process.exit(1);
});
