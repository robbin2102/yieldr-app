/**
 * Hyperliquid Data Fetcher
 * Fetches and saves positions and fills to MongoDB
 */

import { getCollections, COLLECTIONS } from '../lib/db';
import {
  getClearinghouseState,
  getUserFills,
  getUserFills30Days,
  HyperliquidFillResponse,
} from '../lib/api';

export interface FillDocument {
  walletAddress: string;
  tid: number;
  oid: number;
  coin: string;
  side: 'B' | 'A';
  dir: string;
  px: string;
  sz: string;
  startPosition: string;
  closedPnl: string;
  fee: string;
  feeToken: string;
  builderFee?: string;
  crossed: boolean;
  hash: string;
  time: number;
  createdAt: Date;
}

export interface PositionDocument {
  walletAddress: string;
  coin: string;
  side: 'LONG' | 'SHORT';
  szi: string;
  entryPx: string;
  leverage: {
    rawUsd: string;
    type: string;
    value: number;
  };
  positionValue: string;
  marginUsed: string;
  liquidationPx: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  cumFunding: {
    allTime: string;
    sinceChange: string;
    sinceOpen: string;
  };
  maxLeverage: number;
  lastUpdated: Date;
}

/**
 * Fetch and save initial 30-day fills history
 */
export async function fetchAndSaveInitialFills(walletAddress: string) {
  console.log(`[Fetcher] Fetching 30d fills for ${walletAddress}...`);

  const fills = await getUserFills30Days(walletAddress);
  console.log(`[Fetcher] Fetched ${fills.length} fills`);

  if (fills.length === 0) {
    return { saved: 0, duplicates: 0 };
  }

  const { fills: fillsCollection } = await getCollections();

  // Prepare bulk operations
  const bulkOps = fills.map((fill) => ({
    updateOne: {
      filter: { walletAddress: walletAddress.toLowerCase(), tid: fill.tid },
      update: {
        $setOnInsert: {
          walletAddress: walletAddress.toLowerCase(),
          tid: fill.tid,
          oid: fill.oid,
          coin: fill.coin,
          side: fill.side,
          dir: fill.dir,
          px: fill.px,
          sz: fill.sz,
          startPosition: fill.startPosition,
          closedPnl: fill.closedPnl || '0.0',
          fee: fill.fee,
          feeToken: fill.feeToken,
          builderFee: fill.builderFee,
          crossed: fill.crossed,
          hash: fill.hash,
          time: fill.time,
          createdAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  const result = await fillsCollection.bulkWrite(bulkOps, { ordered: false });
  const saved = result.upsertedCount || 0;
  const duplicates = fills.length - saved;

  console.log(`[Fetcher] Saved ${saved} fills, ${duplicates} duplicates`);
  return { saved, duplicates };
}

/**
 * Fetch and save recent fills (for monitoring updates)
 */
export async function fetchAndSaveRecentFills(
  walletAddress: string,
  lastCheckedTime: number
) {
  const now = Date.now();
  const fills = await getUserFills(walletAddress, lastCheckedTime, now);

  if (fills.length === 0) {
    return { newFills: 0 };
  }

  const { fills: fillsCollection } = await getCollections();

  let newFills = 0;
  for (const fill of fills) {
    try {
      const result = await fillsCollection.updateOne(
        { walletAddress: walletAddress.toLowerCase(), tid: fill.tid },
        {
          $setOnInsert: {
            walletAddress: walletAddress.toLowerCase(),
            tid: fill.tid,
            oid: fill.oid,
            coin: fill.coin,
            side: fill.side,
            dir: fill.dir,
            px: fill.px,
            sz: fill.sz,
            startPosition: fill.startPosition,
            closedPnl: fill.closedPnl || '0.0',
            fee: fill.fee,
            feeToken: fill.feeToken,
            builderFee: fill.builderFee,
            crossed: fill.crossed,
            hash: fill.hash,
            time: fill.time,
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
        newFills++;
      }
    } catch (error: any) {
      if (error.code !== 11000) {
        console.error(`[Fetcher] Error saving fill ${fill.tid}:`, error.message);
      }
    }
  }

  return { newFills };
}

/**
 * Fetch and save current positions
 * Returns array of closed position coins
 */
export async function fetchAndSavePositions(walletAddress: string) {
  console.log(`[Fetcher] Fetching positions for ${walletAddress}...`);

  const state = await getClearinghouseState(walletAddress);
  const { positions: positionsCollection } = await getCollections();

  // Get existing positions from DB
  const existingPositions = await positionsCollection
    .find({ walletAddress: walletAddress.toLowerCase() })
    .toArray();
  const existingCoins = existingPositions.map((p: any) => p.coin);

  // Update/create current positions
  const currentCoins: string[] = [];

  for (const assetPos of state.assetPositions) {
    const pos = assetPos.position;
    currentCoins.push(pos.coin);

    const side = parseFloat(pos.szi) > 0 ? 'LONG' : 'SHORT';

    await positionsCollection.updateOne(
      { walletAddress: walletAddress.toLowerCase(), coin: pos.coin },
      {
        $set: {
          walletAddress: walletAddress.toLowerCase(),
          coin: pos.coin,
          side,
          szi: pos.szi,
          entryPx: pos.entryPx,
          leverage: pos.leverage,
          positionValue: pos.positionValue,
          marginUsed: pos.marginUsed,
          liquidationPx: pos.liquidationPx,
          unrealizedPnl: pos.unrealizedPnl,
          returnOnEquity: pos.returnOnEquity,
          cumFunding: pos.cumFunding,
          maxLeverage: pos.maxLeverage,
          lastUpdated: new Date(),
        },
      },
      { upsert: true }
    );
  }

  // Find closed positions (existed before but not now)
  const closedCoins = existingCoins.filter(
    (coin: string) => !currentCoins.includes(coin)
  );

  // Save closed positions to closedPositions collection before removing from open
  if (closedCoins.length > 0) {
    console.log(`[Fetcher] Closed positions detected: ${closedCoins.join(', ')}`);

    const { fills, closedPositions } = await getCollections();

    for (const coin of closedCoins) {
      // Get the position data before we delete it
      const closedPosition = existingPositions.find((p: any) => p.coin === coin);

      // Calculate total realized PnL from all fills for this coin
      const coinFills = await fills
        .find({ walletAddress: walletAddress.toLowerCase(), coin })
        .toArray();

      const totalRealizedPnl = coinFills.reduce(
        (sum: number, f: any) => sum + (parseFloat(f.closedPnl) || 0),
        0
      );

      // Save to closed positions collection
      await closedPositions.insertOne({
        walletAddress: walletAddress.toLowerCase(),
        coin,
        side: closedPosition?.side || 'UNKNOWN',
        entryPx: closedPosition?.entryPx || '0',
        totalRealizedPnl,
        isWin: totalRealizedPnl > 0,
        fillsCount: coinFills.length,
        closedAt: new Date(),
      });

      console.log(`[Fetcher] Saved closed position: ${coin} | PnL: $${totalRealizedPnl.toFixed(2)} | ${totalRealizedPnl > 0 ? 'WIN' : 'LOSS'}`);
    }

    // Now delete from open positions
    await positionsCollection.deleteMany({
      walletAddress: walletAddress.toLowerCase(),
      coin: { $in: closedCoins },
    });
  }

  console.log(`[Fetcher] Saved ${state.assetPositions.length} positions`);

  return {
    marginSummary: state.marginSummary,
    closedCoins,
    currentPositions: state.assetPositions.length,
  };
}
