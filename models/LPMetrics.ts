import mongoose, { Schema, Document } from 'mongoose';

export interface IProtocolBreakdown {
  protocol: string;
  liquidity: number;
  pnl: number;
  positions: number;
}

export interface IPairBreakdown {
  pair: string;
  positions: number;
  winRate: number;
  bestWin: number;
  worstLoss: number;
  totalPnl: number;
}

export interface ILPMetrics extends Document {
  walletAddress: string;

  // From DefiKrystal API (sum of all positions)
  totalLiquidity: number;
  totalPnl: number;
  totalFeesEarned: number;
  totalIL: number;
  totalNetPnl: number;

  // Computed from closed positions
  totalPositions: number;
  closedPositions: number;

  // Win rate based on closed positions
  wins: number;
  losses: number;
  winRate: number;

  avgWin: number;
  avgLoss: number;
  bestPosition: number;
  worstPosition: number;

  sharpeRatio: number;
  avgROI: number;

  // Per-protocol breakdown
  byProtocol: IProtocolBreakdown[];

  // Per-pair breakdown (for closed positions)
  byPair: IPairBreakdown[];

  updatedAt: Date;
}

const ProtocolBreakdownSchema = new Schema({
  protocol: String,
  liquidity: Number,
  pnl: Number,
  positions: Number
}, { _id: false });

const PairBreakdownSchema = new Schema({
  pair: String,
  positions: Number,
  winRate: Number,
  bestWin: Number,
  worstLoss: Number,
  totalPnl: Number
}, { _id: false });

const LPMetricsSchema = new Schema<ILPMetrics>({
  walletAddress: {
    type: String,
    required: true,
    lowercase: true,
    unique: true
  },
  totalLiquidity: {
    type: Number,
    default: 0
  },
  totalPnl: {
    type: Number,
    default: 0
  },
  totalFeesEarned: {
    type: Number,
    default: 0
  },
  totalIL: {
    type: Number,
    default: 0
  },
  totalNetPnl: {
    type: Number,
    default: 0
  },
  totalPositions: {
    type: Number,
    default: 0
  },
  closedPositions: {
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
  bestPosition: {
    type: Number,
    default: 0
  },
  worstPosition: {
    type: Number,
    default: 0
  },
  sharpeRatio: {
    type: Number,
    default: 0
  },
  avgROI: {
    type: Number,
    default: 0
  },
  byProtocol: [ProtocolBreakdownSchema],
  byPair: [PairBreakdownSchema],
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

export default mongoose.models.LPMetrics ||
  mongoose.model<ILPMetrics>('LPMetrics', LPMetricsSchema);
