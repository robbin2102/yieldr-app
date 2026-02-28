/**
 * npm run fetch-coin BTC ETH SOL
 * Fetches and saves data for one or more coins, processed one by one.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { connectDB, disconnectDB } from '../db';
import { fetchAllCoins } from '../fetchers/taapi';
import { fetchAggregateData, fetchPerCoinData, fetchCoinbasePremium } from '../fetchers/coinglass';
import { fetchBinanceCandle } from '../fetchers/binance';
import { buildAndSaveSnapshot } from '../processors/snapshot-builder';
import { logger } from '../utils/logger';

async function main(): Promise<void> {
  const symbols = process.argv.slice(2).map(s => s.toUpperCase());
  if (symbols.length === 0) symbols.push('BTC');

  logger.info('Script', `Fetching data for ${symbols.length} coin(s): ${symbols.join(', ')}`);

  await connectDB();

  const timestamp = new Date();
  timestamp.setUTCMinutes(0, 0, 0);

  // Bulk fetches (support multiple symbols in one call)
  logger.info('Script', 'Fetching TAAPI indicators (bulk)...');
  const taapiMap = await fetchAllCoins(symbols);

  logger.info('Script', 'Fetching CoinGlass aggregate (bulk)...');
  const aggregateMap = await fetchAggregateData(symbols);

  logger.info('Script', 'Fetching Coinbase premium (shared)...');
  const premium = await fetchCoinbasePremium();

  // Per-coin processing — one by one
  const results: Array<{ symbol: string; ok: boolean; error?: string }> = [];

  for (const symbol of symbols) {
    logger.info('Script', `--- Processing ${symbol} ---`);
    try {
      logger.info('Script', `[${symbol}] Fetching CoinGlass per-coin...`);
      const perCoin = await fetchPerCoinData(symbol);

      logger.info('Script', `[${symbol}] Fetching Binance OHLCV...`);
      const binance = await fetchBinanceCandle(symbol);

      const taapi     = taapiMap.get(symbol)   ?? { indicators: {}, candlestick_patterns: [], errors: [] };
      const aggregate = aggregateMap.get(symbol)!;

      logger.info('Script', `[${symbol}] Building snapshot...`);
      await buildAndSaveSnapshot({ symbol, timestamp, tier: 'full', taapi, aggregate, perCoin, coinbasePremium: premium, binance });

      logger.info('Script', `[${symbol}] ✓ Saved`);
      logger.info('Script', `  Indicators: ${Object.keys(taapi.indicators).length}`);
      logger.info('Script', `  Patterns:   ${taapi.candlestick_patterns.length}`);
      logger.info('Script', `  Errors:     ${taapi.errors.length}`);
      logger.info('Script', `  OHLCV: O=${binance.open} H=${binance.high} L=${binance.low} C=${binance.close} V=${binance.volume}`);
      logger.info('Script', `  Pivot PP:   ${binance.daily_close != null ? '✓ computed from Binance' : '✗ missing daily candle'}`);
      if (taapi.errors.length > 0) {
        logger.warn('Script', `  Error details: ${taapi.errors.join(', ')}`);
      }

      results.push({ symbol, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Script', `[${symbol}] ✗ Failed: ${message}`);
      results.push({ symbol, ok: false, error: message });
    }
  }

  // Summary
  logger.info('Script', '--- Summary ---');
  for (const r of results) {
    if (r.ok) {
      logger.info('Script', `  ✓ ${r.symbol}`);
    } else {
      logger.warn('Script', `  ✗ ${r.symbol}: ${r.error}`);
    }
  }
  const failed = results.filter(r => !r.ok).length;
  logger.info('Script', `${results.length - failed}/${results.length} coin(s) succeeded`);

  await disconnectDB();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
