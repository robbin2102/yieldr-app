/**
 * Trader Ranking Pipeline Service — Entry Point
 *
 * Standalone service that runs the 5-step trader profiling pipeline on a 24h schedule.
 * Deployed separately from the copy-trading bot (src/index.ts).
 *
 * Pipeline:
 *   fetch-leaderboard → find-consistent-traders → bulk-profile-ahf → edge-ranked-traders
 *   → materialize (HC trades + open positions)
 *
 * Also runs a market indexer (24h) to keep polyMarkets collection fresh.
 *
 * Health endpoints:
 *   GET /health  — liveness check
 *   GET /status  — pipeline + market indexer status
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load env before anything else — same priority order as the trading bot
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../env.polyagent') });

import * as http from 'http';
import { connectPipelineDB, closePipelineDB } from './pipeline/db';
import { startMarketIndexer, stopMarketIndexer, getMarketIndexerStatus } from './pipeline/market-indexer';
import { startPipeline, stopPipeline, getPipelineStatus } from './pipeline/runner';
import { PIPELINE_CONFIG } from './pipeline/pipeline-config';

let server: http.Server | null = null;

function startHealthServer(): void {
  server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:    'ok',
        service:   'poly-agent-pipeline',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:   'running',
        monitors: {
          marketIndexer: getMarketIndexerStatus(),
          pipeline:      getPipelineStatus(),
        },
        intervals: {
          marketIndex: `${PIPELINE_CONFIG.INTERVALS.MARKET_INDEX / 3_600_000}h`,
          pipeline:    `${PIPELINE_CONFIG.INTERVALS.PIPELINE / 3_600_000}h`,
        },
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PIPELINE_CONFIG.PORT, () => {
    console.log(`[Pipeline] Health check running on port ${PIPELINE_CONFIG.PORT}`);
  });
}

async function main() {
  console.log('');
  console.log('================================================================');
  console.log('           TRADER RANKING PIPELINE SERVICE                      ');
  console.log('================================================================');
  console.log('');

  // Health server first (Railway needs fast response)
  startHealthServer();

  // Connect to MongoDB (needed for materialization step)
  await connectPipelineDB();

  // Market indexer starts immediately
  startMarketIndexer();

  // Pipeline starts 5 min after market indexer to avoid overlap on first run
  setTimeout(() => {
    startPipeline(PIPELINE_CONFIG.INTERVALS.PIPELINE);
  }, 5 * 60 * 1000);

  console.log('');
  console.log('================================================================');
  console.log('              SERVICE RUNNING                                   ');
  console.log('================================================================');
  console.log(`  Health:     http://localhost:${PIPELINE_CONFIG.PORT}/health`);
  console.log(`  Status:     http://localhost:${PIPELINE_CONFIG.PORT}/status`);
  console.log(`  Market:     every ${PIPELINE_CONFIG.INTERVALS.MARKET_INDEX / 3_600_000}h (starts immediately)`);
  console.log(`  Pipeline:   every ${PIPELINE_CONFIG.INTERVALS.PIPELINE / 3_600_000}h (starts in 5m)`);
  console.log('================================================================');
  console.log('');
}

async function shutdown(signal: string) {
  console.log(`\n[Pipeline] Received ${signal}, shutting down...`);
  stopMarketIndexer();
  stopPipeline();
  if (server) server.close();
  await closePipelineDB();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (error)  => console.error('[Pipeline] Uncaught:', error));
process.on('unhandledRejection', (reason) => console.error('[Pipeline] Unhandled:', reason));

main().catch((error) => {
  console.error('[Pipeline] Fatal:', error);
  process.exit(1);
});
