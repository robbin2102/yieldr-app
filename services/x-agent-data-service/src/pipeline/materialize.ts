/**
 * Materialization Step
 *
 * After the pipeline runs, extract data from the v3 profiler's output
 * collections into tool-accessible collections:
 *
 * 1. polymarket-traderPositions.recentHighConvictionTrades
 *    → x-agent-highConvictionTrades (max 10 per trader, sorted by recency + value)
 *
 * 2. polymarket-traderPositions.topOpenPositions
 *    → polymarket-openPositions (max 10 per trader, sorted by currentValue)
 *
 * This keeps the MCP tools and x-content-agent working with their
 * expected collection schemas while the pipeline scripts run as-is.
 */

import { getDB, COLLECTIONS } from '../lib/db';
import { createLogger } from '../utils/logger';

const log = createLogger('Materialize');

const MAX_HC_PER_TRADER = 10;
const MAX_POSITIONS_PER_TRADER = 10;

/**
 * Extract high conviction trades from polymarket-traderPositions
 * into x-agent-highConvictionTrades
 */
async function materializeHighConvictionTrades(): Promise<number> {
  const db = await getDB();

  const traderPositions = db.collection(COLLECTIONS.TRADER_POSITIONS);
  const hcCollection = db.collection(COLLECTIONS.HIGH_CONVICTION_TRADES);

  // Get all trader positions docs that have high conviction trades
  const docs = await traderPositions
    .find({ 'recentHighConvictionTrades.0': { $exists: true } })
    .project({ wallet: 1, recentHighConvictionTrades: 1 })
    .toArray();

  let upserted = 0;

  for (const doc of docs) {
    const wallet = doc.wallet as string;
    const hcTrades = (doc.recentHighConvictionTrades as any[]) || [];

    // Sort by usdcSize descending, take top N
    const topTrades = hcTrades
      .sort((a: any, b: any) => (b.usdcSize || 0) - (a.usdcSize || 0))
      .slice(0, MAX_HC_PER_TRADER);

    // Look up trader edge info from ahf-edgeRankedTraders
    const edgeTrader = await db.collection(COLLECTIONS.EDGE_RANKED_TRADERS)
      .findOne({ wallet }, { projection: { win_rate: 1, pf: 1, specialty: 1, display_name: 1 } });

    for (const trade of topTrades) {
      const txHash = trade.txHash || trade.transactionHash;
      if (!txHash) continue;

      const hcDoc = {
        wallet,
        traderLabel: edgeTrader?.display_name || `Trader-${wallet.slice(0, 6)}`,
        conditionId: trade.conditionId || null,
        market: trade.market,
        outcome: trade.outcome,
        side: trade.side || 'BUY',
        size: trade.size || 0,
        price: trade.price,
        usdcValue: trade.usdcSize,
        timestamp: trade.timestamp instanceof Date
          ? Math.floor(trade.timestamp.getTime() / 1000)
          : trade.timestamp,
        transactionHash: txHash,
        sizeMultiplier: trade.sizeMultiplier || 0,
        convictionLevel: (trade.sizeMultiplier || 0) >= 50 && (trade.usdcSize || 0) >= 25000
          ? 'WHALE' : 'SIGNIFICANT',
        traderWinRate: edgeTrader?.win_rate || null,
        traderProfitFactor: edgeTrader?.pf || null,
        detectedAt: new Date(),
      };

      try {
        const result = await hcCollection.updateOne(
          { transactionHash: txHash },
          {
            $setOnInsert: { postedToX: false },
            $set: hcDoc,
          },
          { upsert: true }
        );
        if (result.upsertedCount > 0) upserted++;
      } catch (error: any) {
        if (error.code !== 11000) throw error;
      }
    }
  }

  return upserted;
}

/**
 * Extract open positions from polymarket-traderPositions
 * into polymarket-openPositions
 */
async function materializeOpenPositions(): Promise<number> {
  const db = await getDB();

  const traderPositions = db.collection(COLLECTIONS.TRADER_POSITIONS);
  const positionsCollection = db.collection(COLLECTIONS.OPEN_POSITIONS);

  // Get all trader positions docs that have open positions
  const docs = await traderPositions
    .find({ 'topOpenPositions.0': { $exists: true } })
    .project({ wallet: 1, topOpenPositions: 1 })
    .toArray();

  let upserted = 0;

  for (const doc of docs) {
    const wallet = doc.wallet as string;
    const positions = (doc.topOpenPositions as any[]) || [];

    // Sort by currentValue descending, take top N
    const topPositions = positions
      .filter((p: any) => p.curPrice >= 0.001 && p.curPrice <= 0.99)
      .sort((a: any, b: any) => (b.currentValue || 0) - (a.currentValue || 0))
      .slice(0, MAX_POSITIONS_PER_TRADER);

    for (const pos of topPositions) {
      const posDoc = {
        wallet: wallet.toLowerCase(),
        conditionId: pos.conditionId || null,
        outcome: pos.outcome,
        title: pos.title,
        slug: pos.slug || null,
        size: pos.size,
        avgPrice: pos.avgPrice,
        curPrice: pos.curPrice,
        initialValue: pos.initialValue || pos.size * pos.avgPrice,
        currentValue: pos.currentValue,
        cashPnl: pos.cashPnl,
        percentPnl: pos.percentPnl,
        lastUpdatedAt: new Date(),
      };

      try {
        await positionsCollection.updateOne(
          { wallet: posDoc.wallet, title: posDoc.title, outcome: posDoc.outcome },
          { $set: posDoc },
          { upsert: true }
        );
        upserted++;
      } catch (error: any) {
        if (error.code !== 11000) throw error;
      }
    }
  }

  return upserted;
}

/**
 * Run all materialization steps
 */
export async function runMaterialization(): Promise<void> {
  try {
    const hcCount = await materializeHighConvictionTrades();
    log.success(`High conviction trades: ${hcCount} new entries materialized`);

    const posCount = await materializeOpenPositions();
    log.success(`Open positions: ${posCount} positions materialized`);

  } catch (error: any) {
    log.error(`Materialization failed: ${error.message}`);
    throw error;
  }
}
