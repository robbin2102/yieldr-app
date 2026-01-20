/**
 * Alert Monitor - Detects new trades from tracked traders and creates alerts
 * Runs every 10-15 seconds for near real-time detection
 */

import { getDB, COLLECTIONS } from '../lib/db';
import { fetchActivitiesSince, Activity } from '../lib/polymarket-api';
import { wsManager } from '../websocket/server';

const POLL_INTERVAL = 10_000; // 10 seconds
let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

interface TrackedTrader {
  wallet: string;
  label: string;
  isActive: boolean;
  isTracking: boolean;
  lastSeenTimestamp: number;
}

async function checkTraderForNewTrades(trader: TrackedTrader): Promise<number> {
  const db = await getDB();
  let newAlertsCount = 0;

  try {
    // Fetch activities since last seen
    const activities = await fetchActivitiesSince(
      trader.wallet,
      trader.lastSeenTimestamp,
      50 // Limit per check
    );

    // Filter to only BUY trades (the ones we want to alert on)
    const newTrades = activities.filter(
      a => a.type === 'TRADE' && a.side === 'BUY'
    );

    if (newTrades.length === 0) return 0;

    // Create alerts for each new trade
    const alertsCollection = db.collection(COLLECTIONS.TRADE_ALERTS);
    const tradersCollection = db.collection(COLLECTIONS.TRACKED_TRADERS);

    let latestTimestamp = trader.lastSeenTimestamp;

    for (const trade of newTrades) {
      // Create alert document
      const alert = {
        traderWallet: trader.wallet.toLowerCase(),
        traderLabel: trader.label,
        conditionId: trade.conditionId,
        market: trade.title,
        outcome: trade.outcome,
        side: trade.side,
        size: trade.size,
        price: trade.price,
        usdcValue: trade.usdcSize,
        timestamp: trade.timestamp,
        transactionHash: trade.transactionHash,
        createdAt: new Date(),
        isRead: false,
        isActioned: false,
      };

      // Upsert to avoid duplicates (based on transaction hash)
      const result = await alertsCollection.updateOne(
        { transactionHash: trade.transactionHash },
        { $setOnInsert: alert },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
        newAlertsCount++;

        // Broadcast via WebSocket
        wsManager.broadcastAlert(alert);

        console.log(
          `[Alert] ${trader.label}: ${trade.side} ${trade.outcome} - ${trade.title.substring(0, 40)}... ($${trade.usdcSize.toFixed(2)})`
        );
      }

      // Track latest timestamp
      if (trade.timestamp > latestTimestamp) {
        latestTimestamp = trade.timestamp;
      }
    }

    // Update lastSeenTimestamp for trader
    if (latestTimestamp > trader.lastSeenTimestamp) {
      await tradersCollection.updateOne(
        { wallet: trader.wallet.toLowerCase() },
        {
          $set: {
            lastSeenTimestamp: latestTimestamp,
            lastUpdatedAt: new Date(),
          },
        }
      );
    }

    // Update totalAlerts count
    if (newAlertsCount > 0) {
      await tradersCollection.updateOne(
        { wallet: trader.wallet.toLowerCase() },
        { $inc: { totalAlerts: newAlertsCount } }
      );
    }

  } catch (error: any) {
    console.error(`[Alert] Error checking ${trader.label}:`, error.message);
  }

  return newAlertsCount;
}

async function runAlertCheck(): Promise<void> {
  if (isRunning) return; // Prevent overlapping runs
  isRunning = true;

  try {
    const db = await getDB();

    // Get all actively tracked traders
    const traders = await db
      .collection(COLLECTIONS.TRACKED_TRADERS)
      .find({ isActive: true, isTracking: true })
      .toArray() as unknown as TrackedTrader[];

    if (traders.length === 0) {
      return;
    }

    let totalAlerts = 0;

    // Check each trader (with small delay to avoid rate limiting)
    for (const trader of traders) {
      const count = await checkTraderForNewTrades(trader);
      totalAlerts += count;
      await new Promise(r => setTimeout(r, 100)); // 100ms delay between traders
    }

    if (totalAlerts > 0) {
      console.log(`[Alert] Created ${totalAlerts} new alerts from ${traders.length} traders`);
    }

  } catch (error: any) {
    console.error('[Alert] Monitor error:', error.message);
  } finally {
    isRunning = false;
  }
}

export function startAlertMonitor(): void {
  console.log(`[Alert] Starting alert monitor (polling every ${POLL_INTERVAL / 1000}s)`);

  // Run immediately
  runAlertCheck();

  // Then run on interval
  intervalId = setInterval(runAlertCheck, POLL_INTERVAL);
}

export function stopAlertMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Alert] Monitor stopped');
  }
}
