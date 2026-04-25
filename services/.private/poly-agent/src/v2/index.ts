/**
 * v2 entry point — starts the CLOBv2 copy-trading pipeline.
 *
 * Reads config from environment variables and starts TradeOrchestrator.
 * Runs alongside v1 until cutover (both systems operate independently).
 *
 * Usage:
 *   npx tsx src/v2/index.ts
 *   EXECUTION_STRATEGY=market npx tsx src/v2/index.ts   # force market orders
 *
 * Runtime strategy override (no restart needed):
 *   The orchestrator.router is exposed — patch it from REPL or admin endpoint.
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// ── Env loading ───────────────────────────────────────────────────────────────
const envCandidates = [
  resolve(__dirname, '../../.env.polyagent'),
  resolve(__dirname, '../../.env.poly-agent'),
  resolve(__dirname, '../../.env.local'),
  resolve(__dirname, '../../.env'),
  resolve(__dirname, '../../../../.env.local'),
];
for (const p of envCandidates) {
  if (existsSync(p)) { dotenvConfig({ path: p }); break; }
}

import { TradeOrchestrator, OrchestratorConfig } from './tradeOrchestrator';
import { ExecutionStrategy } from './types';
import { connectDB } from '../db/connection';
import mongoose from 'mongoose';

function required(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`[v2] Missing required env: ${name}`); process.exit(1); }
  return v!;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

const POLYGON_RPC_HTTP = (process.env.POLYGON_WS_URL || process.env.POLYGON_RPC_URL || '')
  .replace(/^wss?:\/\//, 'https://').replace(/^ws:\/\//, 'http://');

const cfg: OrchestratorConfig = {
  // Detection
  polygonWsUrl:   required('POLYGON_WS_URL'),
  polygonHttpUrl: POLYGON_RPC_HTTP || required('POLYGON_RPC_URL'),
  mongoUri:       process.env.MONGODB_URI || process.env.MONGO_PUBLIC_URL || required('MONGODB_URI'),
  dbName:         optional('MONGODB_DB_NAME', 'yieldr'),

  // Execution
  clobHost:    optional('CLOB_API_BASE', 'https://clob.polymarket.com'),
  privateKey:  process.env.BOT_PRIVATE_KEY || process.env.PRIVATE_KEY || required('BOT_PRIVATE_KEY'),
  apiKey:      process.env.CLOB_V2_API_KEY      || process.env.POLYMARKET_API_KEY      || required('CLOB_V2_API_KEY'),
  apiSecret:   process.env.CLOB_V2_API_SECRET   || process.env.POLYMARKET_API_SECRET   || required('CLOB_V2_API_SECRET'),
  passphrase:  process.env.CLOB_V2_PASSPHRASE   || process.env.POLYMARKET_PASSPHRASE   || required('CLOB_V2_PASSPHRASE'),
  polygonRpc:  POLYGON_RPC_HTTP || required('POLYGON_RPC_URL'),
  botAddress:  process.env.BOT_WALLET_ADDRESS   || process.env.BOT_ADDRESS             || required('BOT_WALLET_ADDRESS'),

  // WS User Channel
  wssUserUrl: process.env.WSS_USER || optional('CLOB_WSS_USER_URL', 'wss://ws-subscriptions-clob.polymarket.com/ws/user'),

  // Safety
  maxDriftPct:  parseFloat(optional('MAX_DRIFT_PCT',  '0.05')),
  maxSpreadPct: parseFloat(optional('MAX_SPREAD_PCT', '0.10')),

  // Execution
  maxMarketAttempts: parseInt(optional('MAX_MARKET_ATTEMPTS', '5')),
  maxGtdAttempts:    parseInt(optional('MAX_GTD_ATTEMPTS',    '3')),
  defaultStrategy:   (optional('EXECUTION_STRATEGY', 'auto')) as ExecutionStrategy,
};

async function main() {
  console.log('[v2] Starting CLOBv2 copy-trading pipeline...');
  console.log(`[v2] Strategy: ${cfg.defaultStrategy} | drift: ${cfg.maxDriftPct * 100}% | spread: ${cfg.maxSpreadPct * 100}%`);

  await connectDB();

  const orchestrator = await TradeOrchestrator.create(cfg);
  await orchestrator.start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[v2] Shutting down...');
    orchestrator.stop();
    await mongoose.connection.close();
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[v2] Running. Ctrl+C to stop.\n');
}

main().catch(err => {
  console.error('[v2] Fatal startup error:', err.message ?? err);
  process.exit(1);
});
