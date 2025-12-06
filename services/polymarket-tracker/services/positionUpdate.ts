/**
 * Position Update Service
 * Updates open and closed positions after new trades
 */

import { fetchOpenPositions } from '../api/positions';
import { fetchClosedPositions } from '../api/closedPositions';
import { createLogger } from '../utils/logger';
import PolymarketOpenPosition from '../../../models/PolymarketOpenPosition';
import PolymarketClosedPosition from '../../../models/PolymarketClosedPosition';
import type { OpenPositionResponse, ClosedPositionResponse } from '../types/polymarket';

const logger = createLogger('Position Update');

/**
 * Update open positions from API
 */
export async function updateOpenPositions(walletAddress: string): Promise<void> {
  logger.debug('Fetching updated open positions...');

  const positions = await fetchOpenPositions(walletAddress);

  if (positions.length === 0) {
    // No open positions - delete all
    await PolymarketOpenPosition.deleteMany({
      walletAddress: walletAddress.toLowerCase(),
    });
    logger.debug('Cleared all open positions (none exist)');
    return;
  }

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

  await PolymarketOpenPosition.bulkWrite(operations);

  // Remove positions that no longer exist
  const activeConditionIds = positions.map((p) => p.conditionId);
  await PolymarketOpenPosition.deleteMany({
    walletAddress: walletAddress.toLowerCase(),
    conditionId: { $nin: activeConditionIds },
  });

  logger.debug(`Updated ${positions.length} open positions`);
}

/**
 * Update closed positions from API (last 30 days)
 */
export async function updateClosedPositions(walletAddress: string): Promise<void> {
  logger.debug('Fetching updated closed positions...');

  const positions = await fetchClosedPositions(walletAddress);

  if (positions.length === 0) {
    logger.debug('No new closed positions');
    return;
  }

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

  await PolymarketClosedPosition.bulkWrite(operations);
  logger.debug(`Updated ${positions.length} closed positions`);
}

/**
 * Update all positions after new trades detected
 */
export async function updateAllPositions(walletAddress: string): Promise<void> {
  await Promise.all([
    updateOpenPositions(walletAddress),
    updateClosedPositions(walletAddress),
  ]);
  logger.debug('All positions updated');
}
