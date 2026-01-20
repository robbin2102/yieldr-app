import mongoose, { Schema, Document } from 'mongoose';

export interface IAssetMetrics {
  coin: string;
  trades: number;
  winRate: number;
  bestWin: number;
  worstLoss: number;
  totalPnl: number;
}

export interface IHyperliquidMetrics extends Document {
  walletAddress: string;

  // Account summary
  accountValue: string;
  totalMarginUsed: string;
  totalNtlPos: string; // Total notional position value
  withdrawable: string;

  // Computed PnL (from portfolio API)
  pnl_1d: number;
  pnl_7d: number;
  pnl_30d: number;
  pnl_allTime: number;
  volume_24h: string;

  // Trade statistics
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  bestTrade: number;
  worstTrade: number;

  // Risk metrics
  sharpeRatio: number;
  maxDrawdown: number;
  avgLeverage: number;
  maxLeverageUsed: number;

  // Per-asset breakdown
  byAsset: IAssetMetrics[];

  updatedAt: Date;
}

const AssetMetricsSchema = new Schema({
  coin: String,
  trades: Number,
  winRate: Number,
  bestWin: Number,
  worstLoss: Number,
  totalPnl: Number
}, { _id: false });

const HyperliquidMetricsSchema = new Schema<IHyperliquidMetrics>({
  walletAddress: {
    type: String,
    required: true,
    lowercase: true,
    unique: true
  },
  accountValue: {
    type: String,
    default: '0'
  },
  totalMarginUsed: {
    type: String,
    default: '0'
  },
  totalNtlPos: {
    type: String,
    default: '0'
  },
  withdrawable: {
    type: String,
    default: '0'
  },
  pnl_1d: {
    type: Number,
    default: 0
  },
  pnl_7d: {
    type: Number,
    default: 0
  },
  pnl_30d: {
    type: Number,
    default: 0
  },
  pnl_allTime: {
    type: Number,
    default: 0
  },
  volume_24h: {
    type: String,
    default: '0'
  },
  totalTrades: {
    type: Number,
    default: 0
  },
  wins: {
    type: Number,
    default: 0
  },
  losses: {
    type: Number,
    default: 0
  },
  winRate: {
    type: Number,
    default: 0
  },
  avgWin: {
    type: Number,
    default: 0
  },
  avgLoss: {
    type: Number,
    default: 0
  },
  bestTrade: {
    type: Number,
    default: 0
  },
  worstTrade: {
    type: Number,
    default: 0
  },
  sharpeRatio: {
    type: Number,
    default: 0
  },
  maxDrawdown: {
    type: Number,
    default: 0
  },
  avgLeverage: {
    type: Number,
    default: 0
  },
  maxLeverageUsed: {
    type: Number,
    default: 0
  },
  byAsset: [AssetMetricsSchema],
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

export default mongoose.models.HyperliquidMetrics ||
  mongoose.model<IHyperliquidMetrics>('HyperliquidMetrics', HyperliquidMetricsSchema);
