/**
 * get_funding_rate_current Tool
 * Query 1h premium index klines for a coin from the binance_premium_index_1h collection.
 * The premium_index (close) value = predicted funding rate at the next 8h settlement.
 * Provides hourly granularity for current and near-term predicted funding rates.
 */

import { z } from 'zod';
import { getDB, COLLECTIONS } from '../../db/mongodb.js';

export const getFundingRateCurrentSchema = z.object({
  symbol: z.string().describe('Coin symbol, e.g. BTC, ETH, SOL'),
  hours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .optional()
    .default(24)
    .describe('Lookback window in hours. Default: 24. Max: 168 (7 days).'),
});

export type GetFundingRateCurrentInput = z.infer<typeof getFundingRateCurrentSchema>;

export async function executeGetFundingRateCurrent(input: GetFundingRateCurrentInput) {
  const { symbol, hours = 24 } = input;
  const db = await getDB();
  const col = db.collection(COLLECTIONS.BINANCE_PREMIUM_INDEX_1H);

  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const records = await col
    .find(
      { symbol: symbol.toUpperCase(), open_time: { $gte: since } },
      {
        sort: { open_time: 1 },
        projection: { _id: 0, open_time: 1, close_time: 1, premium_index: 1, open_premium: 1, high_premium: 1, low_premium: 1 },
      }
    )
    .toArray();

  if (records.length === 0) {
    return {
      found: false,
      symbol: symbol.toUpperCase(),
      message: `No premium index data found for ${symbol.toUpperCase()} in the last ${hours}h. The binance-fetcher service may still be backfilling or the symbol may not trade on Binance Futures.`,
    };
  }

  const latest = records[records.length - 1];
  const indices = records.map(r => r.premium_index);

  const avg = (arr: number[]) =>
    arr.length === 0 ? null : arr.reduce((s, n) => s + n, 0) / arr.length;

  // Trend: compare first half vs second half
  const mid = Math.floor(indices.length / 2);
  const avgFirst = avg(indices.slice(0, mid));
  const avgLast  = avg(indices.slice(mid));
  const trend =
    avgFirst !== null && avgLast !== null
      ? avgLast > avgFirst * 1.1 ? 'rising'
        : avgLast < avgFirst * 0.9 ? 'falling'
        : 'flat'
      : 'flat';

  return {
    found: true,
    symbol: symbol.toUpperCase(),
    hours_requested: hours,
    records_found: records.length,
    note: 'premium_index is the 1h close of the Binance premium index, which approximates the predicted funding rate at the next 8h settlement (00:00, 08:00, or 16:00 UTC).',
    history: records,
    stats: {
      current_premium_index:   latest.premium_index,
      current_annualized_pct:  latest.premium_index * 3 * 365 * 100,
      avg_period:              avg(indices),
      min_period:              Math.min(...indices),
      max_period:              Math.max(...indices),
      trend,
    },
  };
}

export const getFundingRateCurrentTool = {
  name: 'get_funding_rate_current',
  description:
    'Get current and predicted funding rate for a coin at 1h granularity (Binance premium index klines). ' +
    'The premium_index value = predicted funding rate at the next 8h settlement. ' +
    'Use this for: "what is the current funding rate?", "last 5h of funding rate", "hourly funding trend". ' +
    'For historical settled rates (8h granularity, up to 30 days) use get_funding_rate_history instead. ' +
    'Data is sourced from the binance-fetcher service writing to binance_premium_index_1h collection.',
  inputSchema: getFundingRateCurrentSchema,
  execute: executeGetFundingRateCurrent,
};
