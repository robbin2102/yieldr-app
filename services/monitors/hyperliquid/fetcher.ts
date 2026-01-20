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
 * Fetches all fills from last 30 days in a single call (API returns max 2000)
 * Returns detailed stats for logging
 */
export async function fetchAndSave30DayHistory(walletAddress: string) {
  const now = Date.now();
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

  console.log(`[Backfill] 📅 Starting backfill from ${new Date(now).toISOString()} back 30 days`);
  console.log(`[Backfill] 🎯 Fetching max 2000 fills (API limit)`);

  // Fetch all fills in one call (no chunking) - matches user's curl command
  // Don't pass endTime to get all fills from startTime to now
  // Don't pass aggregateByTime to match user's curl exactly
  const fetchStart = Date.now();
  const fills = await getUserFills(walletAddress, thirtyDaysAgo);
  const fetchDuration = Date.now() - fetchStart;

  console.log(`[Backfill] 📥 API returned ${fills.length} fills in ${fetchDuration}ms`);

  if (fills.length === 0) {
    console.log(`[Backfill] ℹ️  No fills found for this wallet`);
    return {
      totalFetched: 0,
      totalSaved: 0,
      totalDuplicates: 0,
      chunksFetched: 1,
      stoppedReason: 'No fills available'
    };
  }

  // Bulk insert with deduplication
  console.log(`[Backfill] 💾 Starting bulk save to MongoDB...`);
  const saveStart = Date.now();

  // Prepare all documents
  const fillDocs = fills.map(fill => ({
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
  }));

  // Use bulkWrite for efficient upsert
  let saved = 0;
  let duplicates = 0;

  try {
    const bulkOps = fillDocs.map(doc => ({
      updateOne: {
        filter: { walletAddress, tid: doc.tid },
        update: { $setOnInsert: doc },
        upsert: true
      }
    }));

    const result = await HyperliquidFill.bulkWrite(bulkOps, { ordered: false });
    saved = result.upsertedCount || 0;
    duplicates = fills.length - saved;
  } catch (error: any) {
    console.error(`[Backfill] ⚠️  Bulk write error:`, error.message);
    // Fall back to individual inserts if bulk fails
    for (const doc of fillDocs) {
      try {
        await HyperliquidFill.create(doc);
        saved++;
      } catch (err: any) {
        if (err.code === 11000) {
          duplicates++;
        } else {
          console.error(`[Backfill] ⚠️  Error saving fill ${doc.tid}:`, err.message);
        }
      }
    }
  }

  const saveDuration = Date.now() - saveStart;
  console.log(`[Backfill] ✅ Save completed in ${saveDuration}ms`);
  console.log(`[Backfill] 📊 Summary:`);
  console.log(`[Backfill]    Total fetched: ${fills.length} fills`);
  console.log(`[Backfill]    Saved: ${saved} new`);
  console.log(`[Backfill]    Duplicates: ${duplicates}`);

  return {
    totalFetched: fills.length,
    totalSaved: saved,
    totalDuplicates: duplicates,
    chunksFetched: 1,
    stoppedReason: fills.length >= 2000 ? 'Reached API limit (2000 fills)' : 'Fetched all available fills'
  };
}
