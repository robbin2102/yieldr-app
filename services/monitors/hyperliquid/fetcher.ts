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
  console.log(`[Fetcher] 🔄 Calling Hyperliquid API (clearinghouseState) for ${walletAddress}...`);
  const startTime = Date.now();

  const state = await getClearinghouseState(walletAddress);

  const apiDuration = Date.now() - startTime;
  console.log(`[Fetcher] ✓ API responded in ${apiDuration}ms`);
  console.log(`[Fetcher] 📊 Account Value: $${state.marginSummary.accountValue}, Open Positions: ${state.assetPositions.length}`);

  // Get existing positions from DB
  const existingPositions = await HyperliquidPosition.find({ walletAddress });
  const existingCoins = existingPositions.map(p => p.coin);

  // Update/create current positions
  const currentCoins: string[] = [];

  for (const assetPos of state.assetPositions) {
    const pos = assetPos.position;
    currentCoins.push(pos.coin);

    const side = parseFloat(pos.szi) > 0 ? 'LONG' : 'SHORT';
    console.log(`[Fetcher] 💹 Position: ${pos.coin} ${side} ${pos.szi} @ $${pos.entryPx} | PnL: $${pos.unrealizedPnl}`);

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
    console.log(`[Fetcher] 🔴 Closed positions detected: ${closedCoins.join(', ')}`);
    await HyperliquidPosition.deleteMany({
      walletAddress,
      coin: { $in: closedCoins }
    });
  }

  console.log(`[Fetcher] ✓ Saved ${state.assetPositions.length} positions to DB`);

  return {
    marginSummary: state.marginSummary,
    closedCoins,
    currentPositions: state.assetPositions.length
  };
}

/**
 * Smart 30-day history backfill
 * - Fetches in 7-day chunks going backwards in time
 * - Stops at 10k fills OR 30 days, whichever comes first
 * - Returns detailed stats for logging
 */
export async function fetchAndSave30DayHistory(walletAddress: string) {
  const now = Date.now();
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
  const CHUNK_SIZE = 7 * 24 * 60 * 60 * 1000; // 7 days
  const MAX_FILLS = 10000;

  let totalFetched = 0;
  let totalSaved = 0;
  let totalDuplicates = 0;
  let chunksFetched = 0;
  let currentEnd = now;
  let stoppedReason = '';

  console.log(`[Backfill] 📅 Starting backfill from ${new Date(now).toISOString()} to ${new Date(thirtyDaysAgo).toISOString()}`);
  console.log(`[Backfill] 🎯 Limits: ${MAX_FILLS} fills OR 30 days`);

  while (currentEnd > thirtyDaysAgo && totalFetched < MAX_FILLS) {
    const currentStart = Math.max(currentEnd - CHUNK_SIZE, thirtyDaysAgo);
    chunksFetched++;

    console.log(`[Backfill] 📦 Chunk ${chunksFetched}: ${new Date(currentStart).toISOString()} to ${new Date(currentEnd).toISOString()}`);

    const chunkStart = Date.now();
    const fills = await getUserFills(walletAddress, currentStart, currentEnd);
    const apiDuration = Date.now() - chunkStart;

    console.log(`[Backfill] 📥 API returned ${fills.length} fills in ${apiDuration}ms`);

    if (fills.length === 0) {
      console.log(`[Backfill] 🏁 No more fills found - reached beginning of trading history`);
      stoppedReason = 'No more fills available';
      break;
    }

    // Save fills with deduplication
    let saved = 0;
    let duplicates = 0;

    for (const fill of fills) {
      try {
        const result = await HyperliquidFill.findOneAndUpdate(
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

        // Check if it was an insert (new) or update (duplicate)
        if (result && !result.createdAt) {
          duplicates++;
        } else {
          saved++;
        }
      } catch (error: any) {
        if (error.code === 11000) {
          duplicates++;
        } else {
          console.error(`[Backfill] ⚠️  Error saving fill ${fill.tid}:`, error.message);
        }
      }
    }

    totalFetched += fills.length;
    totalSaved += saved;
    totalDuplicates += duplicates;

    console.log(`[Backfill] 💾 Saved ${saved} new, ${duplicates} duplicates | Total: ${totalFetched}/${MAX_FILLS}`);

    // Check if we've hit the limit
    if (totalFetched >= MAX_FILLS) {
      console.log(`[Backfill] 🛑 Reached ${MAX_FILLS} fills limit`);
      stoppedReason = `Reached ${MAX_FILLS} fills limit`;
      break;
    }

    // If we got less than 2000 fills, we've reached the end
    if (fills.length < 2000) {
      console.log(`[Backfill] 🏁 Received ${fills.length} fills (< 2000) - end of available data`);
      stoppedReason = 'Reached end of available fills';
      break;
    }

    // Move to next chunk (going backwards in time)
    currentEnd = currentStart;

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (currentEnd <= thirtyDaysAgo && !stoppedReason) {
    stoppedReason = 'Reached 30-day limit';
  }

  console.log(`[Backfill] 📊 Summary:`);
  console.log(`[Backfill]    Total fetched: ${totalFetched} fills`);
  console.log(`[Backfill]    Saved: ${totalSaved} new`);
  console.log(`[Backfill]    Duplicates: ${totalDuplicates}`);
  console.log(`[Backfill]    Chunks: ${chunksFetched}`);

  return {
    totalFetched,
    totalSaved,
    totalDuplicates,
    chunksFetched,
    stoppedReason
  };
}
