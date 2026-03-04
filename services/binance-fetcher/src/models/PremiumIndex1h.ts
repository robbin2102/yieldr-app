import mongoose, { Schema } from 'mongoose';

const PremiumIndex1hSchema = new Schema({
  symbol:        { type: String, required: true, uppercase: true },
  pair:          { type: String, required: true },        // e.g. BTCUSDT
  open_time:     { type: Date,   required: true },        // candle open time
  close_time:    { type: Date,   required: true },        // candle close time
  premium_index: { type: Number, required: true },        // close = predicted funding rate
  open_premium:  { type: Number, required: true },
  high_premium:  { type: Number, required: true },
  low_premium:   { type: Number, required: true },
}, { collection: 'binance_premium_index_1h', timestamps: false });

PremiumIndex1hSchema.index({ symbol: 1, open_time: -1 }, { unique: true });
PremiumIndex1hSchema.index({ open_time: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export default mongoose.models.PremiumIndex1h ||
  mongoose.model('PremiumIndex1h', PremiumIndex1hSchema);
