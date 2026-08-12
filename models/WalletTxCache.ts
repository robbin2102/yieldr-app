import mongoose, { Schema, Document } from 'mongoose';

/**
 * Per-wallet reconstructed-position cache so a "Re-run" or a repeat visit
 * doesn't re-fetch + re-reconstruct 90 days of trades from scratch.
 * TTL'd short (see index below) since this is a live-analysis cache, not
 * a source of truth - WalletTxCache.positions is derived data.
 */
export interface IWalletTxCache extends Document {
  wallet: string;
  chain: string;
  windowDays: number;
  positions: unknown[];
  fetchedAt: Date;
}

const WalletTxCacheSchema = new Schema<IWalletTxCache>(
  {
    wallet: { type: String, required: true, lowercase: true },
    chain: { type: String, required: true },
    windowDays: { type: Number, required: true },
    positions: { type: [Schema.Types.Mixed], default: [] },
    fetchedAt: { type: Date, required: true, default: Date.now },
  },
  { collection: 'wallet_tx_cache' }
);

WalletTxCacheSchema.index({ wallet: 1, chain: 1 }, { unique: true });
// Short TTL: this is a live-analysis cache, not an index of record.
WalletTxCacheSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 60 * 30 });

export const WalletTxCache =
  mongoose.models.WalletTxCache || mongoose.model<IWalletTxCache>('WalletTxCache', WalletTxCacheSchema);
