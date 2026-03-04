/**
 * get_market_snapshot Tool
 * Query latest market indicators + derivatives for a tracked coin from MongoDB
 */

import { z } from 'zod';
import { getDB, COLLECTIONS } from '../../db/mongodb.js';

export const getMarketSnapshotSchema = z.object({
  symbol: z.string().describe('Coin symbol, e.g. BTC, ETH, SOL'),
  fields: z
    .enum(['price', 'indicators', 'derivatives', 'computed', 'candlestick_patterns', 'all'])
    .optional()
    .default('all')
    .describe('Which fields to include. Default: all. Use specific fields to limit response size.'),
});

export type GetMarketSnapshotInput = z.infer<typeof getMarketSnapshotSchema>;

export async function executeGetMarketSnapshot(input: GetMarketSnapshotInput) {
  const { symbol, fields = 'all' } = input;
  const db = await getDB();
  const col = db.collection(COLLECTIONS.MARKET_SNAPSHOTS);

  const projection: Record<string, 1> = {
    symbol: 1,
    timestamp: 1,
    interval: 1,
    tier: 1,
    fetched_on_demand: 1,
    on_demand_expires_at: 1,
    fetch_duration_ms: 1,
    errors: 1,
  };

  if (fields === 'all' || fields === 'price') projection.price = 1;
  if (fields === 'all' || fields === 'indicators') projection.indicators = 1;
  if (fields === 'all' || fields === 'derivatives') projection.derivatives = 1;
  if (fields === 'all' || fields === 'computed') projection.computed = 1;
  if (fields === 'all' || fields === 'candlestick_patterns') projection.candlestick_patterns = 1;

  const snapshot = await col.findOne(
    { symbol: symbol.toUpperCase() },
    { sort: { timestamp: -1 }, projection }
  );

  if (!snapshot) {
    return {
      found: false,
      symbol: symbol.toUpperCase(),
      message: `No data found for ${symbol.toUpperCase()}. Coin may not be in the tracked list or ingestion hasn't run yet.`,
    };
  }

  const ageMs = Date.now() - new Date(snapshot.timestamp).getTime();
  const ageMins = Math.round(ageMs / 60000);

  // Filter active candlestick patterns (non-zero values only)
  const activePatterns = (snapshot.candlestick_patterns as any[] | undefined)
    ?.filter((p: any) => p.value !== 0)
    ?? [];

  return {
    found: true,
    symbol: snapshot.symbol,
    timestamp: snapshot.timestamp,
    data_age_minutes: ageMins,
    tier: snapshot.tier,
    ...(fields === 'all' || fields === 'price' ? { price: snapshot.price } : {}),
    ...(fields === 'all' || fields === 'indicators' ? { indicators: snapshot.indicators } : {}),
    ...(fields === 'all' || fields === 'derivatives' ? { derivatives: snapshot.derivatives } : {}),
    ...(fields === 'all' || fields === 'computed' ? { computed: snapshot.computed } : {}),
    ...(fields === 'all' || fields === 'candlestick_patterns'
      ? { candlestick_patterns: activePatterns }
      : {}),
    ...(snapshot.errors?.length ? { errors: snapshot.errors } : {}),
  };
}

export const getMarketSnapshotTool = {
  name: 'get_market_snapshot',
  description:
    'Get latest technical indicators + derivatives data for a tracked coin from MongoDB. Returns price, EMA/SMA, RSI, MACD, funding rates, OI, long/short ratios, and computed signals. Use fields param to limit response size (price | indicators | derivatives | computed | candlestick_patterns).',
  inputSchema: getMarketSnapshotSchema,
  execute: executeGetMarketSnapshot,
};
