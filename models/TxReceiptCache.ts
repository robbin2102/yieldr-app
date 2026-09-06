import mongoose, { Schema, Document } from 'mongoose';

/**
 * Persistent (no-TTL) cache of transaction receipt logs, keyed by hash.
 * Receipts are immutable once a transaction is mined/finalized, so unlike
 * WalletTxCache (a short-TTL cache of DERIVED positions, invalidated
 * every 30 min), this is safe to keep forever.
 *
 * This exists to cut Alchemy CU spend: enrichUniswapV4Legs was calling
 * eth_getTransactionReceipt once per unbalanced trade candidate - on a
 * wallet with thousands of HOOD trades that's tens of thousands of CUs on
 * every single analysis run, including the periodic reasoning cron
 * (app/api/edge/cron/reason) re-analyzing the same wallets every
 * EDGE_REASONING_INTERVAL_HOURS. With this cache, only transactions never
 * seen before cost a real RPC call - a repeat analysis of the same wallet
 * only pays for the delta.
 *
 * Only `logs` is stored (the one field every call site actually reads) to
 * keep documents small - not the full receipt.
 */
export interface ITxReceiptCache extends Document {
  chain: string;
  txHash: string;
  logs: unknown[];
  fetchedAt: Date;
}

const TxReceiptCacheSchema = new Schema<ITxReceiptCache>(
  {
    chain: { type: String, required: true },
    txHash: { type: String, required: true, lowercase: true },
    logs: { type: [Schema.Types.Mixed], default: [] },
    fetchedAt: { type: Date, required: true, default: Date.now },
  },
  { collection: 'tx_receipt_cache' }
);

TxReceiptCacheSchema.index({ chain: 1, txHash: 1 }, { unique: true });

export const TxReceiptCache =
  mongoose.models.TxReceiptCache || mongoose.model<ITxReceiptCache>('TxReceiptCache', TxReceiptCacheSchema);
