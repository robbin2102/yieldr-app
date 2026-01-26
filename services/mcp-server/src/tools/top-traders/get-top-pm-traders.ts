/**
 * get_top_pm_traders Tool
 * Query indexed Polymarket traders from MongoDB
 */

import { z } from 'zod';
import { getTopPMTraders, type PMTraderProfile } from '../../db/index.js';

export const getTopPMTradersSchema = z.object({
  category: z.string().optional().describe('Filter by category: Sports, Crypto, NFL, NBA, NHL, Soccer, Politics, etc.'),
  sortBy: z.enum(['winRate', 'netPnl', 'profitFactor', 'totalTrades']).optional().describe('Sort traders by metric'),
  minTrades: z.number().optional().describe('Minimum number of trades to filter experienced traders'),
  limit: z.number().optional().describe('Number of traders to return (default: 10)'),
});

export type GetTopPMTradersInput = z.infer<typeof getTopPMTradersSchema>;

export interface GetTopPMTradersOutput {
  traders: Array<{
    wallet: string;
    label?: string;
    specialty?: string;
    strategyLabel?: string;
    volumeLabel?: string;
    metrics: {
      totalTrades: number;
      winRate: number;
      netPnl: number;
      profitFactor: number;
      avgTradeSize: number;
    };
    strengths?: Array<{ category: string; trades: number; winRate: number; totalPnl: number }>;
    weaknesses?: Array<{ category: string; trades: number; winRate: number; totalPnl: number }>;
    openPositionsCount?: number;
    unrealizedPnl?: number;
  }>;
  totalFound: number;
  queryParams: GetTopPMTradersInput;
}

export async function executeGetTopPMTraders(
  input: GetTopPMTradersInput
): Promise<GetTopPMTradersOutput> {
  const { traders, totalFound } = await getTopPMTraders({
    category: input.category,
    sortBy: input.sortBy,
    minTrades: input.minTrades,
    limit: input.limit,
  });

  return {
    traders: traders.map((t: PMTraderProfile) => ({
      wallet: t.wallet,
      label: t.label,
      specialty: t.strengths?.[0]?.category, // Top strength = specialty
      strategyLabel: t.strategyLabel,
      volumeLabel: t.volumeLabel,
      metrics: {
        totalTrades: t.buyCount + t.sellCount,
        winRate: t.winRate,
        netPnl: t.netPnl,
        profitFactor: t.profitFactor,
        avgTradeSize: t.avgTradeSize,
      },
      strengths: t.strengths?.slice(0, 3),
      weaknesses: t.weaknesses?.slice(0, 3),
      openPositionsCount: t.openPositionsCount,
      unrealizedPnl: t.unrealizedPnl,
    })),
    totalFound,
    queryParams: input,
  };
}

export const getTopPMTradersTool = {
  name: 'get_top_pm_traders',
  description: 'Get top Polymarket traders, optionally filtered by category (Sports, Crypto, NFL, NBA, etc.). Returns traders sorted by performance metrics.',
  inputSchema: getTopPMTradersSchema,
  execute: executeGetTopPMTraders,
};
