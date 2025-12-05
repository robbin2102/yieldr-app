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
import { computeMetrics, displayMetrics } from './services/metrics';
import { TradePoller } from './services/poller';
import { CONFIG } from './config';
import { createLogger } from './utils/logger';

const logger = createLogger('Main');

/**
 * Track a single wallet
 */
async function trackWallet(walletAddress: string): Promise<TradePoller> {
  console.log('\n' + '='.repeat(80));
  console.log(`TRACKING WALLET: ${walletAddress}`);
  console.log('='.repeat(80) + '\n');

  try {
    // Step 1: Initial fetch of all data
    logger.info('Step 1: Fetching all historical data...');
    await fetchAllDataForWallet(walletAddress);

    // Step 2: Compute and display metrics
    logger.info('Step 2: Computing performance metrics...');
    const metrics = await computeMetrics(walletAddress);
    displayMetrics(metrics);

    // Step 3: Start polling for new trades
    logger.info('Step 3: Starting trade monitoring...');
    const poller = new TradePoller(walletAddress);
    poller.start(CONFIG.POLL_INTERVAL_MS);

    logger.success(`Wallet ${walletAddress} is now being tracked!`);

    return poller;
  } catch (error: any) {
    logger.error(`Failed to track wallet ${walletAddress}: ${error.message}`);
    throw error;
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

    // Get wallets from config
    const wallets = CONFIG.WALLETS;

    if (wallets.length === 0) {
      logger.error('No wallets configured!');
      logger.info('Please set POLYMARKET_WALLETS environment variable');
      logger.info('Example: POLYMARKET_WALLETS=0xabc...,0xdef...');
      process.exit(1);
    }

    logger.info(`Tracking ${wallets.length} wallet(s): ${wallets.join(', ')}`);

    // Track all wallets
    const pollers: TradePoller[] = [];

    for (const wallet of wallets) {
      const poller = await trackWallet(wallet);
      pollers.push(poller);
    }

    // Display status
    console.log('\n' + '='.repeat(80));
    console.log('SERVICE STATUS: RUNNING');
    console.log('='.repeat(80));
    console.log(`\n✅ Tracking ${pollers.length} wallet(s)`);
    console.log(`⏱️  Polling interval: ${CONFIG.POLL_INTERVAL_MS / 1000} seconds`);
    console.log(`🔄 API delay: ${CONFIG.API_DELAY_MS}ms`);
    console.log('\nPress Ctrl+C to stop\n');

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n\n' + '='.repeat(80));
      logger.info('Shutting down gracefully...');

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
