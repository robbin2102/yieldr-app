import mongoose, { Schema, Document } from 'mongoose';

/**
 * Candle-level OHLC cache, upserted per (chain, poolAddress, ts). This
 * accumulates over time as different wallets' analyses touch overlapping
 * tokens - each live pull fills in gaps rather than re-fetching candles
 * that are already indexed, so coverage improves passively with traffic.
 */
export interface ITokenOhlcCache extends Document {
  chain: string;
  poolAddress: string;
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  source: string;
}

const TokenOhlcCacheSchema = new Schema<ITokenOhlcCache>(
  {
    chain: { type: String, required: true },
    poolAddress: { type: String, required: true, lowercase: true },
    ts: { type: Date, required: true },
    open: { type: Number, required: true },
    high: { type: Number, required: true },
    low: { type: Number, required: true },
    close: { type: Number, required: true },
    source: { type: String, default: 'geckoterminal' },
  },
  { collection: 'token_ohlc_cache' }
);

TokenOhlcCacheSchema.index({ chain: 1, poolAddress: 1, ts: 1 }, { unique: true });

export const TokenOhlcCache =
  mongoose.models.TokenOhlcCache ||
  mongoose.model<ITokenOhlcCache>('TokenOhlcCache', TokenOhlcCacheSchema);
