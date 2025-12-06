/**
 * Polymarket Tracker Service - Main Entry Point
 *
 * Usage:
 *   npm run polymarket:start
 *
 * Environment Variables:
 *   POLYMARKET_WALLETS - Comma-separated list of wallet addresses
 *   POLYMARKET_POLL_INTERVAL_MS - Polling interval in milliseconds (default: 60000)
 *   POLYMARKET_API_DELAY_MS - Delay between API calls in milliseconds (default: 300)
 */

// Load environment variables FIRST (before any imports that need them)
import dotenv from 'dotenv';
import path from 'path';

// Load from project root .env.local
// Only load if not already loaded by node --require dotenv/config
if (!process.env.MONGODB_URI) {
  const envPath = path.resolve(process.cwd(), '.env.local');
  const result = dotenv.config({ path: envPath });

  if (result.error) {
    console.error('Error loading .env.local:', result.error);
    console.error('Looking for .env.local at:', envPath);
    process.exit(1);
  }
}

// Debug: Check env vars
console.log('[DEBUG] MONGODB_URI exists:', !!process.env.MONGODB_URI);
console.log('[DEBUG] POLYMARKET_WALLETS:', process.env.POLYMARKET_WALLETS || 'NOT SET');

// Now import modules that depend on environment variables
import connectDB from '../../lib/mongoose';
import { fetchAllDataForWallet } from './services/initialFetch';
import { computeMetrics, displayMetrics, saveMetrics } from './services/metrics';
import { TradePoller } from './services/poller';
import { CONFIG } from './config';
import { createLogger } from './utils/logger';
import Trader from '../../models/Trader';

const logger = createLogger('Main');

/**
 * Track a single wallet
 */
async function trackWallet(walletAddress: string): Promise<TradePoller> {
  console.log('\n' + '='.repeat(80));
  console.log(`TRACKING WALLET: ${walletAddress}`);
  console.log('='.repeat(80) + '\n');

  try {
    // Update trader status to IN_PROGRESS
    await Trader.findOneAndUpdate(
      { walletAddress: walletAddress.toLowerCase() },
      {
        $set: {
          polymarketSyncStatus: 'IN_PROGRESS',
          polymarketSyncStartedAt: new Date(),
          trackingStatus: 'ACTIVE'
        }
      },
      { upsert: true }
    );

    // Step 1: Initial fetch of all data
    logger.info('Step 1: Fetching all historical data...');
    await fetchAllDataForWallet(walletAddress);

    // Step 2: Compute and display metrics
    logger.info('Step 2: Computing performance metrics...');
    const metrics = await computeMetrics(walletAddress);
    displayMetrics(metrics);
    await saveMetrics(walletAddress, metrics);

    // Update trader with initial metrics
    await Trader.findOneAndUpdate(
      { walletAddress: walletAddress.toLowerCase() },
      {
        $set: {
          'metrics.totalPnL30d': metrics.pnl30d,
          'metrics.totalPnL7d': metrics.pnl7d,
          'metrics.totalPnL1d': metrics.pnl1d,
          'metrics.roi30d': metrics.roi30d,
          'metrics.roi7d': metrics.roi7d,
          'metrics.roi1d': metrics.roi1d,
          'metrics.overallRoi': metrics.overallRoi,
          'metrics.winRate': metrics.winRate,
          'metrics.totalInvested': metrics.totalInvested,
          'metrics.openPositions': metrics.openPositionsCount,
          'metrics.closedPositions': metrics.closedPositionsCount,
          'metrics.sharpeRatio': metrics.sharpeRatio,
          polymarketSyncStatus: 'COMPLETED',
          polymarketSyncCompletedAt: new Date(),
          polymarketLastSyncAt: new Date(),
          lastMetricsSync: new Date()
        }
      }
    );

    // Step 3: Start polling for new trades
    logger.info('Step 3: Starting trade monitoring...');
    const poller = new TradePoller(walletAddress);
    poller.start(CONFIG.POLL_INTERVAL_MS);

    logger.success(`Wallet ${walletAddress} is now being tracked!`);

    return poller;
  } catch (error: any) {
    logger.error(`Failed to track wallet ${walletAddress}: ${error.message}`);

    // Update trader status to FAILED
    await Trader.findOneAndUpdate(
      { walletAddress: walletAddress.toLowerCase() },
      {
        $set: {
          polymarketSyncStatus: 'FAILED',
          polymarketSyncError: error.message,
          trackingStatus: 'ERROR'
        }
      }
    );

    throw error;
  }
}

