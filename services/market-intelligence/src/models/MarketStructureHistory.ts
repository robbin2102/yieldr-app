import mongoose, { Schema, Document } from 'mongoose';

export interface IMarketStructureHistory extends Document {
  symbol: string;
  updated_at: Date;
  swing_points: Array<{ type: 'high' | 'low'; price: number; timestamp: Date; timeframe: string }>;
  structure_events: Array<{ type: 'bos' | 'choch'; direction: 'bullish' | 'bearish'; price: number; timestamp: Date }>;
  trend: 'uptrend' | 'downtrend' | 'range';
  last_hh: number | null;
  last_hl: number | null;
  last_lh: number | null;
  last_ll: number | null;
}

const MarketStructureHistorySchema = new Schema<IMarketStructureHistory>({
  symbol:     { type: String, required: true, uppercase: true },
  updated_at: { type: Date, default: Date.now },
  swing_points: [{
    type:      { type: String, enum: ['high', 'low'], required: true },
    price:     { type: Number, required: true },
    timestamp: { type: Date,   required: true },
    timeframe: { type: String, default: '1h' },
    _id: false,
  }],
  structure_events: [{
    type:      { type: String, enum: ['bos', 'choch'], required: true },
    direction: { type: String, enum: ['bullish', 'bearish'], required: true },
    price:     { type: Number, required: true },
    timestamp: { type: Date,   required: true },
    _id: false,
  }],
  trend:   { type: String, enum: ['uptrend', 'downtrend', 'range'], default: 'range' },
  last_hh: { type: Number, default: null },
  last_hl: { type: Number, default: null },
  last_lh: { type: Number, default: null },
  last_ll: { type: Number, default: null },
}, { collection: 'market_structure_history', timestamps: false });

MarketStructureHistorySchema.index({ symbol: 1 }, { unique: true });

export default mongoose.models.MarketStructureHistory ||
  mongoose.model<IMarketStructureHistory>('MarketStructureHistory', MarketStructureHistorySchema);
