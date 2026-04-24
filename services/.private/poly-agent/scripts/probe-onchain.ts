/**
 * probe-onchain.ts — On-chain detection lag probe (Option 1 benchmark)
 *
 * Subscribes to OrderFilled events on Polygon via QuickNode WebSocket.
 * Measures: block.timestamp → event received by this process.
 * Uses raw ws (not ethers WebSocketProvider) to avoid Polygon ENS errors.
 *
 * Usage:
 *   npx tsx scripts/probe-onchain.ts --all           # all fills, stop at 100
 *   npx tsx scripts/probe-onchain.ts --all --max=50  # stop at 50
 *   npx tsx scripts/probe-onchain.ts                 # only tracked trader wallets (from DB)
 *
 * Requires POLYGON_WS_URL in .env.polyagent
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import WebSocket from 'ws';
import { ethers } from 'ethers';
import { MongoClient } from 'mongodb';

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
const WS_URL    = process.env.POLYGON_WS_URL
  || (() => { throw new Error('POLYGON_WS_URL not set in .env.polyagent'); })();
// Same QuickNode endpoint, HTTP for block timestamp fetches
const HTTP_URL  = WS_URL.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
const MONGO_URI = (process.env.MONGO_PUBLIC_URL || process.env.MONGODB_URI)!;
const DB_NAME   = process.env.MONGODB_DB_NAME || 'yieldr';

const ALL_MODE   = process.argv.includes('--all');
const DEBUG_MODE = process.argv.includes('--debug'); // no topics filter — shows ALL logs + raw topic0
const maxArg     = process.argv.find(a => a.startsWith('--max='));
const MAX_EVENTS = maxArg ? parseInt(maxArg.split('=')[1]) : (ALL_MODE || DEBUG_MODE ? 20 : Infinity);

// Polymarket exchange contracts on Polygon mainnet (from allowances.ts)
const CTF_EXCHANGE      = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// ABI used only for decoding — no provider needed
const iface  = new ethers.utils.Interface([
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
]);
const TOPIC0 = iface.getEventTopic('OrderFilled');

// ── Block timestamp (via HTTP RPC, cached by block hex) ───────────────────────
const blockTsCache = new Map<string, number>();

async function fetchBlockTs(blockHex: string): Promise<number | null> {
  if (blockTsCache.has(blockHex)) return blockTsCache.get(blockHex)!;
  try {
    const res  = await fetch(HTTP_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'eth_getBlockByNumber', params: [blockHex, false] }),
    });
    const json = await res.json() as any;
    const ts   = parseInt(json.result.timestamp, 16) * 1000;
    blockTsCache.set(blockHex, ts);
    if (blockTsCache.size > 20) blockTsCache.delete(blockTsCache.keys().next().value!);
    return ts;
  } catch { return null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtUsdc(bn: ethers.BigNumber): string {
  return parseFloat(ethers.utils.formatUnits(bn, 6)).toFixed(2);
}

function printSummary(lags: number[], startMs: number) {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  if (lags.length === 0) {
    console.log(`\n[SUMMARY] 0 events captured in ${elapsed}s`);
    return;
  }
  const sorted = [...lags].sort((a, b) => a - b);
  const avg    = Math.round(lags.reduce((s, v) => s + v, 0) / lags.length);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log('\n' + '─'.repeat(60));
  console.log(`[SUMMARY] ${lags.length} events captured in ${elapsed}s`);
  console.log(`  Avg lag:    ${avg}ms   (${(avg / 1000).toFixed(2)}s)`);
  console.log(`  Median lag: ${median}ms  (${(median / 1000).toFixed(2)}s)`);
  console.log(`  Min lag:    ${sorted[0]}ms`);
  console.log(`  Max lag:    ${sorted[sorted.length - 1]}ms`);
  console.log(`  Interpretation: this is block.timestamp → WS event received`);
  console.log(`  Compare vs API polling lag (~30-370s from DB history)`);
  console.log('─'.repeat(60));
}

async function loadTrackedWallets(): Promise<Set<string>> {
  if (ALL_MODE) return new Set();
  const client  = new MongoClient(MONGO_URI);
  await client.connect();
  const traders = await client.db(DB_NAME).collection('ahf-copyTraders')
    .find({ active: true }).project({ wallet: 1 }).toArray();
  await client.close();
  const set = new Set(traders.map((t: any) => (t.wallet as string).toLowerCase()));
  console.log(`[probe-onchain] Tracking ${set.size} active trader wallets`);
  return set;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const startMs = Date.now();
  const modeLabel = DEBUG_MODE ? `DEBUG (all logs, no topic filter, stop at ${MAX_EVENTS})`
    : ALL_MODE ? `ALL trades (stop at ${MAX_EVENTS})` : 'tracked wallets only';
  console.log(`[probe-onchain] Mode: ${modeLabel}`);
  console.log(`[probe-onchain] WS: ${WS_URL.slice(0, 50)}...`);
  console.log(`[probe-onchain] Expected OrderFilled topic0: ${TOPIC0}`);

  const trackedWallets = await loadTrackedWallets();
  const collectedLags: number[] = [];

  const ws = new WebSocket(WS_URL);

  // Two subscription IDs — one per contract — avoids relying on array address support in eth_subscribe
  const subIds = new Set<string>();

  ws.on('open', () => {
    const filterDesc = DEBUG_MODE ? 'ALL logs (no topic filter)' : `OrderFilled`;
    console.log(`[probe-onchain] Connected. Subscribing to ${filterDesc} on CTF + NEG_RISK separately...\n`);

    // Subscribe to each contract individually (more compatible than address array)
    for (const [id, addr] of [[1, CTF_EXCHANGE], [2, NEG_RISK_EXCHANGE]]) {
      const filterParams: any = { address: addr };
      if (!DEBUG_MODE) filterParams.topics = [TOPIC0];
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_subscribe', params: ['logs', filterParams] }));
    }
  });

  ws.on('message', async (raw: Buffer) => {
    const msg = JSON.parse(raw.toString()) as any;

    // Subscription confirmations (id 1 = CTF, id 2 = NEG_RISK)
    if (msg.id === 1 || msg.id === 2) {
      const name = msg.id === 1 ? 'CTF_EXCHANGE' : 'NEG_RISK_EXCHANGE';
      if (msg.error) { console.error(`[probe-onchain] Subscribe error (${name}):`, msg.error); process.exit(1); }
      subIds.add(msg.result);
      console.log(`[probe-onchain] Subscribed to ${name} (id=${msg.result})`);
      if (subIds.size === 2) console.log(`[probe-onchain] Both subscriptions active. Waiting for fills...\n`);
      return;
    }

    // Event notification
    if (msg.method !== 'eth_subscription') return;

    // Record arrival time immediately
    const receivedAt = Date.now();
    const log        = msg.params.result;

    // DEBUG mode: just print raw topic0 so we can verify the event signature
    if (DEBUG_MODE) {
      const topic0Actual = log.topics?.[0] ?? '(no topics)';
      const contract     = log.address?.toLowerCase() === CTF_EXCHANGE.toLowerCase() ? 'CTF' : 'NEG';
      const match        = topic0Actual === TOPIC0 ? '✅ MATCHES expected OrderFilled' : '❌ DIFFERENT from expected';
      collectedLags.push(0);
      console.log(
        `[DEBUG] #${collectedLags.length} | contract=${contract} | topic0=${topic0Actual} | ${match} | tx=${log.transactionHash?.slice(0, 14)}`
      );
      if (collectedLags.length >= MAX_EVENTS) {
        console.log(`\n[DEBUG] Collected ${MAX_EVENTS} raw logs. If all showed ❌, the event signature is wrong.`);
        console.log(`[DEBUG] Expected: ${TOPIC0}`);
        ws.close(); process.exit(0);
      }
      return;
    }

    // Filter by tracked wallets (indexed in topics[2]=maker, topics[3]=taker)
    const maker = ('0x' + log.topics[2].slice(26)).toLowerCase();
    const taker = ('0x' + log.topics[3].slice(26)).toLowerCase();

    const walletMatch = trackedWallets.has(maker) || trackedWallets.has(taker);
    if (!ALL_MODE && !walletMatch) return;

    // Decode non-indexed args from data field
    const parsed       = iface.parseLog({ topics: log.topics, data: log.data });
    const makerAssetId = parsed.args.makerAssetId as ethers.BigNumber;
    const makerPaysUsdc = makerAssetId.isZero();
    const usdcAmt      = makerPaysUsdc
      ? fmtUsdc(parsed.args.makerAmountFilled)
      : fmtUsdc(parsed.args.takerAmountFilled);

    const wallet   = ALL_MODE ? maker : (trackedWallets.has(maker) ? maker : taker);
    const role     = makerPaysUsdc ? 'BUY' : 'SELL';
    const exchange = log.address.toLowerCase() === CTF_EXCHANGE.toLowerCase() ? 'CTF' : 'NEG';

    // Block timestamp via HTTP (cached — fills in same block share one RPC call)
    const blockTs = await fetchBlockTs(log.blockNumber);
    const lagMs   = blockTs !== null ? receivedAt - blockTs : null;

    collectedLags.push(lagMs ?? 0);

    const ts     = new Date(receivedAt).toISOString().slice(11, 23);
    const lagStr = lagMs !== null ? `${lagMs}ms` : '?ms';

    console.log(
      `[ON-CHAIN] ${ts} | #${collectedLags.length}/${MAX_EVENTS === Infinity ? '∞' : MAX_EVENTS} | ` +
      `${role} $${usdcAmt} | wallet=${wallet.slice(0, 10)}... | lag=${lagStr} | ` +
      `exchange=${exchange} | tx=${log.transactionHash.slice(0, 14)}`
    );

    if (collectedLags.length >= MAX_EVENTS) {
      printSummary(collectedLags, startMs);
      ws.close();
      process.exit(0);
    }
  });

  ws.on('error', (err) => {
    console.error('[probe-onchain] WS error:', err.message);
    process.exit(1);
  });

  ws.on('close', (code) => {
    if (collectedLags.length < MAX_EVENTS) {
      console.log(`\n[probe-onchain] WS closed (code=${code})`);
      printSummary(collectedLags, startMs);
    }
    process.exit(0);
  });

  // Allow Ctrl+C to print summary before exit
  process.on('SIGINT', () => {
    console.log('\n[probe-onchain] Interrupted');
    printSummary(collectedLags, startMs);
    ws.close();
    process.exit(0);
  });
}

run().catch((err) => {
  console.error('[probe-onchain] Fatal:', err.message);
  process.exit(1);
});
