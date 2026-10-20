/**
 * get_edge_ranked_traders Tool
 *
 * Reads ahf-edgeRankedTraders for the ranked list (scored by statistical edge),
 * then enriches from polymarket-traderProfiles (core metrics) and
 * polymarket-traderPositions (positions, HC trades) per wallet.
 */

import { z } from 'zod';
import { getDB } from '../../db/mongodb.js';

const EDGE_COLLECTION = 'ahf-edgeRankedTraders';
const PROFILES_COLLECTION = 'polymarket-traderProfiles';
const POSITIONS_COLLECTION = 'polymarket-traderPositions';

export const getEdgeRankedTradersSchema = z.object({
  category: z.string().optional().describe('Filter by specialty category: NBA, Soccer, Politics, Crypto, Finance, etc.'),
  sortBy: z.enum(['rank_score', 'win_rate', 'pnl_30d', 'pf', 'edge']).optional().default('rank_score').describe('Sort traders by metric'),
  minWinRate: z.number().optional().describe('Minimum win rate percentage (e.g. 55)'),
  minProfitFactor: z.number().optional().describe('Minimum profit factor (e.g. 1.5)'),
  confidence: z.enum(['confirmed', 'likely']).optional().describe('Filter by edge confidence level'),
  limit: z.number().optional().default(10).describe('Number of traders to return (default: 10, max: 50)'),
});

export type GetEdgeRankedTradersInput = z.infer<typeof getEdgeRankedTradersSchema>;

