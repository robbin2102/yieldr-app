import mongoose from 'mongoose';

/**
 * Position Snapshot Schema
 *
 * Stores periodic snapshots of all positions for a manager's wallet.
 * Used to detect changes and build historical data.
 *
 * Snapshot frequency: Every 60 seconds per wallet
 */

const PositionSnapshotSchema = new mongoose.Schema({
  // Identification
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

  // Snapshot metadata
  snapshotTime: {
    type: Date,
    required: true,
    default: Date.now,
    index: true
  },

  // Platform-specific data
  platform: {
    type: String,
    required: true,
    enum: ['avantis', 'hyperliquid', 'aerodrome', 'uniswap'],
    index: true
  },

  // Position data (varies by platform)
  positions: [{
    // Universal fields
    positionId: String,        // Unique ID from platform
    asset: String,             // BTC, ETH, SOL, etc.
    pair: String,              // BTC/USD, ETH-USDC, etc.
    type: {
      type: String,
      enum: ['PERP', 'LP']
    },

    // PERP-specific
    direction: String,         // LONG, SHORT
    leverage: Number,
    positionSize: Number,      // USD value
    margin: Number,            // Margin used
    entryPrice: Number,
    currentPrice: Number,
    liquidationPrice: Number,

    // LP-specific
    liquidity: Number,         // USD value
    token0: String,
    token1: String,
    unclaimedFees: Number,

    // Universal metrics
    pnl: Number,
    roi: Number,
    status: String,            // active, closed

    // Tracking
    openedAt: Date,            // When position was first opened
    closedAt: Date,            // When position was closed (if applicable)
  }],

  // Summary metrics for this snapshot
  summary: {
    totalPositions: Number,
    totalAUM: Number,
    totalPnL: Number,
    totalROI: Number,
    perpPositions: Number,
    lpPositions: Number,
  },

  // Change detection
  changes: {
    newPositions: [String],    // positionIds of new positions
    closedPositions: [String], // positionIds of closed positions
    modifiedPositions: [String] // positionIds of modified positions
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Compound indexes for efficient queries
PositionSnapshotSchema.index({ managerId: 1, snapshotTime: -1 });
PositionSnapshotSchema.index({ walletAddress: 1, platform: 1, snapshotTime: -1 });

// TTL index: Keep snapshots for 90 days, then auto-delete
PositionSnapshotSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90 days

export default mongoose.models.PositionSnapshot || mongoose.model('PositionSnapshot', PositionSnapshotSchema);
