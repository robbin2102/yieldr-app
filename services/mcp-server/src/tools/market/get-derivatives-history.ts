/**
 * get_derivatives_history Tool
 * Query 15m open interest + long/short ratio history for a coin from the
 * binance_derivatives_15m collection (populated by binance-fetcher Singapore service).
 */

import { z } from 'zod';
import { getDB, COLLECTIONS } from '../../db/mongodb.js';

export const getDerivativesHistorySchema = z.object({
  symbol: z.string().describe('Coin symbol, e.g. BTC, ETH, SOL'),
  hours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .optional()
    .default(24)
    .describe('Lookback window in hours. Default: 24. Max: 168 (7 days).'),
  include: z
    .array(z.enum(['oi', 'ls_global', 'ls_top_accounts', 'ls_top_positions']))
    .optional()
    .default(['oi', 'ls_global', 'ls_top_accounts', 'ls_top_positions'])
    .describe('Which fields to include in history records. Omit for all.'),
});

export type GetDerivativesHistoryInput = z.infer<typeof getDerivativesHistorySchema>;

export async function executeGetDerivativesHistory(input: GetDerivativesHistoryInput) {
  const { symbol, hours = 24, include = ['oi', 'ls_global', 'ls_top_accounts', 'ls_top_positions'] } = input;
  const db = await getDB();
  const col = db.collection(COLLECTIONS.BINANCE_DERIVATIVES_15M);

  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const includeSet = new Set(include);

  // Build projection
  const projection: Record<string, 1 | 0> = { _id: 0, timestamp: 1 };
  if (includeSet.has('oi'))               projection.open_interest_usdt = 1;
  if (includeSet.has('ls_global'))        projection.long_short_global = 1;
  if (includeSet.has('ls_top_accounts'))  projection.long_short_top_accounts = 1;
  if (includeSet.has('ls_top_positions')) projection.long_short_top_positions = 1;

  const records = await col
    .find(
      { symbol: symbol.toUpperCase(), timestamp: { $gte: since } },
      { sort: { timestamp: 1 }, projection }
    )
    .toArray();

  if (records.length === 0) {
    return {
      found: false,
      symbol: symbol.toUpperCase(),
      message: `No derivatives history found for ${symbol.toUpperCase()} in the last ${hours}h. The binance-fetcher service may still be backfilling.`,
    };
  }

  const latest = records[records.length - 1];

  // OI stats
  let oiStats: Record<string, unknown> | null = null;
  if (includeSet.has('oi')) {
    const oiValues = records.map(r => r.open_interest_usdt).filter(v => v != null) as number[];
    if (oiValues.length > 0) {
      const prev4h  = records[Math.max(0, records.length - 17)];   // ~4h back
      const prev24h = records[Math.max(0, records.length - 97)];   // ~24h back
      const currentOI = latest.open_interest_usdt ?? null;
      oiStats = {
        current_usdt:   currentOI,
        change_4h_pct:  currentOI && prev4h?.open_interest_usdt
          ? ((currentOI - prev4h.open_interest_usdt) / prev4h.open_interest_usdt * 100)
          : null,
        change_24h_pct: currentOI && prev24h?.open_interest_usdt
          ? ((currentOI - prev24h.open_interest_usdt) / prev24h.open_interest_usdt * 100)
          : null,
        min_usdt: Math.min(...oiValues),
        max_usdt: Math.max(...oiValues),
      };
    }
  }

  // L/S stats helper
  const lsStats = (field: string) => {
    const vals = records.map(r => (r as any)[field]).filter(v => v?.long_pct != null);
    if (vals.length === 0) return null;
    const latest_val = vals[vals.length - 1];
    const avgLong  = vals.reduce((s: number, v: any) => s + v.long_pct, 0) / vals.length;
    const avgShort = vals.reduce((s: number, v: any) => s + v.short_pct, 0) / vals.length;
    return {
      current: { long_pct: latest_val.long_pct, short_pct: latest_val.short_pct, ratio: latest_val.ratio },
      avg_long_pct:  avgLong,
      avg_short_pct: avgShort,
      bias: latest_val.long_pct > 55 ? 'longs_dominant' : latest_val.short_pct > 55 ? 'shorts_dominant' : 'balanced',
    };
  };

  return {
    found: true,
    symbol: symbol.toUpperCase(),
    hours_requested: hours,
    records_found: records.length,
    interval: '15m',
    history: records,
    latest: {
      timestamp:                  latest.timestamp,
      open_interest_usdt:         latest.open_interest_usdt         ?? null,
      long_short_global:          latest.long_short_global          ?? null,
      long_short_top_accounts:    latest.long_short_top_accounts    ?? null,
      long_short_top_positions:   latest.long_short_top_positions   ?? null,
    },
    stats: {
      ...(oiStats ? { open_interest: oiStats } : {}),
      ...(includeSet.has('ls_global')        ? { long_short_global: lsStats('long_short_global') }           : {}),
      ...(includeSet.has('ls_top_accounts')  ? { long_short_top_accounts: lsStats('long_short_top_accounts') } : {}),
      ...(includeSet.has('ls_top_positions') ? { long_short_top_positions: lsStats('long_short_top_positions') } : {}),
    },
  };
}

export const getDerivativesHistoryTool = {
  name: 'get_derivatives_history',
  description:
    'Get 15-minute open interest + long/short ratio history for a coin from Binance Futures (up to 7 days). ' +
    'Returns OI in USDT with 4h/24h change, plus global L/S account ratio, top trader account ratio, and top trader position ratio. ' +
    'Use the include param to request only specific fields. ' +
    'Data is sourced from the binance-fetcher service (Singapore) writing to binance_derivatives_15m collection.',
  inputSchema: getDerivativesHistorySchema,
  execute: executeGetDerivativesHistory,
};
