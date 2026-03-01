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
/**
 * Merge TAAPI + CoinGlass data into a market_snapshots document and upsert to MongoDB.
 */
async function buildAndSaveSnapshot(args) {
    const { symbol, timestamp, tier, taapi, aggregate, perCoin, coinbasePremium } = args;
    const start = Date.now();
    const indicators = taapi.indicators;
    // Extract price from indicators (VWAP ≈ close, or get from pivot point's PP)
    // We use the close price from indicators if available. TAAPI doesn't give raw OHLCV
    // in the bulk endpoint — we'll use the pivot point PP as a proxy for close price.
    const closePrice = indicators?.vwap ?? indicators?.pivot_points?.pp ?? null;
    // Build derivatives object
    const derivatives = buildDerivatives(aggregate, perCoin, coinbasePremium, symbol);
    // Build the snapshot document
    const snapshotDoc = {
        symbol: symbol.toUpperCase(),
        timestamp,
        interval: '1h',
        price: {
            open: null,
            high: null,
            low: null,
            close: closePrice,
            volume: null,
        },
        indicators: {
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
            pivot_points: indicators?.pivot_points ?? null,
            fibonacci: indicators?.fibonacci ?? null,
            swing_high: indicators?.swing_high ?? null,
            swing_low: indicators?.swing_low ?? null,
        },
        candlestick_patterns: taapi.candlestick_patterns,
        derivatives,
        computed: {
            ma_crossovers: [],
            divergences: [],
            market_structure: {},
            fvg: [],
            order_blocks: [],
            alerts: [],
        },
        chart_patterns: [],
        tier,
        fetched_on_demand: false,
        on_demand_expires_at: null,
        fetch_duration_ms: Date.now() - start,
        errors: taapi.errors,
    };
    try {
        await MarketSnapshot_1.default.findOneAndUpdate({ symbol: snapshotDoc.symbol, timestamp }, { $set: snapshotDoc }, { upsert: true, new: true });
        logger_1.logger.debug('Snapshot', `${symbol} saved (tier=${tier})`);
    }
    catch (err) {
        logger_1.logger.error('Snapshot', `${symbol} save failed: ${err.message}`);
        throw err;
    }
    // Build liquidation levels from per-coin liq history
    if (perCoin?.liq_history && perCoin.liq_history.length > 0) {
        await updateLiquidationLevels(symbol, perCoin.liq_history, aggregate.price ?? closePrice);
    }
}
function buildDerivatives(aggregate, perCoin, coinbasePremium, symbol) {
    const sym = symbol.toUpperCase();
    // Funding rate annualized: rate * 3 (8h periods/day) * 365 * 100
    const fundingCurrent = aggregate.funding_rate_current;
    const fundingAnnualized = fundingCurrent != null ? fundingCurrent * 3 * 365 * 100 : null;
    // OI change: from per-coin history if available, else from aggregate
    let oiChange1h = null;
    let oiChange4h = null;
    if (perCoin?.oi_history && perCoin.oi_history.length >= 2) {
        const vals = perCoin.oi_history;
        const curr = vals[vals.length - 1]?.o ?? null;
        const prev1 = vals[vals.length - 2]?.o ?? null;
        const prev4 = vals.length >= 4 ? vals[vals.length - 4]?.o ?? null : null;
        if (curr && prev1)
            oiChange1h = ((curr - prev1) / prev1) * 100;
        if (curr && prev4)
            oiChange4h = ((curr - prev4) / prev4) * 100;
    }
    // CVD from history
    let cvd = {
        value: null, change_1h: null, change_4h: null,
    };
    if (perCoin?.cvd_history && perCoin.cvd_history.length > 0) {
        const vals = perCoin.cvd_history.map((d) => d.cvd ?? d.value ?? 0);
        cvd = {
            value: vals[vals.length - 1] ?? null,
            change_1h: vals.length >= 2 ? vals[vals.length - 1] - vals[vals.length - 2] : null,
            change_4h: vals.length >= 4 ? vals[vals.length - 1] - vals[0] : null,
        };
    }
    // Funding OI/Vol weighted from history
    let oiWeighted = null;
    let volWeighted = null;
    if (perCoin?.funding_rate_history && perCoin.funding_rate_history.length > 0) {
        const latest = perCoin.funding_rate_history[perCoin.funding_rate_history.length - 1];
        oiWeighted = latest?.oiWeightedFundingRate ?? null;
        volWeighted = latest?.volWeightedFundingRate ?? null;
    }
    // Liq h1/h4 from history
    let liqH1 = { long_usd: null, short_usd: null, count: null };
    let liqH4 = { long_usd: null, short_usd: null };
    if (perCoin?.liq_history && perCoin.liq_history.length > 0) {
        const h1Data = perCoin.liq_history[perCoin.liq_history.length - 1];
        liqH1 = {
            long_usd: h1Data?.longLiquidationUsd ?? null,
            short_usd: h1Data?.shortLiquidationUsd ?? null,
            count: h1Data?.count ?? null,
        };
        if (perCoin.liq_history.length >= 4) {
            const h4Longs = perCoin.liq_history.slice(-4).reduce((s, d) => s + (d?.longLiquidationUsd ?? 0), 0);
            const h4Shorts = perCoin.liq_history.slice(-4).reduce((s, d) => s + (d?.shortLiquidationUsd ?? 0), 0);
            liqH4 = { long_usd: h4Longs, short_usd: h4Shorts };
        }
    }
    return {
        open_interest: {
            total_usd: aggregate.open_interest_usd,
            change_1h_pct: oiChange1h,
            change_4h_pct: oiChange4h,
            change_24h_pct: aggregate.oi_change_24h_pct,
        },
        funding_rate: {
            current: fundingCurrent,
            predicted: null,
            oi_weighted: oiWeighted,
            vol_weighted: volWeighted,
            annualized: fundingAnnualized,
        },
        funding_arbitrage: perCoin?.funding_arbitrage ?? [],
        long_short_ratio: {
            global_accounts: perCoin?.long_short_global ?? { long: null, short: null },
            top_accounts: perCoin?.long_short_top_accounts ?? { long: null, short: null },
            top_positions: perCoin?.long_short_top_positions ?? { long: null, short: null },
        },
        liquidations: {
            h1: liqH1,
            h4: liqH4,
            h24: {
                long_usd: aggregate.liq_long_24h,
                short_usd: aggregate.liq_short_24h,
            },
        },
        taker_buy_sell: {
            buy_vol: aggregate.taker_buy_vol,
            sell_vol: aggregate.taker_sell_vol,
            ratio: aggregate.taker_ratio,
        },
        cvd,
        basis: { aggregate: aggregate.basis },
        coinbase_premium: (sym === 'BTC' ? coinbasePremium?.btc : sym === 'ETH' ? coinbasePremium?.eth : null) ?? null,
        net_flow: perCoin?.net_flow ?? null,
    };
}
async function updateLiquidationLevels(symbol, liqHistory, currentPrice) {
    try {
        const buckets = await (0, liquidation_bucketer_1.bucketLiquidations)(symbol, liqHistory, currentPrice);
        const totalLong = liqHistory.reduce((s, d) => s + (d?.longLiquidationUsd ?? 0), 0);
        const totalShort = liqHistory.reduce((s, d) => s + (d?.shortLiquidationUsd ?? 0), 0);
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