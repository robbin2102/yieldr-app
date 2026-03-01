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
/**
 * npm run fetch-coin BTC ETH SOL
 * Fetches and saves data for one or more coins, processed one by one.
 */
const dotenv = __importStar(require("dotenv"));
dotenv.config({ path: '../../.env.local' });
const db_1 = require("../db");
const taapi_1 = require("../fetchers/taapi");
const coinglass_1 = require("../fetchers/coinglass");
const binance_1 = require("../fetchers/binance");
const snapshot_builder_1 = require("../processors/snapshot-builder");
const logger_1 = require("../utils/logger");
async function main() {
    const symbols = process.argv.slice(2).map(s => s.toUpperCase());
    if (symbols.length === 0)
        symbols.push('BTC');
    logger_1.logger.info('Script', `Fetching data for ${symbols.length} coin(s): ${symbols.join(', ')}`);
    await (0, db_1.connectDB)();
    const timestamp = new Date();
    timestamp.setUTCMinutes(0, 0, 0);
    // Bulk fetches (support multiple symbols in one call)
    logger_1.logger.info('Script', 'Fetching TAAPI indicators (bulk)...');
    const taapiMap = await (0, taapi_1.fetchAllCoins)(symbols);
    logger_1.logger.info('Script', 'Fetching CoinGlass aggregate (bulk)...');
    const aggregateMap = await (0, coinglass_1.fetchAggregateData)(symbols);
    logger_1.logger.info('Script', 'Fetching Coinbase premium (shared)...');
    const premium = await (0, coinglass_1.fetchCoinbasePremium)();
    // Per-coin processing — one by one
    const results = [];
    for (const symbol of symbols) {
        logger_1.logger.info('Script', `--- Processing ${symbol} ---`);
        try {
            logger_1.logger.info('Script', `[${symbol}] Fetching CoinGlass per-coin...`);
            const perCoin = await (0, coinglass_1.fetchPerCoinData)(symbol);
            logger_1.logger.info('Script', `[${symbol}] Fetching Binance OHLCV...`);
            const binance = await (0, binance_1.fetchBinanceCandle)(symbol);
            const taapi = taapiMap.get(symbol) ?? { indicators: {}, candlestick_patterns: [], errors: [] };
            const aggregate = aggregateMap.get(symbol);
            logger_1.logger.info('Script', `[${symbol}] Building snapshot...`);
            await (0, snapshot_builder_1.buildAndSaveSnapshot)({ symbol, timestamp, tier: 'full', taapi, aggregate, perCoin, coinbasePremium: premium, binance });
            logger_1.logger.info('Script', `[${symbol}] ✓ Saved`);
            logger_1.logger.info('Script', `  Indicators: ${Object.keys(taapi.indicators).length}`);
            logger_1.logger.info('Script', `  Patterns:   ${taapi.candlestick_patterns.length}`);
            logger_1.logger.info('Script', `  Errors:     ${taapi.errors.length}`);
            logger_1.logger.info('Script', `  OHLCV: O=${binance.open} H=${binance.high} L=${binance.low} C=${binance.close} V=${binance.volume}`);
            logger_1.logger.info('Script', `  Pivot PP:   ${binance.daily_close != null ? '✓ computed from Binance' : '✗ missing daily candle'}`);
            if (taapi.errors.length > 0) {
                logger_1.logger.warn('Script', `  Error details: ${taapi.errors.join(', ')}`);
            }
            results.push({ symbol, ok: true });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger_1.logger.error('Script', `[${symbol}] ✗ Failed: ${message}`);
            results.push({ symbol, ok: false, error: message });
        }
    }
    // Summary
    logger_1.logger.info('Script', '--- Summary ---');
    for (const r of results) {
        if (r.ok) {
            logger_1.logger.info('Script', `  ✓ ${r.symbol}`);
        }
        else {
            logger_1.logger.warn('Script', `  ✗ ${r.symbol}: ${r.error}`);
        }
    }
    const failed = results.filter(r => !r.ok).length;
    logger_1.logger.info('Script', `${results.length - failed}/${results.length} coin(s) succeeded`);
    await (0, db_1.disconnectDB)();
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(err => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=fetch-coin.js.map