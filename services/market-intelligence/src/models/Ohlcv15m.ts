import mongoose, { Schema, Document } from 'mongoose';

export interface IOhlcv15m extends Document {
  symbol:     string;
  timestamp:  Date;
  open:       number;
  high:       number;
  low:        number;
  close:      number;
  volume:     number;
  fetched_at: Date;
}

const Ohlcv15mSchema = new Schema<IOhlcv15m>({
  symbol:     { type: String, required: true, uppercase: true },
  timestamp:  { type: Date, required: true },
  open:       { type: Number, required: true },
  high:       { type: Number, required: true },
  low:        { type: Number, required: true },
  close:      { type: Number, required: true },
  volume:     { type: Number, required: true },
  fetched_at: { type: Date, default: Date.now },
}, { collection: 'ohlcv_15m', timestamps: false });

Ohlcv15mSchema.index({ symbol: 1, timestamp: -1 }, { unique: true });
Ohlcv15mSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7 * 24 * 3600 }); // 7-day TTL

export default (mongoose.models.Ohlcv15m as mongoose.Model<IOhlcv15m>) ||
  mongoose.model<IOhlcv15m>('Ohlcv15m', Ohlcv15mSchema);
