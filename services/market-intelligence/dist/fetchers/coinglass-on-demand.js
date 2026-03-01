"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchOnDemand = fetchOnDemand;
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const coinglass_1 = require("./coinglass");
const MarketSnapshot_1 = __importDefault(require("../models/MarketSnapshot"));
/**
 * On-demand CoinGlass fetch for coins 21-100.
 * Checks cache first; fetches and merges if stale or missing.
 */
async function fetchOnDemand(symbol) {
    const upperSym = symbol.toUpperCase();
    // Check cache: does a recent on-demand snapshot exist?
    const existing = await MarketSnapshot_1.default.findOne({ symbol: upperSym })
        .sort({ timestamp: -1 })
        .select('tier on_demand_expires_at derivatives');
    if (existing) {
        const isCached = existing.tier === 'on_demand' &&
            existing.on_demand_expires_at &&
            existing.on_demand_expires_at > new Date();
        if (isCached) {
            logger_1.logger.info('OnDemand', `${upperSym}: serving from cache (expires ${existing.on_demand_expires_at?.toISOString()})`);
            return existing.derivatives;
        }
    }
    // Cache miss or expired — fetch full per-coin data
    logger_1.logger.info('OnDemand', `${upperSym}: cache miss — fetching 10 per-coin CoinGlass endpoints`);
    const fetchStart = Date.now();
    const perCoin = await (0, coinglass_1.fetchPerCoinData)(upperSym);
    const fetchMs = Date.now() - fetchStart;
    logger_1.logger.info('OnDemand', `${upperSym}: fetched in ${fetchMs}ms, ${perCoin.errors.length} errors`);
    if (!existing) {
        logger_1.logger.warn('OnDemand', `${upperSym}: no existing snapshot to merge into`);
        return null;
    }
    // Merge enriched data into the existing lite snapshot
    const expiresAt = new Date(Date.now() + config_1.config.onDemandCacheTtlMs);
    const enrichedDerivatives = buildEnrichedDerivatives(perCoin, existing.derivatives);
    await MarketSnapshot_1.default.findOneAndUpdate({ symbol: upperSym, timestamp: existing.timestamp }, {
        $set: {
            tier: 'on_demand',
            fetched_on_demand: true,
            on_demand_expires_at: expiresAt,
            derivatives: enrichedDerivatives,
            fetch_duration_ms: existing.fetch_duration_ms + fetchMs,
            ...(perCoin.errors.length > 0 ? { $push: { errors: { $each: perCoin.errors } } } : {}),
        },
    }, { new: true });
    logger_1.logger.info('OnDemand', `${upperSym}: snapshot upgraded to on_demand tier, cached until ${expiresAt.toISOString()}`);
    return enrichedDerivatives;
}
function buildEnrichedDerivatives(perCoin, existing) {
    const enriched = { ...(existing || {}) };
    // Funding arbitrage
    if (perCoin.funding_arbitrage.length > 0) {
        if (!enriched.funding_rate)
            enriched.funding_rate = {};
        enriched.funding_arbitrage = perCoin.funding_arbitrage;
    }
    // OI history — extract change percentages
    if (perCoin.oi_history.length >= 2) {
        const current = perCoin.oi_history[perCoin.oi_history.length - 1];
        const prev1h = perCoin.oi_history[perCoin.oi_history.length - 2];
        if (!enriched.open_interest)
            enriched.open_interest = {};
        enriched.open_interest.change_1h_pct = current && prev1h
            ? ((current.o - prev1h.o) / prev1h.o) * 100
            : null;
    }
    // Long/short ratios
    enriched.long_short_ratio = {
        global_accounts: perCoin.long_short_global,
        top_accounts: perCoin.long_short_top_accounts,
        top_positions: perCoin.long_short_top_positions,
    };
    // Liquidation history
    if (perCoin.liq_history.length > 0) {
        const latest = perCoin.liq_history[perCoin.liq_history.length - 1];
        if (!enriched.liquidations)
            enriched.liquidations = {};
        enriched.liquidations.h1 = {
            long_usd: latest?.longLiquidationUsd ?? null,
            short_usd: latest?.shortLiquidationUsd ?? null,
            count: latest?.count ?? null,
        };
    }
    // Taker history
    if (perCoin.taker_history.length > 0) {
        const latest = perCoin.taker_history[perCoin.taker_history.length - 1];
        if (!enriched.taker_buy_sell)
            enriched.taker_buy_sell = {};
        enriched.taker_buy_sell.buy_vol = latest?.buyVol ?? enriched.taker_buy_sell?.buy_vol ?? null;
        enriched.taker_buy_sell.sell_vol = latest?.sellVol ?? enriched.taker_buy_sell?.sell_vol ?? null;
    }
    // CVD
    if (perCoin.cvd_history.length > 0) {
        const values = perCoin.cvd_history.map((d) => d.cvd ?? d.value ?? 0);
        enriched.cvd = {
            value: values[values.length - 1] ?? null,
            change_1h: values.length >= 2 ? values[values.length - 1] - values[values.length - 2] : null,
            change_4h: values.length >= 4 ? values[values.length - 1] - values[0] : null,
        };
    }
    // Net flow
    enriched.net_flow = perCoin.net_flow;
    // Funding rate from history
    if (perCoin.funding_rate_history.length > 0) {
        const latest = perCoin.funding_rate_history[perCoin.funding_rate_history.length - 1];
        if (!enriched.funding_rate)
            enriched.funding_rate = {};
        enriched.funding_rate.oi_weighted = latest?.oiWeightedFundingRate ?? null;
        enriched.funding_rate.vol_weighted = latest?.volWeightedFundingRate ?? null;
        enriched.funding_rate.annualized = enriched.funding_rate.current != null
            ? enriched.funding_rate.current * 3 * 365 * 100
            : null;
    }
    return enriched;
}
//# sourceMappingURL=coinglass-on-demand.js.map