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
 * npm run fetch-coin BTC
 * Fetches and saves data for a single coin.
 */
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const db_1 = require("../db");
const taapi_1 = require("../fetchers/taapi");
const coinglass_1 = require("../fetchers/coinglass");
const snapshot_builder_1 = require("../processors/snapshot-builder");
const logger_1 = require("../utils/logger");
async function main() {
    const symbol = (process.argv[2] || 'BTC').toUpperCase();
    logger_1.logger.info('Script', `Fetching data for single coin: ${symbol}`);
    await (0, db_1.connectDB)();
    const timestamp = new Date();
    timestamp.setUTCMinutes(0, 0, 0);
    logger_1.logger.info('Script', 'Fetching TAAPI indicators...');
    const taapiMap = await (0, taapi_1.fetchAllCoins)([symbol]);
    logger_1.logger.info('Script', 'Fetching CoinGlass aggregate...');
    const aggregateMap = await (0, coinglass_1.fetchAggregateData)([symbol]);
    logger_1.logger.info('Script', 'Fetching CoinGlass per-coin...');
    const perCoin = await (0, coinglass_1.fetchPerCoinData)(symbol);
    logger_1.logger.info('Script', 'Fetching Coinbase premium...');
    const premium = await (0, coinglass_1.fetchCoinbasePremium)();
    const taapi = taapiMap.get(symbol) ?? { indicators: {}, candlestick_patterns: [], errors: [] };
    const aggregate = aggregateMap.get(symbol);
    logger_1.logger.info('Script', 'Building snapshot...');
    await (0, snapshot_builder_1.buildAndSaveSnapshot)({ symbol, timestamp, tier: 'full', taapi, aggregate, perCoin, coinbasePremium: premium });
    logger_1.logger.info('Script', `✓ Snapshot for ${symbol} saved successfully`);
    logger_1.logger.info('Script', `  Indicators: ${Object.keys(taapi.indicators).length}`);
    logger_1.logger.info('Script', `  Patterns: ${taapi.candlestick_patterns.length}`);
    logger_1.logger.info('Script', `  Errors: ${taapi.errors.length}`);
    if (taapi.errors.length > 0) {
        logger_1.logger.warn('Script', `  Error details: ${taapi.errors.join(', ')}`);
    }
    await (0, db_1.disconnectDB)();
    process.exit(0);
}
main().catch(err => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=fetch-coin.js.map