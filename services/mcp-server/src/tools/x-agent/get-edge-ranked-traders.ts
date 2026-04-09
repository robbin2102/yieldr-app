/**
 * get_edge_ranked_traders Tool
 * Query top edge-ranked Polymarket traders from ahf-edgeRankedTraders collection
 */

import { z } from 'zod';
import { getDB } from '../../db/mongodb.js';

const COLLECTION = 'ahf-edgeRankedTraders';

export const getEdgeRankedTradersSchema = z.object({
  category: z.string().optional().describe('Filter by specialty category: NBA, Soccer, Politics, Crypto, Geopolitics, etc.'),
  sortBy: z.enum(['profitFactor', 'winRate', 'netPnl', 'asymmetricTradesCount']).optional().default('profitFactor').describe('Sort traders by metric'),
  minWinRate: z.number().optional().describe('Minimum win rate percentage (e.g. 55)'),
  minProfitFactor: z.number().optional().describe('Minimum profit factor (e.g. 1.5)'),
  limit: z.number().optional().default(10).describe('Number of traders to return (default: 10, max: 50)'),
});

export type GetEdgeRankedTradersInput = z.infer<typeof getEdgeRankedTradersSchema>;

export async function executeGetEdgeRankedTraders(input: GetEdgeRankedTradersInput) {
  const db = await getDB();
  const collection = db.collection(COLLECTION);

  const filter: any = {};

  if (input.category) {
    filter.specialty = { $regex: new RegExp(input.category, 'i') };
  }
  if (input.minWinRate) {
    filter.winRate = { $gte: input.minWinRate };
  }
  if (input.minProfitFactor) {
    filter.profitFactor = { $gte: input.minProfitFactor };
  }

  const sortField = input.sortBy || 'profitFactor';
  const limit = Math.min(input.limit || 10, 50);

  const traders = await collection
    .find(filter)
    .sort({ [sortField]: -1 })
    .limit(limit)
    .toArray();

  return {
    traders: traders.map(t => ({
      wallet: t.wallet,
      label: t.label,
      specialty: t.specialty,
      strategyLabel: t.strategyLabel,
      volumeLabel: t.volumeLabel,
      metrics: {
        winRate: t.winRate,
        netPnl: t.netPnl,
        profitFactor: t.profitFactor,
        grossProfit: t.grossProfit,
        grossLoss: t.grossLoss,
        avgTradeSize: t.avgTradeSize,
        closedPositionsCount: t.closedPositionsCount,
      },
      openPositions: {
        count: t.openPositionsCount,
        value: t.openValue,
        unrealizedPnl: t.unrealizedPnl,
      },
      highConviction: {
        count: t.asymmetricTradesCount,
        volume: t.asymmetricVolume,
        volumePercent: t.asymmetricVolumePercent,
        recentTrades: (t.recentHighConvictionTrades || []).slice(0, 5),
      },
      strengths: (t.strengths || []).slice(0, 3),
      weaknesses: (t.weaknesses || []).slice(0, 3),
      topOpenPositions: (t.topOpenPositions || []).slice(0, 5),
      profiledAt: t.profiledAt,
    })),
    totalFound: traders.length,
    queryParams: input,
  };
}

export const getEdgeRankedTradersTool = {
  name: 'get_edge_ranked_traders',
  description: 'Get top Polymarket traders ranked by edge (profit factor, win rate, PnL). These are the best-performing traders identified by the AI Hedge Fund profiler. Returns detailed metrics, specialties, high conviction trades, and open positions.',
  inputSchema: getEdgeRankedTradersSchema,
  execute: executeGetEdgeRankedTraders,
};
