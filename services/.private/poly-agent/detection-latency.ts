/**
 * Detection latency diagnostic
 *
 * Measures p50/p95/p99 lag between Polymarket CLOB market WS message
 * timestamps and local receive time, then compares against the current
 * QuickNode on-chain detection lag.
 *
 * Usage:
 *   npx tsx detection-latency.ts
 *   npx tsx detection-latency.ts --token <tokenId>   # specific market
 *   npx tsx detection-latency.ts --duration 120       # run for 2 min (default 60s)
 *
 * The script prints rolling percentile stats every 20 samples and a final
 * summary at exit.
 */

import WebSocket from 'ws';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

const envCandidates = [
  path.resolve(__dirname, '.env.polyagent'),
  path.resolve(__dirname, '.env.local'),
  path.resolve(__dirname, '.env'),
];
for (const p of envCandidates) {
  if (fs.existsSync(p)) { dotenv.config({ path: p }); break; }
}

// ── CLI args ──────────────────────────────────────────────────────────────────
function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

// High-volume Yes token for "Will there be a US recession?" — good proxy market for traffic
const DEFAULT_TOKEN = '21742633143463906290569050155826241533067272736897614950488156847949938836455';
const TOKEN_ID      = arg('token', DEFAULT_TOKEN);
const DURATION_MS   = parseInt(arg('duration', '60')) * 1000;
const WSS_MARKET    = process.env.WSS_MARKET || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// ── Stats helpers ─────────────────────────────────────────────────────────────
function percentile(sorted: number[], p: number): number {
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

function printStats(label: string, samples: number[]): void {
  if (samples.length === 0) { console.log(`${label} — no samples`); return; }
  const sorted = [...samples].sort((a, b) => a - b);
  const p50  = percentile(sorted, 0.50);
  const p95  = percentile(sorted, 0.95);
  const p99  = percentile(sorted, 0.99);
  const min  = sorted[0];
  const max  = sorted[sorted.length - 1];
  const mean = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  console.log(`${label} n=${samples.length} | min=${min}ms mean=${mean}ms p50=${p50}ms p95=${p95}ms p99=${p99}ms max=${max}ms`);
}

// ── Verdict ───────────────────────────────────────────────────────────────────
function verdict(p50: number): string {
  if (p50 < 50)  return '✅ Excellent — CLOB WS is fast from this region.';
  if (p50 < 100) return '✅ Good — p50 <100ms is fine for copy-trading.';
  if (p50 < 150) return '⚠️  Marginal — consider switching to Dublin region (fly regions add dub && fly regions remove arn).';
  return '❌ High latency — region move to Dublin + CLOB WS (vs QuickNode) recommended.';
}

// ── Main ──────────────────────────────────────────────────────────────────────
const clobSamples:    number[] = [];  // CLOB market WS trade lag
const priceSamples:   number[] = [];  // last_trade_price events (higher volume)

let connected = false;
let done = false;

console.log(`\n[Latency] Connecting to ${WSS_MARKET}`);
console.log(`[Latency] Token: ${TOKEN_ID.slice(0, 20)}...`);
console.log(`[Latency] Duration: ${DURATION_MS / 1000}s\n`);

const ws = new WebSocket(WSS_MARKET, { handshakeTimeout: 10_000 });

ws.on('open', () => {
  connected = true;
  console.log(`[Latency] Connected at ${new Date().toISOString()}`);
  ws.send(JSON.stringify({ type: 'market', assets_ids: [TOKEN_ID] }));
});

ws.on('message', (raw: Buffer) => {
  const receivedAt = Date.now();
  let msgs: any[];
  try {
    const parsed = JSON.parse(raw.toString());
    msgs = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return;
  }

  for (const msg of msgs) {
    if (!msg.timestamp) continue;

    // Polymarket timestamps are Unix seconds (10-digit) or ms (13-digit)
    let tsMs = parseInt(msg.timestamp);
    if (tsMs < 1e12) tsMs *= 1000;  // seconds → ms
    if (isNaN(tsMs) || tsMs <= 0 || tsMs > receivedAt + 5000) continue;

    const lag = receivedAt - tsMs;
    if (lag < 0 || lag > 60_000) continue;  // sanity: ignore >60s old or clock skew

    if (msg.event_type === 'trade') {
      clobSamples.push(lag);
      if (clobSamples.length % 20 === 0) {
        process.stdout.write('[CLOB trade] ');
        printStats('', clobSamples);
      }
    } else if (msg.event_type === 'last_trade_price' || msg.event_type === 'price_change') {
      priceSamples.push(lag);
      if (priceSamples.length % 20 === 0) {
        process.stdout.write('[Price event] ');
        printStats('', priceSamples);
      }
    }
  }
});

ws.on('error', (err) => {
  console.error(`[Latency] WS error: ${err.message}`);
});

ws.on('close', (code, reason) => {
  if (!done) console.warn(`[Latency] WS closed early code=${code} reason=${reason?.toString() || ''}`);
});

function finish() {
  if (done) return;
  done = true;
  ws.close();

  console.log('\n══════════════════════════════════════════════');
  console.log('  FINAL RESULTS');
  console.log('══════════════════════════════════════════════');

  if (clobSamples.length === 0 && priceSamples.length === 0) {
    console.log('\n⚠️  No matching trade/price events received in this window.');
    console.log('   Try a more active token or increase --duration.');
    console.log(`   Hint: subscribe to a high-volume market like US election tokens.\n`);
    process.exit(0);
  }

  const allSamples = [...clobSamples, ...priceSamples];
  printStats('[CLOB trade events]  ', clobSamples);
  printStats('[Price events]       ', priceSamples);
  printStats('[Combined]           ', allSamples);

  const sorted = [...allSamples].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.50);

  console.log('\n──────────────────────────────────────────────');
  console.log(verdict(p50));
  console.log('──────────────────────────────────────────────');
  console.log('\nNext steps:');
  console.log('  If p50 <100ms from Stockholm: QuickNode is the lag, not region');
  console.log('     → switch off QuickNode WS; use Polymarket CLOB WS for detection');
  console.log('  If p50 >150ms from Stockholm: region matters');
  console.log('     → fly regions add dub && fly regions remove arn');
  console.log('');

  process.exit(0);
}

setTimeout(finish, DURATION_MS);

// Allow Ctrl+C early exit with stats
process.on('SIGINT', finish);
process.on('SIGTERM', finish);

if (!connected) {
  setTimeout(() => {
    if (!connected) {
      console.error('[Latency] Failed to connect within 15s. Check network or token.');
      process.exit(1);
    }
  }, 15_000);
}
