/**
 * get_top_perp_traders Tool
 * Query indexed perp traders from MongoDB (Hyperliquid/Avantis)
 */

import { z } from 'zod';
import { getTopPerpTraders, type HLTraderMetrics } from '../../db/index.js';

export const getTopPerpTradersSchema = z.object({
  protocol: z.enum(['hyperliquid', 'avantis']).describe('Protocol to query'),
  asset: z.string().optional().describe('Filter by asset (ETH, BTC, etc.)'),
  sortBy: z.enum(['pnl', 'winRate', 'sharpe', 'volume']).optional().describe('Sort traders by metric'),
  timeframe: z.enum(['7d', '30d', '90d']).optional().describe('Timeframe for PnL calculation'),
  limit: z.number().optional().describe('Number of traders to return (default: 10)'),
});

export type GetTopPerpTradersInput = z.infer<typeof getTopPerpTradersSchema>;

export interface GetTopPerpTradersOutput {
  protocol: string;
  traders: Array<{
    wallet: string;
    accountValue: string;
    pnl: {
      day: number;
      week: number;
      month: number;
      allTime: number;
    };
    stats: {
      totalTrades: number;
      winRate: number;
      sharpeRatio: number;
      maxDrawdown: number;
    };
    volume24h: string;
  }>;
  totalFound: number;
}

export async function executeGetTopPerpTraders(
  input: GetTopPerpTradersInput
): Promise<GetTopPerpTradersOutput> {
  const { protocol, traders, totalFound } = await getTopPerpTraders({
    protocol: input.protocol,
    asset: input.asset,
    sortBy: input.sortBy,
    timeframe: input.timeframe,
    limit: input.limit,
  });

  return {
    protocol,
    traders: traders.map((t: HLTraderMetrics) => ({
      wallet: t.walletAddress,
      accountValue: t.accountValue,
      pnl: {
        day: t.pnl_1d,
        week: t.pnl_7d,
        month: t.pnl_30d,
        allTime: t.pnl_allTime,
      },
      stats: {
        totalTrades: t.totalTrades,
        winRate: t.winRate,
        sharpeRatio: t.sharpeRatio,
        maxDrawdown: t.maxDrawdown,
      },
      volume24h: t.volume_24h,
    })),
    totalFound,
  };
}

export const getTopPerpTradersTool = {
  name: 'get_top_perp_traders',
  description: 'Get top perp traders from Hyperliquid or Avantis. Returns traders sorted by PnL, win rate, Sharpe ratio, or volume.',
  inputSchema: getTopPerpTradersSchema,
  execute: executeGetTopPerpTraders,
};
