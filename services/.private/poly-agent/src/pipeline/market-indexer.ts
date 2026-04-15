/**
 * Market Indexer
 *
 * Fetches all active Polymarket markets ending within 30 days
 * and upserts them into the polyMarkets collection.
 *
 * Runs every 24 hours.
 */

import { getPipelineDB, COLLECTIONS } from './db';
import { fetchMarketsEndingWithinDays, GammaMarket } from './polymarket-api';
import { PIPELINE_CONFIG } from './pipeline-config';
import { createLogger } from './logger';

const log = createLogger('MarketIndexer');

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

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
    const db = await getPipelineDB();
    const collection = db.collection(COLLECTIONS.POLY_MARKETS);

    log.info(`Fetching markets ending within ${PIPELINE_CONFIG.MARKET_DAYS_WINDOW} days (min volume: $${PIPELINE_CONFIG.MARKET_MIN_VOLUME.toLocaleString()})...`);

    const markets = await fetchMarketsEndingWithinDays(
      PIPELINE_CONFIG.MARKET_DAYS_WINDOW,
      PIPELINE_CONFIG.MARKET_MIN_VOLUME,
    );

    log.info(`Fetched ${markets.length} markets, upserting...`);

    let upserted = 0;
    let updated = 0;

    for (const market of markets) {
      const doc = transformMarket(market);
      const result = await collection.updateOne(
        { id: market.id },
        { $set: doc },
        { upsert: true },
      );
      if (result.upsertedCount > 0) upserted++;
      if (result.modifiedCount > 0) updated++;
    }

    // Create text index for keyword search
    try {
      await collection.createIndex(
        { question: 'text', description: 'text' },
        { name: 'text_search_idx' },
      );
    } catch {
      // Index already exists — ignore
    }

    log.success(`Market index complete: ${upserted} new, ${updated} updated, ${markets.length} total`);
  } catch (error: any) {
    log.error(`Market index failed: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

export function startMarketIndexer(): void {
  log.info(`Starting market indexer (every ${PIPELINE_CONFIG.INTERVALS.MARKET_INDEX / 3_600_000}h)`);
  runMarketIndex();
  intervalId = setInterval(runMarketIndex, PIPELINE_CONFIG.INTERVALS.MARKET_INDEX);
}

export function stopMarketIndexer(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Market indexer stopped');
  }
}

export function getMarketIndexerStatus() {
  return { isRunning };
}
