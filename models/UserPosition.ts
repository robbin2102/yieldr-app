import mongoose, { Document, Schema } from 'mongoose';

/**
 * User positions cache for active monitoring users.
 * Written by the monitoring-scheduler position-refresh loop.
 * Passed to the evaluator LLM as context when deciding whether to alert.
 *
 * Covers Hyperliquid (perps), Polymarket (predictions), and Avantis (perps).
 * One document per (userId, platform) pair, replaced on each refresh.
 */

export interface IUserPositionEntry {
  // Common
  asset: string;            // coin, pair, or market title
  direction?: string;       // LONG/SHORT/YES/NO/BUY/SELL
  size?: number;
  pnl?: number;
  platform: string;

  // Perp-specific
  entryPrice?: number;
  currentPrice?: number;
  leverage?: number;
  liquidationPrice?: number;
  marginUsed?: number;
  roi?: number;

  // Prediction-specific
  outcome?: string;
  avgPrice?: number;
  currentValue?: number;
  pnlPercent?: number;
}

export interface IUserPosition extends Document {
  userId: string;                    // wallet address (lowercase)
  platform: 'hyperliquid' | 'polymarket' | 'avantis';
  positions: IUserPositionEntry[];
  totalPnl?: number;
  accountValue?: number;
  lastUpdated: Date;
}

const UserPositionEntrySchema = new Schema<IUserPositionEntry>({
  asset: { type: String, required: true },
  direction: { type: String },
  size: { type: Number },
  pnl: { type: Number },
  platform: { type: String, required: true },
  entryPrice: { type: Number },
  currentPrice: { type: Number },
  leverage: { type: Number },
  liquidationPrice: { type: Number },
  marginUsed: { type: Number },
  roi: { type: Number },
  outcome: { type: String },
  avgPrice: { type: Number },
  currentValue: { type: Number },
  pnlPercent: { type: Number },
}, { _id: false });

const UserPositionSchema = new Schema<IUserPosition>({
  userId: { type: String, required: true, lowercase: true },
  platform: {
    type: String,
    required: true,
    enum: ['hyperliquid', 'polymarket', 'avantis'],
  },
  positions: { type: [UserPositionEntrySchema], default: [] },
  totalPnl: { type: Number },
  accountValue: { type: Number },
  lastUpdated: { type: Date, required: true, default: Date.now },
});

UserPositionSchema.index({ userId: 1, platform: 1 }, { unique: true });
UserPositionSchema.index({ lastUpdated: 1 });

export default mongoose.models.UserPosition ||
  mongoose.model<IUserPosition>('UserPosition', UserPositionSchema, 'user_positions');
