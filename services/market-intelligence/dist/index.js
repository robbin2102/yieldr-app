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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Yieldr Market Intelligence Service
 *
 * Ingests TAAPI + CoinGlass data every hour and stores snapshots in MongoDB.
 * Runs as a standalone Railway service.
 *
 * Environment Variables:
 *   MONGODB_URI             — MongoDB connection string
 *   TAAPI_API_KEY           — TAAPI.io Pro API key
 *   COINGLASS_API_KEY       — CoinGlass Hobby API key
 *   TAAPI_RATE_DELAY_MS     — Delay between TAAPI requests (default: 600)
 *   COINGLASS_RATE_DELAY_MS — Delay between CoinGlass requests (default: 2200)
 *   PORT                    — HTTP health check port (default: 3000)
 */
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const express_1 = __importDefault(require("express"));
const db_1 = require("./db");
const logger_1 = require("./utils/logger");
const cron_1 = require("./scheduler/cron");
const tracker_1 = require("./coins/tracker");
const macro_builder_1 = require("./processors/macro-builder");
const config_1 = require("./config");
const MarketSnapshot_1 = __importDefault(require("./models/MarketSnapshot"));
let lastCycleAt = null;
let lastCycleErrors = 0;
let totalCycles = 0;
async function main() {
    console.log('');
    console.log('██████████████████████████████████████████████████████████████████');
    console.log('█                                                                ██');
    console.log('█            YIELDR MARKET INTELLIGENCE SERVICE                  ██');
    console.log('█                                                                ██');
    console.log('██████████████████████████████████████████████████████████████████');
    console.log('');
    // Start HTTP server FIRST so Railway healthcheck passes immediately
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.get('/health', async (_req, res) => {
        res.json({
            status: 'ok',
            service: 'market-intelligence',
            uptime: process.uptime(),
            lastCycleAt: lastCycleAt?.toISOString() ?? null,
            isCycleRunning: cron_1.isRunning,
            totalCycles,
        });
    });
    app.get('/status', async (_req, res) => {
        try {
            const latestSnapshots = await MarketSnapshot_1.default
                .find()
                .sort({ timestamp: -1 })
                .limit(5)
                .select('symbol timestamp tier fetch_duration_ms');
            res.json({
                status: 'running',
                isCycleRunning: cron_1.isRunning,
                totalCycles,
                lastCycleAt: lastCycleAt?.toISOString() ?? null,
                lastCycleErrors,
                latestSnapshots,
            });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    app.listen(config_1.config.port, () => {
        logger_1.logger.info('Server', `Health server listening on port ${config_1.config.port}`);
    });
    // Connect to MongoDB (after server is up so healthcheck doesn't time out)
    await (0, db_1.connectDB)();
    // Load (or refresh) tracked coins on startup
    logger_1.logger.info('Startup', 'Loading tracked coins...');
    const { all } = await (0, tracker_1.loadTrackedCoins)();
    logger_1.logger.info('Startup', `Tracking ${all.length} coins. Top 5: ${all.slice(0, 5).join(', ')}`);
    // Run the first cycle immediately on startup
    logger_1.logger.info('Startup', 'Running initial hourly cycle...');
    await (0, cron_1.runHourlyCycle)();
    lastCycleAt = new Date();
    totalCycles++;
    // Also run daily macro on startup
    logger_1.logger.info('Startup', 'Running initial macro daily fetch...');
    await (0, macro_builder_1.buildAndSaveMacroDaily)();
    // Start all cron jobs
    (0, cron_1.startCronJobs)();
    logger_1.logger.info('Startup', 'All cron jobs scheduled. Service is running.');
}
async function shutdown(signal) {
    logger_1.logger.info('Shutdown', `Received ${signal}, shutting down gracefully...`);
    await (0, db_1.disconnectDB)();
    logger_1.logger.info('Shutdown', 'Goodbye!');
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    logger_1.logger.error('Process', `Uncaught exception: ${err.message}`);
    logger_1.logger.error('Process', err.stack ?? '');
});
process.on('unhandledRejection', (reason) => {
    logger_1.logger.error('Process', `Unhandled rejection: ${reason}`);
});
main().catch((err) => {
    logger_1.logger.error('Startup', `Fatal startup error: ${err.message}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map