/**
 * LP Position Fetcher
 * Fetches and saves LP positions to MongoDB
 */

import LPPosition from '@/models/LPPosition';
import LPPositionHistory from '@/models/LPPositionHistory';
import { fetchLPPositions, parseKrystalPosition } from './api';

/**
 * Fetch and save current LP positions
 * Returns info about new, updated, and closed positions
 */
export async function fetchAndSavePositions(walletAddress: string) {
  const data = await fetchLPPositions(walletAddress);
  const positions = data.positions || [];

  if (positions.length === 0) {
    return {
      newPositions: 0,
      updatedPositions: 0,
      closedPositions: 0,
      totalPositions: 0
    };
  }

  // Get existing positions
  const existingPositions = await LPPosition.find({ walletAddress });
  const existingIds = existingPositions.map(p => p.positionId);

  let newPositions = 0;
  let updatedPositions = 0;

  const now = new Date();
  const currentIds: string[] = [];

  // Update/create positions
  for (const pos of positions) {
    const parsed = parseKrystalPosition(pos);
    currentIds.push(parsed.positionId);

    const existing = existingPositions.find(p => p.positionId === parsed.positionId);

    if (!existing) {
      // New position
      await LPPosition.create({
        walletAddress,
        ...parsed,
        entryTimestamp: now,
        lastUpdated: now
      });
      newPositions++;
    } else {
      // Update existing position and track changes
      const changes = {
        liquidityValueDelta: parsed.liquidityValue - existing.liquidityValue,
        token0AmountDelta: parsed.token0.amount - existing.token0.amount,
        token1AmountDelta: parsed.token1.amount - existing.token1.amount,
        pnlDelta: parsed.currentPnl - existing.currentPnl,
        feesEarnedDelta: parsed.feesEarned - existing.feesEarned,
        timestamp: now
      };

      await LPPosition.updateOne(
        { _id: existing._id },
        {
          ...parsed,
          entryTimestamp: existing.entryTimestamp, // Keep original entry time
          lastUpdated: now,
          lastChange: changes
        }
      );
      updatedPositions++;
    }
  }

  // Find closed positions (existed before but not now)
  const closedIds = existingIds.filter(id => !currentIds.includes(id));

  // Move closed positions to history
  if (closedIds.length > 0) {
    for (const id of closedIds) {
      const closedPos = existingPositions.find(p => p.positionId === id);
      if (closedPos) {
        await LPPositionHistory.create({
          walletAddress,
          positionId: closedPos.positionId,
          protocol: closedPos.protocol,
          poolAddress: closedPos.poolAddress,
          pair: closedPos.pair,
          token0: closedPos.token0,
          token1: closedPos.token1,
          entryValue: closedPos.liquidityValue, // Using current as entry (limitation)
          exitValue: closedPos.liquidityValue,
          liquidityChange: 0,
          feesEarned: closedPos.feesEarned,
          impermanentLoss: closedPos.impermanentLoss,
          netPnl: closedPos.netPnl,
          roi: closedPos.roi,
          duration: now.getTime() - closedPos.entryTimestamp.getTime(),
          apr: closedPos.apr,
          entryTimestamp: closedPos.entryTimestamp,
          exitTimestamp: now
        });
      }
    }

    await LPPosition.deleteMany({
      walletAddress,
      positionId: { $in: closedIds }
    });
  }

  return {
    newPositions,
    updatedPositions,
    closedPositions: closedIds.length,
    totalPositions: positions.length
  };
}
