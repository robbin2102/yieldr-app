import mongoose from 'mongoose';

/**
 * Open Orders Schema
 *
 * Stores open/pending orders from platforms that support order books.
 * Currently: Hyperliquid only (Avantis doesn't expose open orders via SDK)
 *
 * Updated via:
 * - Hyperliquid WebSocket (real-time)
 * - Backup polling every 60s
 */

const OpenOrderSchema = new mongoose.Schema({
  // Identification
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  walletAddress: {
    type: String,
    required: true,
    lowercase: true,
    index: true
  },
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Manager',
    required: true,
    index: true
  },

  // Platform
  platform: {
    type: String,
    required: true,
    enum: ['hyperliquid'],  // Only Hyperliquid for now
    default: 'hyperliquid'
  },

  // Order details
  asset: {
    type: String,
    required: true,
    index: true
  },
  pair: String,  // e.g., "BTC/USD"

  // Order type & direction
  orderType: {
    type: String,
    required: true,
    enum: ['limit', 'market', 'stop_loss', 'take_profit', 'stop_limit'],
    index: true
  },
  direction: {
    type: String,
    required: true,
    enum: ['LONG', 'SHORT', 'BUY', 'SELL']
  },

  // Order parameters
  size: {
    type: Number,
    required: true  // Order size in USD or asset units
  },
  price: Number,           // Limit price (null for market orders)
  triggerPrice: Number,    // For stop orders
  leverage: Number,

  // Order status
  status: {
    type: String,
    required: true,
    enum: ['open', 'partially_filled', 'filled', 'cancelled', 'rejected', 'expired'],
    default: 'open',
    index: true
  },

  // Fill information
  filledSize: {
    type: Number,
    default: 0
  },
  remainingSize: Number,
  averageFillPrice: Number,

  // Timestamps
  placedAt: {
    type: Date,
    required: true,
    index: true
  },
  lastUpdatedAt: {
    type: Date,
    default: Date.now
  },
  filledAt: Date,
  cancelledAt: Date,
  expiresAt: Date,  // For time-limited orders

  // Risk management
  stopLoss: Number,
  takeProfit: Number,
  reduceOnly: Boolean,  // Close-only order (won't increase position)

  // Associated position
  linkedPositionId: String,  // If order is TP/SL for existing position

  // Metadata
  rawData: mongoose.Schema.Types.Mixed,  // Store raw platform response

  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound indexes
OpenOrderSchema.index({ managerId: 1, status: 1, placedAt: -1 });
OpenOrderSchema.index({ walletAddress: 1, platform: 1, status: 1 });
OpenOrderSchema.index({ managerId: 1, asset: 1, status: 1 });

// TTL index: Auto-delete filled/cancelled orders after 30 days
OpenOrderSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 2592000, // 30 days
    partialFilterExpression: { status: { $in: ['filled', 'cancelled', 'rejected', 'expired'] } }
  }
);

// Update timestamp on save
OpenOrderSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.models.OpenOrder || mongoose.model('OpenOrder', OpenOrderSchema);
