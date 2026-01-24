/**
 * Polymarket Data Fetcher
 * Fetches and saves positions and trades to MongoDB
 */

import { getCollections } from '../lib/db';
import {
  fetchOpenPositions,
  fetchActivities,
  fetchClosedPositions,
  OpenPosition,
  Activity,
  ClosedPosition,
} from '../lib/api';

const LOSS_THRESHOLD = 0.001;
const WIN_THRESHOLD = 0.99;

/**
 * Fetch and save open positions for a wallet
 */
export async function fetchAndSaveOpenPositions(walletAddress: string) {
  console.log(`[Fetcher] Fetching open positions for ${walletAddress}...`);

  const positions = await fetchOpenPositions(walletAddress);
  const { openPositions } = await getCollections();

  // Filter active vs resolved positions
  const activePositions = positions.filter(
    (p) => p.curPrice >= LOSS_THRESHOLD && p.curPrice <= WIN_THRESHOLD
  );

  // Clear old positions and insert new ones
  await openPositions.deleteMany({ wallet: walletAddress.toLowerCase() });

  if (activePositions.length > 0) {
    const docs = activePositions.map((p) => ({
      wallet: walletAddress.toLowerCase(),
      conditionId: p.conditionId,
      asset: p.asset,
      title: p.title,
      slug: p.slug,
      outcome: p.outcome,
      size: p.size,
      avgPrice: p.avgPrice,
      curPrice: p.curPrice,
      initialValue: p.initialValue,
      currentValue: p.currentValue,
      cashPnl: p.cashPnl,
      percentPnl: p.percentPnl,
      updatedAt: new Date(),
    }));

    await openPositions.insertMany(docs);
  }

  console.log(`[Fetcher] Saved ${activePositions.length} open positions`);

  return {
    total: positions.length,
    active: activePositions.length,
    resolved: positions.length - activePositions.length,
  };
}

/**
 * Fetch and save recent trades for a wallet
 */
export async function fetchAndSaveTrades(walletAddress: string, days: number = 30) {
  console.log(`[Fetcher] Fetching ${days}d trades for ${walletAddress}...`);

  const activities = await fetchActivities(walletAddress, days);
  const trades = activities.filter((a) => a.type === 'TRADE');

  if (trades.length === 0) {
    console.log(`[Fetcher] No trades found`);
    return { saved: 0, duplicates: 0 };
  }

  const { trades: tradesCollection } = await getCollections();

  // Bulk upsert trades
  const bulkOps = trades.map((t) => ({
    updateOne: {
      filter: {
        wallet: walletAddress.toLowerCase(),
        transactionHash: t.transactionHash,
      },
      update: {
        $setOnInsert: {
          wallet: walletAddress.toLowerCase(),
          conditionId: t.conditionId,
          asset: t.asset,
          title: t.title,
          slug: t.slug,
          outcome: t.outcome,
          type: t.type,
          side: t.side,
          size: t.size,
          price: t.price,
          usdcSize: t.usdcSize,
          timestamp: t.timestamp,
          transactionHash: t.transactionHash,
          createdAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  const result = await tradesCollection.bulkWrite(bulkOps, { ordered: false });
  const saved = result.upsertedCount || 0;
  const duplicates = trades.length - saved;

  console.log(`[Fetcher] Saved ${saved} trades, ${duplicates} existing`);

  return { saved, duplicates, total: trades.length };
}

/**
 * Fetch and save closed positions for a wallet
 */
export async function fetchAndSaveClosedPositions(
  walletAddress: string,
  days: number = 90
) {
  console.log(`[Fetcher] Fetching ${days}d closed positions for ${walletAddress}...`);

  const positions = await fetchClosedPositions(walletAddress, days);

  if (positions.length === 0) {
    console.log(`[Fetcher] No closed positions found`);
    return { saved: 0 };
  }

  const { closedPositions } = await getCollections();

  // Bulk upsert closed positions
  const bulkOps = positions.map((p) => ({
    updateOne: {
      filter: {
        wallet: walletAddress.toLowerCase(),
        conditionId: p.conditionId,
        outcome: p.outcome,
      },
      update: {
        $set: {
          wallet: walletAddress.toLowerCase(),
          conditionId: p.conditionId,
          asset: p.asset,
          title: p.title,
          slug: p.slug,
          outcome: p.outcome,
          totalBought: p.totalBought,
          avgPrice: p.avgPrice,
          realizedPnl: p.realizedPnl,
          timestamp: p.timestamp,
          updatedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  const result = await closedPositions.bulkWrite(bulkOps, { ordered: false });
  const saved = result.upsertedCount || 0;

  console.log(`[Fetcher] Saved ${saved} closed positions`);

  return { saved, total: positions.length };
}

/**
 * Get all activities including redeems
 */
export async function getAllActivities(walletAddress: string, days: number = 30) {
  return fetchActivities(walletAddress, days);
}
