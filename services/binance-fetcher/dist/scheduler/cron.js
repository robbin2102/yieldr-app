"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runFundingRateCycle = runFundingRateCycle;
exports.runDerivativesCycle = runDerivativesCycle;
exports.runBackfill = runBackfill;
exports.startCronJobs = startCronJobs;
const node_cron_1 = __importDefault(require("node-cron"));
const logger_1 = require("../utils/logger");
const config_1 = require("../config");
const db_1 = require("../db");
const FundingRate1h_1 = __importDefault(require("../models/FundingRate1h"));
const Derivatives15m_1 = __importDefault(require("../models/Derivatives15m"));
const binance_1 = require("../fetchers/binance");
// ─── Coin list ────────────────────────────────────────────────────────────────
const FALLBACK_COINS = [
    'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT',
    'UNI', 'LTC', 'BCH', 'ATOM', 'FIL', 'APT', 'ARB', 'OP', 'INJ', 'SUI',
    'TRX', 'NEAR', 'ICP', 'HBAR', 'PEPE', 'SHIB', 'WIF', 'BONK', 'TIA', 'SEI',
    'WLD', 'ORDI', 'JUP', 'ENA', 'FTM', 'RUNE', 'CRV', 'AAVE', 'LDO', 'MKR',
    'SNX', 'COMP', 'GRT', 'DYDX', 'IMX', 'APE', 'SAND', 'MANA', 'AXS', 'ENJ',
    'GMT', 'RNDR', 'FET', 'OCEAN', 'FLOW', 'QNT', 'VET', 'ALGO', 'EOS', 'ZEC',
    'DASH', 'WAVES', 'KSM', 'ONE', 'ZIL', 'IOTA', 'THETA', 'CHZ', 'BAT', 'STORJ',
    'BAND', 'ROSE', 'JASMY', 'MINA', 'ANKR', 'CELR', 'KAVA', 'TRB', 'YFI', 'SUSHI',
    'GMX', 'PENDLE', 'RPL', 'STX', 'EGLD', 'BLUR', 'CYBER', 'CFX', 'ZK', 'MANTA',
    'JTO', 'PYTH', 'W', 'STRK', 'ALT', 'DYM', 'HOOK', 'SXP', 'ACE', 'AGIX',
];
async function loadCoins() {
    try {
        const db = db_1.mongoose.connection.db;
        if (!db)
            return FALLBACK_COINS;
        const stored = await db.collection('tracked_coins').findOne({}, { sort: { updated_at: -1 } });
        if (stored?.all?.length > 0) {
            logger_1.logger.info('Coins', `Loaded ${stored.all.length} coins from tracked_coins collection`);
            return stored.all;
        }
    }
    catch (err) {
        logger_1.logger.warn('Coins', `Could not load tracked coins from DB: ${err.message}`);
    }
    logger_1.logger.info('Coins', `Using fallback list of ${FALLBACK_COINS.length} coins`);
    return FALLBACK_COINS;
}
// ─── Funding Rate Cycle (1h) ──────────────────────────────────────────────────
let fundingRunning = false;
async function runFundingRateCycle(coins) {
    if (fundingRunning) {
        logger_1.logger.warn('Funding', 'Previous funding cycle still running — skipping');
        return;
    }
    fundingRunning = true;
    const start = Date.now();
    const allCoins = coins ?? await loadCoins();
    logger_1.logger.info('Funding', `Starting funding rate cycle for ${allCoins.length} coins`);
    let saved = 0;
    let skipped = 0;
    for (const symbol of allCoins) {
        const pair = (0, binance_1.toPair)(symbol);
        try {
            // Find last stored timestamp to do incremental fetch
            const latest = await FundingRate1h_1.default.findOne({ symbol }, null, { sort: { timestamp: -1 } });
            const startTime = latest ? latest.timestamp.getTime() + 1 : undefined;
            // If no data, fetch limit=200 (covers ~8 days at 1h intervals)
            const limit = startTime ? 10 : 200;
            const records = await (0, binance_1.fetchFundingRateKlines)(pair, startTime, limit);
            if (records.length === 0) {
                skipped++;
                await (0, binance_1.sleep)(config_1.config.binance.requestDelayMs);
                continue;
            }
            const ops = records.map(r => ({
                updateOne: {
                    filter: { symbol, timestamp: r.timestamp },
                    update: { $set: { symbol, pair, ...r } },
                    upsert: true,
                },
            }));
            await FundingRate1h_1.default.bulkWrite(ops, { ordered: false });
            saved += records.length;
        }
        catch (err) {
            logger_1.logger.warn('Funding', `${symbol} failed: ${err.message}`);
        }
        await (0, binance_1.sleep)(config_1.config.binance.requestDelayMs);
    }
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    logger_1.logger.info('Funding', `Cycle complete — ${saved} records saved, ${skipped} coins skipped, ${dur}s`);
    fundingRunning = false;
}
// ─── Derivatives Cycle (15m) ──────────────────────────────────────────────────
let derivativesRunning = false;
async function runDerivativesCycle(coins) {
    if (derivativesRunning) {
        logger_1.logger.warn('Deriv', 'Previous derivatives cycle still running — skipping');
        return;
    }
    derivativesRunning = true;
    const start = Date.now();
    const allCoins = coins ?? await loadCoins();
    logger_1.logger.info('Deriv', `Starting derivatives cycle for ${allCoins.length} coins`);
    let saved = 0;
    let skipped = 0;
    for (const symbol of allCoins) {
        const pair = (0, binance_1.toPair)(symbol);
        try {
            // Find last stored timestamp
            const latest = await Derivatives15m_1.default.findOne({ symbol }, null, { sort: { timestamp: -1 } });
            const startTime = latest ? latest.timestamp.getTime() + 1 : undefined;
            // If no data, fetch limit=500 (covers ~5 days at 15m intervals)
            const limit = startTime ? 10 : 500;
            // Fetch all 4 endpoints in parallel
            const [oiRecords, globalLS, topAccountLS, topPositionLS] = await Promise.all([
                (0, binance_1.fetchOIHistory)(pair, startTime, limit),
                (0, binance_1.fetchGlobalLSRatio)(pair, startTime, limit),
                (0, binance_1.fetchTopAccountLSRatio)(pair, startTime, limit),
                (0, binance_1.fetchTopPositionLSRatio)(pair, startTime, limit),
            ]);
            if (oiRecords.length === 0) {
                skipped++;
                await (0, binance_1.sleep)(config_1.config.binance.requestDelayMs);
                continue;
            }
            // Merge by timestamp — OI is the master set
            const globalMap = new Map(globalLS.map(r => [r.timestamp.getTime(), r]));
            const accountMap = new Map(topAccountLS.map(r => [r.timestamp.getTime(), r]));
            const positionMap = new Map(topPositionLS.map(r => [r.timestamp.getTime(), r]));
            const ops = oiRecords.map(oi => {
                const ts = oi.timestamp.getTime();
                const glob = globalMap.get(ts);
                const acct = accountMap.get(ts);
                const pos = positionMap.get(ts);
                return {
                    updateOne: {
                        filter: { symbol, timestamp: oi.timestamp },
                        update: {
                            $set: {
                                symbol,
                                pair,
                                timestamp: oi.timestamp,
                                open_interest_usdt: oi.open_interest_usdt,
                                long_short_global: glob ? { long_pct: glob.long_pct, short_pct: glob.short_pct, ratio: glob.ratio } : null,
                                long_short_top_accounts: acct ? { long_pct: acct.long_pct, short_pct: acct.short_pct, ratio: acct.ratio } : null,
                                long_short_top_positions: pos ? { long_pct: pos.long_pct, short_pct: pos.short_pct, ratio: pos.ratio } : null,
                            },
                        },
                        upsert: true,
                    },
                };
            });
            await Derivatives15m_1.default.bulkWrite(ops, { ordered: false });
            saved += ops.length;
        }
        catch (err) {
            logger_1.logger.warn('Deriv', `${symbol} failed: ${err.message}`);
        }
        await (0, binance_1.sleep)(config_1.config.binance.requestDelayMs);
    }
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    logger_1.logger.info('Deriv', `Cycle complete — ${saved} records saved, ${skipped} coins skipped, ${dur}s`);
    derivativesRunning = false;
}
// ─── Backfill ─────────────────────────────────────────────────────────────────
// Runs once on startup if collections are empty.
async function runBackfill() {
    logger_1.logger.info('Backfill', `Backfilling ${config_1.config.backfillDays} days of Binance data`);
    const coins = await loadCoins();
    const backfillMs = config_1.config.backfillDays * 24 * 60 * 60 * 1000;
    const startTime = Date.now() - backfillMs;
    let fundingSaved = 0;
    let derivSaved = 0;
    for (const symbol of coins) {
        const pair = (0, binance_1.toPair)(symbol);
        try {
            // Funding: 1h candles. backfillDays * 24 records. Fetch in 1 call (limit 1500 max).
            const fundingLimit = config_1.config.backfillDays * 24 + 5;
            const fundingRecords = await (0, binance_1.fetchFundingRateKlines)(pair, startTime, fundingLimit);
            if (fundingRecords.length > 0) {
                const ops = fundingRecords.map(r => ({
                    updateOne: {
                        filter: { symbol, timestamp: r.timestamp },
                        update: { $set: { symbol, pair, ...r } },
                        upsert: true,
                    },
                }));
                await FundingRate1h_1.default.bulkWrite(ops, { ordered: false });
                fundingSaved += ops.length;
            }
            await (0, binance_1.sleep)(config_1.config.binance.requestDelayMs);
            // Derivatives: 15m candles. backfillDays * 96 records per endpoint.
            // Need multiple calls if backfillDays > 5 (500 limit per call).
            let derivCursor = startTime;
            let iterCount = 0;
            const maxIter = Math.ceil((config_1.config.backfillDays * 96) / 500) + 1;
            while (iterCount < maxIter) {
                const [oiRecords, globalLS, topAccountLS, topPositionLS] = await Promise.all([
                    (0, binance_1.fetchOIHistory)(pair, derivCursor, 500),
                    (0, binance_1.fetchGlobalLSRatio)(pair, derivCursor, 500),
                    (0, binance_1.fetchTopAccountLSRatio)(pair, derivCursor, 500),
                    (0, binance_1.fetchTopPositionLSRatio)(pair, derivCursor, 500),
                ]);
                if (oiRecords.length === 0)
                    break;
                const globalMap = new Map(globalLS.map(r => [r.timestamp.getTime(), r]));
                const accountMap = new Map(topAccountLS.map(r => [r.timestamp.getTime(), r]));
                const positionMap = new Map(topPositionLS.map(r => [r.timestamp.getTime(), r]));
                const ops = oiRecords.map(oi => {
                    const ts = oi.timestamp.getTime();
                    const glob = globalMap.get(ts);
                    const acct = accountMap.get(ts);
                    const pos = positionMap.get(ts);
                    return {
                        updateOne: {
                            filter: { symbol, timestamp: oi.timestamp },
                            update: {
                                $set: {
                                    symbol, pair,
                                    timestamp: oi.timestamp,
                                    open_interest_usdt: oi.open_interest_usdt,
                                    long_short_global: glob ? { long_pct: glob.long_pct, short_pct: glob.short_pct, ratio: glob.ratio } : null,
                                    long_short_top_accounts: acct ? { long_pct: acct.long_pct, short_pct: acct.short_pct, ratio: acct.ratio } : null,
                                    long_short_top_positions: pos ? { long_pct: pos.long_pct, short_pct: pos.short_pct, ratio: pos.ratio } : null,
                                },
                            },
                            upsert: true,
                        },
                    };
                });
                await Derivatives15m_1.default.bulkWrite(ops, { ordered: false });
                derivSaved += ops.length;
                if (oiRecords.length < 500)
                    break;
                derivCursor = oiRecords[oiRecords.length - 1].timestamp.getTime() + 1;
                iterCount++;
                await (0, binance_1.sleep)(config_1.config.binance.requestDelayMs * 2);
            }
        }
        catch (err) {
            logger_1.logger.warn('Backfill', `${symbol} failed: ${err.message}`);
        }
        await (0, binance_1.sleep)(config_1.config.binance.requestDelayMs);
    }
    logger_1.logger.info('Backfill', `Complete — ${fundingSaved} funding records, ${derivSaved} derivatives records`);
}
// ─── Cron jobs ────────────────────────────────────────────────────────────────
function startCronJobs() {
    // Hourly funding rate fetch — at minute 5 of every hour (5 mins after market-intelligence cycle starts)
    node_cron_1.default.schedule('5 * * * *', async () => {
        logger_1.logger.info('Cron', 'Running hourly funding rate cycle');
        await runFundingRateCycle();
    });
    // Every 15m derivatives fetch
    node_cron_1.default.schedule('*/15 * * * *', async () => {
        logger_1.logger.info('Cron', 'Running 15m derivatives cycle');
        await runDerivativesCycle();
    });
    logger_1.logger.info('Cron', 'Cron jobs started: funding (5 * * * *), derivatives (*/15 * * * *)');
}
