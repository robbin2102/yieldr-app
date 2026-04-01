import mongoose, { Document } from 'mongoose';

/**
 * Skip reason codes — every skip is logged with a reason for post-analysis.
 *
 * ALLOCATION_FULL  — trader's lifetime allocationUsdc exhausted (missed opportunity)
 * MIN_BET          — computed copy bet rounds below $5 minimum
 * NO_ORDERBOOK     — failed to fetch orderbook after retries
 * SELL_NO_POSITION — copying SELL but we have no matching position
 * DUPLICATE        — txHash already processed (dedup guard)
 * ORDER_FAILED     — GTT failed after all retries (execution failure)
 * NON_TRADE        — activity type was REDEEM/MERGE/SPLIT (not a trade)
 * PRICE_DRIFT      — accumulated position discarded: price moved >priceDriftPct% before threshold hit
 * SIDE_CONFLICT    — BUY accumulation discarded because SELL detected on same token
 */
export type SkipReason =
  | 'ALLOCATION_FULL'
  | 'MIN_BET'
  | 'NO_ORDERBOOK'
  | 'SELL_NO_POSITION'
  | 'DUPLICATE'
  | 'ORDER_FAILED'
  | 'NON_TRADE'
  | 'PRICE_DRIFT'
  | 'SIDE_CONFLICT'
  | 'NO_RATIO';       // copyRatio not yet computed for this trader (startup race or new trader)

export type TradeStatus = 'DETECTED' | 'SKIPPED' | 'EXECUTING' | 'FILLED' | 'PARTIAL' | 'FAILED';

export interface ICopyTrade extends Document {
  // Source trader
  sourceWallet: string;
  traderLabel: string;

  // Trader's original activity
  txHash: string;
  conditionId: string;
  tokenId: string;
  title: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  traderBetUsdc: number;   // USDC the trader spent
  traderPrice: number;     // their fill price
  traderSize: number;      // their shares

  // Copy decision
  copyBetUsdc: number;     // USDC we copy (from betSizer formula; 0 if skipped)
  skipReason?: SkipReason;
  skipDetail?: string;     // human-readable e.g. "$12 < $185 avg"

  // ── Full execution timeline ──────────────────────────────────────
  traderTs: number;            // trader's tx timestamp (unix ms)
  detectedAt: number;          // when our detector saw it (unix ms)
  discoveryLatencyMs: number;  // detectedAt - traderTs  (poll lag)

  submittedAt?: number;        // when first GTT order was sent
  submissionLatencyMs?: number;// submittedAt - detectedAt

  filledAt?: number;           // when fill confirmed
  fillLatencyMs?: number;      // filledAt - submittedAt
  totalLatencyMs?: number;     // filledAt - traderTs  (end-to-end)

  // Fill results
  filledSize?: number;
  avgFillPrice?: number;
  filledUsdc?: number;
  priceDrift?: number;         // (ourPrice - traderPrice) / traderPrice × 100
  attempts?: number;           // GTT retry count

  // Accumulation — set on the batch execution doc when multiple small trades are merged
  accumulatedDocIds?: string[];  // doc IDs of constituent trades merged into this order
  isAccumulatedBatch?: boolean;  // true = this doc represents the executed batch order
  batchTradeCount?: number;      // how many trader txs were accumulated

  status: TradeStatus;
  failReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const copyTradeSchema = new mongoose.Schema<ICopyTrade>({
  sourceWallet:  { type: String, required: true, index: true, lowercase: true },
  traderLabel:   { type: String, default: '' },

  txHash:      { type: String, required: true, unique: true, index: true },
  conditionId: { type: String, index: true },
  tokenId:     { type: String },
  title:       { type: String, default: '' },
  outcome:     { type: String, default: '' },
  side:        { type: String, enum: ['BUY', 'SELL'], required: true },
  traderBetUsdc: { type: Number, default: 0 },
  traderPrice:   { type: Number, default: 0 },
  traderSize:    { type: Number, default: 0 },

  copyBetUsdc:  { type: Number, default: 0 },
  skipReason:   { type: String },
  skipDetail:   { type: String },

  traderTs:           { type: Number, required: true },
  detectedAt:         { type: Number, required: true },
  discoveryLatencyMs: { type: Number, required: true },

  submittedAt:         { type: Number },
  submissionLatencyMs: { type: Number },

  filledAt:        { type: Number },
  fillLatencyMs:   { type: Number },
  totalLatencyMs:  { type: Number },

  filledSize:    { type: Number },
  avgFillPrice:  { type: Number },
  filledUsdc:    { type: Number },
  priceDrift:    { type: Number },
  attempts:      { type: Number },

  accumulatedDocIds: [{ type: String }],
  isAccumulatedBatch:{ type: Boolean },
  batchTradeCount:   { type: Number },

  status:     { type: String, enum: ['DETECTED','SKIPPED','EXECUTING','FILLED','PARTIAL','FAILED'], default: 'DETECTED', index: true },
  failReason: { type: String },

}, { timestamps: true, collection: 'ahf-copyTrades' });

copyTradeSchema.index({ sourceWallet: 1, detectedAt: -1 });
copyTradeSchema.index({ status: 1, createdAt: -1 });

export const CopyTrade = mongoose.model<ICopyTrade>('CopyTrade', copyTradeSchema, 'ahf-copyTrades');
