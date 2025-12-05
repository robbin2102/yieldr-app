import mongoose, { Schema, Document } from 'mongoose';
import { PolymarketMetrics as IPolymarketMetrics } from '../../types/polymarket';

export interface MetricsDocument extends Omit<IPolymarketMetrics, '_id'>, Document {}

const metricsSchema = new Schema<MetricsDocument>(
  {
    walletAddress: {
      type: String,
      required: true,
      lowercase: true,
      unique: true,
      index: true,
    },
    openPositionsCount: {
      type: Number,
      required: true,
      default: 0,
    },
    totalUnrealizedPnl: {
      type: Number,
      required: true,
      default: 0,
    },
    closedPositionsCount: {
      type: Number,
      required: true,
      default: 0,
    },
    totalRealizedPnl: {
      type: Number,
      required: true,
      default: 0,
    },
    wins: {
      type: Number,
      required: true,
      default: 0,
    },
    losses: {
      type: Number,
      required: true,
      default: 0,
    },
    winRate: {
      type: Number,
      required: true,
      default: 0,
    },
    totalPnl: {
      type: Number,
      required: true,
      default: 0,
    },
    totalInvested: {
      type: Number,
      required: true,
      default: 0,
    },
    overallRoi: {
      type: Number,
      required: true,
      default: 0,
    },
    sharpeRatio: {
      type: Number,
      required: true,
      default: 0,
    },
    pnl1d: {
      type: Number,
      required: true,
      default: 0,
    },
    pnl7d: {
      type: Number,
      required: true,
      default: 0,
    },
    pnl30d: {
      type: Number,
      required: true,
      default: 0,
    },
    lastUpdated: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    collection: 'polymarket_metrics',
    timestamps: false,
  }
);

export const Metrics = mongoose.model<MetricsDocument>('Metrics', metricsSchema);
