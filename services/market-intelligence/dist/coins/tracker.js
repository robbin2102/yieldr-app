"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshTrackedCoins = refreshTrackedCoins;
exports.loadTrackedCoins = loadTrackedCoins;
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const models_1 = require("../models");
const TAAPI_EXCHANGE_SYMBOLS_URL = `${config_1.config.taapi.baseUrl}/exchange-symbols`;
const CG_COINS_MARKETS_URL = `${config_1.config.coinglass.baseUrl}/api/futures/coins-markets`;
// Stablecoins and tokens we never want to track
const EXCLUDE_SYMBOLS = new Set([
    'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'GUSD', 'FRAX',
    'WBTC', 'WETH', 'STETH', 'RETH', 'CBETH', // wrapped tokens
]);
/**
 * Refresh the dynamic tracked coins list.
 * Steps:
 * 1. TAAPI exchange-symbols → available symbols on binancefutures
 * 2. CoinGlass coins-markets → all coins with OI
 * 3. Intersect → top 100 by OI
 * 4. Save to tracked_coins collection
 */
async function refreshTrackedCoins() {
    logger_1.logger.info('Tracker', 'Refreshing tracked coins list...');
    // Step 1: TAAPI symbols
    const taapiSymbols = await fetchTaapiSymbols();
    logger_1.logger.info('Tracker', `TAAPI binancefutures symbols: ${taapiSymbols.size}`);
    // Step 2: CoinGlass markets
    const cgCoins = await fetchCoinGlassMarkets();
    logger_1.logger.info('Tracker', `CoinGlass coins: ${cgCoins.length}`);
    // Step 3: Intersect
    const intersected = cgCoins.filter(item => {
        const sym = item.symbol.toUpperCase();
        return taapiSymbols.has(sym) && !EXCLUDE_SYMBOLS.has(sym);
    });
    const excluded = cgCoins
        .filter(item => EXCLUDE_SYMBOLS.has(item.symbol.toUpperCase()))
        .map(item => item.symbol.toUpperCase());
    // Step 4: Sort by OI descending, take top 100
    intersected.sort((a, b) => (b.openInterest ?? 0) - (a.openInterest ?? 0));
    const all = intersected.slice(0, config_1.config.totalTrackedCoins).map(item => item.symbol.toUpperCase());
    const full = all.slice(0, config_1.config.fullDerivativesTier);
    const lite = all.slice(config_1.config.fullDerivativesTier);
    // Step 5: Save to DB
    await models_1.TrackedCoins.findOneAndUpdate({}, {
        $set: {
            updated_at: new Date(),
            all,
            full_derivatives: full,
            lite_derivatives: lite,
            excluded,
            source_taapi_count: taapiSymbols.size,
            source_coinglass_count: cgCoins.length,
            intersection_count: intersected.length,
        },
    }, { upsert: true, new: true });
    logger_1.logger.info('Tracker', `Tracked coins updated: ${all.length} total, ${full.length} full, ${lite.length} lite`);
    logger_1.logger.info('Tracker', `Top 10: ${all.slice(0, 10).join(', ')}`);
    return { all, full, lite };
}
/**
 * Load tracked coins from DB. Falls back to refreshing if not found.
 */
async function loadTrackedCoins() {
    const stored = await models_1.TrackedCoins.findOne().sort({ updated_at: -1 });
    if (stored && stored.all.length > 0) {
        const ageMs = Date.now() - stored.updated_at.getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        logger_1.logger.info('Tracker', `Loaded ${stored.all.length} coins from DB (age: ${ageDays.toFixed(1)} days)`);
        return {
            all: stored.all,
            full: stored.full_derivatives,
            lite: stored.lite_derivatives,
        };
    }
    logger_1.logger.info('Tracker', 'No stored coins found — refreshing now');
    return refreshTrackedCoins();
}
// ─── Private helpers ──────────────────────────────────────────────────────────
async function fetchTaapiSymbols() {
    try {
        const url = `${TAAPI_EXCHANGE_SYMBOLS_URL}?secret=${config_1.config.taapi.apiKey}&exchange=${config_1.config.taapi.exchange}`;
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`TAAPI exchange-symbols ${res.status}`);
        const symbols = await res.json();
        // Convert "BTC/USDT" → "BTC"
        const baseSymbols = new Set();
        for (const sym of symbols) {
            const [base] = sym.split('/');
            if (base)
                baseSymbols.add(base.toUpperCase());
        }
        return baseSymbols;
    }
    catch (err) {
        logger_1.logger.error('Tracker', `Failed to fetch TAAPI symbols: ${err.message}`);
        return new Set();
    }
}
async function fetchCoinGlassMarkets() {
    try {
        const res = await fetch(CG_COINS_MARKETS_URL, {
            headers: {
                'CG-API-KEY': config_1.config.coinglass.apiKey,
                'Content-Type': 'application/json',
            },
        });
        if (!res.ok)
            throw new Error(`CoinGlass coins-markets ${res.status}`);
        const json = await res.json();
        if (json.code !== '0' && json.code !== 0) {
            throw new Error(`CoinGlass API error: ${json.msg}`);
        }
        const data = json.data || [];
        return data.map(item => ({
            symbol: (item.symbol || item.coin || '').toUpperCase(),
            openInterest: item.openInterest ?? item.openInterestUsd ?? null,
            price: item.price ?? item.lastPrice ?? null,
        })).filter(item => item.symbol.length > 0);
    }
    catch (err) {
        logger_1.logger.error('Tracker', `Failed to fetch CoinGlass markets: ${err.message}`);
        return [];
    }
}
//# sourceMappingURL=tracker.js.map