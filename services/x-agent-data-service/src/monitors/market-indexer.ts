/**
 * Market Indexer Monitor
 *
 * Fetches all active Polymarket markets ending within 30 days
 * and upserts them into the polyMarkets collection.
 *
 * Runs every 6 hours.
 */

import { getDB, COLLECTIONS } from '../lib/db';
import { fetchMarketsEndingWithinDays, GammaMarket } from '../lib/polymarket-api';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('MarketIndexer');

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

/**
 * Transform Gamma API market to DB document
 */
function transformMarket(market: GammaMarket) {
  const now = new Date();
  const endDate = market.endDate ? new Date(market.endDate) : now;
  const daysUntilEnd = Math.ceil((endDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

  return {
    id: market.id,
    conditionId: market.conditionId,
    slug: market.slug,
    question: market.question,
    description: market.description,
    category: market.category,
    outcomes: market.outcomes,
    outcomePrices: market.outcomePrices,
    volume: market.volume,
    volumeNum: market.volumeNum,
    volume24hr: market.volume24hr,
    liquidity: market.liquidity,
    liquidityNum: market.liquidityNum,
    active: market.active,
    closed: market.closed,
    startDate: market.startDate ? new Date(market.startDate) : undefined,
    endDate,
    image: market.image,
    icon: market.icon,
    bestBid: market.bestBid,
    bestAsk: market.bestAsk,
    lastTradePrice: market.lastTradePrice,
    oneHourPriceChange: market.oneHourPriceChange,
    oneDayPriceChange: market.oneDayPriceChange,
    oneWeekPriceChange: market.oneWeekPriceChange,
    events: market.events,
    tags: market.tags,
    fetchedAt: now,
    daysUntilEnd,
  };
}

async function runMarketIndex(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    const db = await getDB();
    const collection = db.collection(COLLECTIONS.POLY_MARKETS);

    log.info(`Fetching markets ending within ${CONFIG.MARKET_DAYS_WINDOW} days (min volume: $${CONFIG.MARKET_MIN_VOLUME.toLocaleString()})...`);

    const markets = await fetchMarketsEndingWithinDays(
      CONFIG.MARKET_DAYS_WINDOW,
      CONFIG.MARKET_MIN_VOLUME
    );

    log.info(`Fetched ${markets.length} markets, upserting...`);

    let upserted = 0;
    let updated = 0;

    for (const market of markets) {
      const doc = transformMarket(market);

      const result = await collection.updateOne(
        { id: market.id },
        { $set: doc },
        { upsert: true }
      );

      if (result.upsertedCount > 0) upserted++;
      if (result.modifiedCount > 0) updated++;
    }

    // Create text index for keyword search if it doesn't exist
    try {
      await collection.createIndex(
        { question: 'text', description: 'text' },
        { name: 'text_search_idx' }
      );
    } catch {
      // Index already exists
    }

    log.success(`Market index complete: ${upserted} new, ${updated} updated, ${markets.length} total`);
  } catch (error: any) {
    log.error(`Market index failed: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

export function startMarketIndexer(): void {
  log.info(`Starting market indexer (every ${CONFIG.INTERVALS.MARKET_INDEX / 3600000}h)`);

  // Run immediately
  runMarketIndex();

  // Then on interval
  intervalId = setInterval(runMarketIndex, CONFIG.INTERVALS.MARKET_INDEX);
}

export function stopMarketIndexer(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Market indexer stopped');
  }
}

// Export for status reporting
export function getMarketIndexerStatus() {
  return { isRunning };
}
