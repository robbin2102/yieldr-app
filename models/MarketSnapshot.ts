import mongoose, { Schema, Document } from 'mongoose';

export interface ICandlestickPattern {
  pattern: string;
  value: number;
  timeframe: string;
}

export interface IAlert {
  type: string;
  severity: 'high' | 'medium' | 'low';
  message: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

export interface IMarketSnapshot extends Document {
  symbol: string;
  timestamp: Date;
  interval: string;

  price: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };

  indicators: {
    ema_8: number | null;
    ema_21: number | null;
    ema_50: number | null;
    ema_200: number | null;
    sma_50: number | null;
    sma_200: number | null;
    rsi_14: number | null;
    macd: { macd_line: number; signal_line: number; histogram: number } | null;
    stoch_rsi: { k: number; d: number } | null;
    adx: { adx: number; plus_di: number; minus_di: number } | null;
    momentum: number | null;
    bbands: { upper: number; middle: number; lower: number; bandwidth: number } | null;
    atr_14: number | null;
    squeeze: { value: number; is_squeeze: boolean } | null;
    vwap: number | null;
    obv: number | null;
    cmf: number | null;
    ichimoku: { tenkan: number; kijun: number; senkou_a: number; senkou_b: number; chikou: number } | null;
    supertrend: { value: number; direction: string } | null;
    psar: number | null;
    pivot_points: { pp: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number } | null;
    fibonacci: { level_236: number; level_382: number; level_500: number; level_618: number; level_786: number } | null;
    swing_high: { price: number; timestamp: Date } | null;
    swing_low: { price: number; timestamp: Date } | null;
  };

  candlestick_patterns: ICandlestickPattern[];

  derivatives: {
    open_interest: {
      total_usd: number | null;
      change_1h_pct: number | null;
      change_4h_pct: number | null;
      change_24h_pct: number | null;
    };
    funding_rate: {
      current: number | null;
      predicted: number | null;
      oi_weighted: number | null;
      vol_weighted: number | null;
      annualized: number | null;
    };
    funding_arbitrage: Array<{ long_exchange: string; short_exchange: string; spread: number }>;
    long_short_ratio: {
      global_accounts: { long: number | null; short: number | null };
      top_accounts: { long: number | null; short: number | null };
      top_positions: { long: number | null; short: number | null };
    };
    liquidations: {
      h1: { long_usd: number | null; short_usd: number | null; count: number | null };
      h4: { long_usd: number | null; short_usd: number | null };
      h24: { long_usd: number | null; short_usd: number | null };
    };
    taker_buy_sell: {
      buy_vol: number | null;
      sell_vol: number | null;
      ratio: number | null;
    };
    cvd: { value: number | null; change_1h: number | null; change_4h: number | null };
    basis: { aggregate: number | null };
    coinbase_premium: number | null;
    net_flow: number | null;
  };

  computed: {
    ma_crossovers: unknown[];
    divergences: unknown[];
    market_structure: Record<string, unknown>;
    fvg: unknown[];
    order_blocks: unknown[];
    alerts: IAlert[];
  };

  chart_patterns: unknown[];

  tier: 'full' | 'lite' | 'on_demand';
  fetched_on_demand: boolean;
  on_demand_expires_at: Date | null;
  fetch_duration_ms: number;
}

