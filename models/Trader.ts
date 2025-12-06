/**
 * Trader Model
 * Tracks Polymarket traders and their performance
 * Similar to Manager model, will be merged later
 */

import mongoose from 'mongoose';

const FollowedWalletSchema = new mongoose.Schema({
  wallet: {
    type: String,
    required: true,
    lowercase: true
  },
  platform: {
    type: String,
    required: true,
    enum: ['polymarket', 'avantis', 'hyperliquid'],
    default: 'polymarket'
  },
  addedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const TraderPositionSchema = new mongoose.Schema({
  conditionId: String,
  asset: String,
  title: String,
  outcome: String,
  size: Number,
  avgPrice: Number,
  curPrice: Number,
  initialValue: Number,
  currentValue: Number,
  pnl: Number,
  roi: Number,
  endDate: Date,
  redeemable: Boolean
}, { _id: false });

const TraderSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false // Optional - can track public wallets without user
  },
  username: {
    type: String,
    unique: true,
    sparse: true, // Allow null values but enforce uniqueness when set
    lowercase: true
  },
  profilePicture: {
    type: String,
    default: ''
  },
  walletAddress: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },

  // Profile text
  marketOutlook: {
    type: String,
    default: ''
  },
  investmentThesis: {
    type: String,
    default: ''
  },
  positionStrategy: {
    type: String,
    default: ''
  },

  // Wallets being tracked with platform mapping
  followed_wallets: [FollowedWalletSchema],

  // Platforms (for future multi-platform support)
  platforms: {
    type: [String],
    default: ['polymarket']
  },

  // Performance metrics (synced from polymarket-metrics)
  metrics: {
    totalPnL30d: { type: Number, default: 0 },
    totalPnL7d: { type: Number, default: 0 },
    totalPnL1d: { type: Number, default: 0 },
    roi30d: { type: Number, default: 0 },
    roi7d: { type: Number, default: 0 },
    roi1d: { type: Number, default: 0 },
    overallRoi: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    totalInvested: { type: Number, default: 0 },
    totalTrades: { type: Number, default: 0 },
    openPositions: { type: Number, default: 0 },
    closedPositions: { type: Number, default: 0 },
    sharpeRatio: { type: Number, default: 0 }
  },

  // Current open positions (synced from polymarket-openPositions)
  positions: [TraderPositionSchema],

  // Tracking status
  trackingStatus: {
    type: String,
    enum: ['ACTIVE', 'PAUSED', 'STOPPED', 'ERROR'],
    default: 'ACTIVE'
  },

  // Polymarket sync tracking
  polymarketSyncStatus: {
    type: String,
    enum: ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED'],
    default: 'NOT_STARTED'
  },
  polymarketSyncStartedAt: {
    type: Date,
    default: null
  },
  polymarketSyncCompletedAt: {
    type: Date,
    default: null
  },
  polymarketLastSyncAt: {
    type: Date,
    default: null
  },
  polymarketSyncError: {
    type: String,
    default: null
  },

  // Metadata
  verified: {
    type: Boolean,
    default: false
  },
  lastPositionSync: {
    type: Date,
    default: null
  },
  lastMetricsSync: {
    type: Date,
    default: null
  },

  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes
TraderSchema.index({ username: 1 });
TraderSchema.index({ walletAddress: 1 });
TraderSchema.index({ trackingStatus: 1 });
TraderSchema.index({ polymarketSyncStatus: 1 });

// Update timestamp on save
TraderSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.models.Trader || mongoose.model('Trader', TraderSchema, 'traders');
