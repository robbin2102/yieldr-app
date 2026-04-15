/**
 * X Agent Data Service Entry Point
 *
 * Two scheduled jobs:
 * 1. Market Indexer — fetches active Polymarket markets (every 24h)
 * 2. Trader Pipeline — 4-step profiling pipeline + materialization (every 24h)
 *
 * Pipeline steps:
 *   fetch-leaderboard → find-consistent-traders → bulk-profile-ahf (v3) → edge-ranked-traders
 *   → materialize (HC trades + positions for MCP tools)
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

import * as http from 'http';
import { connectDB, closeDB } from './lib/db';
import { startMarketIndexer, stopMarketIndexer, getMarketIndexerStatus } from './monitors/market-indexer';
import { startPipeline, stopPipeline, getPipelineStatus } from './pipeline/runner';
import { CONFIG } from './config';

let server: http.Server | null = null;

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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'running',
        monitors: {
          marketIndexer: getMarketIndexerStatus(),
          pipeline: getPipelineStatus(),
        },
        intervals: {
          marketIndex: `${CONFIG.INTERVALS.MARKET_INDEX / 3600000}h`,
          pipeline: `${CONFIG.INTERVALS.PIPELINE / 3600000}h`,
        },
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(CONFIG.PORT, () => {
    console.log(`[Server] Health check running on port ${CONFIG.PORT}`);
  });
}

async function main() {
  console.log('');
  console.log('================================================================');
  console.log('           X AGENT DATA SERVICE                                 ');
  console.log('================================================================');
  console.log('');

  // Health server first (Railway needs fast response)
  startHealthServer();

  // Connect to MongoDB (for materialization step)
  await connectDB();

  // Start market indexer (24h)
  startMarketIndexer();

  // Start trader pipeline (24h) — stagger by 5 min after market indexer
  setTimeout(() => {
    startPipeline(CONFIG.INTERVALS.PIPELINE);
  }, 5 * 60 * 1000);

  console.log('');
  console.log('================================================================');
  console.log('              SERVICE RUNNING                                   ');
  console.log('================================================================');
  console.log(`  Health:     http://localhost:${CONFIG.PORT}/health`);
  console.log(`  Status:     http://localhost:${CONFIG.PORT}/status`);
  console.log(`  Market:     every ${CONFIG.INTERVALS.MARKET_INDEX / 3600000}h`);
  console.log(`  Pipeline:   every ${CONFIG.INTERVALS.PIPELINE / 3600000}h (starts in 5m)`);
  console.log('================================================================');
  console.log('');
}

async function shutdown(signal: string) {
  console.log(`\n[Service] Received ${signal}, shutting down...`);
  stopMarketIndexer();
  stopPipeline();
  if (server) server.close();
  await closeDB();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => console.error('[Service] Uncaught:', error));
process.on('unhandledRejection', (reason) => console.error('[Service] Unhandled:', reason));

main().catch((error) => {
  console.error('[Service] Fatal:', error);
  process.exit(1);
});
