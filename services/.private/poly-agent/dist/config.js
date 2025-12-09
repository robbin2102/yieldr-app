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
    // Target trader wallet
    targetWallet: process.env.TARGET_WALLET?.trim(),
    // Bot wallet (our wallet)
    botWalletAddress: process.env.BOT_WALLET_ADDRESS?.trim(),
    botPrivateKey: process.env.BOT_PRIVATE_KEY?.trim(),
    // Polymarket API credentials
    apiKey: process.env.POLYMARKET_API_KEY?.trim(),
    apiSecret: process.env.POLYMARKET_API_SECRET?.trim(),
    passphrase: process.env.POLYMARKET_PASSPHRASE?.trim(),
    // MongoDB connection
    mongoUri: process.env.MONGODB_URI,
    // Agent parameters
    copyRatio: parseFloat(process.env.COPY_RATIO || '0.05'),
    maxPositionUsdc: parseFloat(process.env.MAX_POSITION_USDC || '50'),
    minTradeSize: parseFloat(process.env.MIN_TRADE_SIZE || '1'),
    // Polling intervals
    detectorIntervalMs: parseInt(process.env.DETECTOR_INTERVAL_MS || '3000'),
    reconcilerIntervalMs: parseInt(process.env.RECONCILER_INTERVAL_MS || '60000'),
    // Polymarket endpoints
    dataApiBase: process.env.DATA_API_BASE || 'https://data-api.polymarket.com',
    clobApiBase: process.env.CLOB_API_BASE || 'https://clob.polymarket.com',
    wssMarket: process.env.WSS_MARKET || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    wssUser: process.env.WSS_USER || 'wss://ws-subscriptions-clob.polymarket.com/ws/user',
    chainId: parseInt(process.env.CHAIN_ID || '137'),
};
// Validate required environment variables
const required = [
    'targetWallet',
    'botWalletAddress',
    'botPrivateKey',
    'apiKey',
    'apiSecret',
    'passphrase',
    'mongoUri'
];
for (const key of required) {
    if (!exports.config[key]) {
        throw new Error(`Missing required config: ${key}. Please check your .env.polyagent file.`);
    }
}
// Validate wallet addresses format (basic check)
if (exports.config.targetWallet && !exports.config.targetWallet.startsWith('0x')) {
    throw new Error('TARGET_WALLET must be a valid Ethereum address starting with 0x');
}
if (exports.config.botWalletAddress && !exports.config.botWalletAddress.startsWith('0x')) {
    throw new Error('BOT_WALLET_ADDRESS must be a valid Ethereum address starting with 0x');
}
if (exports.config.botPrivateKey && !exports.config.botPrivateKey.startsWith('0x')) {
    throw new Error('BOT_PRIVATE_KEY must start with 0x');
}
//# sourceMappingURL=config.js.map