"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRunning = void 0;
exports.runHourlyCycle = runHourlyCycle;
exports.startCronJobs = startCronJobs;
const node_cron_1 = __importDefault(require("node-cron"));
const logger_1 = require("../utils/logger");
const tracker_1 = require("../coins/tracker");
const taapi_1 = require("../fetchers/taapi");
const coinglass_1 = require("../fetchers/coinglass");
const snapshot_builder_1 = require("../processors/snapshot-builder");
const macro_builder_1 = require("../processors/macro-builder");
exports.isRunning = false;
/**
 * Main hourly cycle:
 * Phase 1 — CoinGlass aggregate (5 calls, ~10s)
 * Phase 2 — TAAPI indicators for all coins (~9 min)
 * Phase 3 — CoinGlass per-coin for top 20 (~7 min)
 * Phase 4 — Build and upsert snapshots (reads OHLCV from ohlcv_15m collection)
 */
async function runHourlyCycle() {
    if (exports.isRunning) {
        logger_1.logger.warn('Cron', 'Previous cycle still running — skipping');
        return;
    }
    exports.isRunning = true;
    const cycleStart = Date.now();
    const timestamp = roundToHour(new Date());
    logger_1.logger.info('Cron', `═══ HOURLY CYCLE START — ${timestamp.toISOString()} ═══`);
    try {
        const { all: allCoins, full: fullCoins } = await (0, tracker_1.loadTrackedCoins)();
        if (allCoins.length === 0) {
            logger_1.logger.warn('Cron', 'No tracked coins — skipping cycle');
            return;
        }
        logger_1.logger.info('Cron', `Coins: ${allCoins.length} total, ${fullCoins.length} full-tier`);
        // Phase 1: CoinGlass aggregate (all coins)
        logger_1.logger.info('Cron', '─── Phase 1: CoinGlass aggregate ───');
        const aggregateMap = await (0, coinglass_1.fetchAggregateData)(allCoins);
        // Phase 2: TAAPI indicators (all coins)
        logger_1.logger.info('Cron', '─── Phase 2: TAAPI indicators ───');
        const taapiMap = await (0, taapi_1.fetchAllCoins)(allCoins);
        // Phase 3: CoinGlass per-coin (top 20 only)
        logger_1.logger.info('Cron', '─── Phase 3: CoinGlass per-coin (top 20) ───');
        const perCoinMap = new Map();
        for (const coin of fullCoins) {
            const data = await (0, coinglass_1.fetchPerCoinData)(coin);
            perCoinMap.set(coin, data);
            logger_1.logger.debug('Cron', `Per-coin ${coin}: ${data.errors.length} errors`);
        }
        const premium = await (0, coinglass_1.fetchCoinbasePremium)();
        // Phase 4: Build and upsert snapshots
        // OHLCV price data is read from ohlcv_15m collection (written by ohlcv cron at :03/:18/:33/:48)
        logger_1.logger.info('Cron', '─── Phase 4: Building snapshots ───');
        let saved = 0;
        let failed = 0;
        for (const coin of allCoins) {
            const taapi = taapiMap.get(coin) ?? { indicators: {}, candlestick_patterns: [], errors: [] };
            const aggregate = aggregateMap.get(coin) ?? {
                symbol: coin, open_interest_usd: null, oi_change_24h_pct: null, price: null,
                volume_24h: null, funding_rate_current: null, liq_long_24h: null,
                liq_short_24h: null, taker_buy_vol: null, taker_sell_vol: null,
                taker_ratio: null, basis: null,
            };
            const perCoin = perCoinMap.get(coin);
            const tier = perCoin ? 'full' : 'lite';
            try {
                await (0, snapshot_builder_1.buildAndSaveSnapshot)({
                    symbol: coin, timestamp, tier, taapi, aggregate, perCoin,
                    coinbasePremium: premium,
                });
                saved++;
            }
            catch (err) {
                logger_1.logger.error('Cron', `Failed to save snapshot for ${coin}: ${err.message}`);
                failed++;
            }
        }
        const durationMs = Date.now() - cycleStart;
        const durationMin = (durationMs / 60000).toFixed(1);
        logger_1.logger.info('Cron', `═══ CYCLE COMPLETE ═══`);
        logger_1.logger.info('Cron', `  Duration: ${durationMin} min | Saved: ${saved} | Failed: ${failed}`);
        logger_1.logger.info('Cron', `  Coins: ${allCoins.length} total, ${fullCoins.length} full, ${allCoins.length - fullCoins.length} lite`);
        if (durationMs > 30 * 60 * 1000) {
            logger_1.logger.warn('Cron', `⚠ Cycle took ${durationMin} min — exceeds 30 min warning threshold`);
        }
    }
    catch (err) {
        logger_1.logger.error('Cron', `Cycle failed: ${err.message}`);
    }
    finally {
        exports.isRunning = false;
    }
}
/** Start all cron jobs */
function startCronJobs() {
    // Main hourly cycle — minute 0 of every hour
    node_cron_1.default.schedule('0 * * * *', async () => {
        await runHourlyCycle();
    });
    // OHLCV 15m cron — disabled for now; OHLCV fetch moved to on-demand agent tooling.
    // Re-enable by uncommenting when batch pre-fetch is needed again.
    // cron.schedule('3,18,33,48 * * * *', async () => {
    //   logger.info('Cron', 'Running 15m OHLCV cycle');
    //   try {
    //     const { all } = await loadTrackedCoins();
    //     if (all.length > 0) await fetchAndStoreOhlcv(all);
    //   } catch (err: any) {
    //     logger.error('Cron', `OHLCV cycle failed: ${err.message}`);
    //   }
    // });
    // Daily macro — 10:00 UTC every day
    node_cron_1.default.schedule('0 10 * * *', async () => {
        logger_1.logger.info('Cron', 'Running daily macro fetch');
        await (0, macro_builder_1.buildAndSaveMacroDaily)();
    });
    // Weekly coin refresh — Sunday 00:00 UTC
    node_cron_1.default.schedule('0 0 * * 0', async () => {
        logger_1.logger.info('Cron', 'Running weekly coin list refresh');
        await (0, tracker_1.refreshTrackedCoins)();
    });
    logger_1.logger.info('Cron', 'Cron jobs started: hourly (0 * * * *), daily macro (0 10 * * *), weekly refresh (0 0 * * 0)');
}
function roundToHour(date) {
    const d = new Date(date);
    d.setUTCMinutes(0, 0, 0);
    return d;
}
//# sourceMappingURL=cron.js.map