const IndicatorsSchema = new Schema({
  ema_8: Number,
  ema_21: Number,
  ema_50: Number,
  ema_200: Number,
  sma_50: Number,
  sma_200: Number,
  rsi_14: Number,
  macd: {
    macd_line: Number,
    signal_line: Number,
    histogram: Number,
  },
  stoch_rsi: { k: Number, d: Number },
  adx: { adx: Number, plus_di: Number, minus_di: Number },
  momentum: Number,
  bbands: { upper: Number, middle: Number, lower: Number, bandwidth: Number },
  atr_14: Number,
  squeeze: { value: Number, is_squeeze: Boolean },
  vwap: Number,
  obv: Number,
  cmf: Number,
  ichimoku: { tenkan: Number, kijun: Number, senkou_a: Number, senkou_b: Number, chikou: Number },
  supertrend: { value: Number, direction: String },
  psar: Number,
  pivot_points: { pp: Number, r1: Number, r2: Number, r3: Number, s1: Number, s2: Number, s3: Number },
  fibonacci: { level_236: Number, level_382: Number, level_500: Number, level_618: Number, level_786: Number },
  swing_high: { price: Number, timestamp: Date },
  swing_low: { price: Number, timestamp: Date },
}, { _id: false });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MarketSnapshotSchema = new Schema<any>({
  symbol: { type: String, required: true, uppercase: true },
  timestamp: { type: Date, required: true },
  interval: { type: String, default: '1h' },

  price: {
    open: Number,
    high: Number,
    low: Number,
    close: Number,
    volume: Number,
  },

  indicators: IndicatorsSchema,

  candlestick_patterns: [{
    pattern: String,
    value: Number,
    timeframe: { type: String, default: '1h' },
    _id: false,
  }],

  derivatives: {
    open_interest: {
      total_usd: Number,
      change_1h_pct: Number,
      change_4h_pct: Number,
      change_24h_pct: Number,
    },
    funding_rate: {
      current: Number,
      predicted: Number,
      oi_weighted: Number,
      vol_weighted: Number,
      annualized: Number,
    },
    funding_arbitrage: [{
      long_exchange: String,
      short_exchange: String,
      spread: Number,
      _id: false,
    }],
    long_short_ratio: {
      global_accounts: { long: Number, short: Number },
      top_accounts: { long: Number, short: Number },
      top_positions: { long: Number, short: Number },
    },
    liquidations: {
      h1: { long_usd: Number, short_usd: Number, count: Number },
      h4: { long_usd: Number, short_usd: Number },
      h24: { long_usd: Number, short_usd: Number },
    },
    taker_buy_sell: { buy_vol: Number, sell_vol: Number, ratio: Number },
    cvd: { value: Number, change_1h: Number, change_4h: Number },
    basis: { aggregate: Number },
    coinbase_premium: Number,
    net_flow: Number,
  },

  computed: {
    ma_crossovers: { type: [Schema.Types.Mixed], default: [] },
    divergences: { type: [Schema.Types.Mixed], default: [] },
    market_structure: { type: Schema.Types.Mixed, default: {} },
    fvg: { type: [Schema.Types.Mixed], default: [] },
    order_blocks: { type: [Schema.Types.Mixed], default: [] },
    alerts: [{
      type: { type: String },
      severity: { type: String, enum: ['high', 'medium', 'low'] },
      message: String,
      data: Schema.Types.Mixed,
      timestamp: { type: Date, default: Date.now },
      _id: false,
    }],
  },

  chart_patterns: { type: [Schema.Types.Mixed], default: [] },

  tier: { type: String, enum: ['full', 'lite', 'on_demand'], default: 'lite' },
  fetched_on_demand: { type: Boolean, default: false },
  on_demand_expires_at: { type: Date, default: null },
  fetch_duration_ms: { type: Number, default: 0 },
  errors: [String],
}, {
  collection: 'market_snapshots',
  timestamps: false,
});

MarketSnapshotSchema.index({ symbol: 1, timestamp: -1 }, { unique: true });
MarketSnapshotSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
MarketSnapshotSchema.index({ 'derivatives.funding_rate.current': 1 });
MarketSnapshotSchema.index({ 'computed.alerts.severity': 1, timestamp: -1 });
MarketSnapshotSchema.index({ tier: 1, timestamp: -1 });

export default mongoose.models.MarketSnapshot ||
  mongoose.model<IMarketSnapshot>('MarketSnapshot', MarketSnapshotSchema);
