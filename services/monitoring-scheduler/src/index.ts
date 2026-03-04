import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

import express from 'express';
import { connectDB } from './db/connection';
import { startScheduler, getSchedulerStatus } from './scheduler';
import { startPositionRefresh } from './position-refresh';
import { logger } from './utils/logger';
import { config } from './config';

console.log('');
console.log('█████████████████████████████████████████████');
console.log('█     YIELDR MONITORING SCHEDULER           █');
console.log('█  Agent monitoring · alerts · positions    █');
console.log('█████████████████████████████████████████████');
console.log('');

async function main(): Promise<void> {
  const app = express();
  app.use(express.json());

  let dbConnected = false;
  const startedAt = new Date();

  // Health endpoint — Railway uses this to confirm the service is alive
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'monitoring-scheduler',
      db: dbConnected ? 'connected' : 'connecting',
      uptime: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      ...getSchedulerStatus(),
    });
  });

  // Start HTTP server first so Railway healthcheck passes immediately
  app.listen(config.port, () => {
    logger.info('Server', `Health server listening on port ${config.port}`);
  });

  // Connect to MongoDB and ensure indexes
  await connectDB();
  dbConnected = true;

  // Start the main task scheduler loop
  startScheduler();

  // Start position refresh loops (HL/PM every 2m, Avantis every 10m)
  startPositionRefresh();

  logger.info('Startup', 'All loops started. Service is running.');
}

process.on('SIGTERM', async () => {
  logger.info('Shutdown', 'SIGTERM received — exiting');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Shutdown', 'SIGINT received — exiting');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('Process', `Uncaught exception: ${err.message}`);
  logger.error('Process', err.stack ?? '');
});

process.on('unhandledRejection', (reason: any) => {
  logger.error('Process', `Unhandled rejection: ${reason}`);
});

main().catch((err) => {
  logger.error('Startup', `Fatal: ${err.message}`);
  process.exit(1);
});
