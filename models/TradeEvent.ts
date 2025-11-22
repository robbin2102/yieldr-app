import mongoose from 'mongoose';

/**
 * Trade Event Schema
 * Stores Avantis trading events from blockchain
 */
const TradeEventSchema = new mongoose.Schema({
  // Unique order identifier (correlation key)
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  // Trade status
  status: {
    type: String,
    enum: ['PENDING', 'EXECUTED', 'CLOSED'],
    required: true,
    index: true,
  },

  // Trader information
  trader: {
    type: String,
    required: true,
    lowercase: true,
    index: true,
  },

  // Trading pair
  pairIndex: {
    type: Number,
    required: true,
  },

  pairSymbol: {
    type: String, // e.g., "ETH/USD"
  },

  // Trade direction
  isBuy: {
    type: Boolean,
    required: true,
  },

  // --- From MarketOrderInitiated ---
  initiatedAt: {
    type: Date,
    required: true,
  },

  initiatedTxHash: {
    type: String,
    required: true,
  },

  initiatedBlockNumber: {
    type: Number,
    required: true,
    index: true,
  },

  // --- From MarketExecuted (when opened) ---
  tradeIndex: {
    type: Number,
  },

  collateralUsdc: {
    type: Number,
  },

  positionSizeUsdc: {
    type: Number,
  },

  leverage: {
    type: Number,
  },

  openPrice: {
    type: Number,
  },

  executionPrice: {
    type: Number,
  },

  tp: {
    type: Number,
  },

  sl: {
    type: Number,
  },

  executedAt: {
    type: Date,
  },

  executedTxHash: {
    type: String,
  },

  executedBlockNumber: {
    type: Number,
  },

  // --- For closes (when open=false) ---
  closePrice: {
    type: Number,
  },

  pnlUsdc: {
    type: Number, // Profit/Loss in USDC (can be negative)
  },

  roi: {
    type: Number, // Return on investment percentage (can be negative)
  },

  closedAt: {
    type: Date,
  },

  closedTxHash: {
    type: String,
  },

  // --- Computed fields ---
  durationSeconds: {
    type: Number,
  },

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
  },

  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Compound indexes for efficient querying
TradeEventSchema.index({ trader: 1, initiatedAt: -1 });
TradeEventSchema.index({ status: 1, trader: 1 });
TradeEventSchema.index({ trader: 1, status: 1, initiatedAt: -1 });

// Update 'updatedAt' on every save
TradeEventSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.models.TradeEvent ||
  mongoose.model('TradeEvent', TradeEventSchema);
