import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Load environment variables - try multiple locations (priority order)
const envPolyagentPath = resolve(__dirname, '../.env.polyagent');    // poly-agent/.env.polyagent (PREFERRED)
const envPolyAgentPath = resolve(__dirname, '../.env.poly-agent');   // poly-agent/.env.poly-agent (alternative)
const envLocalPath = resolve(__dirname, '../.env.local');            // poly-agent/.env.local (fallback)
const envPath = resolve(__dirname, '../.env');                        // poly-agent/.env (fallback)
const rootEnvLocalPath = resolve(__dirname, '../../../.env.local');  // project root .env.local (fallback)

if (existsSync(envPolyagentPath)) {
  console.log('[Config] ✅ Loading from poly-agent/.env.polyagent (isolated secrets)');
  dotenvConfig({ path: envPolyagentPath });
} else if (existsSync(envPolyAgentPath)) {
  console.log('[Config] ✅ Loading from poly-agent/.env.poly-agent (isolated secrets)');
  dotenvConfig({ path: envPolyAgentPath });
} else if (existsSync(envLocalPath)) {
  console.log('[Config] Loading from poly-agent/.env.local');
  dotenvConfig({ path: envLocalPath });
} else if (existsSync(envPath)) {
  console.log('[Config] Loading from poly-agent/.env');
  dotenvConfig({ path: envPath });
} else if (existsSync(rootEnvLocalPath)) {
  console.log('[Config] ⚠️  Loading from project root .env.local (consider using .env.polyagent for better isolation)');
  dotenvConfig({ path: rootEnvLocalPath });
} else {
  throw new Error('No environment file found! Please create services/.private/poly-agent/.env.polyagent from .env.example');
}

export const config = {
  // Target trader wallet (comma-separated for multiple)
  targetWallet: process.env.TARGET_WALLET?.trim()!,

  // Bot wallet (our wallet)
  botWalletAddress: process.env.BOT_WALLET_ADDRESS?.trim()!,
  botPrivateKey: process.env.BOT_PRIVATE_KEY?.trim()!,

  // Polymarket API credentials
  apiKey: process.env.POLYMARKET_API_KEY?.trim()!,
  apiSecret: process.env.POLYMARKET_API_SECRET?.trim()!,
  passphrase: process.env.POLYMARKET_PASSPHRASE?.trim()!,

  // MongoDB connection
  mongoUri: process.env.MONGODB_URI!,

  // Agent parameters
  copyRatio: parseFloat(process.env.COPY_RATIO || '0.01'),
  maxPositionUsdc: parseFloat(process.env.MAX_POSITION_USDC || '2000'),
  minTradeSize: parseFloat(process.env.MIN_TRADE_SIZE || '0'),  // DEPRECATED: Not used anymore

  // Allocation (pro-rata based on max allocation per trader)
  maxAllocationUsdc: parseFloat(process.env.MAX_ALLOCATION_USDC || '100'),

  // Drift thresholds (percentage)
  driftThresholdNew: parseFloat(process.env.DRIFT_THRESHOLD_NEW || '10'),         // New positions: copy if drift < 10%
  driftThresholdExisting: parseFloat(process.env.DRIFT_THRESHOLD_EXISTING || '20'), // Existing: sync if drift < 20%
  driftThresholdUnderwater: parseFloat(process.env.DRIFT_THRESHOLD_UNDERWATER || '-10'), // Skip if underwater > 10%

  // Order execution
  orderRetryDelayMs: parseInt(process.env.ORDER_RETRY_DELAY_MS || '500'),
  maxOrderRetries: parseInt(process.env.MAX_ORDER_RETRIES || '5'),

  // Initial sync
  enableInitialSync: process.env.ENABLE_INITIAL_SYNC !== 'false',

  // Polling intervals
  detectorIntervalMs: parseInt(process.env.DETECTOR_INTERVAL_MS || '30000'),  // 30s default
  reconcilerIntervalMs: parseInt(process.env.RECONCILER_INTERVAL_MS || '60000'),

  // Polymarket endpoints
  dataApiBase: process.env.DATA_API_BASE || 'https://data-api.polymarket.com',
  clobApiBase: process.env.CLOB_API_BASE || 'https://clob.polymarket.com',
  wssMarket: process.env.WSS_MARKET || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  wssUser: process.env.WSS_USER || 'wss://ws-subscriptions-clob.polymarket.com/ws/user',
  chainId: parseInt(process.env.CHAIN_ID || '137'),

  // Polygon RPC endpoint (for on-chain transactions like approvals)
  polygonRpcUrl: process.env.POLYGON_RPC_URL!,
};

// Validate required environment variables
const required = [
  'targetWallet',
  'botWalletAddress',
  'botPrivateKey',
  'apiKey',
  'apiSecret',
  'passphrase',
  'mongoUri',
  'polygonRpcUrl'
];

for (const key of required) {
  if (!config[key as keyof typeof config]) {
    throw new Error(`Missing required config: ${key}. Please check your .env.polyagent file.`);
  }
}

// Validate wallet addresses format (basic check)
if (config.targetWallet && !config.targetWallet.startsWith('0x')) {
  throw new Error('TARGET_WALLET must be a valid Ethereum address starting with 0x');
}
if (config.botWalletAddress && !config.botWalletAddress.startsWith('0x')) {
  throw new Error('BOT_WALLET_ADDRESS must be a valid Ethereum address starting with 0x');
}
if (config.botPrivateKey && !config.botPrivateKey.startsWith('0x')) {
  throw new Error('BOT_PRIVATE_KEY must start with 0x');
}
