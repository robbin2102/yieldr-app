/**
 * Profile Refresher - Updates trader profile data (positions, stats)
 * Runs every 5 minutes for lighter updates (not full re-profile)
 */

import { getDB, COLLECTIONS } from '../lib/db';
import { fetchOpenPositions, fetchActivities, OpenPosition, Activity } from '../lib/polymarket-api';
import { wsManager } from '../websocket/server';

const REFRESH_INTERVAL = 5 * 60_000; // 5 minutes
let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

const LOSS_THRESHOLD = 0.001;
const WIN_THRESHOLD = 0.99;

interface TrackedTrader {
  wallet: string;
  label: string;
  isActive: boolean;
  isTracking: boolean;
}

async function refreshTraderProfile(trader: TrackedTrader): Promise<void> {
  const db = await getDB();

  try {
    // Fetch current data
    const [positions, activities] = await Promise.all([
      fetchOpenPositions(trader.wallet),
      fetchActivities(trader.wallet, 30), // Last 30 days
    ]);

    // Separate active from resolved positions
    const activePositions = positions.filter(
      p => p.curPrice >= LOSS_THRESHOLD && p.curPrice <= WIN_THRESHOLD
    );
    const resolvedLosses = positions.filter(
      p => p.curPrice < LOSS_THRESHOLD && p.size > 0
    );
    const resolvedWins = positions.filter(
      p => p.curPrice > WIN_THRESHOLD && p.size > 0
    );

    // Calculate stats
    const trades = activities.filter(a => a.type === 'TRADE');
    const buys = trades.filter(t => t.side === 'BUY');
    const sells = trades.filter(t => t.side === 'SELL');
    const redeems = activities.filter(a => a.type === 'REDEEM');

    // Calculate open position metrics
    const openValue = activePositions.reduce((sum, p) => sum + p.currentValue, 0);
    const unrealizedPnl = activePositions.reduce((sum, p) => sum + p.cashPnl, 0);

    // Identify high conviction trades (asymmetric bets)
    const highConvictionTrades = buys
      .filter(t => {
        // High conviction: large size AND low price (asymmetric risk/reward)
        const isLowPrice = t.price <= 0.25; // 25¢ or less
        const isLargeSize = t.usdcSize >= 50; // $50+
        return isLowPrice && isLargeSize;
      })
      .sort((a, b) => b.usdcSize - a.usdcSize)
      .slice(0, 50) // Keep top 50
      .map(t => ({
        market: t.title,
        outcome: t.outcome,
        price: t.price,
        size: t.size,
        usdcValue: t.usdcSize,
        timestamp: t.timestamp,
        transactionHash: t.transactionHash,
      }));

    // Build top open positions
    const topOpenPositions = activePositions
      .sort((a, b) => b.currentValue - a.currentValue)
      .map(p => ({
        conditionId: p.conditionId,
        title: p.title,
        outcome: p.outcome,
        size: p.size,
        avgPrice: p.avgPrice,
        curPrice: p.curPrice,
        initialValue: p.initialValue,
        currentValue: p.currentValue,
        cashPnl: p.cashPnl,
        percentPnl: p.percentPnl,
      }));

    // Build closed positions from resolved
    const recentClosedPositions = [
      ...resolvedWins.map(p => ({
        title: p.title,
        outcome: p.outcome,
        size: p.size,
        avgPrice: p.avgPrice,
        realizedPnl: p.currentValue - (p.size * p.avgPrice),
        timestamp: new Date().toISOString(),
        status: 'WON' as const,
      })),
      ...resolvedLosses.map(p => ({
        title: p.title,
        outcome: p.outcome,
        size: p.size,
        avgPrice: p.avgPrice,
        realizedPnl: -(p.size * p.avgPrice),
        timestamp: new Date().toISOString(),
        status: 'LOST' as const,
      })),
    ].slice(0, 20);

    // Update profile in database
    const profilesCollection = db.collection(COLLECTIONS.TRADER_PROFILES);

    await profilesCollection.updateOne(
      { wallet: trader.wallet.toLowerCase() },
      {
        $set: {
          // Updated position data
          openPositionsCount: activePositions.length,
          openValue,
          unrealizedPnl,
          topOpenPositions,
          recentClosedPositions,

          // Updated activity stats
          totalActivities: activities.length,
          buyCount: buys.length,
          sellCount: sells.length,
          redeemCount: redeems.length,

          // High conviction trades
          recentHighConvictionTrades: highConvictionTrades,
          asymmetricTradesCount: highConvictionTrades.length,

          // Metadata
          lastRefreshedAt: new Date(),
        },
      }
    );

    // Also update the tracked trader stats
    const tradersCollection = db.collection(COLLECTIONS.TRACKED_TRADERS);
    await tradersCollection.updateOne(
      { wallet: trader.wallet.toLowerCase() },
      {
        $set: {
          openPositionsCount: activePositions.length,
          openValue,
          lastUpdatedAt: new Date(),
        },
      }
    );

    // Broadcast profile update
    wsManager.broadcastProfile(trader.wallet, {
      openPositionsCount: activePositions.length,
      openValue,
      unrealizedPnl,
      highConvictionCount: highConvictionTrades.length,
    });

  } catch (error: any) {
    console.error(`[Profile] Error refreshing ${trader.label}:`, error.message);
  }
}

async function runProfileRefresh(): Promise<void> {
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

    console.log(`[Profile] Refreshing profiles for ${traders.length} traders...`);

    // Refresh each trader's profile
    for (const trader of traders) {
      await refreshTraderProfile(trader);
      await new Promise(r => setTimeout(r, 500)); // 500ms delay between traders
    }

    console.log(`[Profile] Refresh complete`);

  } catch (error: any) {
    console.error('[Profile] Refresh error:', error.message);
  } finally {
    isRunning = false;
  }
}

export function startProfileRefresher(): void {
  console.log(`[Profile] Starting profile refresher (every ${REFRESH_INTERVAL / 60000} min)`);

  // Run after a short delay (let positions refresh first)
  setTimeout(() => {
    runProfileRefresh();
    intervalId = setInterval(runProfileRefresh, REFRESH_INTERVAL);
  }, 30_000); // Start 30s after boot
}

export function stopProfileRefresher(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Profile] Refresher stopped');
  }
}
