"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = require("dotenv");
const path_1 = require("path");
const fs_1 = require("fs");
// Load environment variables - try multiple locations (priority order)
const envPolyagentPath = (0, path_1.resolve)(__dirname, '../.env.polyagent'); // poly-agent/.env.polyagent (PREFERRED)
const envPolyAgentPath = (0, path_1.resolve)(__dirname, '../.env.poly-agent'); // poly-agent/.env.poly-agent (alternative)
const envLocalPath = (0, path_1.resolve)(__dirname, '../.env.local'); // poly-agent/.env.local (fallback)
const envPath = (0, path_1.resolve)(__dirname, '../.env'); // poly-agent/.env (fallback)
const rootEnvLocalPath = (0, path_1.resolve)(__dirname, '../../../.env.local'); // project root .env.local (fallback)
if ((0, fs_1.existsSync)(envPolyagentPath)) {
    console.log('[Config] ✅ Loading from poly-agent/.env.polyagent (isolated secrets)');
    (0, dotenv_1.config)({ path: envPolyagentPath });
}
else if ((0, fs_1.existsSync)(envPolyAgentPath)) {
    console.log('[Config] ✅ Loading from poly-agent/.env.poly-agent (isolated secrets)');
    (0, dotenv_1.config)({ path: envPolyAgentPath });
}
else if ((0, fs_1.existsSync)(envLocalPath)) {
    console.log('[Config] Loading from poly-agent/.env.local');
    (0, dotenv_1.config)({ path: envLocalPath });
}
else if ((0, fs_1.existsSync)(envPath)) {
    console.log('[Config] Loading from poly-agent/.env');
    (0, dotenv_1.config)({ path: envPath });
}
else if ((0, fs_1.existsSync)(rootEnvLocalPath)) {
    console.log('[Config] ⚠️  Loading from project root .env.local (consider using .env.polyagent for better isolation)');
    (0, dotenv_1.config)({ path: rootEnvLocalPath });
}
else {
    throw new Error('No environment file found! Please create services/.private/poly-agent/.env.polyagent from .env.example');
}
exports.config = {
    // ── Bot identity (never move to DB) ────────────────────────────────────────
    botWalletAddress: process.env.BOT_WALLET_ADDRESS?.trim(),
    botPrivateKey: process.env.BOT_PRIVATE_KEY?.trim(),
    // ── Polymarket API credentials ─────────────────────────────────────────────
    apiKey: process.env.POLYMARKET_API_KEY?.trim(),
    apiSecret: process.env.POLYMARKET_API_SECRET?.trim(),
    passphrase: process.env.POLYMARKET_PASSPHRASE?.trim(),
    // ── Infrastructure ─────────────────────────────────────────────────────────
    mongoUri: process.env.MONGODB_URI,
    polygonRpcUrl: process.env.POLYGON_RPC_URL,
    chainId: parseInt(process.env.CHAIN_ID || '137'),
    // ── Polymarket endpoints (defaults work for mainnet) ───────────────────────
    dataApiBase: process.env.DATA_API_BASE || 'https://data-api.polymarket.com',
    clobApiBase: process.env.CLOB_API_BASE || 'https://clob.polymarket.com',
    wssMarket: process.env.WSS_MARKET || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    wssUser: process.env.WSS_USER || 'wss://ws-subscriptions-clob.polymarket.com/ws/user',
    // ── Detector ──────────────────────────────────────────────────────────────
    // Default poll interval. Individual traders can override via detectorIntervalMs
    // in their ahf-copyTraders document (e.g. 300 for BTC 5m markets).
    detectorIntervalMs: parseInt(process.env.DETECTOR_INTERVAL_MS || '60000'), // 1m default
    // ── GTT order execution ────────────────────────────────────────────────────
    maxOrderRetries: parseInt(process.env.MAX_ORDER_RETRIES || '3'),
    orderRetryDelayMs: parseInt(process.env.ORDER_RETRY_DELAY_MS || '500'),
    gttExpirySeconds: parseInt(process.env.GTT_EXPIRY_SECONDS || '8'),
    // Polymarket taker fee in basis points. Standard markets use 1000 (10bps).
    // Override via FEE_RATE_BPS if needed.
    feeRateBps: parseInt(process.env.FEE_RATE_BPS || '1000'),
    // ── Global safety cap per single copy order ────────────────────────────────
    // Per-trader maxBetUsdc in DB overrides this for bet sizing.
    // This is the hard ceiling regardless of any per-trader setting.
    maxPositionUsdc: parseFloat(process.env.MAX_POSITION_USDC || '20'),
    // ── Execution reporting interval ──────────────────────────────────────────
    reportIntervalMs: parseInt(process.env.REPORT_INTERVAL_MS || '3600000'), // 1h
    // ── Stale activity filter ──────────────────────────────────────────────────
    // Activities older than this are silently skipped (prevent backlog replay).
    // 5 minutes covers typical poll gaps; increase if needed for slow markets.
    maxLagMs: parseInt(process.env.MAX_LAG_MS || '300000'), // 5m default
};
// Validate required environment variables
const required = [
    'botWalletAddress',
    'botPrivateKey',
    'apiKey',
    'apiSecret',
    'passphrase',
    'mongoUri',
    'polygonRpcUrl',
];
for (const key of required) {
    if (!exports.config[key]) {
        throw new Error(`Missing required config: ${key}. Please check your .env.polyagent file.`);
    }
}
if (!exports.config.botWalletAddress.startsWith('0x')) {
    throw new Error('BOT_WALLET_ADDRESS must be a valid Ethereum address starting with 0x');
}
if (!exports.config.botPrivateKey.startsWith('0x')) {
    throw new Error('BOT_PRIVATE_KEY must start with 0x');
}
//# sourceMappingURL=config.js.map