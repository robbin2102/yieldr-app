/**
 * npm run refresh-coins
 * Forces a refresh of the dynamic tracked coins list.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { connectDB, disconnectDB } from '../db';
import { refreshTrackedCoins } from '../coins/tracker';
import { logger } from '../utils/logger';

async function main() {
  await connectDB();

  logger.info('Script', 'Refreshing tracked coins list...');
  const { all, full, lite } = await refreshTrackedCoins();

  logger.info('Script', `✓ Tracked coins refreshed`);
  logger.info('Script', `  Total: ${all.length}`);
  logger.info('Script', `  Full (top ${full.length}): ${full.join(', ')}`);
  logger.info('Script', `  Lite (${lite.length} coins): ${lite.slice(0, 10).join(', ')}...`);

  await disconnectDB();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
