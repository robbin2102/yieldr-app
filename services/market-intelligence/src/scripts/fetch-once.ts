/**
 * npm run fetch-once
 * Runs one full cycle and logs all output.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { connectDB, disconnectDB } from '../db';
import { loadTrackedCoins } from '../coins/tracker';
import { runHourlyCycle } from '../scheduler/cron';
import { logger } from '../utils/logger';

async function main() {
  await connectDB();
  const { all } = await loadTrackedCoins();
  logger.info('Script', `Tracking ${all.length} coins`);

  logger.info('Script', 'Running full hourly cycle...');
  await runHourlyCycle();

  logger.info('Script', 'Done.');
  await disconnectDB();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
