/**
 * get_high_conviction_trades Tool
 * Query whale/high-conviction trades from x-agent-highConvictionTrades collection
 */

import { z } from 'zod';
import { getDB } from '../../db/mongodb.js';

const COLLECTION = 'x-agent-highConvictionTrades';

export const getHighConvictionTradesSchema = z.object({
  convictionLevel: z.enum(['WHALE', 'SIGNIFICANT', 'ALL']).optional().default('ALL').describe('Filter by conviction level: WHALE (50x avg, $25k+), SIGNIFICANT (10x avg, $5k+), or ALL'),
  minUsdcValue: z.number().optional().describe('Minimum USDC value of trade (e.g. 25000)'),
  minSizeMultiplier: z.number().optional().describe('Minimum size multiplier vs avg trade size (e.g. 50)'),
  hours: z.number().optional().default(24).describe('Lookback window in hours (default: 24)'),
  unposted: z.boolean().optional().default(false).describe('Only return trades not yet posted to X'),
  limit: z.number().optional().default(10).describe('Number of trades to return (default: 10)'),
});

export type GetHighConvictionTradesInput = z.infer<typeof getHighConvictionTradesSchema>;

export async function executeGetHighConvictionTrades(input: GetHighConvictionTradesInput) {
  const db = await getDB();
  const collection = db.collection(COLLECTION);

  const cutoff = new Date(Date.now() - (input.hours || 24) * 60 * 60 * 1000);

  const filter: any = {
    detectedAt: { $gte: cutoff },
  };

  if (input.convictionLevel && input.convictionLevel !== 'ALL') {
    filter.convictionLevel = input.convictionLevel;
  }
  if (input.minUsdcValue) {
    filter.usdcValue = { $gte: input.minUsdcValue };
  }
  if (input.minSizeMultiplier) {
    filter.sizeMultiplier = { $gte: input.minSizeMultiplier };
  }
  if (input.unposted) {
    filter.postedToX = { $ne: true };
  }

  const trades = await collection
    .find(filter)
    .sort({ usdcValue: -1 })
    .limit(input.limit || 10)
    .toArray();

  return {
    trades: trades.map(t => ({
      wallet: t.wallet,
      traderLabel: t.traderLabel,
      market: t.market,
      outcome: t.outcome,
      side: t.side,
      price: t.price,
      usdcValue: t.usdcValue,
      sizeMultiplier: t.sizeMultiplier,
      convictionLevel: t.convictionLevel,
      traderContext: {
        winRate: t.traderWinRate,
        profitFactor: t.traderProfitFactor,
        avgTradeSize: t.traderAvgTradeSize,
      },
      timestamp: t.timestamp,
      transactionHash: t.transactionHash,
      detectedAt: t.detectedAt,
      postedToX: t.postedToX,
    })),
    totalFound: trades.length,
    queryParams: input,
  };
}

export const getHighConvictionTradesTool = {
  name: 'get_high_conviction_trades',
  description: 'Get recent high-conviction whale trades from top edge-ranked traders. WHALE level: trades >50x average size AND >$25,000. SIGNIFICANT level: >10x average AND >$5,000. Includes trader edge context (win rate, profit factor).',
  inputSchema: getHighConvictionTradesSchema,
  execute: executeGetHighConvictionTrades,
};
