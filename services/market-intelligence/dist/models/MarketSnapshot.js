"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importStar(require("mongoose"));
const IndicatorsSchema = new mongoose_1.Schema({
    ema_8: Number, ema_21: Number, ema_50: Number, ema_200: Number,
    sma_50: Number, sma_200: Number,
    rsi_14: Number,
    macd: { macd_line: Number, signal_line: Number, histogram: Number },
    stoch_rsi: { k: Number, d: Number },
    adx: { adx: Number, plus_di: Number, minus_di: Number },
    momentum: Number,
    bbands: { upper: Number, middle: Number, lower: Number, bandwidth: Number },
    atr_14: Number,
    squeeze: { value: Number, is_squeeze: Boolean },
    vwap: Number, obv: Number, cmf: Number,
    ichimoku: { tenkan: Number, kijun: Number, senkou_a: Number, senkou_b: Number, chikou: Number },
    supertrend: { value: Number, direction: String },
    psar: Number,
    pivot_points: { pp: Number, r1: Number, r2: Number, r3: Number, s1: Number, s2: Number, s3: Number },
    fibonacci: { level_236: Number, level_382: Number, level_500: Number, level_618: Number, level_786: Number },
    swing_high: { price: Number, timestamp: Date },
    swing_low: { price: Number, timestamp: Date },
}, { _id: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MarketSnapshotSchema = new mongoose_1.Schema({
    symbol: { type: String, required: true, uppercase: true },
    timestamp: { type: Date, required: true },
    interval: { type: String, default: '1h' },
    price: { open: Number, high: Number, low: Number, close: Number, volume: Number },
    indicators: IndicatorsSchema,
    candlestick_patterns: [{ pattern: String, value: Number, timeframe: { type: String, default: '1h' }, _id: false }],
    derivatives: {
        open_interest: { total_usd: Number, change_1h_pct: Number, change_4h_pct: Number, change_24h_pct: Number },
        funding_rate: { current: Number, predicted: Number, oi_weighted: Number, vol_weighted: Number, annualized: Number },
        funding_arbitrage: [{ long_exchange: String, short_exchange: String, spread: Number, _id: false }],
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
        ma_crossovers: { type: [mongoose_1.Schema.Types.Mixed], default: [] },
        divergences: { type: [mongoose_1.Schema.Types.Mixed], default: [] },
        market_structure: { type: mongoose_1.Schema.Types.Mixed, default: {} },
        fvg: { type: [mongoose_1.Schema.Types.Mixed], default: [] },
        order_blocks: { type: [mongoose_1.Schema.Types.Mixed], default: [] },
        alerts: [{
                type: { type: String },
                severity: { type: String, enum: ['high', 'medium', 'low'] },
                message: String,
                data: mongoose_1.Schema.Types.Mixed,
                timestamp: { type: Date, default: Date.now },
                _id: false,
            }],
    },
    chart_patterns: { type: [mongoose_1.Schema.Types.Mixed], default: [] },
    tier: { type: String, enum: ['full', 'lite', 'on_demand'], default: 'lite' },
    fetched_on_demand: { type: Boolean, default: false },
    on_demand_expires_at: { type: Date, default: null },
    fetch_duration_ms: { type: Number, default: 0 },
    errors: [String],
}, { collection: 'market_snapshots', timestamps: false });
MarketSnapshotSchema.index({ symbol: 1, timestamp: -1 }, { unique: true });
MarketSnapshotSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
MarketSnapshotSchema.index({ 'derivatives.funding_rate.current': 1 });
MarketSnapshotSchema.index({ 'computed.alerts.severity': 1, timestamp: -1 });
MarketSnapshotSchema.index({ tier: 1, timestamp: -1 });
exports.default = mongoose_1.default.models.MarketSnapshot ||
    mongoose_1.default.model('MarketSnapshot', MarketSnapshotSchema);
//# sourceMappingURL=MarketSnapshot.js.map