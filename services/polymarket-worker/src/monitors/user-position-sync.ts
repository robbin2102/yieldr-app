/**
 * User Position Sync - Syncs user copy positions and matches them to tracked traders
 * Runs every 5 minutes to keep positions up-to-date
 */

import { getDB, COLLECTIONS } from '../lib/db';
import { fetchOpenPositions, fetchActivities, fetchClosedPositions, Activity, OpenPosition, ClosedPosition } from '../lib/polymarket-api';

const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes
let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

// Default user wallet to sync (can be configured via DB or env)
const DEFAULT_USER_WALLET = process.env.USER_WALLET || '0x01ba1dfbf9dd83a6ee27eb4c33f2d540232ca4ba';

interface TrackedTrader {
  wallet: string;
  label: string;
}

interface TraderData {
  wallet: string;
  label: string;
  activities: Activity[];
  openPositions: OpenPosition[];
}

// Match a trade to a trader
function matchTradeToTrader(
  myTrade: Activity,
  tradersData: TraderData[]
): { wallet: string; label: string; matchType: 'activity' | 'position' } | null {
  const TIME_WINDOW = 48 * 60 * 60; // 48 hours

  // Activity-based matching
  let bestMatch: { wallet: string; label: string; timeDiff: number } | null = null;

  for (const trader of tradersData) {
    for (const traderTrade of trader.activities) {
      const sameMarket = traderTrade.conditionId === myTrade.conditionId;
      const sameOutcome = traderTrade.outcome === myTrade.outcome;
      const sameSide = traderTrade.side === myTrade.side;
      const traderFirst = traderTrade.timestamp <= myTrade.timestamp;

      if (sameMarket && sameOutcome && sameSide && traderFirst) {
        const timeDiff = myTrade.timestamp - traderTrade.timestamp;
        if (timeDiff <= TIME_WINDOW) {
          if (!bestMatch || timeDiff < bestMatch.timeDiff) {
            bestMatch = { wallet: trader.wallet, label: trader.label, timeDiff };
          }
        }
      }
    }
  }

  if (bestMatch) {
    return { wallet: bestMatch.wallet, label: bestMatch.label, matchType: 'activity' };
  }

  // Position-based matching (for BUY trades only)
  if (myTrade.side === 'BUY') {
    let posMatch: { wallet: string; label: string; positionValue: number } | null = null;

    for (const trader of tradersData) {
      for (const position of trader.openPositions) {
        if (position.conditionId === myTrade.conditionId && position.outcome === myTrade.outcome) {
          if (!posMatch || position.currentValue > posMatch.positionValue) {
            posMatch = { wallet: trader.wallet, label: trader.label, positionValue: position.currentValue };
          }
        }
      }
    }

    if (posMatch) {
      return { wallet: posMatch.wallet, label: posMatch.label, matchType: 'position' };
    }
  }

  return null;
}

async function syncUserPositions(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    const db = await getDB();
    const userWallet = DEFAULT_USER_WALLET.toLowerCase();
    const days = 30;

    // Get tracked traders
    const trackedTraders = await db
      .collection(COLLECTIONS.TRACKED_TRADERS)
      .find({ isActive: true, isTracking: true })
      .toArray() as unknown as TrackedTrader[];

    if (trackedTraders.length === 0) {
      console.log('[UserSync] No traders being tracked, skipping');
      return;
    }

    console.log(`[UserSync] Syncing positions for ${userWallet.slice(0, 10)}... (${trackedTraders.length} traders)`);

    // Fetch user data
    const [myActivities, myOpenPositions, myClosedPositions] = await Promise.all([
      fetchActivities(userWallet, days),
      fetchOpenPositions(userWallet),
      fetchClosedPositions(userWallet, days),
    ]);

    const myTrades = myActivities.filter(a => a.type === 'TRADE');

    // Fetch trader data
    const tradersData: TraderData[] = [];

    for (const trader of trackedTraders) {
      try {
        const [activities, positions] = await Promise.all([
          fetchActivities(trader.wallet, days),
          fetchOpenPositions(trader.wallet),
        ]);

        tradersData.push({
          wallet: trader.wallet,
          label: trader.label,
          activities: activities.filter(a => a.type === 'TRADE'),
          openPositions: positions,
        });

        await new Promise(r => setTimeout(r, 100));
      } catch (err: any) {
        console.error(`[UserSync] Error fetching ${trader.label}: ${err.message}`);
      }
    }

    // Match and save positions
    const collection = db.collection(COLLECTIONS.COPY_POSITIONS);
    let savedCount = 0;
    let updatedCount = 0;
    let matchedCount = 0;

    for (const trade of myTrades) {
      const match = matchTradeToTrader(trade, tradersData);

      if (match) {
        matchedCount++;

        // Find position status
        const openPos = myOpenPositions.find(
          p => p.conditionId === trade.conditionId && p.outcome === trade.outcome
        );
        const closedPos = myClosedPositions.find(
          p => p.conditionId === trade.conditionId && p.outcome === trade.outcome
        );

        let status: 'OPEN' | 'CLOSED' | 'UNKNOWN' = 'UNKNOWN';
        let currentValue: number | undefined;
        let cashPnl: number | undefined;
        let curPrice: number | undefined;

        if (openPos) {
          status = 'OPEN';
          currentValue = openPos.currentValue;
          cashPnl = openPos.cashPnl;
          curPrice = openPos.curPrice;
        } else if (closedPos) {
          status = 'CLOSED';
          cashPnl = closedPos.realizedPnl;
        }

        const positionDoc = {
          userWallet,
          traderWallet: match.wallet,
          traderLabel: match.label,
          conditionId: trade.conditionId,
          asset: trade.asset,
          market: trade.title,
          outcome: trade.outcome,
          side: trade.side || 'UNKNOWN',
          size: trade.size,
          price: trade.price,
          usdcValue: trade.usdcSize,
          timestamp: new Date(trade.timestamp * 1000),
          status,
          currentValue,
          curPrice,
          pnl: cashPnl,
          pnlPercent: trade.usdcSize > 0 && cashPnl ? (cashPnl / trade.usdcSize) * 100 : 0,
          matchType: match.matchType,
          matchedAt: new Date(),
          txHash: trade.transactionHash,
        };

        try {
          const result = await collection.updateOne(
            {
              userWallet,
              conditionId: trade.conditionId,
              outcome: trade.outcome,
              txHash: trade.transactionHash,
            },
            { $set: positionDoc },
            { upsert: true }
          );

          if (result.upsertedCount > 0) savedCount++;
          else if (result.modifiedCount > 0) updatedCount++;
        } catch (err: any) {
          if (!err.message?.includes('duplicate key')) {
            console.error(`[UserSync] Error saving: ${err.message}`);
          }
        }
      }
    }

    console.log(
      `[UserSync] Complete: ${matchedCount}/${myTrades.length} matched, ${savedCount} new, ${updatedCount} updated`
    );

  } catch (error: any) {
    console.error('[UserSync] Error:', error.message);
  } finally {
    isRunning = false;
  }
}

export function startUserPositionSync(): void {
  console.log(`[UserSync] Starting user position sync (every ${SYNC_INTERVAL / 1000}s)`);

  // Run immediately
  syncUserPositions();

  // Then run on interval
  intervalId = setInterval(syncUserPositions, SYNC_INTERVAL);
}

export function stopUserPositionSync(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[UserSync] Stopped');
  }
}

// Export for manual triggering
export { syncUserPositions };
