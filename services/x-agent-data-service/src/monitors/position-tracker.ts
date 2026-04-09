/**
 * Position Tracker Monitor
 *
 * Fetches open positions of top 100 edge-ranked traders
 * and logs them in polymarket-openPositions collection.
 *
 * Runs every 15 minutes.
 */

import { getDB, COLLECTIONS } from '../lib/db';
import { fetchOpenPositions, OpenPosition } from '../lib/polymarket-api';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('PositionTracker');

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

const LOSS_THRESHOLD = 0.001;
const WIN_THRESHOLD = 0.99;

/**
 * Get top 100 edge-ranked traders
 */
async function getTopTraders(): Promise<Array<{ wallet: string; label?: string }>> {
  const db = await getDB();

  // Try ahf-edgeRankedTraders first
  const edgeCollection = db.collection(COLLECTIONS.EDGE_RANKED_TRADERS);
  let traders = await edgeCollection
    .find({})
    .sort({ profitFactor: -1, winRate: -1 })
    .limit(CONFIG.TOP_TRADERS_LIMIT)
    .project({ wallet: 1, label: 1 })
    .toArray();

  // Fallback to polymarket-traderProfiles
  if (traders.length === 0) {
    const profilesCollection = db.collection(COLLECTIONS.TRADER_PROFILES);
    traders = await profilesCollection
      .find({ winRate: { $gte: 55 }, profitFactor: { $gte: 1.5 } })
      .sort({ profitFactor: -1 })
      .limit(CONFIG.TOP_TRADERS_LIMIT)
      .project({ wallet: 1, label: 1 })
      .toArray();
  }

  return traders.map(t => ({ wallet: t.wallet, label: t.label }));
}

async function trackPositions(wallet: string): Promise<number> {
  const db = await getDB();
  const collection = db.collection(COLLECTIONS.OPEN_POSITIONS);

  try {
    const positions = await fetchOpenPositions(wallet);

    // Filter to active positions only (not resolved)
    const activePositions = positions.filter(
      p => p.curPrice >= LOSS_THRESHOLD && p.curPrice <= WIN_THRESHOLD
    );

    let saved = 0;

    for (const position of activePositions) {
      const doc = {
        wallet: wallet.toLowerCase(),
        conditionId: position.conditionId,
        outcome: position.outcome,
        title: position.title,
        slug: position.slug,
        size: position.size,
        avgPrice: position.avgPrice,
        curPrice: position.curPrice,
        initialValue: position.initialValue,
        currentValue: position.currentValue,
        cashPnl: position.cashPnl,
        percentPnl: position.percentPnl,
        lastUpdatedAt: new Date(),
      };

      try {
        await collection.updateOne(
          { wallet: doc.wallet, conditionId: doc.conditionId, outcome: doc.outcome },
          { $set: doc },
          { upsert: true }
        );
        saved++;
      } catch (error: any) {
        if (error.code !== 11000) throw error;
      }
    }

    return saved;
  } catch (error: any) {
    log.error(`Error tracking positions for ${wallet}: ${error.message}`);
    return 0;
  }
}

async function runPositionTrack(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    const traders = await getTopTraders();

    if (traders.length === 0) {
      log.warn('No traders found to track positions');
      return;
    }

    log.info(`Tracking positions for ${traders.length} traders...`);

    let totalPositions = 0;

    for (const trader of traders) {
      const saved = await trackPositions(trader.wallet);
      totalPositions += saved;

      // Rate limiting
      await new Promise(r => setTimeout(r, 300));
    }

    log.success(`Position tracking complete: ${totalPositions} positions across ${traders.length} traders`);
  } catch (error: any) {
    log.error(`Position tracking failed: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

export function startPositionTracker(): void {
  log.info(`Starting position tracker (every ${CONFIG.INTERVALS.POSITION_TRACK / 60000}m)`);

  // Delay 60s to let activity tracker run first
  setTimeout(() => {
    runPositionTrack();
    intervalId = setInterval(runPositionTrack, CONFIG.INTERVALS.POSITION_TRACK);
  }, 60_000);
}

export function stopPositionTracker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Position tracker stopped');
  }
}

export function getPositionTrackerStatus() {
  return { isRunning };
}
