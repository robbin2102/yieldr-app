import mongoose, { Schema, Document } from 'mongoose';

/**
 * Tracked position - both trader's and our mirrored position
 */
export interface IPolyAgentPosition extends Document {
  // Identifiers
  targetWallet: string;
  botWallet: string;
  tokenId: string;
  conditionId: string;

  // Market info
  marketQuestion: string;
  marketSlug: string;
  outcome: string;
  outcomeIndex: number;

  // Trader's position
  traderSize: number;
  traderAvgPrice: number;
  traderCurrentPrice: number;
  traderValueUsdc: number;
  traderPnL: number;        // (currentPrice - avgPrice) * size
  traderPnLPercent: number;

  // Our position
  ourSize: number;
  ourAvgPrice: number;
  ourTargetSize: number;    // Pro-rata calculated target
  ourValueUsdc: number;
  ourPnL: number;
  ourPnLPercent: number;

  // Drift metrics
  entryDrift: number;       // Drift when we entered vs trader's avg
  currentDrift: number;     // Current price drift from our avg
  priceVsTrader: number;    // Our avg vs trader's avg (%)

  // Status
  status: 'SYNCED' | 'PENDING' | 'PARTIAL' | 'SKIPPED' | 'UNDERWATER' | 'CLOSED';
  skipReason?: string;

  // Timestamps
  traderEnteredAt?: Date;
  ourEnteredAt?: Date;
  lastSyncedAt: Date;
  closedAt?: Date;

  // Execution details
  fillAttempts: number;
  totalSlippageUsdc: number;

  createdAt: Date;
  updatedAt: Date;
}

const PolyAgentPositionSchema = new Schema<IPolyAgentPosition>(
  {
    // Identifiers
    targetWallet: { type: String, required: true, lowercase: true },
    botWallet: { type: String, required: true, lowercase: true },
    tokenId: { type: String, required: true },
    conditionId: { type: String, required: true },

    // Market info
    marketQuestion: { type: String },
    marketSlug: { type: String },
    outcome: { type: String },
    outcomeIndex: { type: Number },

    // Trader's position
    traderSize: { type: Number, default: 0 },
    traderAvgPrice: { type: Number, default: 0 },
    traderCurrentPrice: { type: Number, default: 0 },
    traderValueUsdc: { type: Number, default: 0 },
    traderPnL: { type: Number, default: 0 },
    traderPnLPercent: { type: Number, default: 0 },

    // Our position
    ourSize: { type: Number, default: 0 },
    ourAvgPrice: { type: Number, default: 0 },
    ourTargetSize: { type: Number, default: 0 },
    ourValueUsdc: { type: Number, default: 0 },
    ourPnL: { type: Number, default: 0 },
    ourPnLPercent: { type: Number, default: 0 },

    // Drift metrics
    entryDrift: { type: Number, default: 0 },
    currentDrift: { type: Number, default: 0 },
    priceVsTrader: { type: Number, default: 0 },

    // Status
    status: {
      type: String,
      enum: ['SYNCED', 'PENDING', 'PARTIAL', 'SKIPPED', 'UNDERWATER', 'CLOSED'],
      default: 'PENDING'
    },
    skipReason: { type: String },

    // Timestamps
    traderEnteredAt: { type: Date },
    ourEnteredAt: { type: Date },
    lastSyncedAt: { type: Date, default: Date.now },
    closedAt: { type: Date },

    // Execution details
    fillAttempts: { type: Number, default: 0 },
    totalSlippageUsdc: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    collection: 'poly-agent-positions',
  }
);

// Unique index: one position per token per trader-bot pair
PolyAgentPositionSchema.index(
  { targetWallet: 1, botWallet: 1, tokenId: 1 },
  { unique: true }
);

// Index for finding positions by status
PolyAgentPositionSchema.index({ status: 1 });

// Index for finding positions by target wallet
PolyAgentPositionSchema.index({ targetWallet: 1 });

export const PolyAgentPosition = mongoose.model<IPolyAgentPosition>(
  'PolyAgentPosition',
  PolyAgentPositionSchema
);
