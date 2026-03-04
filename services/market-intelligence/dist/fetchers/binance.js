"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchBinanceCandle = fetchBinanceCandle;
/**
 * Fetches OHLCV candle data from Coinbase Exchange public REST API (no auth required).
 * Used for: price.open/high/low/close/volume + daily OHLC for pivot point computation.
 *
 * NOTE: Previously used Binance (/api/v3/klines) which returns HTTP 451 (geo-blocked)
 * from Railway's server region. Coinbase Exchange public candle API has no geo-restrictions
 * and requires no API key.
 *
 * Endpoint: GET https://api.exchange.coinbase.com/products/{id}/candles
 * Response: [[time, low, high, open, close, volume], ...] sorted newest-first
 */
const logger_1 = require("../utils/logger");
const BASE = 'https://api.exchange.coinbase.com';
// Coinbase Exchange uses the rebranded ticker for some tokens
const SYMBOL_MAP = {
    MATIC: 'POL', // Polygon rebranded MATIC → POL in Sept 2024
};
async function cbGet(path) {
    const res = await fetch(`${BASE}${path}`, {
        headers: { 'Accept': 'application/json' },
    });
    if (!res.ok)
        throw new Error(`Coinbase ${res.status}: ${path}`);
    return res.json();
}
async function fetchBinanceCandle(symbol) {
    const result = {
        open: null, high: null, low: null, close: null, volume: null,
        daily_high: null, daily_low: null, daily_close: null,
    };
    const productId = `${SYMBOL_MAP[symbol] ?? symbol}-USD`;
    const now = Math.floor(Date.now() / 1000);
    // 1h candle: end = start of current hour (excludes forming candle), start = 1h before
    const hourEnd = Math.floor(now / 3600) * 3600;
    const hourStart = hourEnd - 3600;
    try {
        const startIso = new Date(hourStart * 1000).toISOString();
        const endIso = new Date(hourEnd * 1000).toISOString();
        const candles = await cbGet(`/products/${productId}/candles?start=${startIso}&end=${endIso}&granularity=3600`);
        if (Array.isArray(candles) && candles.length >= 1) {
            const c = candles[0]; // newest = last complete 1h candle
            // Coinbase Exchange format: [time, low, high, open, close, volume]
            result.open = parseFloat(c[3]);
            result.high = parseFloat(c[2]);
            result.low = parseFloat(c[1]);
            result.close = parseFloat(c[4]);
            result.volume = parseFloat(c[5]);
            logger_1.logger.debug('Coinbase', `${symbol} 1h OHLCV: O=${result.open} H=${result.high} L=${result.low} C=${result.close} V=${result.volume}`);
        }
    }
    catch (err) {
        logger_1.logger.warn('Coinbase', `${symbol} 1h candle failed: ${err.message}`);
    }
    // Daily candle: end = today midnight UTC, start = yesterday midnight
    const dayEnd = Math.floor(now / 86400) * 86400;
    const dayStart = dayEnd - 86400;
    try {
        const startIso = new Date(dayStart * 1000).toISOString();
        const endIso = new Date(dayEnd * 1000).toISOString();
        const candles = await cbGet(`/products/${productId}/candles?start=${startIso}&end=${endIso}&granularity=86400`);
        if (Array.isArray(candles) && candles.length >= 1) {
            const d = candles[0]; // previous complete day
            // Coinbase Exchange format: [time, low, high, open, close, volume]
            result.daily_high = parseFloat(d[2]);
            result.daily_low = parseFloat(d[1]);
            result.daily_close = parseFloat(d[4]);
            logger_1.logger.debug('Coinbase', `${symbol} prev-day H=${result.daily_high} L=${result.daily_low} C=${result.daily_close}`);
        }
    }
    catch (err) {
        logger_1.logger.warn('Coinbase', `${symbol} daily candle failed: ${err.message}`);
    }
    return result;
}
//# sourceMappingURL=binance.js.map
