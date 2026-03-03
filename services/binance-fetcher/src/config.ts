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
  port: parseInt(process.env.PORT || '3001'),
  get mongodbUri() { return required('MONGODB_URI'); },

  binance: {
    baseUrl: 'https://fapi.binance.com',
    // Delay between requests within a cycle (ms) — keeps us well under rate limits
    requestDelayMs: parseInt(process.env.BINANCE_REQUEST_DELAY_MS || '50'),
  },

  // How far back to backfill on startup (if collection is empty)
  backfillDays: parseInt(process.env.BACKFILL_DAYS || '7'),
};
