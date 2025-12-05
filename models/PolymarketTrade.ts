import mongoose from 'mongoose';

/**
 * Polymarket Trade Schema
 * Stores all trading activity (TRADE and REDEEM events)
 * Collection: polymarket-trades
 */
const PolymarketTradeSchema = new mongoose.Schema({
  // Wallet & Trade Identifiers
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

  transactionHash: {
    type: String,
    required: true,
    index: true,
  },

  // Activity Type
  activityType: {
    type: String,
    enum: ['TRADE', 'REDEEM'],
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
  },

  // Trade Details
  side: {
    type: String,
    enum: ['BUY', 'SELL'],
  },

  size: {
    type: Number,
    required: true,
  },

  price: {
    type: Number,
    required: true,
  },

  usdcSize: {
    type: Number,
    required: true,
  },

  // Timestamps
  timestamp: {
    type: Date,
    required: true,
    index: true,
  },

  detectedAt: {
    type: Date,
    default: Date.now,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Compound indexes for efficient queries
PolymarketTradeSchema.index(
  { walletAddress: 1, transactionHash: 1 },
  { unique: true } // Prevent duplicate trades
);
PolymarketTradeSchema.index({ walletAddress: 1, timestamp: -1 }); // Chronological queries
PolymarketTradeSchema.index({ timestamp: 1 }); // For polling
PolymarketTradeSchema.index({ conditionId: 1, walletAddress: 1 }); // Market-specific trades

export default mongoose.models.PolymarketTrade ||
  mongoose.model('PolymarketTrade', PolymarketTradeSchema, 'polymarket-trades');
