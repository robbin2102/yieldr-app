import mongoose, { Schema, Document } from 'mongoose';

export interface ICopyPosition extends Document {
  // User info
  userWallet: string;

  // Trader attribution
  traderWallet: string;
  traderLabel: string;

  // Position details
  conditionId: string;
  asset: string;
  market: string;
  outcome: string;
  side: 'BUY' | 'SELL';

  // Trade details
  size: number;
  price: number;
  usdcValue: number;
  timestamp: Date;

  // Current status
  status: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  currentValue?: number;
  pnl?: number;
  pnlPercent?: number;

  // Metadata
  matchedAt: Date;
  updatedAt: Date;
}

const CopyPositionSchema = new Schema<ICopyPosition>(
  {
    // User info
    userWallet: { type: String, required: true, lowercase: true, index: true },

    // Trader attribution
    traderWallet: { type: String, required: true, lowercase: true, index: true },
    traderLabel: { type: String, required: true },

    // Position details
    conditionId: { type: String, required: true },
    asset: { type: String },
    market: { type: String },
    outcome: { type: String },
    side: { type: String, enum: ['BUY', 'SELL'] },

    // Trade details
    size: { type: Number },
    price: { type: Number },
    usdcValue: { type: Number },
    timestamp: { type: Date },

    // Current status
    status: { type: String, enum: ['OPEN', 'CLOSED', 'UNKNOWN'], default: 'UNKNOWN' },
    currentValue: { type: Number },
    pnl: { type: Number },
    pnlPercent: { type: Number },

    // Metadata
    matchedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'polymarket-copyPositions',
  }
);

// Compound index for efficient lookups
CopyPositionSchema.index({ userWallet: 1, conditionId: 1, outcome: 1 }, { unique: true });
CopyPositionSchema.index({ userWallet: 1, traderWallet: 1 });
CopyPositionSchema.index({ userWallet: 1, status: 1 });

export const CopyPosition = mongoose.models.CopyPosition || mongoose.model<ICopyPosition>('CopyPosition', CopyPositionSchema);
