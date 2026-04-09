/**
 * High Conviction Trade Detector
 *
 * Scans x-agent-tradeActivities for trades that meet high conviction criteria:
 * - Size multiplier >= 50x average trade size
 * - USDC value >= $25,000
 *
 * Also detects broader high conviction (10x avg, any size) for content variety.
 * Logs detected trades to x-agent-highConvictionTrades collection.
 *
 * Runs every 15 minutes (after activity tracker).
 */

import { getDB, COLLECTIONS } from '../lib/db';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('HighConviction');

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

interface TradeActivity {
  wallet: string;
  traderLabel?: string;
  conditionId: string;
  market: string;
  outcome: string;
  type: string;
  side?: string;
  size: number;
  price: number;
  usdcSize: number;
  timestamp: number;
  transactionHash: string;
  traderWinRate?: number;
  traderProfitFactor?: number;
  traderAvgTradeSize?: number;
  sizeMultiplier: number;
}

async function detectHighConvictionTrades(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    const db = await getDB();
    const activitiesCol = db.collection(COLLECTIONS.TRADE_ACTIVITIES);
    const hcCol = db.collection(COLLECTIONS.HIGH_CONVICTION_TRADES);

    // Look for activities in the last 30 minutes (overlap with previous cycle for safety)
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 60;

    // Query for recent BUY trades with high size multiplier
    const recentActivities = await activitiesCol
      .find({
        type: 'TRADE',
        side: 'BUY',
        timestamp: { $gte: cutoff },
        $or: [
          // Primary: whale trades (50x avg, $25k+)
          {
            sizeMultiplier: { $gte: CONFIG.HIGH_CONVICTION.MIN_SIZE_MULTIPLIER },
            usdcSize: { $gte: CONFIG.HIGH_CONVICTION.MIN_USDC_VALUE },
          },
          // Secondary: significant trades (10x avg, $5k+)
          {
            sizeMultiplier: { $gte: CONFIG.HIGH_CONVICTION.FALLBACK_SIZE_MULTIPLIER },
            usdcSize: { $gte: 5000 },
          },
        ],
      })
      .sort({ usdcSize: -1 })
      .toArray() as unknown as TradeActivity[];

    if (recentActivities.length === 0) {
      log.info('No high conviction trades detected');
      return;
    }

    let whaleCount = 0;
    let significantCount = 0;

    for (const activity of recentActivities) {
      const isWhale = activity.sizeMultiplier >= CONFIG.HIGH_CONVICTION.MIN_SIZE_MULTIPLIER
        && activity.usdcSize >= CONFIG.HIGH_CONVICTION.MIN_USDC_VALUE;

      const doc = {
        wallet: activity.wallet,
        traderLabel: activity.traderLabel,
        conditionId: activity.conditionId,
        market: activity.market,
        outcome: activity.outcome,
        side: activity.side,
        size: activity.size,
        price: activity.price,
        usdcValue: activity.usdcSize,
        timestamp: activity.timestamp,
        transactionHash: activity.transactionHash,

        // Conviction metrics
        sizeMultiplier: activity.sizeMultiplier,
        convictionLevel: isWhale ? 'WHALE' : 'SIGNIFICANT',

        // Trader context
        traderWinRate: activity.traderWinRate,
        traderProfitFactor: activity.traderProfitFactor,
        traderAvgTradeSize: activity.traderAvgTradeSize,

        // Metadata
        detectedAt: new Date(),
        postedToX: false,
      };

      try {
        const result = await hcCol.updateOne(
          { transactionHash: activity.transactionHash },
          { $setOnInsert: doc },
          { upsert: true }
        );

        if (result.upsertedCount > 0) {
          if (isWhale) whaleCount++;
          else significantCount++;
        }
      } catch (error: any) {
        if (error.code !== 11000) throw error;
      }
    }

    if (whaleCount > 0 || significantCount > 0) {
      log.success(`Detected: ${whaleCount} whale trades, ${significantCount} significant trades`);
    } else {
      log.info('All detected trades already recorded');
    }
  } catch (error: any) {
    log.error(`High conviction detection failed: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

export function startHighConvictionDetector(): void {
  log.info(`Starting high conviction detector (every ${CONFIG.INTERVALS.HIGH_CONVICTION / 60000}m)`);

  // Delay 90s to let activity tracker populate data first
  setTimeout(() => {
    detectHighConvictionTrades();
    intervalId = setInterval(detectHighConvictionTrades, CONFIG.INTERVALS.HIGH_CONVICTION);
  }, 90_000);
}

export function stopHighConvictionDetector(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('High conviction detector stopped');
  }
}

export function getHighConvictionStatus() {
  return { isRunning };
}
