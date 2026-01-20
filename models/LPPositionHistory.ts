import mongoose, { Schema, Document } from 'mongoose';
import { ITokenInfo } from './LPPosition';

export interface ILPPositionHistory extends Document {
  walletAddress: string;
  positionId: string;
  protocol: string;
  poolAddress: string;
  pair: string;
  token0: ITokenInfo;
  token1: ITokenInfo;
  entryValue: number;
  exitValue: number;
  liquidityChange: number;
  feesEarned: number;
  impermanentLoss: number;
  netPnl: number;
  roi: number;
  duration: number; // milliseconds
  apr: number;
  entryTimestamp: Date;
  exitTimestamp: Date;
}

const TokenInfoSchema = new Schema({
  symbol: String,
  amount: Number,
  value: Number,
  address: String
}, { _id: false });

const LPPositionHistorySchema = new Schema<ILPPositionHistory>({
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
  entryValue: {
    type: Number,
    required: true
  },
  exitValue: {
    type: Number,
    required: true
  },
  liquidityChange: {
    type: Number,
    default: 0
  },
  feesEarned: {
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
  roi: {
    type: Number,
    default: 0
  },
  duration: {
    type: Number,
    required: true
  },
  apr: {
    type: Number,
    default: 0
  },
  entryTimestamp: {
    type: Date,
    required: true
  },
  exitTimestamp: {
    type: Date,
    required: true
  }
});

// Indexes
LPPositionHistorySchema.index({ walletAddress: 1, exitTimestamp: -1 });
LPPositionHistorySchema.index({ walletAddress: 1, protocol: 1 });

export default mongoose.models.LPPositionHistory ||
  mongoose.model<ILPPositionHistory>('LPPositionHistory', LPPositionHistorySchema);
