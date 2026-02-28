import mongoose, { Schema, Document } from 'mongoose';

export interface IMarketSnapshot extends Document {
  symbol: string;
  timestamp: Date;
  interval: string;
  price: { open: number; high: number; low: number; close: number; volume: number };
  indicators: Record<string, unknown>;
  candlestick_patterns: Array<{ pattern: string; value: number; timeframe: string }>;
  derivatives: Record<string, unknown>;
  computed: {
    ma_crossovers: unknown[];
    divergences: unknown[];
    market_structure: Record<string, unknown>;
    fvg: unknown[];
    order_blocks: unknown[];
    alerts: unknown[];
  };
  chart_patterns: unknown[];
  tier: 'full' | 'lite' | 'on_demand';
  fetched_on_demand: boolean;
  on_demand_expires_at: Date | null;
  fetch_duration_ms: number;
}

const IndicatorsSchema = new Schema({
  ema_8: Number, ema_21: Number, ema_50: Number, ema_200: Number,
  sma_50: Number, sma_200: Number,
  rsi_14: Number,
  macd:      { macd_line: Number, signal_line: Number, histogram: Number },
  stoch_rsi: { k: Number, d: Number },
  adx:       { adx: Number, plus_di: Number, minus_di: Number },
  momentum:  Number,
  bbands:    { upper: Number, middle: Number, lower: Number, bandwidth: Number },
  atr_14:    Number,
  squeeze:   { value: Number, is_squeeze: Boolean },
  vwap: Number, obv: Number, cmf: Number,
  ichimoku: {
    tenkan: Number, kijun: Number,                    // conversion & base lines
    senkou_a: Number, senkou_b: Number,               // future cloud (displaced +26)
    current_span_a: Number, current_span_b: Number,   // cloud at current bar
    lagging_span_a: Number, lagging_span_b: Number,   // lagging span (chikou context)
  },
  supertrend: { value: Number, direction: String },
  psar:       Number,
  pivot_points: { pp: Number, r1: Number, r2: Number, r3: Number, s1: Number, s2: Number, s3: Number },
  fibonacci:  { level_236: Number, level_382: Number, level_500: Number, level_618: Number, level_786: Number },
  swing_high: { price: Number, timestamp: Date },
  swing_low:  { price: Number, timestamp: Date },
}, { _id: false });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MarketSnapshotSchema = new Schema<any>({
  symbol:    { type: String, required: true, uppercase: true },
  timestamp: { type: Date, required: true },
  interval:  { type: String, default: '1h' },
  price:     { open: Number, high: Number, low: Number, close: Number, volume: Number },
  indicators: IndicatorsSchema,
  candlestick_patterns: [{ pattern: String, value: Number, timeframe: { type: String, default: '1h' }, _id: false }],
  derivatives: {
    open_interest: { total_usd: Number, change_4h_pct: Number, change_24h_pct: Number },
    funding_rate:  { current: Number, predicted: Number, oi_weighted: Number, vol_weighted: Number, annualized: Number },
    funding_arbitrage: [{ long_exchange: String, short_exchange: String, spread: Number, _id: false }],
    long_short_ratio: {
      global_accounts: { long: Number, short: Number, ratio: Number },
      top_accounts:    { long: Number, short: Number, ratio: Number },
      top_positions:   { long: Number, short: Number, ratio: Number },
    },
    liquidations: {
      latest: { long_usd: Number, short_usd: Number, count: Number },
      h4:     { long_usd: Number, short_usd: Number },
      h24:    { long_usd: Number, short_usd: Number },
    },
    taker_buy_sell: { buy_vol_usd: Number, sell_vol_usd: Number, buy_ratio: Number, sell_ratio: Number },
    basis:            Number,
    coinbase_premium: Number,
  },
  computed: {
    ma_crossovers:   { type: [Schema.Types.Mixed], default: [] },
    divergences:     { type: [Schema.Types.Mixed], default: [] },
    market_structure: { type: Schema.Types.Mixed,  default: {} },
    fvg:             { type: [Schema.Types.Mixed], default: [] },
    order_blocks:    { type: [Schema.Types.Mixed], default: [] },
    alerts: [{
      type: { type: String },
      severity: { type: String, enum: ['high', 'medium', 'low'] },
      message: String,
      data: Schema.Types.Mixed,
      timestamp: { type: Date, default: Date.now },
      _id: false,
    }],
  },
  chart_patterns:      { type: [Schema.Types.Mixed], default: [] },
  tier:                { type: String, enum: ['full', 'lite', 'on_demand'], default: 'lite' },
  fetched_on_demand:   { type: Boolean, default: false },
  on_demand_expires_at: { type: Date, default: null },
  fetch_duration_ms:   { type: Number, default: 0 },
  errors:              [String],
}, { collection: 'market_snapshots', timestamps: false });

MarketSnapshotSchema.index({ symbol: 1, timestamp: -1 }, { unique: true });
MarketSnapshotSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
MarketSnapshotSchema.index({ 'derivatives.funding_rate.current': 1 });
MarketSnapshotSchema.index({ 'computed.alerts.severity': 1, timestamp: -1 });
MarketSnapshotSchema.index({ tier: 1, timestamp: -1 });

export default mongoose.models.MarketSnapshot ||
  mongoose.model<IMarketSnapshot>('MarketSnapshot', MarketSnapshotSchema);
