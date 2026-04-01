import mongoose, { Document } from 'mongoose';

/**
 * Skip reason codes — every skip is logged for post-analysis.
 *
 * BELOW_AVG        — trader bet < avgBet (conviction filter)
 * ALLOCATION_FULL  — trader's allocationUsdc exhausted
 * NO_ORDERBOOK     — failed to fetch orderbook
 * SELL_NO_POSITION — copying SELL but we have no matching position
 * DUPLICATE        — txHash already processed
 * ORDER_FAILED     — GTT failed after all retries
 * NON_TRADE        — activity type was REDEEM/MERGE/SPLIT
 */
export type SkipReason =
  | 'BELOW_AVG'
  | 'ALLOCATION_FULL'
  | 'NO_ORDERBOOK'
  | 'SELL_NO_POSITION'
  | 'DUPLICATE'
  | 'ORDER_FAILED'
  | 'NON_TRADE';

export type TradeStatus = 'DETECTED' | 'SKIPPED' | 'EXECUTING' | 'FILLED' | 'PARTIAL' | 'FAILED';

export interface ICopyTrade extends Document {
  sourceWallet: string;
  traderLabel:  string;

  txHash:       string;
  conditionId:  string;
  tokenId:      string;
  title:        string;
  outcome:      string;
  side:         'BUY' | 'SELL';
  traderBetUsdc: number;
  traderPrice:   number;
  traderSize:    number;

  copyBetUsdc:  number;
  skipReason?:  SkipReason;
  skipDetail?:  string;

  traderTs:            number;
  detectedAt:          number;
  discoveryLatencyMs:  number;

  submittedAt?:         number;
  submissionLatencyMs?: number;

  filledAt?:       number;
  fillLatencyMs?:  number;
  totalLatencyMs?: number;

  filledSize?:    number;
  avgFillPrice?:  number;
  filledUsdc?:    number;
  priceDrift?:    number;
  attempts?:      number;

  status:      TradeStatus;
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

  status:     { type: String, enum: ['DETECTED','SKIPPED','EXECUTING','FILLED','PARTIAL','FAILED'], default: 'DETECTED', index: true },
  failReason: { type: String },

}, { timestamps: true, collection: 'ahf-copyTrades' });

copyTradeSchema.index({ sourceWallet: 1, detectedAt: -1 });
copyTradeSchema.index({ status: 1, createdAt: -1 });

export const CopyTrade = mongoose.model<ICopyTrade>('CopyTrade', copyTradeSchema, 'ahf-copyTrades');
