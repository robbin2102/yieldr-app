import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Load environment variables - try multiple locations
const envLocalPath = resolve(__dirname, '../.env.local');         // poly-agent/.env.local
const envPath = resolve(__dirname, '../.env');                     // poly-agent/.env
const rootEnvLocalPath = resolve(__dirname, '../../../.env.local'); // project root .env.local

if (existsSync(envLocalPath)) {
  console.log('[Config] Loading from poly-agent/.env.local');
  dotenvConfig({ path: envLocalPath });
} else if (existsSync(envPath)) {
  console.log('[Config] Loading from poly-agent/.env');
  dotenvConfig({ path: envPath });
} else if (existsSync(rootEnvLocalPath)) {
  console.log('[Config] Loading from project root .env.local');
  dotenvConfig({ path: rootEnvLocalPath });
} else {
  throw new Error('No .env.local or .env file found! Please create services/.private/poly-agent/.env.local from .env.example, or add poly-agent variables to root .env.local');
}

export const config = {
  // Target trader wallet
  targetWallet: process.env.TARGET_WALLET!,

  // Bot wallet (our wallet)
  botWalletAddress: process.env.BOT_WALLET_ADDRESS!,
  botPrivateKey: process.env.BOT_PRIVATE_KEY!,

  // Polymarket API credentials
  apiKey: process.env.POLYMARKET_API_KEY!,
  apiSecret: process.env.POLYMARKET_API_SECRET!,
  passphrase: process.env.POLYMARKET_PASSPHRASE!,

  // MongoDB connection
  mongoUri: process.env.MONGODB_URI!,

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
  if (!config[key as keyof typeof config]) {
    throw new Error(`Missing required config: ${key}. Please check your .env.local file.`);
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
