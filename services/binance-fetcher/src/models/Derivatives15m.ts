import mongoose, { Schema } from 'mongoose';

const LSRatioSchema = new Schema({
  long_pct:  Number,   // long percentage (0–100)
  short_pct: Number,   // short percentage (0–100)
  ratio:     Number,   // longShortRatio raw value from Binance
}, { _id: false });

const Derivatives15mSchema = new Schema({
  symbol:               { type: String, required: true, uppercase: true },
  pair:                 { type: String, required: true },   // e.g. BTCUSDT
  timestamp:            { type: Date,   required: true },
  open_interest_usdt:   Number,   // sumOpenInterestValue from openInterestHist

  // Long/short ratios — all values in percent (0–100), ratio is raw decimal
  long_short_global:        LSRatioSchema,
  long_short_top_accounts:  LSRatioSchema,
  long_short_top_positions: LSRatioSchema,
}, { collection: 'binance_derivatives_15m', timestamps: false });

Derivatives15mSchema.index({ symbol: 1, timestamp: -1 }, { unique: true });
Derivatives15mSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

export default mongoose.models.Derivatives15m ||
  mongoose.model('Derivatives15m', Derivatives15mSchema);
