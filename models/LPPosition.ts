import mongoose, { Schema, Document } from 'mongoose';

export interface ITokenInfo {
  symbol: string;
  amount: number;
  value: number;
  address: string;
}

export interface ILastChange {
  liquidityValueDelta: number;
  token0AmountDelta: number;
  token1AmountDelta: number;
  pnlDelta: number;
  feesEarnedDelta: number;
  timestamp: Date;
}

export interface ILPPosition extends Document {
  walletAddress: string;
  positionId: string;
  protocol: string; // "AERODROME", "UNISWAP", "AERO"
  poolAddress: string;
  pair: string; // "ETH/USDC"
  token0: ITokenInfo;
  token1: ITokenInfo;
  liquidityValue: number;
  currentPnl: number; // From API
  roi: number; // From API
  feesEarned: number; // From API
  unclaimedFees: number; // From API
  impermanentLoss: number; // From API
  netPnl: number; // From API
  apr: number;
  entryTimestamp: Date;
  lastUpdated: Date;
  lastChange?: ILastChange;
}

const TokenInfoSchema = new Schema({
  symbol: String,
  amount: Number,
  value: Number,
  address: String
}, { _id: false });

const LastChangeSchema = new Schema({
  liquidityValueDelta: Number,
  token0AmountDelta: Number,
  token1AmountDelta: Number,
  pnlDelta: Number,
  feesEarnedDelta: Number,
  timestamp: Date
}, { _id: false });

const LPPositionSchema = new Schema<ILPPosition>({
  walletAddress: {
    type: String,
    required: true,
    lowercase: true
  },
  positionId: {
    type: String,
    required: true
  },
  protocol: {
    type: String,
    required: true
  },
  poolAddress: {
    type: String,
    required: true
  },
  pair: {
    type: String,
    required: true
  },
  token0: {
    type: TokenInfoSchema,
    required: true
  },
  token1: {
    type: TokenInfoSchema,
    required: true
  },
  liquidityValue: {
    type: Number,
    required: true
  },
  currentPnl: {
    type: Number,
    default: 0
  },
  roi: {
    type: Number,
    default: 0
  },
  feesEarned: {
    type: Number,
    default: 0
  },
  unclaimedFees: {
    type: Number,
    default: 0
  },
  impermanentLoss: {
    type: Number,
    default: 0
  },
  netPnl: {
    type: Number,
    default: 0
  },
  apr: {
    type: Number,
    default: 0
  },
  entryTimestamp: {
    type: Date,
    default: Date.now
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  lastChange: {
    type: LastChangeSchema
  }
});

// Indexes
LPPositionSchema.index({ walletAddress: 1, positionId: 1 }, { unique: true });
LPPositionSchema.index({ walletAddress: 1, protocol: 1 });

export default mongoose.models.LPPosition ||
  mongoose.model<ILPPosition>('LPPosition', LPPositionSchema);
