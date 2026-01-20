import mongoose from 'mongoose';

const polyAgentTradeSchema = new mongoose.Schema({
  // UNIQUE INDEX - MongoDB auto-rejects duplicates (no cache needed)
  originalTxHash: {
    type: String,
    unique: true,
    required: true,
    index: true
  },

  // Original trade from target trader
  original: {
    walletAddress: String,
    conditionId: { type: String, index: true },
    tokenId: String,
    side: { type: String, enum: ['BUY', 'SELL'] },
    size: Number,
    price: Number,
    usdcSize: Number,
    timestamp: Date,
    title: String,
    outcome: String,
  },

  // Our copy trade
  copy: {
    orderId: String,
    side: { type: String, enum: ['BUY', 'SELL'] },
    targetSize: Number,
    targetPrice: Number,
    executedSize: Number,
    executedPrice: Number,
    executedUsdcSize: Number,
  },

  // Status
  status: {
    type: String,
    enum: ['DETECTED', 'EXECUTING', 'FILLED', 'FAILED', 'SKIPPED'],
    default: 'DETECTED',
    index: true,
  },
  skipReason: String,
  failReason: String,

  // Slippage for this trade
  slippage: {
    expectedCost: Number,    // traderPrice × ourQty
    actualCost: Number,      // ourFillPrice × ourQty
    slippageUsdc: Number,    // expectedCost - actualCost
    slippageBps: Number,
  },

  // Timing
  detectedAt: Date,
  executedAt: Date,
  confirmedAt: Date,
  latencyMs: Number,

}, { timestamps: true });

// Indexes for efficient queries
polyAgentTradeSchema.index({ 'original.conditionId': 1, createdAt: -1 });
polyAgentTradeSchema.index({ status: 1, createdAt: -1 });

export const PolyAgentTrade = mongoose.model('PolyAgentTrade', polyAgentTradeSchema, 'poly-agent-trades');
