import mongoose, { Schema, Document } from 'mongoose';

export interface IHyperliquidPosition extends Document {
  walletAddress: string;
  coin: string;
  side: 'LONG' | 'SHORT';
  szi: string; // Signed size
  entryPx: string;
  leverage: {
    type: string; // "isolated" or "cross"
    value: number;
    rawUsd: string;
  };
  positionValue: string;
  marginUsed: string;
  liquidationPx: string;
  unrealizedPnl: string;
  returnOnEquity: string; // ROI
  cumFunding: {
    allTime: string;
    sinceOpen: string;
  };
  maxLeverage: number;
  lastUpdated: Date;
}

const HyperliquidPositionSchema = new Schema<IHyperliquidPosition>({
  walletAddress: {
    type: String,
    required: true,
    lowercase: true
  },
  coin: {
    type: String,
    required: true
  },
  side: {
    type: String,
    enum: ['LONG', 'SHORT'],
    required: true
  },
  szi: {
    type: String,
    required: true
  },
  entryPx: {
    type: String,
    required: true
  },
  leverage: {
    type: {
      type: String,
      required: true
    },
    value: {
      type: Number,
      required: true
    },
    rawUsd: {
      type: String,
      required: true
    }
  },
  positionValue: {
    type: String,
    required: true
  },
  marginUsed: {
    type: String,
    required: true
  },
  liquidationPx: {
    type: String,
    required: true
  },
  unrealizedPnl: {
    type: String,
    required: true
  },
  returnOnEquity: {
    type: String,
    required: true
  },
  cumFunding: {
    allTime: {
      type: String,
      required: true
    },
    sinceOpen: {
      type: String,
      required: true
    }
  },
  maxLeverage: {
    type: Number,
    required: true
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  }
});

// Indexes
HyperliquidPositionSchema.index({ walletAddress: 1, coin: 1 }, { unique: true });

export default mongoose.models.HyperliquidPosition ||
  mongoose.model<IHyperliquidPosition>('HyperliquidPosition', HyperliquidPositionSchema);
