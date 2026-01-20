/**
 * Position Refresher - Updates open position data for all tracked traders
 * Runs every 60 seconds to keep prices and P&L current
 */

import { getDB, COLLECTIONS } from '../lib/db';
import { fetchOpenPositions, OpenPosition } from '../lib/polymarket-api';
import { wsManager } from '../websocket/server';

const REFRESH_INTERVAL = 60_000; // 60 seconds
let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

// Thresholds for filtering resolved positions
const LOSS_THRESHOLD = 0.001; // <0.1¢ = resolved loss
const WIN_THRESHOLD = 0.99;   // >99¢ = resolved win

interface TrackedTrader {
  wallet: string;
  label: string;
  isActive: boolean;
  isTracking: boolean;
}

async function refreshTraderPositions(trader: TrackedTrader): Promise<number> {
  const db = await getDB();

  try {
    // Fetch current positions from Polymarket
    const positions = await fetchOpenPositions(trader.wallet);

    // Filter to active positions only (exclude resolved)
    const activePositions = positions.filter(
      p => p.curPrice >= LOSS_THRESHOLD && p.curPrice <= WIN_THRESHOLD
    );

    if (positions.length === 0) return 0;

    const collection = db.collection(COLLECTIONS.OPEN_POSITIONS);
    const now = new Date();

    // Prepare bulk operations
    const operations = activePositions.map(pos => ({
      updateOne: {
        filter: {
          walletAddress: trader.wallet.toLowerCase(),
          conditionId: pos.conditionId,
          asset: pos.asset,
        },
        update: {
          $set: {
            walletAddress: trader.wallet.toLowerCase(),
            traderLabel: trader.label,
            conditionId: pos.conditionId,
            asset: pos.asset,
            title: pos.title,
            slug: pos.slug,
            outcome: pos.outcome,
            size: pos.size,
            avgPrice: pos.avgPrice,
            curPrice: pos.curPrice,
            initialValue: pos.initialValue,
            currentValue: pos.currentValue,
            cashPnl: pos.cashPnl,
            percentPnl: pos.percentPnl,
            fetchedAt: now,
          },
        },
        upsert: true,
      },
    }));

    if (operations.length > 0) {
      await collection.bulkWrite(operations);
    }

    // Clean up old positions that no longer exist
    await collection.deleteMany({
      walletAddress: trader.wallet.toLowerCase(),
      fetchedAt: { $lt: new Date(now.getTime() - 5 * 60 * 1000) }, // Older than 5 min
    });

    // Broadcast update via WebSocket
    wsManager.broadcastPositions(trader.wallet, activePositions);

    return activePositions.length;

  } catch (error: any) {
    console.error(`[Position] Error refreshing ${trader.label}:`, error.message);
    return 0;
  }
}

async function runPositionRefresh(): Promise<void> {
  if (isRunning) return;
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

    let totalPositions = 0;

    // Refresh each trader's positions
    for (const trader of traders) {
      const count = await refreshTraderPositions(trader);
      totalPositions += count;
      await new Promise(r => setTimeout(r, 200)); // 200ms delay between traders
    }

    console.log(
      `[Position] Refreshed ${totalPositions} positions for ${traders.length} traders`
    );

  } catch (error: any) {
    console.error('[Position] Refresh error:', error.message);
  } finally {
    isRunning = false;
  }
}

export function startPositionRefresher(): void {
  console.log(`[Position] Starting position refresher (every ${REFRESH_INTERVAL / 1000}s)`);

  // Run immediately
  runPositionRefresh();

  // Then run on interval
  intervalId = setInterval(runPositionRefresh, REFRESH_INTERVAL);
}

export function stopPositionRefresher(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Position] Refresher stopped');
  }
}
