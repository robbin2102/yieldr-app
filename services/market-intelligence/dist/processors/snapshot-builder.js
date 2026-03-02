"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAndSaveSnapshot = buildAndSaveSnapshot;
const logger_1 = require("../utils/logger");
const MarketSnapshot_1 = __importDefault(require("../models/MarketSnapshot"));
const LiquidationLevels_1 = __importDefault(require("../models/LiquidationLevels"));
const liquidation_bucketer_1 = require("./liquidation-bucketer");
async function buildAndSaveSnapshot(args) {
    const { symbol, timestamp, tier, taapi, aggregate, perCoin, coinbasePremium, binance } = args;
    const start = Date.now();
    const indicators = taapi.indicators;
    // Price: Binance OHLCV only — no fallback to VWAP (that would corrupt computed fields)
    const closePrice = binance?.close ?? null;
    const price = {
        open: binance?.open ?? null,
        high: binance?.high ?? null,
        low: binance?.low ?? null,
        close: closePrice,
        volume: binance?.volume ?? null,
    };
    // Pivot points: prefer TAAPI result, fall back to computing from Binance daily candle
    const pivotPoints = computePivotPoints(indicators?.pivot_points, binance);
    const derivatives = buildDerivatives(aggregate, perCoin, coinbasePremium, symbol);
    const indicatorsDoc = {
        ema_8: indicators?.ema_8 ?? null,
        ema_21: indicators?.ema_21 ?? null,
        ema_50: indicators?.ema_50 ?? null,
        ema_200: indicators?.ema_200 ?? null,
        sma_50: indicators?.sma_50 ?? null,
        sma_200: indicators?.sma_200 ?? null,
        rsi_14: indicators?.rsi_14 ?? null,
        macd: indicators?.macd ?? null,
        stoch_rsi: indicators?.stoch_rsi ?? null,
        adx: indicators?.adx ?? null,
        momentum: indicators?.momentum ?? null,
        bbands: indicators?.bbands ?? null,
        atr_14: indicators?.atr_14 ?? null,
        squeeze: indicators?.squeeze ?? null,
        vwap: indicators?.vwap ?? null,
        obv: indicators?.obv ?? null,
        cmf: indicators?.cmf ?? null,
        ichimoku: indicators?.ichimoku ?? null,
        supertrend: indicators?.supertrend ?? null,
        psar: indicators?.psar ?? null,
        pivot_points: pivotPoints,
        fibonacci: indicators?.fibonacci ?? null,
        swing_high: indicators?.swing_high ?? null,
        swing_low: indicators?.swing_low ?? null,
    };
    const computed = computeSnapshotFields(indicatorsDoc, derivatives, closePrice);
    const snapshotDoc = {
        symbol: symbol.toUpperCase(),
        timestamp,
        interval: '1h',
        price,
        indicators: indicatorsDoc,
        candlestick_patterns: taapi.candlestick_patterns,
        derivatives,
        computed,
        chart_patterns: [],
        tier,
        fetched_on_demand: false,
        on_demand_expires_at: null,
        fetch_duration_ms: Date.now() - start,
        fetch_errors: taapi.errors,
    };
    let savedId;
    try {
        const saved = await MarketSnapshot_1.default.findOneAndUpdate({ symbol: snapshotDoc.symbol, timestamp }, { $set: snapshotDoc }, { upsert: true, new: true });
        savedId = String(saved._id);
        logger_1.logger.debug('Snapshot', `${symbol} saved (tier=${tier}) _id=${savedId}`);
    }
    catch (err) {
        logger_1.logger.error('Snapshot', `${symbol} save failed: ${err.message}`);
        throw err;
    }
    if (perCoin?.liq_history && perCoin.liq_history.length > 0) {
        await updateLiquidationLevels(symbol, perCoin.liq_history, closePrice ?? indicators?.vwap ?? null);
    }
    return { _id: savedId, snapshot: snapshotDoc };
}
// ─── Pivot Points ──────────────────────────────────────────────────────────────
/**
 * Returns TAAPI pivot points if populated, otherwise computes classic floor-trader
 * pivots from the previous day's Binance OHLC.
 *  PP = (H+L+C)/3
 *  R1 = 2*PP-L,  R2 = PP+(H-L),  R3 = H+2*(PP-L)
 *  S1 = 2*PP-H,  S2 = PP-(H-L),  S3 = L-2*(H-PP)
 */
