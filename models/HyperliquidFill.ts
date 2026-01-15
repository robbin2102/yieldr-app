import mongoose, { Schema, Document } from 'mongoose';

export interface IHyperliquidFill extends Document {
  walletAddress: string;
  tid: number; // Trade ID (unique)
  oid: number; // Order ID
  coin: string; // "ETH", "BTC", "@107" for spot
  side: 'B' | 'A'; // Buy/Sell
  dir: string; // "Open Long", "Close Long", "Sell", etc.
  px: string; // Price
  sz: string; // Size
  startPosition: string; // Position before fill
  closedPnl: string; // PnL realized (empty string if 0)
  fee: string;
  feeToken: string; // "USDC"
  builderFee?: string; // Optional
  crossed: boolean;
  hash: string; // Transaction hash
  time: number; // Timestamp in ms
  createdAt: Date; // When we saved it
}

const HyperliquidFillSchema = new Schema<IHyperliquidFill>({
  walletAddress: {
    type: String,
    required: true,
    lowercase: true
  },
  tid: {
    type: Number,
    required: true
  },
  oid: {
    type: Number,
    required: true
  },
  coin: {
    type: String,
    required: true
  },
  side: {
    type: String,
    enum: ['B', 'A'],
    required: true
  },
  dir: {
    type: String,
    required: true
  },
  px: {
    type: String,
    required: true
  },
  sz: {
    type: String,
    required: true
  },
  startPosition: {
    type: String,
    required: true
  },
  closedPnl: {
    type: String,
    default: '0.0'
  },
  fee: {
    type: String,
    required: true
  },
  feeToken: {
    type: String,
    required: true
  },
  builderFee: {
    type: String
  },
  crossed: {
    type: Boolean,
    required: true
  },
  hash: {
    type: String,
    required: true
  },
  time: {
    type: Number,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes
HyperliquidFillSchema.index({ walletAddress: 1, tid: 1 }, { unique: true });
HyperliquidFillSchema.index({ walletAddress: 1, time: -1 });
HyperliquidFillSchema.index({ walletAddress: 1, coin: 1, time: -1 });

export default mongoose.models.HyperliquidFill ||
  mongoose.model<IHyperliquidFill>('HyperliquidFill', HyperliquidFillSchema);
