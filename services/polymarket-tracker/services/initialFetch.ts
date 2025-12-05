/**
 * Initial Fetch Service
 * Fetches all historical data when a wallet is first added
 */

import { fetchOpenPositions } from '../api/positions';
import { fetchClosedPositions } from '../api/closedPositions';
import { fetchHistoricalActivity } from '../api/activity';
import { createLogger } from '../utils/logger';
import PolymarketOpenPosition from '../../../models/PolymarketOpenPosition';
import PolymarketClosedPosition from '../../../models/PolymarketClosedPosition';
import PolymarketTrade from '../../../models/PolymarketTrade';
import type { OpenPositionResponse, ClosedPositionResponse, ActivityResponse } from '../types/polymarket';

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
 * Fetch all data for a wallet (initial load)
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

    // 3. Fetch historical trades (last 30 days)
    const trades = await fetchHistoricalActivity(walletAddress);

    // 4. Save to MongoDB
    await saveOpenPositions(walletAddress, openPositions);
    await saveClosedPositions(walletAddress, closedPositions);
    await saveTrades(walletAddress, trades);

    logger.success(`Initial fetch completed for ${walletAddress}`);

    return {
      openPositions,
      closedPositions,
      trades,
    };
  } catch (error: any) {
    logger.error(`Initial fetch failed: ${error.message}`);
    throw error;
  }
}
