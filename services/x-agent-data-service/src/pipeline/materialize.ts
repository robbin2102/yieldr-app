/**
 * Materialization Step
 *
 * After the pipeline runs:
 *
 * 1. Clean stale v3 profiles from edge consideration
 *    (only profiles from the current cycle are materialized)
 *
 * 2. Extract high conviction trades from polymarket-traderPositions
 *    → x-agent-highConvictionTrades (max 10 per trader)
 *
 * 3. Extract open positions from polymarket-traderPositions
 *    → polymarket-openPositions (max 10 per trader)
 *
 * 4. Log funnel summary (leaderboard → consistent → profiled → edge-ranked)
 */

import { getDB, COLLECTIONS } from '../lib/db';
import { createLogger } from '../utils/logger';

const log = createLogger('Materialize');

const MAX_HC_PER_TRADER = 10;
const MAX_POSITIONS_PER_TRADER = 10;

// Only materialize data from profiles updated within the last 48h
// This prevents stale v3 profiles (from old runs) from polluting tool data
const FRESHNESS_HOURS = 48;

/**
 * Get the freshness cutoff date
 */
function getFreshnessCutoff(): Date {
  return new Date(Date.now() - FRESHNESS_HOURS * 60 * 60 * 1000);
}

/**
 * Extract high conviction trades from FRESH polymarket-traderPositions
 * into x-agent-highConvictionTrades
 */
