"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchFundingRateKlines = fetchFundingRateKlines;
exports.fetchOIHistory = fetchOIHistory;
exports.fetchGlobalLSRatio = fetchGlobalLSRatio;
exports.fetchTopAccountLSRatio = fetchTopAccountLSRatio;
exports.fetchTopPositionLSRatio = fetchTopPositionLSRatio;
exports.toPair = toPair;
exports.sleep = sleep;
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const BASE = config_1.config.binance.baseUrl;
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function binanceGet(path) {
    const url = `${BASE}${path}`;
    const res = await fetch(url);
    if (res.status === 400) {
        // Invalid symbol or bad request — not fatal, coin likely doesn't have a futures pair
        const text = await res.text();
        logger_1.logger.debug('Binance', `400 on ${path}: ${text.slice(0, 100)}`);
        return null;
    }
    if (res.status === 429 || res.status === 418) {
        throw new Error(`Binance rate limited (${res.status}) on ${path}`);
    }
    if (!res.ok) {
        throw new Error(`Binance ${res.status} on ${path}`);
    }
    return res.json();
}
async function fetchFundingRateKlines(pair, startTime, limit = 200) {
    const params = new URLSearchParams({
        symbol: pair,
        interval: '1h',
        limit: String(Math.min(limit, 1500)),
        ...(startTime ? { startTime: String(startTime) } : {}),
    });
    const data = await binanceGet(`/fapi/v1/premiumIndexKlines?${params}`);
    if (!data || !Array.isArray(data))
        return [];
    return data.map((candle) => {
        const fundingRate = parseFloat(candle[4]); // close
        return {
            timestamp: new Date(candle[0]), // openTime
            funding_rate: fundingRate,
            annualized_rate: fundingRate * 3 * 365 * 100,
        };
    });
}
async function fetchOIHistory(pair, startTime, limit = 500) {
    const params = new URLSearchParams({
        symbol: pair,
        period: '15m',
        limit: String(Math.min(limit, 500)),
        ...(startTime ? { startTime: String(startTime) } : {}),
    });
    const data = await binanceGet(`/futures/data/openInterestHist?${params}`);
    if (!data || !Array.isArray(data))
        return [];
    return data.map((d) => ({
        timestamp: new Date(d.timestamp),
        open_interest_usdt: parseFloat(d.sumOpenInterestValue),
    }));
}
async function fetchLSRatio(endpoint, pair, startTime, limit = 500) {
    const params = new URLSearchParams({
        symbol: pair,
        period: '15m',
        limit: String(Math.min(limit, 500)),
        ...(startTime ? { startTime: String(startTime) } : {}),
    });
    const data = await binanceGet(`${endpoint}?${params}`);
    if (!data || !Array.isArray(data))
        return [];
    return data.map((d) => ({
        timestamp: new Date(d.timestamp),
        long_pct: parseFloat(d.longAccount ?? d.longPosition) * 100,
        short_pct: parseFloat(d.shortAccount ?? d.shortPosition) * 100,
        ratio: parseFloat(d.longShortRatio),
    }));
}
function fetchGlobalLSRatio(pair, startTime, limit = 500) {
    return fetchLSRatio('/futures/data/globalLongShortAccountRatio', pair, startTime, limit);
}
function fetchTopAccountLSRatio(pair, startTime, limit = 500) {
    return fetchLSRatio('/futures/data/topLongShortAccountRatio', pair, startTime, limit);
}
function fetchTopPositionLSRatio(pair, startTime, limit = 500) {
    return fetchLSRatio('/futures/data/topLongShortPositionRatio', pair, startTime, limit);
}
// ─── Coin → Pair mapping ──────────────────────────────────────────────────────
function toPair(symbol) {
    return `${symbol.toUpperCase()}USDT`;
}
