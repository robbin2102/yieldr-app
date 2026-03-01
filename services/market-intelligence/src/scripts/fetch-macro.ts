/**
 * npm run fetch-macro
 * Fetches and saves the daily macro snapshot (ETF flows, fear/greed, stablecoin mcap).
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '../../.env.local' });

import { connectDB, disconnectDB } from '../db';
import { buildAndSaveMacroDaily } from '../processors/macro-builder';

async function main(): Promise<void> {
  await connectDB();
  await buildAndSaveMacroDaily();
  await disconnectDB();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
