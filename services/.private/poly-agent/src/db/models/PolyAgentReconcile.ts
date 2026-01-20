import mongoose from 'mongoose';

const polyAgentReconcileSchema = new mongoose.Schema({
  // When this check ran
  checkedAt: { type: Date, required: true, index: true },

  // Market info
  conditionId: { type: String, required: true, index: true },
  title: String,
  outcome: String,

  // Position comparison
  traderPosition: {
    size: Number,
    avgPrice: Number,
  },
  expectedPosition: {
    size: Number,    // traderPosition × copyRatio
  },
  actualPosition: {
    size: Number,
    avgPrice: Number,
  },

  // Gap
  gapSize: Number,           // expected - actual
  gapPercent: Number,        // (gap / expected) × 100
  gapDirection: { type: String, enum: ['UNDER', 'OVER', 'OK'] },

}, { timestamps: true });

// Index for finding gaps
polyAgentReconcileSchema.index({ gapDirection: 1, checkedAt: -1 });

export const PolyAgentReconcile = mongoose.model('PolyAgentReconcile', polyAgentReconcileSchema, 'poly-agent-reconcile');
