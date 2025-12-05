import mongoose, { Schema, Document } from 'mongoose';
import { Trade as ITrade } from '../../types/polymarket';

export interface TradeDocument extends Omit<ITrade, '_id'>, Document {}

const tradeSchema = new Schema<TradeDocument>(
  {
    walletAddress: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    conditionId: {
      type: String,
      required: true,
      index: true,
    },
    asset: {
      type: String,
      required: true,
    },
    transactionHash: {
      type: String,
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    slug: {
      type: String,
      required: true,
    },
    outcome: {
      type: String,
      required: true,
    },
    outcomeIndex: {
      type: Number,
      required: true,
    },
    side: {
      type: String,
      enum: ['BUY', 'SELL'],
      required: true,
    },
    size: {
      type: Number,
      required: true,
    },
    price: {
      type: Number,
      required: true,
    },
    usdcSize: {
      type: Number,
      required: true,
    },
    timestamp: {
      type: Date,
      required: true,
      index: true,
    },
    detectedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    collection: 'polymarket_trades',
    timestamps: false,
  }
);

// Unique constraint on wallet + transaction hash to prevent duplicates
tradeSchema.index({ walletAddress: 1, transactionHash: 1 }, { unique: true });

// Compound index for efficient queries by wallet and time
tradeSchema.index({ walletAddress: 1, timestamp: -1 });

// Index for querying by market/condition
tradeSchema.index({ conditionId: 1, timestamp: -1 });

export const Trade = mongoose.model<TradeDocument>('Trade', tradeSchema);