function computePivotPoints(taapiPivots, binance) {
    // Use TAAPI if it returned real values
    if (taapiPivots?.pp != null)
        return taapiPivots;
    // Fall back to Binance daily OHLC
    const H = binance?.daily_high ?? null;
    const L = binance?.daily_low ?? null;
    const C = binance?.daily_close ?? null;
    if (H == null || L == null || C == null) {
        return { pp: null, r1: null, r2: null, r3: null, s1: null, s2: null, s3: null };
    }
    const pp = (H + L + C) / 3;
    return {
        pp,
        r1: 2 * pp - L,
        r2: pp + (H - L),
        r3: H + 2 * (pp - L),
        s1: 2 * pp - H,
        s2: pp - (H - L),
        s3: L - 2 * (H - pp),
    };
}
// ─── Derivatives ──────────────────────────────────────────────────────────────
function buildDerivatives(aggregate, perCoin, coinbasePremium, symbol) {
    const sym = symbol.toUpperCase();
    const fundingCurrent = aggregate.funding_rate_current;
    const fundingAnnualized = fundingCurrent != null ? fundingCurrent * 3 * 365 * 100 : null;
    // OI-weighted funding rate — close of latest 4h candle
    let oiWeightedFunding = null;
    if (perCoin?.oi_weighted_funding_history && perCoin.oi_weighted_funding_history.length > 0) {
        const latest = perCoin.oi_weighted_funding_history[perCoin.oi_weighted_funding_history.length - 1];
        oiWeightedFunding = parseFloat(latest?.close ?? '') || null;
    }
    // OI: use 4h history (limit=7 → ~28h) for 4h and 24h change
    let oiTotal = null;
    let oiChange4h = null;
    let oiChange24h = null;
    if (perCoin?.oi_history && perCoin.oi_history.length >= 1) {
        const vals = perCoin.oi_history;
        const curr = parseFloat(vals[vals.length - 1]?.close ?? '') || null;
        oiTotal = curr;
        // 4h change: compare last two candles
        if (vals.length >= 2) {
            const prev4h = parseFloat(vals[vals.length - 2]?.close ?? '') || null;
            if (curr && prev4h)
                oiChange4h = ((curr - prev4h) / prev4h) * 100;
        }
        // 24h change: compare last candle to 6 candles ago (6 * 4h = 24h)
        if (vals.length >= 7) {
            const prev24h = parseFloat(vals[vals.length - 7]?.close ?? '') || null;
            if (curr && prev24h)
                oiChange24h = ((curr - prev24h) / prev24h) * 100;
        }
    }
    // Liquidations from extended history (limit=6 → 24h)
    let liqH4 = { long_usd: null, short_usd: null };
    let liqH24 = { long_usd: null, short_usd: null };
    let liqLatest = { long_usd: null, short_usd: null, count: null };
    if (perCoin?.liq_history && perCoin.liq_history.length > 0) {
        const hist = perCoin.liq_history;
        const latest = hist[hist.length - 1];
        liqLatest = {
            long_usd: latest?.aggregated_long_liquidation_usd ?? null,
            short_usd: latest?.aggregated_short_liquidation_usd ?? null,
            count: null,
        };
        // h4: sum of last 1 candle (4h window — single candle at 4h interval)
        liqH4 = {
            long_usd: hist.slice(-1).reduce((s, d) => s + (d?.aggregated_long_liquidation_usd ?? 0), 0) || null,
            short_usd: hist.slice(-1).reduce((s, d) => s + (d?.aggregated_short_liquidation_usd ?? 0), 0) || null,
        };
        // h24: sum of all 6 candles (6 * 4h = 24h)
        const h24Long = hist.reduce((s, d) => s + (d?.aggregated_long_liquidation_usd ?? 0), 0);
        const h24Short = hist.reduce((s, d) => s + (d?.aggregated_short_liquidation_usd ?? 0), 0);
        liqH24 = {
            long_usd: h24Long || aggregate.liq_long_24h || null,
            short_usd: h24Short || aggregate.liq_short_24h || null,
        };
    }
    else {
        // Fallback to aggregate-level 24h data
        liqH24 = { long_usd: aggregate.liq_long_24h, short_usd: aggregate.liq_short_24h };
    }
    return {
        open_interest: {
            total_usd: oiTotal,
            change_4h_pct: oiChange4h,
            change_24h_pct: oiChange24h,
        },
        funding_rate: {
            current: fundingCurrent,
            predicted: null,
            oi_weighted: oiWeightedFunding,
            vol_weighted: null,
            annualized: fundingAnnualized,
        },
        funding_arbitrage: [],
        long_short_ratio: {
            global_accounts: perCoin?.long_short_global ?? { long: null, short: null, ratio: null },
            top_accounts: perCoin?.long_short_top_accounts ?? { long: null, short: null, ratio: null },
            top_positions: perCoin?.long_short_top_positions ?? { long: null, short: null, ratio: null },
        },
        liquidations: {
            latest: liqLatest,
            h4: liqH4,
            h24: liqH24,
        },
        taker_buy_sell: (() => {
            const th = perCoin?.taker_history ?? [];
            const takerLatest = th[th.length - 1];
            const buyVol = parseFloat(takerLatest?.taker_buy_volume_usd ?? '') || null;
            const sellVol = parseFloat(takerLatest?.taker_sell_volume_usd ?? '') || null;
            const total = buyVol != null && sellVol != null ? buyVol + sellVol : null;
            return {
                buy_vol_usd: buyVol,
                sell_vol_usd: sellVol,
                buy_ratio: total ? buyVol / total : null,
                sell_ratio: total ? sellVol / total : null,
            };
        })(),
        basis: perCoin?.basis ?? null,
        coinbase_premium: sym === 'BTC' ? (coinbasePremium?.btc ?? null) : null,
    };
}
// ─── Computed Fields ───────────────────────────────────────────────────────────
/**
 * Derives market_structure, ma_crossovers, and alerts from current snapshot data.
 * Note: divergences, fvg, order_blocks require multi-candle history (future work).
 */
