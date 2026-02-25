import * as dotenv from 'dotenv';
dotenv.config();

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  port: parseInt(process.env.PORT || '3000'),
  mongodbUri: required('MONGODB_URI'),

  taapi: {
    apiKey: required('TAAPI_API_KEY'),
    baseUrl: 'https://api.taapi.io',
    exchange: 'binancefutures',
    interval: '1h',
    // Pro plan: 30 req/15s → 2 req/s → 500ms min. Use 600ms for safety.
    rateDelayMs: parseInt(process.env.TAAPI_RATE_DELAY_MS || '600'),
  },

  coinglass: {
    apiKey: required('COINGLASS_API_KEY'),
    baseUrl: 'https://open-api-v4.coinglass.com',
    // Hobby plan: 30 req/min → 1 req/2s. Use 2200ms for safety.
    rateDelayMs: parseInt(process.env.COINGLASS_RATE_DELAY_MS || '2200'),
    // Token-bucket: 28 req/min to leave buffer
    tokensPerMinute: 28,
  },

  // Top N coins get full per-coin CoinGlass derivatives on cron
  fullDerivativesTier: 20,
  // Total tracked coins
  totalTrackedCoins: 100,

  // On-demand cache TTL (1 hour)
  onDemandCacheTtlMs: 60 * 60 * 1000,
} as const;
