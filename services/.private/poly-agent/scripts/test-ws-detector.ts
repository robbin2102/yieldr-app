/**
 * test-ws-detector.ts — Live test of OnChainDetector vs existing bot detection
 *
 * Instantiates OnChainDetector and listens for real-time trade events.
 * For each WS-detected trade, queries ahf-copyTrades MongoDB (READ-ONLY)
 * to find the same txHash and compare detection timestamps.
 *
 * WS lag:  blockTimestampMs → receivedAtMs   (on-chain event delivery speed)
 * API lag: blockTimestampMs → DB updatedAt   (existing bot: API poll → DB write)
 * Delta:   API lag − WS lag                  (how much faster we'd be)
 *
 * Usage:
 *   npx tsx scripts/test-ws-detector.ts
 *   npx tsx scripts/test-ws-detector.ts --stale   # include backlog replay events
 *
 * No MongoDB writes. Ctrl+C prints summary.
 *
 * Requires: POLYGON_WS_URL in .env.polyagent (or .env.local)
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { MongoClient } from 'mongodb';
import { OnChainDetector, DetectedTrade } from '../src/modules/onChainDetector';

// ── Env loading ───────────────────────────────────────────────────────────────
const envCandidates = [
  resolve(__dirname, '../.env.polyagent'),
  resolve(__dirname, '../.env.poly-agent'),
  resolve(__dirname, '../.env.local'),
  resolve(__dirname, '../.env'),
  resolve(__dirname, '../../../.env.local'),
];
for (const p of envCandidates) {
  if (existsSync(p)) { dotenvConfig({ path: p }); break; }
}

// ── Config ────────────────────────────────────────────────────────────────────
const WS_URL   = process.env.POLYGON_WS_URL
  || (() => { throw new Error('POLYGON_WS_URL not set'); })();
const HTTP_URL = WS_URL.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
const MONGO_URI = (process.env.MONGO_PUBLIC_URL || process.env.MONGODB_URI)!;
const DB_NAME   = process.env.MONGODB_DB_NAME || 'yieldr';

const INCLUDE_STALE = process.argv.includes('--stale');

// ── Stats ─────────────────────────────────────────────────────────────────────
interface TradeResult {
  txHash:        string;
  wallet:        string;
  label:         string;
  side:          string;
  usdcAmount:    number;
  wsLagMs:       number;   // blockTimestamp → WS received
  apiLagMs:      number | null;  // blockTimestamp → DB updatedAt (null = not in DB)
  deltaMs:       number | null;  // apiLagMs - wsLagMs (positive = WS faster)
  isStale:       boolean;
}

const results: TradeResult[] = [];
const startMs = Date.now();

// ── DB lookup (read-only) ─────────────────────────────────────────────────────
async function lookupApiDetection(
  txHash: string,
  blockTimestampMs: number
): Promise<{ apiLagMs: number; deltaMs: number } | null> {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const trade = await client.db(DB_NAME).collection('ahf-copyTrades').findOne(
      { txHash },
      { projection: { updatedAt: 1, createdAt: 1, status: 1 } }
    );
    if (!trade) return null;

    // updatedAt is when the bot last wrote this record — proxy for API detection time
    const detectedAt = trade.updatedAt ?? trade.createdAt;
    if (!detectedAt) return null;

    const apiLagMs = detectedAt.getTime() - blockTimestampMs;
    const wsLagMs  = 0; // placeholder; caller fills delta
    return { apiLagMs, deltaMs: 0 };
  } finally {
    await client.close();
  }
}

// ── Formatting ────────────────────────────────────────────────────────────────
function fmt(ms: number): string {
  if (Math.abs(ms) < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function printTrade(trade: DetectedTrade, result: TradeResult): void {
  const ts        = new Date(trade.receivedAtMs).toISOString().slice(11, 23);
  const wsTag     = `WS lag: ${fmt(trade.lagMs)}`;
  const apiTag    = result.apiLagMs !== null
    ? `API lag: ${fmt(result.apiLagMs)}  Δ: ${fmt(result.deltaMs!)} faster`
    : `API lag: (not in DB yet)`;
  const staleTag  = trade.isStale ? ' [STALE-SKIP]' : '';

  console.log(`\n[${ts}]${staleTag} ${trade.label} | ${trade.side} $${trade.usdcAmount.toFixed(2)} | ${trade.exchange}`);
  console.log(`  wallet=${trade.wallet}  role=${trade.role}`);
  console.log(`  tokenId=${trade.tokenId}`);
  console.log(`  tx=${trade.txHash}`);
  console.log(`  ${wsTag}  |  ${apiTag}`);
}

function printSummary(): void {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const live    = results.filter(r => !r.isStale);
  const withApi = live.filter(r => r.apiLagMs !== null);

  console.log('\n' + '─'.repeat(70));
  console.log(`[SUMMARY] ${live.length} live trades detected in ${elapsed}s`);
  if (results.length > live.length) {
    console.log(`          (${results.length - live.length} stale/backlog events skipped)`);
  }

  if (live.length === 0) {
    console.log('  No live trades captured yet.');
    console.log('─'.repeat(70));
    return;
  }

  const wsLags = live.map(r => r.wsLagMs);
  const wsSorted = [...wsLags].sort((a, b) => a - b);
  const wsAvg    = Math.round(wsLags.reduce((s, v) => s + v, 0) / wsLags.length);
  const wsMedian = wsSorted[Math.floor(wsSorted.length / 2)];

  console.log(`\n  WebSocket detection lag (block.timestamp → received):`);
  console.log(`    Avg:    ${fmt(wsAvg)}   Median: ${fmt(wsMedian)}`);
  console.log(`    Min:    ${fmt(wsSorted[0])}   Max:    ${fmt(wsSorted[wsSorted.length - 1])}`);
  console.log(`    Note: negative = Polygon validator forward-dating block.timestamp`);

  if (withApi.length > 0) {
    const apiLags  = withApi.map(r => r.apiLagMs!);
    const deltas   = withApi.map(r => r.deltaMs!);
    const apiAvg   = Math.round(apiLags.reduce((s, v) => s + v, 0) / apiLags.length);
    const deltaAvg = Math.round(deltas.reduce((s, v) => s + v, 0) / deltas.length);

    console.log(`\n  API detection lag (block.timestamp → DB write) — ${withApi.length}/${live.length} trades found in DB:`);
    console.log(`    Avg:    ${fmt(apiAvg)}`);
    console.log(`    WS was ${fmt(deltaAvg)} faster on average`);
  } else {
    console.log(`\n  No trades cross-matched in DB yet (trades may not be in ahf-copyTrades window)`);
  }
  console.log('─'.repeat(70));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log(`[test-ws-detector] Starting OnChainDetector`);
  console.log(`[test-ws-detector] WS: ${WS_URL.slice(0, 50)}...`);
  console.log(`[test-ws-detector] DB: ${MONGO_URI.replace(/:\/\/[^@]+@/, '://***@').slice(0, 60)}...`);
  console.log(`[test-ws-detector] Stale events: ${INCLUDE_STALE ? 'SHOWN' : 'SKIPPED (use --stale to include)'}`);
  console.log(`[test-ws-detector] No DB writes — read-only comparison mode\n`);

  const detector = new OnChainDetector({ wsUrl: WS_URL, httpUrl: HTTP_URL, mongoUri: MONGO_URI, dbName: DB_NAME });

  detector.on('connected',    ()    => console.log('[test-ws-detector] WebSocket connected'));
  detector.on('reconnecting', (ev)  => console.log(`[test-ws-detector] Reconnecting (code=${ev.code}, delay=${ev.delayMs}ms)`));
  detector.on('error',        (err) => console.error(`[test-ws-detector] Error: ${err.message}`));

  detector.on('trade', async (trade: DetectedTrade) => {
    if (trade.isStale && !INCLUDE_STALE) {
      console.log(`[test-ws-detector] Skipping stale event (${Math.round((Date.now() - trade.blockTimestampMs) / 1000)}s old) tx=${trade.txHash.slice(0, 14)}...`);
      results.push({ ...trade, wsLagMs: trade.lagMs, apiLagMs: null, deltaMs: null });
      return;
    }

    // Look up API detection time (async, non-blocking for event loop)
    const apiResult = await lookupApiDetection(trade.txHash, trade.blockTimestampMs).catch(() => null);

    const wsLagMs  = trade.lagMs;
    const apiLagMs = apiResult?.apiLagMs ?? null;
    const deltaMs  = apiLagMs !== null ? apiLagMs - wsLagMs : null;

    const result: TradeResult = {
      txHash:     trade.txHash,
      wallet:     trade.wallet,
      label:      trade.label,
      side:       trade.side,
      usdcAmount: trade.usdcAmount,
      wsLagMs,
      apiLagMs,
      deltaMs,
      isStale:    trade.isStale,
    };
    results.push(result);
    printTrade(trade, result);
  });

  await detector.start();

  process.on('SIGINT', () => {
    console.log('\n[test-ws-detector] Shutting down...');
    detector.stop();
    printSummary();
    process.exit(0);
  });

  console.log('[test-ws-detector] Listening for trades... Press Ctrl+C to stop\n');
}

run().catch(err => {
  console.error('[test-ws-detector] Fatal:', err.message);
  process.exit(1);
});