export async function executeGetEdgeRankedTraders(input: GetEdgeRankedTradersInput) {
  const db = await getDB();
  const edgeCol = db.collection(EDGE_COLLECTION);

  const filter: any = {};

  if (input.category) {
    filter.specialty = { $regex: new RegExp(input.category, 'i') };
  }
  if (input.minWinRate) {
    filter.win_rate = { $gte: input.minWinRate };
  }
  if (input.minProfitFactor) {
    filter.pf = { $gte: input.minProfitFactor };
  }
  if (input.confidence) {
    filter.confidence = input.confidence;
  }

  const sortField = input.sortBy || 'rank_score';
  const limit = Math.min(input.limit || 10, 50);

  // Step 1: Get edge-ranked traders
  const edgeTraders = await edgeCol
    .find(filter)
    .sort({ [sortField]: -1 })
    .limit(limit)
    .toArray();

  if (edgeTraders.length === 0) {
    return { traders: [], totalFound: 0, queryParams: input };
  }

  // Step 2: Enrich from traderProfiles (core metrics)
  const wallets = edgeTraders.map(t => t.wallet);
  const profilesCol = db.collection(PROFILES_COLLECTION);
  const profiles = await profilesCol
    .find({ wallet: { $in: wallets } })
    .project({
      wallet: 1, label: 1, strategyLabel: 1, volumeLabel: 1,
      win_rate: 1, win_rate_sample_size: 1, profitFactor: 1,
      avgTradeSize: 1, medianTradeSize: 1, maxTradeSize: 1,
      asymmetricTradesCount: 1, asymmetricVolume: 1, asymmetricVolumePercent: 1,
      specialty: 1, category_breakdown: 1,
      capital_trend: 1, drawdown_trend: 1, tradingConsistency: 1,
      insider_probability: 1, insider_score: 1,
      display_name: 1, x_username: 1, profiledAt: 1,
      timeframePnL: 1,
      currentStreak: 1, currentStreakType: 1,
      maxDrawdown: 1, maxDrawdownPercent: 1, max_drawdown_30d_pct: 1,
      account_age_days: 1, last_active_days_ago: 1,
      edge_hypothesis: 1, edge_type: 1, sustainability: 1,
      strength_markets: 1, weakness_markets: 1,
      totalPnlAllTime: 1, totalRealizedPnl: 1, totalUnrealizedPnl: 1,
      tradesPerDay: 1, buyRatio: 1,
      roce_trend: 1,
    })
    .toArray();
  const profileMap = new Map(profiles.map(p => [p.wallet, p]));

  // Step 3: Enrich from traderPositions (top open positions, HC trades, strengths/weaknesses)
  const positionsCol = db.collection(POSITIONS_COLLECTION);
  const positionDocs = await positionsCol
    .find({ wallet: { $in: wallets } })
    .project({
      wallet: 1,
      topOpenPositions: { $slice: 5 },
      recentHighConvictionTrades: { $slice: 5 },
      strengths: { $slice: 3 },
      weaknesses: { $slice: 3 },
    })
    .toArray();
  const posMap = new Map(positionDocs.map(p => [p.wallet, p]));

  return {
    traders: edgeTraders.map((t, i) => {
      const profile = profileMap.get(t.wallet);
      const pos = posMap.get(t.wallet);
      const tf30 = profile?.timeframePnL?.['30d'];

      return {
        rank: t.overall_rank || i + 1,
        wallet: t.wallet,
        displayName: t.display_name || profile?.display_name,
        xUsername: profile?.x_username,
        specialty: t.specialty,
        confidence: t.confidence,
        edge: {
          score: t.rank_score,
          magnitude: t.edge,
          pValue: t.p_val,
          expectedWinRate: t.expected_wr,
        },
        metrics: {
          winRate: t.win_rate,
          sampleSize: t.n,
          profitFactor: t.pf,
          roce30d: t.roce_30d,
          pnl30d: t.pnl_30d,
          avgTradeSize: profile?.avgTradeSize,
          medianTradeSize: profile?.medianTradeSize,
          maxTradeSize: profile?.maxTradeSize,
          daysWonRate: t.days_won_rate,
          sortino: t.sortino,
          totalPnlAllTime: profile?.totalPnlAllTime,
          totalRealizedPnl: profile?.totalRealizedPnl,
          totalUnrealizedPnl: profile?.totalUnrealizedPnl,
          tradesPerDay: profile?.tradesPerDay,
          buyRatio: profile?.buyRatio,
        },
        strategyLabel: profile?.strategyLabel,
        volumeLabel: profile?.volumeLabel,
        insider: t.insider,
        insiderScore: profile?.insider_score,
        edgeHypothesis: profile?.edge_hypothesis,
        edgeType: profile?.edge_type,
        sustainability: profile?.sustainability,
        currentStreak: profile?.currentStreak,
        currentStreakType: profile?.currentStreakType,
        maxDrawdown: profile?.maxDrawdown,
        maxDrawdownPercent: profile?.maxDrawdownPercent,
        maxDrawdown30dPct: profile?.max_drawdown_30d_pct,
        capitalTrend: profile?.capital_trend,
        drawdownTrend: profile?.drawdown_trend,
        accountAgeDays: profile?.account_age_days,
        lastActiveDaysAgo: profile?.last_active_days_ago,
        roceTrend: profile?.roce_trend,
        categoryBreakdown: profile?.category_breakdown,
        strengthMarkets: profile?.strength_markets,
        weaknessMarkets: profile?.weakness_markets,
        highConviction: {
          count: profile?.asymmetricTradesCount || 0,
          volume: profile?.asymmetricVolume || 0,
          volumePercent: profile?.asymmetricVolumePercent || 0,
          recentTrades: (pos?.recentHighConvictionTrades || []).slice(0, 5),
        },
        strengths: (pos?.strengths || []).slice(0, 3),
        weaknesses: (pos?.weaknesses || []).slice(0, 3),
        topOpenPositions: (pos?.topOpenPositions || []).slice(0, 5),
        profiledAt: profile?.profiledAt,
      };
    }),
    totalFound: edgeTraders.length,
    queryParams: input,
  };
}

export const getEdgeRankedTradersTool = {
  name: 'get_edge_ranked_traders',
  description: 'Get top Polymarket traders ranked by statistical edge (win rate vs implied odds). Returns edge confidence, p-value, enriched metrics from v3 profiler, high conviction trades, open positions, and market specializations.',
  inputSchema: getEdgeRankedTradersSchema,
  execute: executeGetEdgeRankedTraders,
};
