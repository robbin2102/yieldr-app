/**
 * Polymarket Indexer Service
 *
 * Monitors top Polymarket traders and indexes their data:
 * - Fetches open positions every 5 minutes
 * - Fetches trades every 5 minutes
 * - Computes metrics (win rate, PnL, profit factor) every 5 minutes
 *
 * Environment Variables:
 *   MONGODB_URI - MongoDB connection string
 *   PORT - HTTP server port for health checks (default: 3000)
 *   POLL_INTERVAL_MS - Polling interval in milliseconds (default: 300000 = 5 min)
 */

import * as dotenv from 'dotenv';
import * as http from 'http';
import { connectDB, closeDB, getCollections } from './lib/db';
import {
  fetchAndSaveOpenPositions,
  fetchAndSaveTrades,
  fetchAndSaveClosedPositions,
} from './monitors/fetcher';
import { computeTraderMetrics, saveTraderProfile } from './monitors/metrics';

// Load environment variables
dotenv.config();

const PORT = parseInt(process.env.PORT || '3000');
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '300000'); // 5 minutes

interface TrackedTrader {
  wallet: string;
  label?: string;
  isActive: boolean;
  isTracking: boolean;
  lastIndexedAt?: Date;
  addedAt: Date;
}

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;
let server: http.Server | null = null;

/**
 * Initialize a new trader - fetch full history
 */
async function initializeTrader(trader: TrackedTrader): Promise<void> {
  console.log(`\n[Init] Initializing trader: ${trader.label || trader.wallet}`);

  try {
    // Fetch 90-day trade history
    const tradeResult = await fetchAndSaveTrades(trader.wallet, 90);
    console.log(`[Init] Trades: ${tradeResult.total} fetched, ${tradeResult.saved} new`);

    // Fetch closed positions (90 days)
    const closedResult = await fetchAndSaveClosedPositions(trader.wallet, 90);
    console.log(`[Init] Closed positions: ${closedResult.total} fetched`);

    // Fetch and save open positions
    const positionResult = await fetchAndSaveOpenPositions(trader.wallet);
    console.log(`[Init] Open positions: ${positionResult.active}`);

    // Compute and save profile metrics
    const profile = await computeTraderMetrics(trader.wallet);
    profile.label = trader.label;
    await saveTraderProfile(profile);

    // Update trader's lastIndexedAt
    const { trackedTraders } = await getCollections();
    await trackedTraders.updateOne(
      { wallet: trader.wallet.toLowerCase() },
      { $set: { lastIndexedAt: new Date(), initializedAt: new Date() } }
    );

    console.log(`[Init] Trader ${trader.label || trader.wallet} initialized successfully`);
  } catch (error: any) {
    console.error(`[Init] Error initializing ${trader.wallet}:`, error.message);
  }
}

/**
 * Poll a single trader for updates
 */
async function pollTrader(trader: TrackedTrader): Promise<void> {
  try {
    // Fetch recent trades (30 days)
    await fetchAndSaveTrades(trader.wallet, 30);

    // Fetch and save open positions
    await fetchAndSaveOpenPositions(trader.wallet);

    // Recompute profile metrics
    const profile = await computeTraderMetrics(trader.wallet);
    profile.label = trader.label;
    await saveTraderProfile(profile);

    // Update lastIndexedAt
    const { trackedTraders } = await getCollections();
    await trackedTraders.updateOne(
      { wallet: trader.wallet.toLowerCase() },
      { $set: { lastIndexedAt: new Date() } }
    );
  } catch (error: any) {
    console.error(`[Poll] Error polling ${trader.wallet}:`, error.message);
  }
}

/**
 * Main polling loop
 */
async function runPollingCycle(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    const { trackedTraders } = await getCollections();

    // Get all active traders being tracked
    const traders = (await trackedTraders
      .find({ isActive: true, isTracking: true })
      .toArray()) as unknown as TrackedTrader[];

    if (traders.length === 0) {
      console.log('[Poll] No active traders to monitor');
      return;
    }

    console.log(
      `\n[Poll] ${new Date().toISOString()} - Indexing ${traders.length} traders...`
    );

    for (const trader of traders) {
      // Initialize if never indexed
      if (!trader.lastIndexedAt) {
        await initializeTrader(trader);
      } else {
        await pollTrader(trader);
      }

      // Delay between traders to avoid rate limiting
      await new Promise((r) => setTimeout(r, 2000));
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
  server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
    } else if (req.url === '/status') {
      const { trackedTraders, traderProfiles } = await getCollections();
      const trackedCount = await trackedTraders.countDocuments({ isActive: true, isTracking: true });
      const profileCount = await traderProfiles.countDocuments();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'running',
          isPolling: isRunning,
          pollInterval: POLL_INTERVAL_MS,
          trackedTraders: trackedCount,
          profiles: profileCount,
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
  console.log('           POLYMARKET INDEXER SERVICE                           ');
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
