/**
 * get_top_perp_traders Tool
 * Query indexed perp traders from MongoDB (Hyperliquid/Avantis)
 * - Hyperliquid: queries hyperliquidmetrics collection
 * - Avantis: queries managers collection
 */

import { z } from 'zod';
import { getTopPerpTraders, type PerpTraderOutput } from '../../db/index.js';

export const getTopPerpTradersSchema = z.object({
  protocol: z.enum(['hyperliquid', 'avantis']).describe('Protocol to query'),
  asset: z.string().optional().describe('Filter by asset (ETH, BTC, etc.)'),
  sortBy: z.enum(['pnl', 'winRate', 'sharpe', 'volume', 'roi', 'aum']).optional().describe('Sort traders by metric'),
  timeframe: z.enum(['7d', '30d', '90d']).optional().describe('Timeframe for PnL calculation (Hyperliquid only)'),
  limit: z.number().optional().describe('Number of traders to return (default: 10)'),
});

export type GetTopPerpTradersInput = z.infer<typeof getTopPerpTradersSchema>;

export interface GetTopPerpTradersOutput {
  protocol: string;
  traders: PerpTraderOutput[];
  totalFound: number;
}

export async function executeGetTopPerpTraders(
  input: GetTopPerpTradersInput
): Promise<GetTopPerpTradersOutput> {
  const result = await getTopPerpTraders({
    protocol: input.protocol,
    asset: input.asset,
    sortBy: input.sortBy,
    timeframe: input.timeframe,
    limit: input.limit,
  });

  return result;
}

export const getTopPerpTradersTool = {
  name: 'get_top_perp_traders',
  description: 'Get top perp traders from Hyperliquid or Avantis. Returns traders sorted by PnL, win rate, Sharpe ratio, or volume.',
  inputSchema: getTopPerpTradersSchema,
  execute: executeGetTopPerpTraders,
};
