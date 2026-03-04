/**
 * get_funding_rate_history Tool
 * Query hourly funding rate history for a coin from the binance_funding_1h collection
 * (populated by the binance-fetcher Singapore service).
 */

import { z } from 'zod';
import { getDB, COLLECTIONS } from '../../db/mongodb.js';

export const getFundingRateHistorySchema = z.object({
  symbol: z.string().describe('Coin symbol, e.g. BTC, ETH, SOL'),
  hours: z
    .number()
    .int()
    .min(1)
    .max(720)
    .optional()
    .default(24)
    .describe('Lookback window in hours. Default: 24. Max: 720 (30 days).'),
});

export type GetFundingRateHistoryInput = z.infer<typeof getFundingRateHistorySchema>;

export async function executeGetFundingRateHistory(input: GetFundingRateHistoryInput) {
  const { symbol, hours = 24 } = input;
  const db = await getDB();
  const col = db.collection(COLLECTIONS.BINANCE_FUNDING_1H);

  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const records = await col
    .find(
      { symbol: symbol.toUpperCase(), timestamp: { $gte: since } },
      { sort: { timestamp: 1 }, projection: { _id: 0, timestamp: 1, funding_rate: 1, annualized_rate: 1 } }
    )
    .toArray();

  if (records.length === 0) {
    return {
      found: false,
      symbol: symbol.toUpperCase(),
      message: `No funding rate history found for ${symbol.toUpperCase()} in the last ${hours}h. The binance-fetcher service may still be backfilling or the symbol may not trade on Binance Futures.`,
    };
  }

  const rates = records.map(r => r.funding_rate);
  const latest = records[records.length - 1];

  // Compute stats
  const avg24h = computeAvg(records.slice(-24).map(r => r.funding_rate));
  const avg7d  = rates.length >= 168
    ? computeAvg(records.slice(-168).map(r => r.funding_rate))
    : computeAvg(rates);

  const min = Math.min(...rates);
  const max = Math.max(...rates);

  // Simple trend: compare first third vs last third
  const third = Math.floor(rates.length / 3);
  const avgFirst = computeAvg(rates.slice(0, third));
  const avgLast  = computeAvg(rates.slice(-third));
  const trend = (avgLast !== null && avgFirst !== null)
    ? (avgLast > avgFirst * 1.1 ? 'rising' : avgLast < avgFirst * 0.9 ? 'falling' : 'flat')
    : 'flat';

  return {
    found: true,
    symbol: symbol.toUpperCase(),
    hours_requested: hours,
    records_found: records.length,
    history: records,
    stats: {
      current:       latest.funding_rate,
      current_annualized_pct: latest.annualized_rate,
      avg_24h:       avg24h,
      avg_period:    computeAvg(rates),
      avg_7d:        avg7d,
      min_period:    min,
      max_period:    max,
      trend,
    },
  };
}

function computeAvg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

export const getFundingRateHistoryTool = {
  name: 'get_funding_rate_history',
  description:
    'Get hourly funding rate history for a coin from Binance Futures (1h granularity, up to 30 days). ' +
    'Returns a time-series of funding rates plus stats: current rate, 24h avg, 7d avg, min/max, trend direction. ' +
    'Data is sourced from the binance-fetcher service (Singapore) writing to binance_funding_1h collection.',
  inputSchema: getFundingRateHistorySchema,
  execute: executeGetFundingRateHistory,
};
