import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { connectDB, disconnectDB } from './db';
import { logger } from './utils/logger';
import { config } from './config';
import { runFundingRateCycle, runDerivativesCycle, runBackfill, startCronJobs } from './scheduler/cron';
import FundingRate1h from './models/FundingRate1h';
import Derivatives15m from './models/Derivatives15m';

async function main(): Promise<void> {
  console.log('');
  console.log('████████████████████████████████████████████████');
  console.log('█       YIELDR BINANCE FETCHER SERVICE          █');
  console.log('█   Funding Rates (1h) · OI · L/S Ratios (15m) █');
  console.log('████████████████████████████████████████████████');
  console.log('');

  const app = express();
  app.use(express.json());

  let dbConnected = false;

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'binance-fetcher',
      db: dbConnected ? 'connected' : 'connecting',
      uptime: process.uptime(),
    });
  });

  app.get('/status', async (_req, res) => {
    try {
      const [latestFunding, latestDeriv] = await Promise.all([
        (FundingRate1h as any).findOne().sort({ timestamp: -1 }).select('symbol timestamp'),
        (Derivatives15m as any).findOne().sort({ timestamp: -1 }).select('symbol timestamp'),
      ]);
      res.json({
        status: 'running',
        latestFunding: latestFunding ? { symbol: latestFunding.symbol, timestamp: latestFunding.timestamp } : null,
        latestDerivatives: latestDeriv ? { symbol: latestDeriv.symbol, timestamp: latestDeriv.timestamp } : null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Start HTTP server immediately so Railway healthcheck passes
  app.listen(config.port, () => {
    logger.info('Server', `Health server listening on port ${config.port}`);
  });

  // Connect MongoDB
  await connectDB();
  dbConnected = true;

  // Check if backfill is needed (empty collections)
  const [fundingCount, derivCount] = await Promise.all([
    (FundingRate1h as any).estimatedDocumentCount(),
    (Derivatives15m as any).estimatedDocumentCount(),
  ]);

  if (fundingCount === 0 || derivCount === 0) {
    logger.info('Startup', `Collections empty (funding=${fundingCount}, deriv=${derivCount}) — running backfill`);
    await runBackfill();
  } else {
    logger.info('Startup', `Collections have data — running incremental fetch`);
    await Promise.all([
      runFundingRateCycle(),
      runDerivativesCycle(),
    ]);
  }

  startCronJobs();
  logger.info('Startup', 'All cron jobs scheduled. Service is running.');
}

process.on('SIGTERM', async () => {
  logger.info('Shutdown', 'SIGTERM received');
  await disconnectDB();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Shutdown', 'SIGINT received');
  await disconnectDB();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('Process', `Uncaught exception: ${err.message}`);
  logger.error('Process', err.stack ?? '');
});

process.on('unhandledRejection', (reason: any) => {
  logger.error('Process', `Unhandled rejection: ${reason}`);
});

main().catch(err => {
  logger.error('Startup', `Fatal: ${err.message}`);
  process.exit(1);
});