function computeSnapshotFields(indicators, derivatives, closePrice) {
    const ema8 = indicators?.ema_8 ?? null;
    const ema21 = indicators?.ema_21 ?? null;
    const ema50 = indicators?.ema_50 ?? null;
    const ema200 = indicators?.ema_200 ?? null;
    const rsi = indicators?.rsi_14 ?? null;
    const adx = indicators?.adx?.adx ?? null;
    const supertrend = indicators?.supertrend ?? null;
    const vwap = indicators?.vwap ?? null;
    const macd = indicators?.macd ?? null;
    const funding = derivatives?.funding_rate?.current ?? null;
    const ichimoku = indicators?.ichimoku ?? null;
    // ── MA crossovers (current alignment state) ──
    const ma_crossovers = [];
    if (ema8 != null && ema21 != null) {
        ma_crossovers.push({ fast: 'ema_8', slow: 'ema_21', state: ema8 > ema21 ? 'above' : 'below', fast_value: ema8, slow_value: ema21 });
    }
    if (ema21 != null && ema50 != null) {
        ma_crossovers.push({ fast: 'ema_21', slow: 'ema_50', state: ema21 > ema50 ? 'above' : 'below', fast_value: ema21, slow_value: ema50 });
    }
    if (ema50 != null && ema200 != null) {
        ma_crossovers.push({ fast: 'ema_50', slow: 'ema_200', state: ema50 > ema200 ? 'above' : 'below', fast_value: ema50, slow_value: ema200 });
    }
    if (closePrice != null && ema200 != null) {
        ma_crossovers.push({ fast: 'price', slow: 'ema_200', state: closePrice > ema200 ? 'above' : 'below', fast_value: closePrice, slow_value: ema200 });
    }
    if (closePrice != null && vwap != null) {
        ma_crossovers.push({ fast: 'price', slow: 'vwap', state: closePrice > vwap ? 'above' : 'below', fast_value: closePrice, slow_value: vwap });
    }
    // ── Market structure ──
    let trend = 'neutral';
    let ema_alignment = null;
    if (ema8 != null && ema21 != null && ema50 != null && ema200 != null) {
        const bull_stack = ema8 > ema21 && ema21 > ema50 && ema50 > ema200;
        const bear_stack = ema8 < ema21 && ema21 < ema50 && ema50 < ema200;
        ema_alignment = bull_stack ? 'bullish' : bear_stack ? 'bearish' : 'mixed';
        if (bull_stack)
            trend = 'strong_uptrend';
        else if (bear_stack)
            trend = 'strong_downtrend';
        else if (ema8 > ema21 && ema21 > ema50)
            trend = 'uptrend';
        else if (ema8 < ema21 && ema21 < ema50)
            trend = 'downtrend';
    }
    // Ichimoku cloud position: above / inside / below current cloud (currentSpanA & currentSpanB)
    let ichimoku_cloud_bias = null;
    if (closePrice != null && ichimoku?.current_span_a != null && ichimoku?.current_span_b != null) {
        const cloudTop = Math.max(ichimoku.current_span_a, ichimoku.current_span_b);
        const cloudBottom = Math.min(ichimoku.current_span_a, ichimoku.current_span_b);
        ichimoku_cloud_bias = closePrice > cloudTop ? 'above' : closePrice < cloudBottom ? 'below' : 'inside';
    }
    // Tenkan vs Kijun cross direction (tk_cross)
    let tk_cross = null;
    if (ichimoku?.tenkan != null && ichimoku?.kijun != null) {
        tk_cross = ichimoku.tenkan > ichimoku.kijun ? 'bullish' : 'bearish';
    }
    const market_structure = {
        trend,
        ema_alignment,
        supertrend_direction: supertrend?.direction ?? null,
        rsi_zone: rsi != null ? (rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : 'neutral') : null,
        price_vs_vwap: closePrice != null && vwap != null ? (closePrice > vwap ? 'above' : 'below') : null,
        macd_bias: macd?.histogram != null ? (macd.histogram > 0 ? 'bullish' : 'bearish') : null,
        funding_bias: funding != null ? (funding > 0.01 ? 'positive' : funding < -0.01 ? 'negative' : 'neutral') : null,
        ichimoku_cloud_bias,
        ichimoku_tk_cross: tk_cross,
    };
    // ── Alerts ──
    const alerts = [];
    if (rsi != null) {
        if (rsi <= 20)
            alerts.push({ type: 'rsi_oversold', severity: 'high', message: `RSI extremely oversold at ${rsi.toFixed(1)}`, data: { rsi }, timestamp: new Date() });
        else if (rsi <= 30)
            alerts.push({ type: 'rsi_oversold', severity: 'medium', message: `RSI oversold at ${rsi.toFixed(1)}`, data: { rsi }, timestamp: new Date() });
        else if (rsi >= 80)
            alerts.push({ type: 'rsi_overbought', severity: 'high', message: `RSI extremely overbought at ${rsi.toFixed(1)}`, data: { rsi }, timestamp: new Date() });
        else if (rsi >= 70)
            alerts.push({ type: 'rsi_overbought', severity: 'medium', message: `RSI overbought at ${rsi.toFixed(1)}`, data: { rsi }, timestamp: new Date() });
    }
    if (adx != null && adx >= 40) {
        alerts.push({ type: 'strong_trend', severity: 'medium', message: `Strong trend: ADX=${adx.toFixed(1)}`, data: { adx }, timestamp: new Date() });
    }
    if (funding != null) {
        const fundingPct = (funding * 100).toFixed(4);
        if (funding <= -0.05)
            alerts.push({ type: 'funding_extreme_negative', severity: 'high', message: `Extreme negative funding: ${fundingPct}%`, data: { funding }, timestamp: new Date() });
        else if (funding <= -0.02)
            alerts.push({ type: 'funding_negative', severity: 'medium', message: `Negative funding rate: ${fundingPct}%`, data: { funding }, timestamp: new Date() });
        else if (funding >= 0.1)
            alerts.push({ type: 'funding_extreme_positive', severity: 'high', message: `Extreme positive funding: ${fundingPct}%`, data: { funding }, timestamp: new Date() });
        else if (funding >= 0.05)
            alerts.push({ type: 'funding_positive', severity: 'medium', message: `High positive funding: ${fundingPct}%`, data: { funding }, timestamp: new Date() });
    }
    if (supertrend?.direction === 'short' && ema_alignment === 'bearish') {
        alerts.push({ type: 'bearish_confluence', severity: 'high', message: 'Supertrend + EMA alignment both bearish', data: { supertrend_dir: 'short', ema_alignment }, timestamp: new Date() });
    }
    if (supertrend?.direction === 'long' && ema_alignment === 'bullish') {
        alerts.push({ type: 'bullish_confluence', severity: 'medium', message: 'Supertrend + EMA alignment both bullish', data: { supertrend_dir: 'long', ema_alignment }, timestamp: new Date() });
    }
    if (ichimoku_cloud_bias === 'inside') {
        alerts.push({ type: 'ichimoku_in_cloud', severity: 'medium', message: 'Price inside Ichimoku cloud — consolidation / indecision zone', data: { current_span_a: ichimoku?.current_span_a, current_span_b: ichimoku?.current_span_b }, timestamp: new Date() });
    }
    if (ichimoku_cloud_bias != null && tk_cross != null && supertrend?.direction != null) {
        const allBullish = ichimoku_cloud_bias === 'above' && tk_cross === 'bullish' && supertrend.direction === 'long';
        const allBearish = ichimoku_cloud_bias === 'below' && tk_cross === 'bearish' && supertrend.direction === 'short';
        if (allBullish)
            alerts.push({ type: 'ichimoku_bullish_confluence', severity: 'high', message: 'Strong bullish: price above cloud, TK cross bullish, Supertrend long', data: { ichimoku_cloud_bias, tk_cross }, timestamp: new Date() });
        if (allBearish)
            alerts.push({ type: 'ichimoku_bearish_confluence', severity: 'high', message: 'Strong bearish: price below cloud, TK cross bearish, Supertrend short', data: { ichimoku_cloud_bias, tk_cross }, timestamp: new Date() });
    }
    return {
        ma_crossovers,
        divergences: [], // requires multi-candle history
        market_structure,
        fvg: [], // requires multi-candle history
        order_blocks: [], // requires multi-candle history
        alerts,
    };
}
// ─── Liquidation Levels ────────────────────────────────────────────────────────
async function updateLiquidationLevels(symbol, liqHistory, currentPrice) {
    try {
        const normalised = liqHistory.map((d) => ({
            ...d,
            longLiquidationUsd: d.aggregated_long_liquidation_usd ?? 0,
            shortLiquidationUsd: d.aggregated_short_liquidation_usd ?? 0,
        }));
        const buckets = await (0, liquidation_bucketer_1.bucketLiquidations)(symbol, normalised, currentPrice);
        const totalLong = normalised.reduce((s, d) => s + d.longLiquidationUsd, 0);
        const totalShort = normalised.reduce((s, d) => s + d.shortLiquidationUsd, 0);
        const heaviest = buckets.reduce((max, b) => (b.total_usd > (max?.total_usd ?? 0) ? b : max), null);
        let nearestDistPct = null;
        if (currentPrice && heaviest) {
            const mid = (heaviest.price_low + heaviest.price_high) / 2;
            nearestDistPct = Math.abs(mid - currentPrice) / currentPrice * 100;
        }
        await LiquidationLevels_1.default.findOneAndUpdate({ symbol: symbol.toUpperCase() }, {
            $set: {
                symbol: symbol.toUpperCase(),
                updated_at: new Date(),
                current_price: currentPrice,
                price_buckets: buckets,
                total_long_liq_24h: totalLong,
                total_short_liq_24h: totalShort,
                heaviest_cluster: heaviest ? {
                    price_range: `${heaviest.price_low.toFixed(2)}–${heaviest.price_high.toFixed(2)}`,
                    total_usd: heaviest.total_usd,
                    side: heaviest.long_liq_usd > heaviest.short_liq_usd ? 'long' : 'short',
                } : { price_range: null, total_usd: null, side: null },
                nearest_cluster_distance_pct: nearestDistPct,
            },
        }, { upsert: true, new: true });
    }
    catch (err) {
        logger_1.logger.warn('Snapshot', `${symbol} liquidation levels update failed: ${err.message}`);
    }
}
//# sourceMappingURL=snapshot-builder.js.map