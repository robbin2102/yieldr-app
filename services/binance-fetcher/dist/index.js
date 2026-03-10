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
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const express_1 = __importDefault(require("express"));
const db_1 = require("./db");
const logger_1 = require("./utils/logger");
const config_1 = require("./config");
const cron_1 = require("./scheduler/cron");
const FundingRate1h_1 = __importDefault(require("./models/FundingRate1h"));
const Derivatives15m_1 = __importDefault(require("./models/Derivatives15m"));
async function main() {
    console.log('');
    console.log('████████████████████████████████████████████████');
    console.log('█       YIELDR BINANCE FETCHER SERVICE          █');
    console.log('█   Funding Rates (1h) · OI · L/S Ratios (15m) █');
    console.log('████████████████████████████████████████████████');
    console.log('');
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    let dbConnected = false;
    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            service: 'binance-fetcher',
            db: dbConnected ? 'connected' : 'connecting',
            uptime: process.uptime(),
        });
    });
    app.get('/status', async (_req, res) => {
        try {
            const [latestFunding, latestDeriv] = await Promise.all([
                FundingRate1h_1.default.findOne().sort({ timestamp: -1 }).select('symbol timestamp'),
                Derivatives15m_1.default.findOne().sort({ timestamp: -1 }).select('symbol timestamp'),
            ]);
            res.json({
                status: 'running',
                latestFunding: latestFunding ? { symbol: latestFunding.symbol, timestamp: latestFunding.timestamp } : null,
                latestDerivatives: latestDeriv ? { symbol: latestDeriv.symbol, timestamp: latestDeriv.timestamp } : null,
            });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // Start HTTP server immediately so Railway healthcheck passes
    app.listen(config_1.config.port, () => {
        logger_1.logger.info('Server', `Health server listening on port ${config_1.config.port}`);
    });
    // Connect MongoDB
    await (0, db_1.connectDB)();
    dbConnected = true;
    // Check if backfill is needed (empty collections)
    const [fundingCount, derivCount] = await Promise.all([
        FundingRate1h_1.default.estimatedDocumentCount(),
        Derivatives15m_1.default.estimatedDocumentCount(),
    ]);
    if (fundingCount === 0 || derivCount === 0) {
        logger_1.logger.info('Startup', `Collections empty (funding=${fundingCount}, deriv=${derivCount}) — running backfill`);
        await (0, cron_1.runBackfill)();
    }
    else {
        logger_1.logger.info('Startup', `Collections have data — running incremental fetch`);
        await Promise.all([
            (0, cron_1.runFundingRateCycle)(),
            (0, cron_1.runDerivativesCycle)(),
        ]);
    }
    (0, cron_1.startCronJobs)();
    logger_1.logger.info('Startup', 'All cron jobs scheduled. Service is running.');
}
process.on('SIGTERM', async () => {
    logger_1.logger.info('Shutdown', 'SIGTERM received');
    await (0, db_1.disconnectDB)();
    process.exit(0);
});
process.on('SIGINT', async () => {
    logger_1.logger.info('Shutdown', 'SIGINT received');
    await (0, db_1.disconnectDB)();
    process.exit(0);
});
process.on('uncaughtException', (err) => {
    logger_1.logger.error('Process', `Uncaught exception: ${err.message}`);
    logger_1.logger.error('Process', err.stack ?? '');
});
process.on('unhandledRejection', (reason) => {
    logger_1.logger.error('Process', `Unhandled rejection: ${reason}`);
});
main().catch(err => {
    logger_1.logger.error('Startup', `Fatal: ${err.message}`);
    process.exit(1);
});
