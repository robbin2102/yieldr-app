import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

// NOTE: apiKey and mongodbUri are lazy getters so they are evaluated only when
// first accessed (inside running functions), NOT at module load time. This lets
// the HTTP health-check server start before env-var validation occurs, which is
// required for Railway's health-check to pass on deployment.
export const config = {
  port: parseInt(process.env.PORT || '3000'),
  get mongodbUri() { return required('MONGODB_URI'); },

  taapi: {
    get apiKey() { return required('TAAPI_API_KEY'); },
    baseUrl: 'https://api.taapi.io',
    exchange: 'binancefutures',
    interval: '1h',
    rateDelayMs: parseInt(process.env.TAAPI_RATE_DELAY_MS || '600'),
  },

  coinglass: {
    get apiKey() { return required('COINGLASS_API_KEY'); },
    baseUrl: 'https://open-api-v4.coinglass.com',
    rateDelayMs: parseInt(process.env.COINGLASS_RATE_DELAY_MS || '2200'),
    tokensPerMinute: 28,
  },

  fullDerivativesTier: 20,
  totalTrackedCoins: 100,
  onDemandCacheTtlMs: 60 * 60 * 1000,
};
