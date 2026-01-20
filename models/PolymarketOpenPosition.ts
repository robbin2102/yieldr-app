import mongoose from 'mongoose';

/**
 * Polymarket Open Position Schema
 * Stores current active positions for tracked wallets
 * Collection: polymarket-openPositions
 */
const PolymarketOpenPositionSchema = new mongoose.Schema({
  // Wallet & Position Identifiers
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

  // Market Info
  title: {
    type: String,
    required: true,
  },

  slug: {
    type: String,
  },

  outcome: {
    type: String,
    required: true,
  },

  outcomeIndex: {
    type: Number,
    required: true,
  },

  // Position Details
  size: {
    type: Number,
    required: true,
  },

  avgPrice: {
    type: Number,
    required: true,
  },

  curPrice: {
    type: Number,
    required: true,
  },

  // PnL (from Polymarket API)
  initialValue: {
    type: Number,
    required: true,
  },

  currentValue: {
    type: Number,
    required: true,
  },

  cashPnl: {
    type: Number,
    required: true,
  },

  percentPnl: {
    type: Number,
    required: true,
  },

  // Computed Metrics
  roi: {
    type: Number,
    default: 0,
  },

  // Market Metadata
  endDate: {
    type: Date,
  },

  redeemable: {
    type: Boolean,
    default: false,
  },

  // Timestamps
  fetchedAt: {
    type: Date,
    default: Date.now,
  },

  updatedAt: {
    type: Date,
    default: Date.now,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Compound indexes for efficient queries
PolymarketOpenPositionSchema.index({ walletAddress: 1, conditionId: 1, asset: 1 }, { unique: true }); // Include asset for Up/Down positions
PolymarketOpenPositionSchema.index({ walletAddress: 1, fetchedAt: -1 });
PolymarketOpenPositionSchema.index({ endDate: 1 });

// Update 'updatedAt' on every save
PolymarketOpenPositionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.models.PolymarketOpenPosition ||
  mongoose.model('PolymarketOpenPosition', PolymarketOpenPositionSchema, 'polymarket-openPositions');
