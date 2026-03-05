/**
 * Yieldr Market Intelligence Service
 *
 * Ingests TAAPI + CoinGlass data every hour and stores snapshots in MongoDB.
 * Runs as a standalone Railway service.
 *
 * Environment Variables:
 *   MONGODB_URI             — MongoDB connection string
 *   TAAPI_API_KEY           — TAAPI.io Pro API key
 *   COINGLASS_API_KEY       — CoinGlass Hobby API key
 *   TAAPI_RATE_DELAY_MS     — Delay between TAAPI requests (default: 600)
 *   COINGLASS_RATE_DELAY_MS — Delay between CoinGlass requests (default: 2200)
 *   PORT                    — HTTP health check port (default: 3000)
 */
import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { connectDB, disconnectDB } from './db';
import { logger } from './utils/logger';
import { isRunning, runHourlyCycle, startCronJobs } from './scheduler/cron';
import { loadTrackedCoins } from './coins/tracker';
import { buildAndSaveMacroDaily } from './processors/macro-builder';
import { config } from './config';
import MarketSnapshot from './models/MarketSnapshot';

let lastCycleAt: Date | null = null;
let lastCycleErrors = 0;
let totalCycles = 0;

async function main(): Promise<void> {
  console.log('');
  console.log('██████████████████████████████████████████████████████████████████');
  console.log('█                                                                ██');
  console.log('█            YIELDR MARKET INTELLIGENCE SERVICE                  ██');
  console.log('█                                                                ██');
  console.log('██████████████████████████████████████████████████████████████████');
  console.log('');

  // Start HTTP server FIRST so Railway healthcheck passes immediately
  const app = express();
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    res.json({
      status:         'ok',
      service:        'market-intelligence',
      uptime:         process.uptime(),
      lastCycleAt:    lastCycleAt?.toISOString() ?? null,
      isCycleRunning: isRunning,
      totalCycles,
    });
  });

  app.get('/status', async (_req, res) => {
    try {
      const latestSnapshots = await MarketSnapshot
        .find()
        .sort({ timestamp: -1 })
        .limit(5)
        .select('symbol timestamp tier fetch_duration_ms');
      res.json({
        status:         'running',
        isCycleRunning: isRunning,
        totalCycles,
        lastCycleAt:    lastCycleAt?.toISOString() ?? null,
        lastCycleErrors,
        latestSnapshots,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(config.port, () => {
    logger.info('Server', `Health server listening on port ${config.port}`);
  });

  // Connect to MongoDB (after server is up so healthcheck doesn't time out)
  await connectDB();

  // Load (or refresh) tracked coins on startup
  logger.info('Startup', 'Loading tracked coins...');
  const { all } = await loadTrackedCoins();
  logger.info('Startup', `Tracking ${all.length} coins. Top 5: ${all.slice(0, 5).join(', ')}`);

  // Run the first cycle immediately on startup
  logger.info('Startup', 'Running initial hourly cycle...');
  await runHourlyCycle();
  lastCycleAt = new Date();
  totalCycles++;

  // Also run daily macro on startup
  logger.info('Startup', 'Running initial macro daily fetch...');
  await buildAndSaveMacroDaily();

  // Start all cron jobs
  startCronJobs();
  logger.info('Startup', 'All cron jobs scheduled. Service is running.');
}

async function shutdown(signal: string): Promise<void> {
  logger.info('Shutdown', `Received ${signal}, shutting down gracefully...`);
  await disconnectDB();
  logger.info('Shutdown', 'Goodbye!');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err: Error) => {
  logger.error('Process', `Uncaught exception: ${err.message}`);
  logger.error('Process', err.stack ?? '');
});
process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Process', `Unhandled rejection: ${reason}`);
});

main().catch((err: Error) => {
  logger.error('Startup', `Fatal startup error: ${err.message}`);
  process.exit(1);
});
