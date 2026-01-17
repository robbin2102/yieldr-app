import mongoose, { Schema, Document } from 'mongoose';

export interface ITradeAlert extends Document {
  // Trader info
  traderWallet: string;
  traderLabel?: string;

  // Trade details
  type: 'TRADE' | 'REDEEM' | 'YIELD' | 'SPLIT' | 'MERGE' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL';
  market: string;
  marketSlug?: string;
  outcome?: string;
  conditionId?: string;
  tokenId?: string;

  // Trade metrics
  size: number;
  price: number;
  usdcValue: number;
  timestamp: Date;
  txHash: string;

  // Copy guidance
  copyRecommendation: 'PRIORITY' | 'COPY' | 'CAUTIOUS' | 'SKIP';
  suggestedSize?: number;
  reason?: string;
  isHighConviction: boolean;
  sizeMultiplier?: number; // How many times avg trade size

  // Alert status
  alertedAt: Date;
  acknowledged: boolean;
  acknowledgedAt?: Date;
  copied: boolean;
  copiedAt?: Date;
  copiedTxHash?: string;
  copiedSize?: number;
  copiedPrice?: number;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}

const TradeAlertSchema = new Schema<ITradeAlert>(
  {
    // Trader info
    traderWallet: { type: String, required: true, index: true },
    traderLabel: { type: String },

    // Trade details
    type: { type: String, required: true, enum: ['TRADE', 'REDEEM', 'YIELD', 'SPLIT', 'MERGE', 'REWARD', 'CONVERSION'] },
    side: { type: String, enum: ['BUY', 'SELL'] },
    market: { type: String, required: true },
    marketSlug: { type: String },
    outcome: { type: String },
    conditionId: { type: String },
    tokenId: { type: String },

    // Trade metrics
    size: { type: Number, required: true },
    price: { type: Number, required: true },
    usdcValue: { type: Number, required: true },
    timestamp: { type: Date, required: true },
    txHash: { type: String, required: true, unique: true },

    // Copy guidance
    copyRecommendation: {
      type: String,
      required: true,
      enum: ['PRIORITY', 'COPY', 'CAUTIOUS', 'SKIP'],
      default: 'COPY',
    },
    suggestedSize: { type: Number },
    reason: { type: String },
    isHighConviction: { type: Boolean, default: false, index: true },
    sizeMultiplier: { type: Number },

    // Alert status
    alertedAt: { type: Date, default: Date.now },
    acknowledged: { type: Boolean, default: false },
    acknowledgedAt: { type: Date },
    copied: { type: Boolean, default: false },
    copiedAt: { type: Date },
    copiedTxHash: { type: String },
    copiedSize: { type: Number },
    copiedPrice: { type: Number },
  },
  {
    timestamps: true,
    collection: 'polymarket-tradeAlerts',
  }
);

// Indexes for efficient queries
TradeAlertSchema.index({ traderWallet: 1, timestamp: -1 });
TradeAlertSchema.index({ acknowledged: 1, alertedAt: -1 });
TradeAlertSchema.index({ copied: 1 });

export const TradeAlert = mongoose.models.TradeAlert || mongoose.model<ITradeAlert>('TradeAlert', TradeAlertSchema);
