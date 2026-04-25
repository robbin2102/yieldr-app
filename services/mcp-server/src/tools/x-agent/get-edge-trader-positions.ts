/**
 * get_edge_trader_positions Tool
 *
 * Returns the highest-value open positions held by edge-ranked traders,
 * filtered by specialty category. Used to generate fresh HIGH_CONVICTION posts
 * without relying on ahf-copyTrades (which has a tiny dataset).
 *
 * Score = percentPnl * abs(cashPnl)  — favours positions that are both
 * up a large % AND have real capital in them.
 */

import { z } from 'zod';
import { getDB } from '../../db/mongodb.js';

export const getEdgeTraderPositionsSchema = z.object({
  category: z
    .string()
    .optional()
    .describe('Specialty filter: NBA, Soccer, Politics, Crypto, Finance, etc.'),
  limit: z
    .number()
    .optional()
    .default(10)
    .describe('Max positions to return (default: 10)'),
  minPercentPnl: z
    .number()
    .optional()
    .describe('Only include positions with at least this % gain (e.g. 10)'),
});

export type GetEdgeTraderPositionsInput = z.infer<typeof getEdgeTraderPositionsSchema>;

export async function executeGetEdgeTraderPositions(input: GetEdgeTraderPositionsInput) {
  const db = await getDB();

  // Step 1: get top edge-ranked traders for the requested category
  const edgeFilter: any = {};
  if (input.category) {
    edgeFilter.specialty = { $regex: new RegExp(input.category, 'i') };
  }

  const edgeTraders = await db
    .collection('ahf-edgeRankedTraders')
    .find(edgeFilter)
    .sort({ rank_score: -1 })
    .limit(20)
    .project({ wallet: 1, specialty: 1, win_rate: 1, pf: 1, rank_score: 1, overall_rank: 1, pnl_30d: 1, roce_30d: 1 })
    .toArray();

  if (edgeTraders.length === 0) {
    return { positions: [], totalPositions: 0, category: input.category || 'all', queryParams: input };
  }

  const wallets = edgeTraders.map(t => t.wallet);

  // Step 2: fetch topOpenPositions for those wallets
  const positionDocs = await db
    .collection('polymarket-traderPositions')
    .find({ wallet: { $in: wallets } })
    .project({ wallet: 1, topOpenPositions: 1 })
    .toArray();

  const posMap = new Map(positionDocs.map(p => [p.wallet, p.topOpenPositions || []]));

  // Step 3: fetch trader profiles for enrichment
  const profiles = await db
    .collection('polymarket-traderProfiles')
    .find({ wallet: { $in: wallets } })
    .project({
      wallet: 1,
      strategyLabel: 1,
      volumeLabel: 1,
      edge_hypothesis: 1,
      avgTradeSize: 1,
      display_name: 1,
      x_username: 1,
      sustainability: 1,
      tradingConsistency: 1,
    })
    .toArray();

  const profileMap = new Map(profiles.map(p => [p.wallet, p]));

  // Step 4: flatten, enrich, score, and filter positions
  const limit = Math.min(input.limit || 10, 50);
  const minPct = input.minPercentPnl || 0;

  const ranked: any[] = [];

  for (const trader of edgeTraders) {
    const positions: any[] = posMap.get(trader.wallet) || [];
    const profile = profileMap.get(trader.wallet);

    for (const p of positions) {
      const pct = p.percentPnl ?? 0;
      const cash = p.cashPnl ?? 0;

      if (pct < minPct) continue;
      // Only include positions that are profitable and still open (price not resolved)
      if (cash <= 0) continue;
      if ((p.curPrice ?? 0) >= 0.99 || (p.curPrice ?? 0) <= 0.001) continue;

      const score = pct * Math.abs(cash);

      ranked.push({
        // Position data
        title: p.title,
        outcome: p.outcome,
        avgPrice: p.avgPrice,
        curPrice: p.curPrice,
        size: p.size,
        initialValue: p.initialValue,
        currentValue: p.currentValue,
        cashPnl: cash,
        percentPnl: pct,
        score,

        // Trader context
        traderWallet: trader.wallet,
        traderSpecialty: trader.specialty,
        traderRank: trader.overall_rank,
        traderWinRate: trader.win_rate,
        traderProfitFactor: trader.pf,
        traderPnl30d: trader.pnl_30d,
        traderRoce30d: trader.roce_30d,
        traderEdgeHypothesis: profile?.edge_hypothesis,
        traderStrategyLabel: profile?.strategyLabel,
        traderVolumeLabel: profile?.volumeLabel,
        traderAvgTradeSize: profile?.avgTradeSize,
        traderDisplayName: profile?.display_name,
        traderSustainability: profile?.sustainability,
      });
    }
  }

  // Sort by score descending, take top N
  ranked.sort((a, b) => b.score - a.score);
  const topPositions = ranked.slice(0, limit);

  return {
    positions: topPositions,
    totalPositions: ranked.length,
    category: input.category || 'all',
    queryParams: input,
  };
}

export const getEdgeTraderPositionsTool = {
  name: 'get_edge_trader_positions',
  description:
    'Get the best open positions held by edge-ranked Polymarket traders, filtered by specialty category (NBA, Soccer, Politics, etc.). Scored by percentPnl × cashPnl — returns the most compelling live positions with full trader context for content generation.',
  inputSchema: getEdgeTraderPositionsSchema,
  execute: executeGetEdgeTraderPositions,
};
