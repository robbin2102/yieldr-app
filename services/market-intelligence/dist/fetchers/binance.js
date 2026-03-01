"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchBinanceCandle = fetchBinanceCandle;
/**
 * Fetches OHLCV candle data from Binance public REST API (no key required).
 * Used for: price.open/high/low/close/volume + daily OHLC for pivot point computation.
 */
const logger_1 = require("../utils/logger");
const BASE = 'https://api.binance.com';
async function binanceGet(path) {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok)
        throw new Error(`Binance ${res.status}: ${path}`);
    return res.json();
}
/**
 * Fetches the last COMPLETE 1h candle + previous day's OHLC for a given symbol.
 * Binance klines response: [open_time, open, high, low, close, volume, close_time, ...]
 */
async function fetchBinanceCandle(symbol) {
    const result = {
        open: null, high: null, low: null, close: null, volume: null,
        daily_high: null, daily_low: null, daily_close: null,
    };
    const pair = `${symbol}USDT`;
    // 1h candle — limit=2 gives [last_complete, currently_forming]; use index 0
    try {
        const klines = await binanceGet(`/api/v3/klines?symbol=${pair}&interval=1h&limit=2`);
        if (Array.isArray(klines) && klines.length >= 1) {
            const c = klines[0]; // last complete 1h candle
            result.open = parseFloat(c[1]);
            result.high = parseFloat(c[2]);
            result.low = parseFloat(c[3]);
            result.close = parseFloat(c[4]);
            result.volume = parseFloat(c[5]);
            logger_1.logger.debug('Binance', `${symbol} 1h OHLCV: O=${result.open} H=${result.high} L=${result.low} C=${result.close} V=${result.volume}`);
        }
    }
    catch (err) {
        logger_1.logger.warn('Binance', `${symbol} 1h candle failed: ${err.message}`);
    }
    // Daily candle — limit=2, use index 0 (previous complete day)
    try {
        const dailyKlines = await binanceGet(`/api/v3/klines?symbol=${pair}&interval=1d&limit=2`);
        if (Array.isArray(dailyKlines) && dailyKlines.length >= 1) {
            const d = dailyKlines[0]; // previous complete day
            result.daily_high = parseFloat(d[2]);
            result.daily_low = parseFloat(d[3]);
            result.daily_close = parseFloat(d[4]);
            logger_1.logger.debug('Binance', `${symbol} prev-day H=${result.daily_high} L=${result.daily_low} C=${result.daily_close}`);
        }
    }
    catch (err) {
        logger_1.logger.warn('Binance', `${symbol} daily candle failed: ${err.message}`);
    }
    return result;
}
//# sourceMappingURL=binance.js.map