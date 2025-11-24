import mongoose, { Document, Schema } from 'mongoose';

/**
 * Universal Pending Orders Model
 * Supports all platforms: Avantis, Hyperliquid, Aero, etc.
 */

export interface IPendingOrder extends Document {
  // Universal Fields
  platform: 'Avantis' | 'Hyperliquid' | 'Aero' | 'Prediction';
  trader: string;
  orderType: 'LIMIT_OPEN' | 'TP' | 'SL' | 'LIQUIDATION';

  // Asset Information
  asset: string;              // BTC, ETH, SOL, etc.
  direction: 'LONG' | 'SHORT';

  // Order Details
  triggerPrice: number;       // Price at which order executes
  orderSize?: number;         // For LIMIT_OPEN (in USDC)
  leverage?: number;          // For LIMIT_OPEN

  // Platform-Specific Identifiers
  orderId?: string;           // Avantis orderId
  tradeIndex?: number;        // Avantis tradeIndex (for TP/SL)
  pairIndex?: number;         // Avantis pairIndex

  // Metadata
  createdAt: Date;
  lastSyncedAt: Date;         // When Python service last confirmed it exists
  expiresAt?: Date;           // Optional expiration

  // Transaction
  txHash?: string;
}

const PendingOrderSchema: Schema = new Schema(
  {
    platform: {
      type: String,
      required: true,
      enum: ['Avantis', 'Hyperliquid', 'Aero', 'Prediction'],
      index: true,
    },
    trader: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    orderType: {
      type: String,
      required: true,
      enum: ['LIMIT_OPEN', 'TP', 'SL', 'LIQUIDATION'],
    },
    asset: {
      type: String,
      required: true,
    },
    direction: {
      type: String,
      required: true,
      enum: ['LONG', 'SHORT'],
    },
    triggerPrice: {
      type: Number,
      required: true,
    },
    orderSize: {
      type: Number,
    },
    leverage: {
      type: Number,
    },

    // Platform-specific
    orderId: {
      type: String,
      sparse: true,     // Only for Avantis
    },
    tradeIndex: {
      type: Number,
      sparse: true,     // Only for Avantis TP/SL
    },
    pairIndex: {
      type: Number,
      sparse: true,     // Only for Avantis
    },

    // Metadata
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    lastSyncedAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
    },
    txHash: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
PendingOrderSchema.index({ trader: 1, platform: 1 });
PendingOrderSchema.index({ platform: 1, orderType: 1 });
PendingOrderSchema.index({ orderId: 1 }, { unique: true, sparse: true }); // Unique orderId for Avantis
PendingOrderSchema.index({ trader: 1, tradeIndex: 1 }, { sparse: true }); // For matching TP/SL

export default mongoose.models.PendingOrder ||
  mongoose.model<IPendingOrder>('PendingOrder', PendingOrderSchema);
