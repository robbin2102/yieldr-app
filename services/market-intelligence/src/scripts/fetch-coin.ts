/**
 * npm run fetch-coin BTC
 * Fetches and saves data for a single coin.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.local') });

import { connectDB, disconnectDB } from '../db';
import { fetchAllCoins } from '../fetchers/taapi';
import { fetchAggregateData, fetchPerCoinData, fetchCoinbasePremium } from '../fetchers/coinglass';
import { buildAndSaveSnapshot } from '../processors/snapshot-builder';
import { logger } from '../utils/logger';

async function main() {
  const symbol = (process.argv[2] || 'BTC').toUpperCase();
  logger.info('Script', `Fetching data for single coin: ${symbol}`);

  await connectDB();

  const timestamp = new Date();
  timestamp.setUTCMinutes(0, 0, 0);

  logger.info('Script', 'Fetching TAAPI indicators...');
  const taapiMap = await fetchAllCoins([symbol]);

  logger.info('Script', 'Fetching CoinGlass aggregate...');
  const aggregateMap = await fetchAggregateData([symbol]);

  logger.info('Script', 'Fetching CoinGlass per-coin...');
  const perCoin = await fetchPerCoinData(symbol);

  logger.info('Script', 'Fetching Coinbase premium...');
  const premium = await fetchCoinbasePremium();

  const taapi = taapiMap.get(symbol) ?? { indicators: {}, candlestick_patterns: [], errors: [] };
  const aggregate = aggregateMap.get(symbol)!;

  logger.info('Script', 'Building snapshot...');
  await buildAndSaveSnapshot({ symbol, timestamp, tier: 'full', taapi, aggregate, perCoin, coinbasePremium: premium });

  logger.info('Script', `✓ Snapshot for ${symbol} saved successfully`);
  logger.info('Script', `  Indicators: ${Object.keys(taapi.indicators).length}`);
  logger.info('Script', `  Patterns: ${taapi.candlestick_patterns.length}`);
  logger.info('Script', `  Errors: ${taapi.errors.length}`);
  if (taapi.errors.length > 0) {
    logger.warn('Script', `  Error details: ${taapi.errors.join(', ')}`);
  }

  await disconnectDB();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
