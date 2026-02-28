import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

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
    rateDelayMs: parseInt(process.env.TAAPI_RATE_DELAY_MS || '600'),
  },

  coinglass: {
    apiKey: required('COINGLASS_API_KEY'),
    baseUrl: 'https://open-api-v4.coinglass.com',
    rateDelayMs: parseInt(process.env.COINGLASS_RATE_DELAY_MS || '2200'),
    tokensPerMinute: 28,
  },

  fullDerivativesTier: 20,
  totalTrackedCoins: 100,
  onDemandCacheTtlMs: 60 * 60 * 1000,
} as const;
