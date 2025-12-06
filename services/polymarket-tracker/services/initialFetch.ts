/**
 * Initial Fetch Service
 * Fast initial load: Fetch open positions immediately
 * Background: Load closed positions and historical data
 */

import { fetchOpenPositions } from '../api/positions';
import { fetchClosedPositions } from '../api/closedPositions';
import { createLogger } from '../utils/logger';
import PolymarketOpenPosition from '../../../models/PolymarketOpenPosition';
import PolymarketClosedPosition from '../../../models/PolymarketClosedPosition';
import type { OpenPositionResponse, ClosedPositionResponse } from '../types/polymarket';

const logger = createLogger('Initial Fetch');

/**
 * Save open positions to MongoDB
 */
async function saveOpenPositions(
  walletAddress: string,
  positions: OpenPositionResponse[]
): Promise<void> {
  logger.info(`Saving ${positions.length} open positions...`);

  const operations = positions.map((pos) => ({
    updateOne: {
      filter: {
        walletAddress: walletAddress.toLowerCase(),
        conditionId: pos.conditionId,
      },
      update: {
        $set: {
          walletAddress: walletAddress.toLowerCase(),
          conditionId: pos.conditionId,
          asset: pos.asset,
          title: pos.title,
          slug: pos.slug,
          outcome: pos.outcome,
          outcomeIndex: pos.outcomeIndex,
          size: pos.size,
          avgPrice: pos.avgPrice,
          curPrice: pos.curPrice,
          initialValue: pos.initialValue,
          currentValue: pos.currentValue,
          cashPnl: pos.cashPnl,
          percentPnl: pos.percentPnl,
          roi: pos.initialValue > 0 ? (pos.cashPnl / pos.initialValue) * 100 : 0,
          endDate: pos.endDate ? new Date(pos.endDate) : undefined,
          redeemable: pos.redeemable || false,
          fetchedAt: new Date(),
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  if (operations.length > 0) {
    await PolymarketOpenPosition.bulkWrite(operations);
    logger.success(`Saved ${operations.length} open positions`);
  }
}

/**
 * Save closed positions to MongoDB
 */
async function saveClosedPositions(
  walletAddress: string,
  positions: ClosedPositionResponse[]
): Promise<void> {
  logger.info(`Saving ${positions.length} closed positions...`);

  const operations = positions.map((pos) => {
    const totalBet = pos.avgPrice * pos.totalBought;
    const amountWon = totalBet + pos.realizedPnl;
    const roi = totalBet > 0 ? (pos.realizedPnl / totalBet) * 100 : 0;

    return {
      updateOne: {
        filter: {
          walletAddress: walletAddress.toLowerCase(),
          conditionId: pos.conditionId,
          closedAt: new Date(pos.timestamp * 1000), // Add timestamp for uniqueness
        },
        update: {
          $set: {
            walletAddress: walletAddress.toLowerCase(),
            conditionId: pos.conditionId,
            asset: pos.asset,
            title: pos.title,
            slug: pos.slug,
            outcome: pos.outcome,
            outcomeIndex: pos.outcomeIndex,
            totalBought: pos.totalBought,
            avgPrice: pos.avgPrice,
            realizedPnl: pos.realizedPnl,
            totalBet,
            amountWon,
            roi,
            won: pos.realizedPnl > 0,
            closedAt: new Date(pos.timestamp * 1000),
            endDate: pos.endDate ? new Date(pos.endDate) : undefined,
            fetchedAt: new Date(),
            updatedAt: new Date(),
          },
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        upsert: true,
      },
    };
  });

  if (operations.length > 0) {
    await PolymarketClosedPosition.bulkWrite(operations);
    logger.success(`Saved ${operations.length} closed positions`);
  }
}

/**
 * Save trades/activities to MongoDB
 */
async function saveTrades(
  walletAddress: string,
  activities: ActivityResponse[]
): Promise<void> {
  logger.info(`Saving ${activities.length} activities...`);

  const operations = activities.map((activity) => ({
    updateOne: {
      filter: {
        walletAddress: walletAddress.toLowerCase(),
        transactionHash: activity.transactionHash,
      },
      update: {
        $set: {
          walletAddress: walletAddress.toLowerCase(),
          conditionId: activity.conditionId,
          asset: activity.asset,
          transactionHash: activity.transactionHash,
          activityType: activity.type,
          title: activity.title,
          slug: activity.slug,
          outcome: activity.outcome,
          outcomeIndex: activity.outcomeIndex,
          side: activity.side,
          size: activity.size,
          price: activity.price,
          usdcSize: activity.usdcSize,
          timestamp: new Date(activity.timestamp * 1000),
          detectedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  if (operations.length > 0) {
    const result = await PolymarketTrade.bulkWrite(operations);
    logger.success(
      `Saved ${result.upsertedCount} new trades, updated ${result.modifiedCount} existing`
    );
  }
}

/**
 * Quick fetch - Only open positions (fast initial load)
 * Returns immediately so user sees their current positions
 */
export async function fetchOpenPositionsQuick(walletAddress: string): Promise<OpenPositionResponse[]> {
  logger.info(`Quick fetch: Loading open positions for ${walletAddress}...`);

  const openPositions = await fetchOpenPositions(walletAddress);
  await saveOpenPositions(walletAddress, openPositions);

  logger.success(`Quick fetch complete: ${openPositions.length} open positions loaded`);

  return openPositions;
}

/**
 * Background fetch - Closed positions and metrics (non-blocking)
 * Runs after quick fetch, user doesn't wait for this
 * Only fetches if data doesn't already exist OR if data is stale
 */
export async function fetchClosedPositionsBackground(
  walletAddress: string,
  forceRefresh: boolean = false
): Promise<void> {
  try {
    // Check if we have recent closed positions data
    const latestPosition = await PolymarketClosedPosition
      .findOne({ walletAddress: walletAddress.toLowerCase() })
      .sort({ fetchedAt: -1 })
      .select('fetchedAt');

    const existingCount = await PolymarketClosedPosition.countDocuments({
      walletAddress: walletAddress.toLowerCase()
    });

    // Check if data is stale (older than 1 hour)
    const isStale = latestPosition &&
      (Date.now() - latestPosition.fetchedAt.getTime() > 60 * 60 * 1000);

    if (existingCount > 0 && !forceRefresh && !isStale) {
      logger.info(`Background: Wallet has ${existingCount} recent closed positions, skipping fetch`);
      logger.info(`Last fetched: ${latestPosition?.fetchedAt.toISOString()}`);
      return;
    }

    if (isStale) {
      logger.warn(`Background: Data is stale (last fetch: ${latestPosition?.fetchedAt.toISOString()}), refreshing...`);
    }

    logger.info(`Background: Fetching closed positions for ${walletAddress}...`);
    const closedPositions = await fetchClosedPositions(walletAddress);
    await saveClosedPositions(walletAddress, closedPositions);

    logger.success(`Background: Saved ${closedPositions.length} closed positions`);
  } catch (error: any) {
    logger.error(`Background fetch failed: ${error.message}`);
  }
}

/**
 * Fetch all data for a wallet (initial load)
 * @deprecated Use fetchOpenPositionsQuick + fetchClosedPositionsBackground for better UX
 */
export async function fetchAllDataForWallet(walletAddress: string): Promise<{
  openPositions: OpenPositionResponse[];
  closedPositions: ClosedPositionResponse[];
  trades: ActivityResponse[];
}> {
  logger.info(`Starting initial fetch for wallet: ${walletAddress}`);
  console.log('\n' + '='.repeat(80));
  console.log(`INITIAL FETCH: ${walletAddress}`);
  console.log('='.repeat(80) + '\n');

  try {
    // 1. Fetch open positions
    const openPositions = await fetchOpenPositions(walletAddress);

    // 2. Fetch closed positions (last 30 days)
    const closedPositions = await fetchClosedPositions(walletAddress);

    // 3. Save to MongoDB
    await saveOpenPositions(walletAddress, openPositions);
    await saveClosedPositions(walletAddress, closedPositions);

    logger.success(`Initial fetch completed for ${walletAddress}`);

    return {
      openPositions,
      closedPositions,
      trades: [], // No longer fetching historical trades
    };
  } catch (error: any) {
    logger.error(`Initial fetch failed: ${error.message}`);
    throw error;
  }
}