/**
 * Get wallets to track from both ENV and Database
 */
async function getWalletsToTrack(): Promise<string[]> {
  const wallets = new Set<string>();

  // 1. Get wallets from ENV (backward compatibility)
  const envWallets = CONFIG.WALLETS;
  envWallets.forEach(w => wallets.add(w.toLowerCase()));

  // 2. Get wallets from traders collection (ACTIVE status only)
  const activeTraders = await Trader.find({
    trackingStatus: 'ACTIVE'
  }).select('walletAddress');

  activeTraders.forEach(trader => {
    wallets.add(trader.walletAddress.toLowerCase());
  });

  return Array.from(wallets);
}

/**
 * Check for new traders and start tracking them
 */
async function checkForNewTraders(
  currentPollers: Map<string, TradePoller>
): Promise<void> {
  try {
    const walletsToTrack = await getWalletsToTrack();

    for (const wallet of walletsToTrack) {
      if (!currentPollers.has(wallet)) {
        logger.info(`New trader detected: ${wallet}`);
        const poller = await trackWallet(wallet);
        currentPollers.set(wallet, poller);
        logger.success(`Started tracking ${wallet}`);
      }
    }

    // Stop tracking wallets that are no longer active
    for (const [wallet, poller] of currentPollers.entries()) {
      if (!walletsToTrack.includes(wallet)) {
        logger.info(`Stopping tracking for ${wallet}`);
        poller.stop();
        currentPollers.delete(wallet);
      }
    }
  } catch (error: any) {
    logger.error(`Error checking for new traders: ${error.message}`);
  }
}

/**
 * Main function
 */
async function main() {
  console.log('\n' + '█'.repeat(80));
  console.log('█' + ' '.repeat(78) + '█');
  console.log('█' + ' '.repeat(20) + 'POLYMARKET TRACKER SERVICE' + ' '.repeat(32) + '█');
  console.log('█' + ' '.repeat(78) + '█');
  console.log('█'.repeat(80) + '\n');

  try {
    // Connect to MongoDB
    logger.info('Connecting to MongoDB...');
    await connectDB();
    logger.success('Connected to MongoDB');

    // Get wallets from both ENV and DB
    const wallets = await getWalletsToTrack();

    if (wallets.length === 0) {
      logger.warn('No wallets to track!');
      logger.info('Add wallets by:');
      logger.info('1. Setting POLYMARKET_WALLETS environment variable');
      logger.info('2. Adding traders to the "traders" collection in MongoDB');
      logger.info('\nWaiting for traders to be added...');
    } else {
      logger.info(`Found ${wallets.length} wallet(s) to track`);
    }

    // Track all wallets
    const pollers = new Map<string, TradePoller>();

    for (const wallet of wallets) {
      try {
        const poller = await trackWallet(wallet);
        pollers.set(wallet.toLowerCase(), poller);
      } catch (error: any) {
        logger.error(`Failed to start tracking ${wallet}: ${error.message}`);
      }
    }

    // Display status
    console.log('\n' + '='.repeat(80));
    console.log('SERVICE STATUS: RUNNING');
    console.log('='.repeat(80));
    console.log(`\n✅ Tracking ${pollers.size} wallet(s)`);
    console.log(`⏱️  Polling interval: ${CONFIG.POLL_INTERVAL_MS / 1000} seconds`);
    console.log(`🔄 API delay: ${CONFIG.API_DELAY_MS}ms`);
    console.log(`🔍 Checking for new traders every 60 seconds`);
    console.log('\nPress Ctrl+C to stop\n');

    // Periodically check for new traders (every 60 seconds)
    const newTraderCheckInterval = setInterval(async () => {
      await checkForNewTraders(pollers);
    }, 60000);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n\n' + '='.repeat(80));
      logger.info('Shutting down gracefully...');

      clearInterval(newTraderCheckInterval);

      pollers.forEach((poller) => {
        poller.stop();
      });

      logger.success('All pollers stopped');
      console.log('='.repeat(80) + '\n');

      process.exit(0);
    });
  } catch (error: any) {
    logger.error(`Fatal error: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

// Run the service
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
