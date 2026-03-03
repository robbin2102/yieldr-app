import mongoose, { Schema } from 'mongoose';

const FundingRate1hSchema = new Schema({
  symbol:        { type: String, required: true, uppercase: true },
  pair:          { type: String, required: true },        // e.g. BTCUSDT
  timestamp:     { type: Date,   required: true },        // candle open time
  funding_rate:  { type: Number, required: true },        // premiumIndexKlines close value
  annualized_rate: { type: Number, required: true },      // funding_rate * 3 * 365 * 100
}, { collection: 'binance_funding_1h', timestamps: false });

FundingRate1hSchema.index({ symbol: 1, timestamp: -1 }, { unique: true });
FundingRate1hSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

export default mongoose.models.FundingRate1h ||
  mongoose.model('FundingRate1h', FundingRate1hSchema);
