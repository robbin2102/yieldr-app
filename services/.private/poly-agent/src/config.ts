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
  // ── Bot identity (never move to DB) ────────────────────────────────────────
  botWalletAddress: process.env.BOT_WALLET_ADDRESS?.trim()!,
  botPrivateKey:    process.env.BOT_PRIVATE_KEY?.trim()!,

  // ── Polymarket API credentials ─────────────────────────────────────────────
  apiKey:      process.env.POLYMARKET_API_KEY?.trim()!,
  apiSecret:   process.env.POLYMARKET_API_SECRET?.trim()!,
  passphrase:  process.env.POLYMARKET_PASSPHRASE?.trim()!,

  // ── Infrastructure ─────────────────────────────────────────────────────────
  mongoUri:      process.env.MONGODB_URI!,
  polygonRpcUrl: process.env.POLYGON_RPC_URL!,
  chainId:       parseInt(process.env.CHAIN_ID || '137'),

  // ── Polymarket endpoints (defaults work for mainnet) ───────────────────────
  dataApiBase: process.env.DATA_API_BASE || 'https://data-api.polymarket.com',
  clobApiBase: process.env.CLOB_API_BASE || 'https://clob.polymarket.com',
  wssMarket:   process.env.WSS_MARKET    || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  wssUser:     process.env.WSS_USER      || 'wss://ws-subscriptions-clob.polymarket.com/ws/user',

  // ── Detector ──────────────────────────────────────────────────────────────
  // Default poll interval. Individual traders can override via detectorIntervalMs
  // in their ahf-copyTraders document (e.g. 300 for BTC 5m markets).
  detectorIntervalMs: parseInt(process.env.DETECTOR_INTERVAL_MS || '60000'),  // 1m default

  // ── GTT order execution ────────────────────────────────────────────────────
  maxOrderRetries:   parseInt(process.env.MAX_ORDER_RETRIES   || '3'),
  orderRetryDelayMs: parseInt(process.env.ORDER_RETRY_DELAY_MS || '500'),
  gttExpirySeconds:  parseInt(process.env.GTT_EXPIRY_SECONDS  || '8'),
  // Polymarket taker fee in basis points. Standard markets use 1000 (10bps).
  // Override via FEE_RATE_BPS if needed.
  feeRateBps:        parseInt(process.env.FEE_RATE_BPS || '1000'),

  // ── Global safety cap per single copy order ────────────────────────────────
  // Per-trader maxBetUsdc in DB overrides this for bet sizing.
  // This is the hard ceiling regardless of any per-trader setting.
  maxPositionUsdc: parseFloat(process.env.MAX_POSITION_USDC || '25'),

  // ── Execution reporting interval ──────────────────────────────────────────
  reportIntervalMs: parseInt(process.env.REPORT_INTERVAL_MS || '600000'),  // 10m

  // ── Stale activity filter ──────────────────────────────────────────────────
  // Activities older than this are silently skipped (prevent backlog replay).
  // 5 minutes covers typical poll gaps; increase if needed for slow markets.
  maxLagMs: parseInt(process.env.MAX_LAG_MS || '300000'),  // 5m default
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
] as const;

for (const key of required) {
  if (!config[key]) {
    throw new Error(`Missing required config: ${key}. Please check your .env.polyagent file.`);
  }
}

if (!config.botWalletAddress.startsWith('0x')) {
  throw new Error('BOT_WALLET_ADDRESS must be a valid Ethereum address starting with 0x');
}
if (!config.botPrivateKey.startsWith('0x')) {
  throw new Error('BOT_PRIVATE_KEY must start with 0x');
}
