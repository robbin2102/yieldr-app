/**
 * Polymarket Trader Metrics Model
 * Stores computed performance metrics with timestamps for historical tracking
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface IPolymarketMetrics extends Document {
  walletAddress: string;

  // Open Positions
  openPositionsCount: number;
  currentPositionValue: number;
  initialInvestment: number;
  totalUnrealizedPnl: number;

  // Closed Positions
  closedPositionsCount: number;
  closedInvestment: number;
  totalRealizedPnl: number;
  wins: number;
  losses: number;
  winRate: number;

  // Combined
  totalPnl: number;
  totalInvested: number;
  overallRoi: number;

  // Time-based PnL
  pnl1d: number;
  pnl7d: number;
  pnl30d: number;
  roi1d: number;
  roi7d: number;
  roi30d: number;

  // Risk Metrics
  sharpeRatio: number;

  // Metadata
  createdAt: Date;
}

const PolymarketMetricsSchema = new Schema<IPolymarketMetrics>({
  walletAddress: {
    type: String,
    required: true,
    lowercase: true,
    index: true,
  },

  // Open Positions
  openPositionsCount: { type: Number, required: true },
  currentPositionValue: { type: Number, required: true },
  initialInvestment: { type: Number, required: true },
  totalUnrealizedPnl: { type: Number, required: true },

  // Closed Positions
  closedPositionsCount: { type: Number, required: true },
  closedInvestment: { type: Number, required: true },
  totalRealizedPnl: { type: Number, required: true },
  wins: { type: Number, required: true },
  losses: { type: Number, required: true },
  winRate: { type: Number, required: true },

  // Combined
  totalPnl: { type: Number, required: true },
  totalInvested: { type: Number, required: true },
  overallRoi: { type: Number, required: true },

  // Time-based PnL
  pnl1d: { type: Number, required: true },
  pnl7d: { type: Number, required: true },
  pnl30d: { type: Number, required: true },
  roi1d: { type: Number, required: true },
  roi7d: { type: Number, required: true },
  roi30d: { type: Number, required: true },

  // Risk Metrics
  sharpeRatio: { type: Number, required: true },

  // Metadata
  createdAt: { type: Date, default: Date.now },
});

// Compound index for wallet + time queries
PolymarketMetricsSchema.index({ walletAddress: 1, createdAt: -1 });

export default mongoose.models.PolymarketMetrics ||
  mongoose.model<IPolymarketMetrics>('PolymarketMetrics', PolymarketMetricsSchema, 'polymarket-metrics');
