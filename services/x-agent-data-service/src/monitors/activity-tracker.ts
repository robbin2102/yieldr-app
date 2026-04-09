/**
 * Activity Tracker Monitor
 *
 * Fetches recent trade activities of top 100 edge-ranked traders
 * and logs them into x-agent-tradeActivities collection.
 *
 * Runs every 15 minutes.
 */

import { getDB, COLLECTIONS } from '../lib/db';
import { fetchActivitiesSince, Activity } from '../lib/polymarket-api';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('ActivityTracker');

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

interface EdgeRankedTrader {
  wallet: string;
  label?: string;
  winRate?: number;
  netPnl?: number;
  profitFactor?: number;
  avgTradeSize?: number;
}

/**
 * Get top 100 edge-ranked traders from MongoDB
 */
async function getTopTraders(): Promise<EdgeRankedTrader[]> {
  const db = await getDB();

  // First try ahf-edgeRankedTraders collection
  const edgeCollection = db.collection(COLLECTIONS.EDGE_RANKED_TRADERS);
  let traders = await edgeCollection
    .find({})
    .sort({ profitFactor: -1, winRate: -1, netPnl: -1 })
    .limit(CONFIG.TOP_TRADERS_LIMIT)
    .toArray();

  // Fallback to polymarket-traderProfiles if edgeRanked is empty
  if (traders.length === 0) {
    log.warn('ahf-edgeRankedTraders empty, falling back to polymarket-traderProfiles');
    const profilesCollection = db.collection(COLLECTIONS.TRADER_PROFILES);
    traders = await profilesCollection
      .find({ winRate: { $gte: 55 }, profitFactor: { $gte: 1.5 } })
      .sort({ profitFactor: -1, netPnl: -1 })
      .limit(CONFIG.TOP_TRADERS_LIMIT)
      .toArray();
  }

  return traders.map(t => ({
    wallet: t.wallet,
    label: t.label,
    winRate: t.winRate,
    netPnl: t.netPnl,
    profitFactor: t.profitFactor,
    avgTradeSize: t.avgTradeSize,
  }));
}

/**
 * Get last seen timestamp for a trader
 */
async function getLastSeenTimestamp(wallet: string): Promise<number> {
  const db = await getDB();
  const collection = db.collection(COLLECTIONS.TRADE_ACTIVITIES);

  const latest = await collection
    .findOne(
      { wallet: wallet.toLowerCase() },
      { sort: { timestamp: -1 }, projection: { timestamp: 1 } }
    );

  if (latest?.timestamp) {
    return typeof latest.timestamp === 'number'
      ? latest.timestamp
      : Math.floor(new Date(latest.timestamp).getTime() / 1000);
  }

  // Default: look back 24 hours on first run
  return Math.floor(Date.now() / 1000) - 24 * 60 * 60;
}

async function trackTraderActivities(trader: EdgeRankedTrader): Promise<number> {
  const db = await getDB();
  const collection = db.collection(COLLECTIONS.TRADE_ACTIVITIES);

  try {
    const lastTimestamp = await getLastSeenTimestamp(trader.wallet);
    const activities = await fetchActivitiesSince(trader.wallet, lastTimestamp, 100);

    if (activities.length === 0) return 0;

    let saved = 0;

    for (const activity of activities) {
      if (!activity.transactionHash) continue;

      const doc = {
        wallet: trader.wallet.toLowerCase(),
        traderLabel: trader.label,
        conditionId: activity.conditionId,
        market: activity.title,
        outcome: activity.outcome,
        type: activity.type,
        side: activity.side,
        size: activity.size,
        price: activity.price,
        usdcSize: activity.usdcSize,
        timestamp: activity.timestamp,
        transactionHash: activity.transactionHash,
        // Trader edge context
        traderWinRate: trader.winRate,
        traderProfitFactor: trader.profitFactor,
        traderAvgTradeSize: trader.avgTradeSize,
        // Computed fields
        sizeMultiplier: trader.avgTradeSize && trader.avgTradeSize > 0
          ? activity.usdcSize / trader.avgTradeSize
          : 0,
        indexedAt: new Date(),
      };

      try {
        await collection.updateOne(
          { wallet: doc.wallet, transactionHash: doc.transactionHash },
          { $setOnInsert: doc },
          { upsert: true }
        );
        saved++;
      } catch (error: any) {
        // Duplicate key - skip
        if (error.code !== 11000) throw error;
      }
    }

    return saved;
  } catch (error: any) {
    log.error(`Error tracking ${trader.label || trader.wallet}: ${error.message}`);
    return 0;
  }
}

async function runActivityTrack(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    const traders = await getTopTraders();

    if (traders.length === 0) {
      log.warn('No edge-ranked traders found to track');
      return;
    }

    log.info(`Tracking activities for ${traders.length} edge-ranked traders...`);

    let totalSaved = 0;

    for (const trader of traders) {
      const saved = await trackTraderActivities(trader);
      totalSaved += saved;

      // Rate limiting between traders
      await new Promise(r => setTimeout(r, 200));
    }

    if (totalSaved > 0) {
      log.success(`Activity tracking complete: ${totalSaved} new activities from ${traders.length} traders`);
    } else {
      log.info(`Activity tracking complete: no new activities`);
    }
  } catch (error: any) {
    log.error(`Activity tracking failed: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

export function startActivityTracker(): void {
  log.info(`Starting activity tracker (every ${CONFIG.INTERVALS.ACTIVITY_TRACK / 60000}m)`);

  // Delay first run by 30s to let market indexer start
  setTimeout(() => {
    runActivityTrack();
    intervalId = setInterval(runActivityTrack, CONFIG.INTERVALS.ACTIVITY_TRACK);
  }, 30_000);
}

export function stopActivityTracker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Activity tracker stopped');
  }
}

export function getActivityTrackerStatus() {
  return { isRunning };
}
