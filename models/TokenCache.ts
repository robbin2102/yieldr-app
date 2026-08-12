import mongoose, { Schema, Document } from 'mongoose';

/**
 * Write-through cache for token metadata + latest price, keyed by
 * chain+address. Populated as a side effect of live wallet analyses -
 * this is the "parallel indexing" layer: every live lookup checks here
 * first, and only calls out (GeckoTerminal / on-chain) on a miss or stale
 * price, writing the result back so the next lookup is a cache hit.
 */
export interface ITokenCache extends Document {
  chain: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  poolAddress: string | null;
  launchTimestamp: Date | null;
  lastPriceUsd: number | null;
  priceUpdatedAt: Date | null;
  source: string;
}

const TokenCacheSchema = new Schema<ITokenCache>(
  {
    chain: { type: String, required: true },
    address: { type: String, required: true, lowercase: true },
    symbol: { type: String, default: '' },
    name: { type: String, default: '' },
    decimals: { type: Number, default: 18 },
    poolAddress: { type: String, default: null, lowercase: true },
    launchTimestamp: { type: Date, default: null },
    lastPriceUsd: { type: Number, default: null },
    priceUpdatedAt: { type: Date, default: null },
    source: { type: String, default: 'unknown' },
  },
  { timestamps: true, collection: 'token_cache' }
);

TokenCacheSchema.index({ chain: 1, address: 1 }, { unique: true });

export const TokenCache =
  mongoose.models.TokenCache || mongoose.model<ITokenCache>('TokenCache', TokenCacheSchema);
