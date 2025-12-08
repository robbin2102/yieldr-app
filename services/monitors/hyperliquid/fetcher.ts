/**
 * Hyperliquid Data Fetcher
 * Fetches and saves positions and fills to MongoDB
 */

import HyperliquidFill from '@/models/HyperliquidFill';
import HyperliquidPosition from '@/models/HyperliquidPosition';
import { getClearinghouseState, getUserFills, getUserFills30Days } from './api';

/**
 * Fetch and save initial 30-day fills history
 */
export async function fetchAndSaveInitialFills(walletAddress: string) {
  console.log(`Fetching 30d fills for ${walletAddress}...`);

  const fills = await getUserFills30Days(walletAddress);
  console.log(`Fetched ${fills.length} fills`);

  if (fills.length === 0) {
    return { saved: 0, duplicates: 0 };
  }

  let saved = 0;
  let duplicates = 0;

  // Save fills with deduplication
  for (const fill of fills) {
    try {
      await HyperliquidFill.findOneAndUpdate(
        { walletAddress, tid: fill.tid },
        {
          walletAddress,
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
          createdAt: new Date()
        },
        { upsert: true, new: true }
      );
      saved++;
    } catch (error: any) {
      if (error.code === 11000) {
        duplicates++;
      } else {
        console.error(`Error saving fill ${fill.tid}:`, error);
      }
    }
  }

  console.log(`Saved ${saved} fills, ${duplicates} duplicates`);
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

  let newFills = 0;

  for (const fill of fills) {
    try {
      await HyperliquidFill.findOneAndUpdate(
        { walletAddress, tid: fill.tid },
        {
          walletAddress,
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
          createdAt: new Date()
        },
        { upsert: true, new: true }
      );
      newFills++;
    } catch (error: any) {
      if (error.code !== 11000) {
        console.error(`Error saving fill ${fill.tid}:`, error);
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
  const state = await getClearinghouseState(walletAddress);

  // Get existing positions from DB
  const existingPositions = await HyperliquidPosition.find({ walletAddress });
  const existingCoins = existingPositions.map(p => p.coin);

  // Update/create current positions
  const currentCoins: string[] = [];

  for (const assetPos of state.assetPositions) {
    const pos = assetPos.position;
    currentCoins.push(pos.coin);

    const side = parseFloat(pos.szi) > 0 ? 'LONG' : 'SHORT';

    await HyperliquidPosition.findOneAndUpdate(
      { walletAddress, coin: pos.coin },
      {
        walletAddress,
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
        lastUpdated: new Date()
      },
      { upsert: true, new: true }
    );
  }

  // Find closed positions (existed before but not now)
  const closedCoins = existingCoins.filter(coin => !currentCoins.includes(coin));

  // Delete closed positions from DB
  if (closedCoins.length > 0) {
    await HyperliquidPosition.deleteMany({
      walletAddress,
      coin: { $in: closedCoins }
    });
  }

  return {
    marginSummary: state.marginSummary,
    closedCoins,
    currentPositions: state.assetPositions.length
  };
}
