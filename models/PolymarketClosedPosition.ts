import mongoose from 'mongoose';

/**
 * Polymarket Closed Position Schema
 * Stores closed/redeemed positions (last 30 days)
 * Collection: polymarket-closedPositions
 */
const PolymarketClosedPositionSchema = new mongoose.Schema({
  // Unique Trade Identifier
  // Composed of: walletAddress + conditionId + asset + timestamp + totalBought + avgPrice
  // This ensures each unique close event (including partial closes) gets its own document
  tradeId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

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
  totalBought: {
    type: Number,
    required: true,
  },

  avgPrice: {
    type: Number,
    required: true,
  },

  // PnL (from Polymarket API)
  realizedPnl: {
    type: Number,
    required: true,
  },

  // Computed Metrics
  totalBet: {
    type: Number,
    required: true,
  },

  amountWon: {
    type: Number,
    required: true,
  },

  roi: {
    type: Number,
    default: 0,
  },

  won: {
    type: Boolean,
    required: true,
  },

  // Timestamps
  closedAt: {
    type: Date,
    required: true,
  },

  endDate: {
    type: Date,
  },

  fetchedAt: {
    type: Date,
    default: Date.now,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Compound indexes for efficient queries
PolymarketClosedPositionSchema.index({ walletAddress: 1, closedAt: -1 }); // For wallet + time queries
PolymarketClosedPositionSchema.index({ closedAt: 1 }); // For time-based queries (1d, 7d, 30d)

export default mongoose.models.PolymarketClosedPosition ||
  mongoose.model('PolymarketClosedPosition', PolymarketClosedPositionSchema, 'polymarket-closedPositions');
