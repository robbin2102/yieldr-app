import { connectDB } from './db/connection';
import { fetchAllDataForWallet } from './services/initialFetch';
import { PollerManager } from './services/poller';
import { config } from './config';
import { createLogger } from './utils/logger';
import { sendErrorEmail, notifyPollerStarted, notifyInitialFetchComplete } from './services/notifications';

const logger = createLogger('Main');

const pollerManager = new PollerManager();

async function trackWallet(walletAddress: string): Promise<void> {
  const wallet = walletAddress.toLowerCase();

  try {
    logger.info(`\n${'='.repeat(70)}`);
    logger.info(`TRACKING NEW WALLET: ${wallet}`);
    logger.info(`${'='.repeat(70)}\n`);

    // 1. Fetch all historical data (30 days)
    const { metrics } = await fetchAllDataForWallet(wallet);

    // 2. Notify that initial fetch is complete
    await notifyInitialFetchComplete(wallet, metrics);

    // 3. Start polling for new trades
    const pollInterval = config.polymarket.pollIntervalMs;
    logger.info(`\nStarting real-time trade monitoring (${pollInterval / 1000}s interval)...`);

    pollerManager.addWallet(wallet, pollInterval);

    await notifyPollerStarted(wallet, pollInterval);

    logger.success(`✓ Now monitoring ${wallet} for new trades\n`);
  } catch (error) {
    logger.error(`Failed to track wallet ${wallet}:`, error);
    await sendErrorEmail(error as Error, `trackWallet(${wallet})`);
    throw error;
  }
}

async function main() {
  try {
    logger.info('\n' + '='.repeat(70));
    logger.info('POLYMARKET TRACKER SERVICE');
    logger.info('='.repeat(70) + '\n');

    // Connect to MongoDB
    await connectDB();

    // Get wallets from config
    const wallets = config.polymarket.wallets;

    if (wallets.length === 0) {
      logger.error('No wallets configured!');
      logger.info('Add wallet addresses to POLYMARKET_WALLETS in .env.local');
      logger.info('Example: POLYMARKET_WALLETS=0xabc...,0xdef...');
      process.exit(1);
    }

    logger.info(`Found ${wallets.length} wallet(s) to track:\n`);
    wallets.forEach((wallet, i) => {
      logger.info(`  ${i + 1}. ${wallet}`);
    });
    logger.info('');

    // Track each wallet
    for (const wallet of wallets) {
      await trackWallet(wallet);

      // Add delay between wallet setups to avoid rate limits
      if (wallets.indexOf(wallet) < wallets.length - 1) {
        logger.info('Waiting 5 seconds before next wallet setup...\n');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    logger.info('\n' + '='.repeat(70));
    logger.info('ALL WALLETS TRACKED - SERVICE RUNNING');
    logger.info('='.repeat(70));
    logger.info('\nPoller Status:');
    const status = pollerManager.getStatus();
    status.forEach((s) => {
      logger.info(`  ${s.walletAddress}: ${s.isRunning ? '✓ Running' : '✗ Stopped'} (Last seen: ${s.lastSeenDate})`);
    });
    logger.info('\nPress Ctrl+C to stop all pollers and exit.\n');
  } catch (error) {
    logger.error('Fatal error in main():', error);
    await sendErrorEmail(error as Error, 'main()');
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('\n\nReceived SIGINT signal, shutting down gracefully...');

  pollerManager.stopAll();

  logger.info('All pollers stopped. Exiting...\n');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('\n\nReceived SIGTERM signal, shutting down gracefully...');

  pollerManager.stopAll();

  logger.info('All pollers stopped. Exiting...\n');
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', async (error) => {
  logger.error('Uncaught exception:', error);
  await sendErrorEmail(error, 'uncaughtException');
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  await sendErrorEmail(reason as Error, 'unhandledRejection');
  process.exit(1);
});

// Start the service
main();
