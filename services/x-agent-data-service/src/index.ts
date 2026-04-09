/**
 * X Agent Data Service Entry Point
 *
 * Combined data indexing service for the X Content Agent.
 * Runs 5 monitors on independent schedules:
 *
 * 1. Market Indexer (6h)     - Fetch all live Polymarket markets → polyMarkets
 * 2. Activity Tracker (15m)  - Fetch top 100 edge trader activities → x-agent-tradeActivities
 * 3. Position Tracker (15m)  - Fetch top 100 trader open positions → polymarket-openPositions
 * 4. High Conviction (15m)   - Detect whale trades from activities → x-agent-highConvictionTrades
 * 5. Profiler (1h)           - Re-profile top 100 traders → ahf-edgeRankedTraders
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load env: local .env first, then monorepo .env.local
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

import * as http from 'http';
import { connectDB, closeDB, getDB, COLLECTIONS } from './lib/db';
import { startMarketIndexer, stopMarketIndexer, getMarketIndexerStatus } from './monitors/market-indexer';
import { startActivityTracker, stopActivityTracker, getActivityTrackerStatus } from './monitors/activity-tracker';
import { startPositionTracker, stopPositionTracker, getPositionTrackerStatus } from './monitors/position-tracker';
import { startHighConvictionDetector, stopHighConvictionDetector, getHighConvictionStatus } from './monitors/high-conviction';
import { startProfiler, stopProfiler, getProfilerStatus } from './monitors/profiler';
import { CONFIG } from './config';

let server: http.Server | null = null;

/**
 * Start HTTP server for health checks and status
 */
function startHealthServer(): void {
  server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'x-agent-data-service',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (req.url === '/status') {
      try {
        const db = await getDB();

        // Get collection counts
        const [
          marketsCount,
          activitiesCount,
          hcTradesCount,
          edgeTraders,
        ] = await Promise.all([
          db.collection(COLLECTIONS.POLY_MARKETS).countDocuments({ active: true }),
          db.collection(COLLECTIONS.TRADE_ACTIVITIES).countDocuments(),
          db.collection(COLLECTIONS.HIGH_CONVICTION_TRADES).countDocuments(),
          db.collection(COLLECTIONS.EDGE_RANKED_TRADERS).countDocuments(),
        ]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'running',
          monitors: {
            marketIndexer: getMarketIndexerStatus(),
            activityTracker: getActivityTrackerStatus(),
            positionTracker: getPositionTrackerStatus(),
            highConviction: getHighConvictionStatus(),
            profiler: getProfilerStatus(),
          },
          data: {
            activeMarkets: marketsCount,
            tradeActivities: activitiesCount,
            highConvictionTrades: hcTradesCount,
            edgeRankedTraders: edgeTraders,
          },
          intervals: {
            marketIndex: `${CONFIG.INTERVALS.MARKET_INDEX / 3600000}h`,
            activityTrack: `${CONFIG.INTERVALS.ACTIVITY_TRACK / 60000}m`,
            positionTrack: `${CONFIG.INTERVALS.POSITION_TRACK / 60000}m`,
            highConviction: `${CONFIG.INTERVALS.HIGH_CONVICTION / 60000}m`,
            profileRefresh: `${CONFIG.INTERVALS.PROFILE_REFRESH / 3600000}h`,
          },
          timestamp: new Date().toISOString(),
        }));
      } catch (error: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(CONFIG.PORT, () => {
    console.log(`[Server] Health check server running on port ${CONFIG.PORT}`);
  });
}

/**
 * Main function
 */
async function main() {
  console.log('');
  console.log('================================================================');
  console.log('          X AGENT DATA SERVICE                                  ');
  console.log('================================================================');
  console.log('');

  // Start health check server FIRST (Railway needs fast response)
  startHealthServer();

  // Connect to MongoDB
  await connectDB();

  // Start all monitors with staggered delays
  startMarketIndexer();      // Immediate start
  startActivityTracker();    // 30s delay
  startPositionTracker();    // 60s delay
  startHighConvictionDetector(); // 90s delay
  startProfiler();           // 120s delay

  console.log('');
  console.log('================================================================');
  console.log('              ALL MONITORS STARTED                              ');
  console.log('================================================================');
  console.log(`  Health: http://localhost:${CONFIG.PORT}/health`);
  console.log(`  Status: http://localhost:${CONFIG.PORT}/status`);
  console.log('');
  console.log('  Schedules:');
  console.log(`    Market Indexer:     every ${CONFIG.INTERVALS.MARKET_INDEX / 3600000}h`);
  console.log(`    Activity Tracker:   every ${CONFIG.INTERVALS.ACTIVITY_TRACK / 60000}m`);
  console.log(`    Position Tracker:   every ${CONFIG.INTERVALS.POSITION_TRACK / 60000}m`);
  console.log(`    High Conviction:    every ${CONFIG.INTERVALS.HIGH_CONVICTION / 60000}m`);
  console.log(`    Profiler:           every ${CONFIG.INTERVALS.PROFILE_REFRESH / 3600000}h`);
  console.log('================================================================');
  console.log('');
}

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`\n[Service] Received ${signal}, shutting down...`);

  stopMarketIndexer();
  stopActivityTracker();
  stopPositionTracker();
  stopHighConvictionDetector();
  stopProfiler();

  if (server) {
    server.close();
  }

  await closeDB();

  console.log('[Service] Goodbye!');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('[Service] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Service] Unhandled rejection:', reason);
});

// Start
main().catch((error) => {
  console.error('[Service] Fatal error:', error);
  process.exit(1);
});
