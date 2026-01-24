/**
 * Hyperliquid Indexer Service
 *
 * Monitors top Hyperliquid traders and indexes their data:
 * - Fetches fills (trade history) every 5 minutes
 * - Updates positions every 5 minutes
 * - Computes metrics (win rate, PnL, Sharpe ratio) every 5 minutes
 *
 * Environment Variables:
 *   MONGODB_URI - MongoDB connection string
 *   PORT - HTTP server port for health checks (default: 3000)
 *   POLL_INTERVAL_MS - Polling interval in milliseconds (default: 300000 = 5 min)
 */

import * as dotenv from 'dotenv';
import * as http from 'http';
import { connectDB, closeDB, getCollections } from './lib/db';
import { fetchAndSaveInitialFills, fetchAndSavePositions, fetchAndSaveRecentFills } from './monitors/fetcher';
import { computeMetrics } from './monitors/metrics';

// Load environment variables
dotenv.config();

const PORT = parseInt(process.env.PORT || '3000');
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '300000'); // 5 minutes

interface TrackedWallet {
  walletAddress: string;
  label?: string;
  isActive: boolean;
  lastCheckedTime: number;
  addedAt: Date;
}

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;
let server: http.Server | null = null;

/**
 * Initialize a new wallet - fetch 30-day history
 */
async function initializeWallet(wallet: TrackedWallet): Promise<void> {
  console.log(`\n[Init] Initializing wallet: ${wallet.walletAddress}`);

  try {
    // Fetch 30-day fill history
    const { saved, duplicates } = await fetchAndSaveInitialFills(wallet.walletAddress);
    console.log(`[Init] Fills: ${saved} new, ${duplicates} existing`);

    // Fetch current positions
    const positionResult = await fetchAndSavePositions(wallet.walletAddress);
    console.log(`[Init] Positions: ${positionResult.currentPositions} open`);

    // Compute initial metrics
    await computeMetrics(wallet.walletAddress, positionResult.marginSummary);

    // Update wallet's lastCheckedTime
    const { trackedWallets } = await getCollections();
    await trackedWallets.updateOne(
      { walletAddress: wallet.walletAddress.toLowerCase() },
      { $set: { lastCheckedTime: Date.now(), initializedAt: new Date() } }
    );

    console.log(`[Init] Wallet ${wallet.walletAddress} initialized successfully`);
  } catch (error: any) {
    console.error(`[Init] Error initializing ${wallet.walletAddress}:`, error.message);
  }
}

/**
 * Poll a single wallet for updates
 */
async function pollWallet(wallet: TrackedWallet): Promise<void> {
  try {
    // Fetch recent fills since last check
    const { newFills } = await fetchAndSaveRecentFills(
      wallet.walletAddress,
      wallet.lastCheckedTime
    );

    // Fetch current positions
    const positionResult = await fetchAndSavePositions(wallet.walletAddress);

    // Recompute metrics if there are new fills or position changes
    if (newFills > 0 || positionResult.closedCoins.length > 0) {
      await computeMetrics(wallet.walletAddress, positionResult.marginSummary);
    }

    // Update lastCheckedTime
    const { trackedWallets } = await getCollections();
    await trackedWallets.updateOne(
      { walletAddress: wallet.walletAddress.toLowerCase() },
      { $set: { lastCheckedTime: Date.now() } }
    );

    if (newFills > 0) {
      console.log(`[Poll] ${wallet.label || wallet.walletAddress}: ${newFills} new fills`);
    }
  } catch (error: any) {
    console.error(`[Poll] Error polling ${wallet.walletAddress}:`, error.message);
  }
}

/**
 * Main polling loop
 */
async function runPollingCycle(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    const { trackedWallets } = await getCollections();

    // Get all active wallets
    const wallets = (await trackedWallets
      .find({ isActive: true })
      .toArray()) as unknown as TrackedWallet[];

    if (wallets.length === 0) {
      console.log('[Poll] No active wallets to monitor');
      return;
    }

    console.log(`\n[Poll] ${new Date().toISOString()} - Checking ${wallets.length} wallets...`);

    for (const wallet of wallets) {
      // Initialize if no lastCheckedTime (new wallet)
      if (!wallet.lastCheckedTime) {
        await initializeWallet(wallet);
      } else {
        await pollWallet(wallet);
      }

      // Small delay between wallets to avoid rate limiting
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log(`[Poll] Cycle complete`);
  } catch (error: any) {
    console.error('[Poll] Error in polling cycle:', error.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Start HTTP server for health checks
 */
function startHealthServer(): void {
  server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
    } else if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'running',
          isPolling: isRunning,
          pollInterval: POLL_INTERVAL_MS,
          timestamp: new Date().toISOString(),
        })
      );
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(PORT, () => {
    console.log(`[Server] Health check server running on port ${PORT}`);
  });
}

/**
 * Main function
 */
async function main() {
  console.log('');
  console.log('================================================================');
  console.log('           HYPERLIQUID INDEXER SERVICE                          ');
  console.log('================================================================');
  console.log('');

  // Connect to MongoDB
  await connectDB();

  // Start health check server
  startHealthServer();

  // Run initial polling cycle
  await runPollingCycle();

  // Start periodic polling
  intervalId = setInterval(runPollingCycle, POLL_INTERVAL_MS);

  console.log('');
  console.log('================================================================');
  console.log('                    INDEXER RUNNING                             ');
  console.log('================================================================');
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  Status: http://localhost:${PORT}/status`);
  console.log(`  Poll Interval: ${POLL_INTERVAL_MS / 1000 / 60} minutes`);
  console.log('================================================================');
  console.log('');
}

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`\n[Indexer] Received ${signal}, shutting down...`);

  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  if (server) {
    server.close();
  }

  await closeDB();

  console.log('[Indexer] Goodbye!');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Indexer] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Indexer] Unhandled rejection:', reason);
});

// Start the indexer
main().catch((error) => {
  console.error('[Indexer] Fatal error:', error);
  process.exit(1);
});
