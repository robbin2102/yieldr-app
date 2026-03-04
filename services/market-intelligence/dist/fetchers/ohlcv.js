"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchAndStoreOhlcv = fetchAndStoreOhlcv;
exports.getLatestOhlcv = getLatestOhlcv;
/**
 * Fetches 15-minute OHLCV candles from TAAPI /bulk (binance spot exchange)
 * and upserts them into the ohlcv_15m collection.
 *
 * Called on the OHLCV cron schedule (:03, :18, :33, :48).
 * Separate from the hourly TAAPI indicator fetches — does NOT interfere
 * with BULK 1/2/pattern batches which run only on the hourly cycle.
 *
 * Also exports getLatestOhlcv() for use by the snapshot builder.
 */
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const db_1 = require("../db");
const Ohlcv15m_1 = __importDefault(require("../models/Ohlcv15m"));
const BULK_URL = `${config_1.config.taapi.baseUrl}/bulk`;
const COINS_PER_BULK = 3; // TAAPI Pro plan: 3 constructs per bulk request
const NULL_OHLCV = {
    open: null, high: null, low: null, close: null, volume: null,
    daily_high: null, daily_low: null, daily_close: null,
};
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function postBulkCandles(coins) {
    const constructs = coins.map(sym => ({
        exchange: 'binance', // spot exchange (not binancefutures) for OHLCV
        symbol: `${sym}/USDT`,
        interval: '15m',
        indicators: [{ indicator: 'candle', id: `candle_${sym}` }],
    }));
    const body = { secret: config_1.config.taapi.apiKey, construct: constructs };
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const res = await fetch(BULK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.status === 429) {
                const waitMs = 15000 * Math.pow(2, attempt); // 15s, 30s, 60s, 120s, 240s
                logger_1.logger.warn('OHLCV', `Rate limited (429), waiting ${waitMs / 1000}s before retry ${attempt + 1}/5`);
                await sleep(waitMs);
                continue;
            }
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`TAAPI ${res.status}: ${text.slice(0, 200)}`);
            }
            return parseCandleResponse(await res.json(), coins);
        }
        catch (err) {
            if (attempt === 4)
                throw err;
            logger_1.logger.warn('OHLCV', `Attempt ${attempt + 1} failed: ${err.message}, retrying...`);
            await sleep(2000 * (attempt + 1));
        }
    }
    return new Map();
}
function parseCandleResponse(data, symbols) {
    const result = new Map();
    if (!data?.data)
        return result;
    for (let ci = 0; ci < symbols.length && ci < data.data.length; ci++) {
        const sym = symbols[ci];
        const items = data.data[ci];
        if (!Array.isArray(items))
            continue;
        for (const item of items) {
            if (item.id === `candle_${sym}` && item.result) {
                const r = item.result;
                result.set(sym, {
                    // TAAPI returns timestamp in seconds; convert to ms
                    timestamp: r.timestamp ? new Date(r.timestamp * 1000) : new Date(),
                    open: parseFloat(r.open),
                    high: parseFloat(r.high),
                    low: parseFloat(r.low),
                    close: parseFloat(r.close),
                    volume: parseFloat(r.volume),
                });
            }
        }
    }
    return result;
}
/**
 * Fetch and store 15m OHLCV candles for all tracked coins.
 * Called by the cron scheduler at :03, :18, :33, :48.
 */
async function fetchAndStoreOhlcv(coins) {
    logger_1.logger.info('OHLCV', `Starting 15m OHLCV fetch for ${coins.length} coins`);
    const start = Date.now();
    let saved = 0;
    let failed = 0;
    for (let i = 0; i < coins.length; i += COINS_PER_BULK) {
        const batch = coins.slice(i, i + COINS_PER_BULK);
        try {
            const candles = await postBulkCandles(batch);
            for (const [sym, c] of candles) {
                try {
                    await Ohlcv15m_1.default.findOneAndUpdate({ symbol: sym.toUpperCase(), timestamp: c.timestamp }, {
                        $set: {
                            symbol: sym.toUpperCase(),
                            timestamp: c.timestamp,
                            open: c.open,
                            high: c.high,
                            low: c.low,
                            close: c.close,
                            volume: c.volume,
                            fetched_at: new Date(),
                        },
                    }, { upsert: true, new: true });
                    saved++;
                    logger_1.logger.debug('OHLCV', `${sym} upserted: C=${c.close} @ ${c.timestamp.toISOString()}`);
                }
                catch (err) {
                    logger_1.logger.warn('OHLCV', `${sym} upsert failed: ${err.message}`);
                    failed++;
                }
            }
            // Log any symbols in batch that returned no candle
            for (const sym of batch) {
                if (!candles.has(sym)) {
                    logger_1.logger.warn('OHLCV', `${sym} returned no candle data`);
                    failed++;
                }
            }
        }
        catch (err) {
            logger_1.logger.warn('OHLCV', `Batch [${batch.join(',')}] failed: ${err.message}`);
            failed += batch.length;
        }
        // Rate limit delay between bulk requests — same pattern as existing TAAPI fetchers
        if (i + COINS_PER_BULK < coins.length) {
            await sleep(config_1.config.taapi.rateDelayMs);
        }
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger_1.logger.info('OHLCV', `Cycle complete — ${saved} saved, ${failed} failed, ${elapsed}s`);
}
/**
 * Read the latest 15m candle for a symbol from ohlcv_15m.
 * Also queries the last 96 candles (24h) to derive daily high/low for pivot fallback.
 * Called by the snapshot builder during Phase 4.
 */
async function getLatestOhlcv(symbol) {
    try {
        const db = db_1.mongoose.connection.db;
        if (!db)
            return { ...NULL_OHLCV };
        // Last 96 candles = 24h of 15m data (96 × 15min = 1440min = 24h)
        const candles = await db.collection('ohlcv_15m')
            .find({ symbol: symbol.toUpperCase() })
            .sort({ timestamp: -1 })
            .limit(96)
            .toArray();
        if (candles.length === 0)
            return { ...NULL_OHLCV };
        const latest = candles[0];
        const daily_high = Math.max(...candles.map(c => c.high));
        const daily_low = Math.min(...candles.map(c => c.low));
        return {
            open: latest.open,
            high: latest.high,
            low: latest.low,
            close: latest.close,
            volume: latest.volume,
            daily_high,
            daily_low,
            daily_close: latest.close, // latest close serves as pivot-fallback "daily close"
        };
    }
    catch (err) {
        logger_1.logger.debug('OHLCV', `${symbol} ohlcv lookup failed: ${err.message}`);
        return { ...NULL_OHLCV };
    }
}
//# sourceMappingURL=ohlcv.js.map