async function materializeHighConvictionTrades(): Promise<number> {
  const db = await getDB();
  const cutoff = getFreshnessCutoff();

  const traderPositions = db.collection(COLLECTIONS.TRADER_POSITIONS);
  const hcCollection = db.collection(COLLECTIONS.HIGH_CONVICTION_TRADES);

  // Only process recently profiled traders
  const docs = await traderPositions
    .find({
      'recentHighConvictionTrades.0': { $exists: true },
      profiledAt: { $gte: cutoff },
    })
    .project({ wallet: 1, recentHighConvictionTrades: 1 })
    .toArray();

  log.info(`Found ${docs.length} fresh traders with high conviction trades`);

  let upserted = 0;

  for (const doc of docs) {
    const wallet = doc.wallet as string;
    const hcTrades = (doc.recentHighConvictionTrades as any[]) || [];

    // Sort by usdcSize descending, take top N
    const topTrades = hcTrades
      .sort((a: any, b: any) => (b.usdcSize || 0) - (a.usdcSize || 0))
      .slice(0, MAX_HC_PER_TRADER);

    // Look up trader edge info
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
 * Extract open positions from FRESH polymarket-traderPositions
 * into polymarket-openPositions
 */
async function materializeOpenPositions(): Promise<number> {
  const db = await getDB();
  const cutoff = getFreshnessCutoff();

  const traderPositions = db.collection(COLLECTIONS.TRADER_POSITIONS);
  const positionsCollection = db.collection(COLLECTIONS.OPEN_POSITIONS);

  // Only process recently profiled traders
  const docs = await traderPositions
    .find({
      'topOpenPositions.0': { $exists: true },
      profiledAt: { $gte: cutoff },
    })
    .project({ wallet: 1, topOpenPositions: 1 })
    .toArray();

  log.info(`Found ${docs.length} fresh traders with open positions`);

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
 * Log the full funnel summary: leaderboard → consistent → profiled → edge-ranked
 * Broken down by category
 */
async function logFunnelSummary(): Promise<void> {
  const db = await getDB();
  const cutoff = getFreshnessCutoff();

  // Step 1: Leaderboard snapshots — unique wallets by category
  const leaderboardCol = db.collection(COLLECTIONS.LEADERBOARD_SNAPSHOTS);
  const leaderboardByCategory = await leaderboardCol.aggregate([
    { $group: { _id: '$category', wallets: { $addToSet: '$wallet' } } },
    { $project: { category: '$_id', count: { $size: '$wallets' }, _id: 0 } },
    { $sort: { count: -1 } },
  ]).toArray();
  const totalLeaderboard = await leaderboardCol.aggregate([
    { $group: { _id: '$wallet' } },
    { $count: 'total' },
  ]).toArray();

  // Step 2: Consistent traders — by consistent_categories
  const consistentCol = db.collection(COLLECTIONS.CONSISTENT_TRADERS);
  const totalConsistent = await consistentCol.countDocuments();
  const shouldProfile = await consistentCol.countDocuments({ should_profile: true });
  const consistentByCategory = await consistentCol.aggregate([
    { $unwind: '$consistent_categories' },
    { $group: { _id: '$consistent_categories', count: { $sum: 1 } } },
    { $project: { category: '$_id', count: 1, _id: 0 } },
    { $sort: { count: -1 } },
  ]).toArray();

  // Step 3: Profiled traders (fresh v3 only)
  const profilesCol = db.collection(COLLECTIONS.TRADER_PROFILES);
  const totalProfiledFresh = await profilesCol.countDocuments({
    tradingConsistency: { $exists: true },
    profiledAt: { $gte: cutoff },
  });
  const totalProfiledAll = await profilesCol.countDocuments({
    tradingConsistency: { $exists: true },
  });
  const profiledBySpecialty = await profilesCol.aggregate([
    { $match: { tradingConsistency: { $exists: true }, profiledAt: { $gte: cutoff } } },
    { $group: { _id: '$specialty', count: { $sum: 1 } } },
    { $project: { specialty: '$_id', count: 1, _id: 0 } },
    { $sort: { count: -1 } },
  ]).toArray();

  // Step 4: Edge-ranked traders
  const edgeCol = db.collection(COLLECTIONS.EDGE_RANKED_TRADERS);
  const totalEdge = await edgeCol.countDocuments();
  const edgeBySpecialty = await edgeCol.aggregate([
    { $group: { _id: '$specialty', count: { $sum: 1 } } },
    { $project: { specialty: '$_id', count: 1, _id: 0 } },
    { $sort: { count: -1 } },
  ]).toArray();
  const edgeByConfidence = await edgeCol.aggregate([
    { $group: { _id: '$confidence', count: { $sum: 1 } } },
    { $project: { confidence: '$_id', count: 1, _id: 0 } },
    { $sort: { count: -1 } },
  ]).toArray();

  // Materialized views
  const hcCount = await db.collection(COLLECTIONS.HIGH_CONVICTION_TRADES).countDocuments();
  const posCount = await db.collection(COLLECTIONS.OPEN_POSITIONS).countDocuments();

  // Print funnel
  console.log('');
  console.log('================================================================');
  console.log('           PIPELINE FUNNEL SUMMARY                              ');
  console.log('================================================================');
  console.log('');

  // Leaderboard
  const lbTotal = totalLeaderboard[0]?.total || 0;
  console.log(`  1. LEADERBOARD SNAPSHOTS: ${lbTotal} unique wallets`);
  for (const c of leaderboardByCategory) {
    console.log(`     ${(c.category || 'UNKNOWN').padEnd(15)} ${c.count} wallets`);
  }

  // Consistent
  console.log('');
  console.log(`  2. CONSISTENT TRADERS: ${totalConsistent} total (${shouldProfile} should_profile=true)`);
  for (const c of consistentByCategory) {
    console.log(`     ${(c.category || 'UNKNOWN').padEnd(15)} ${c.count}`);
  }

  // Profiled
  console.log('');
  console.log(`  3. PROFILED v3: ${totalProfiledFresh} fresh (last ${FRESHNESS_HOURS}h) / ${totalProfiledAll} total v3`);
  for (const c of profiledBySpecialty) {
    console.log(`     ${(c.specialty || 'Other').padEnd(15)} ${c.count}`);
  }

  // Edge-ranked
  console.log('');
  console.log(`  4. EDGE-RANKED: ${totalEdge} traders`);
  console.log('     By specialty:');
  for (const c of edgeBySpecialty) {
    console.log(`       ${(c.specialty || 'Other').padEnd(15)} ${c.count}`);
  }
  console.log('     By confidence:');
  for (const c of edgeByConfidence) {
    console.log(`       ${(c.confidence || 'unknown').padEnd(15)} ${c.count}`);
  }

  // Materialized
  console.log('');
  console.log(`  5. MATERIALIZED VIEWS:`);
  console.log(`     High conviction trades:  ${hcCount}`);
  console.log(`     Open positions:          ${posCount}`);

  // Funnel conversion
  console.log('');
  console.log('  FUNNEL:');
  console.log(`     Leaderboard → Consistent:  ${lbTotal} → ${totalConsistent} (${lbTotal > 0 ? ((totalConsistent / lbTotal) * 100).toFixed(1) : 0}%)`);
  console.log(`     Consistent → Profiled v3:  ${shouldProfile} → ${totalProfiledFresh} (${shouldProfile > 0 ? ((totalProfiledFresh / shouldProfile) * 100).toFixed(1) : 0}%)`);
  console.log(`     Profiled v3 → Edge-ranked: ${totalProfiledFresh} → ${totalEdge} (${totalProfiledFresh > 0 ? ((totalEdge / totalProfiledFresh) * 100).toFixed(1) : 0}%)`);

  console.log('');
  console.log('================================================================');
  console.log('');
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

    await logFunnelSummary();

  } catch (error: any) {
    log.error(`Materialization failed: ${error.message}`);
    throw error;
  }
}
