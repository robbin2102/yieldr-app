import mongoose from 'mongoose';

const HyperliquidPnlSnapshotSchema = new mongoose.Schema({
  walletAddress: {
    type: String,
    required: true,
    lowercase: true,
    index: true
  },
  timestamp: {
    type: Date,
    required: true,
    index: true
  },
  accountValue: {
    type: String,
    required: true
  },
  pnl_1d: {
    type: Number,
    required: true
  },
  pnl_7d: {
    type: Number,
    required: true
  },
  pnl_30d: {
    type: Number,
    required: true
  },
  pnl_allTime: {
    type: Number,
    required: true
  },
  volume_24h: {
    type: String,
    default: '0'
  }
}, {
  timestamps: true
});

// Compound index for efficient queries
HyperliquidPnlSnapshotSchema.index({ walletAddress: 1, timestamp: -1 });

const HyperliquidPnlSnapshot = mongoose.models.HyperliquidPnlSnapshot ||
  mongoose.model('HyperliquidPnlSnapshot', HyperliquidPnlSnapshotSchema);

export default HyperliquidPnlSnapshot;
