/**
 * probe-api.ts — Existing API polling lag probe (baseline benchmark)
 *
 * Mirrors multiDetector's polling logic in isolation.
 * Starts each trader's cursor at NOW so only new trades are captured.
 * Measures time from activity.timestamp → detected by this poll.
 *
 * Usage:
 *   tsx scripts/probe-api.ts
 *   PROBE_POLL_INTERVAL_MS=2000 tsx scripts/probe-api.ts   # faster polling
 *
 * Run alongside probe-onchain.ts in a second terminal.
 * Correlate results via tx= field (same txHash appears in both probes).
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
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
const MONGO_URI        = (process.env.MONGO_PUBLIC_URL || process.env.MONGODB_URI)!;
const DB_NAME          = process.env.MONGODB_DB_NAME || 'yieldr';
const DATA_API_BASE    = process.env.DATA_API_BASE    || 'https://data-api.polymarket.com';
const POLL_INTERVAL_MS = parseInt(process.env.PROBE_POLL_INTERVAL_MS || '5000');

// ── Types ─────────────────────────────────────────────────────────────────────
interface Activity {
  timestamp:       number;
  type:            string;
  side?:           string;
  size:            number;
  price:           number;
  usdcSize:        number;
  asset:           string;
  conditionId:     string;
  title:           string;
  outcome:         string;
  transactionHash: string;
}

interface TraderState {
  wallet:     string;
  label:      string;
  lastSeenTs: number;  // unix seconds — starts at now, not DB cursor
}

// ── DB load ───────────────────────────────────────────────────────────────────
async function loadActiveTraders(): Promise<TraderState[]> {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const traders = await client.db(DB_NAME).collection('ahf-copyTraders')
    .find({ active: true }).project({ wallet: 1, label: 1 }).toArray();
  await client.close();

  const nowSec = Math.floor(Date.now() / 1000);
  return traders.map((t: any) => ({
    wallet:     t.wallet as string,
    label:      t.label  as string,
    lastSeenTs: nowSec,   // cursor starts at NOW — only catches new trades
  }));
}

// ── Polling ───────────────────────────────────────────────────────────────────
async function pollTrader(state: TraderState): Promise<void> {
  const url = `${DATA_API_BASE}/activity?user=${state.wallet}&limit=50&offset=0&sortBy=TIMESTAMP&sortDirection=DESC`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  let res: Response;
  try {
    res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'poly-agent-probe/1' },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    console.warn(`[API-POLL] ${state.label}: HTTP ${res.status}`);
    return;
  }

  const data = await res.json() as any;
  const activities: Activity[] = Array.isArray(data) ? data : (data.data ?? []);

  // Only BUY trades that are newer than our cursor
  const newBuys = activities.filter(
    a => a.timestamp > state.lastSeenTs && a.type === 'TRADE' && a.side === 'BUY'
  );

  if (newBuys.length === 0) return;

  // Advance cursor
  state.lastSeenTs = Math.max(...newBuys.map(a => a.timestamp));

  const detectedAt = Date.now();
  for (const act of newBuys) {
    const activityTs = act.timestamp * 1000;
    const lagMs      = detectedAt - activityTs;
    const ts         = new Date(detectedAt).toISOString().slice(11, 23);
    const title      = (act.title || act.conditionId?.slice(0, 30) || '?').slice(0, 35);

    console.log(
      `[API-POLL] ${ts} | BUY $${act.usdcSize.toFixed(2)} | wallet=${state.wallet.slice(0, 10)}... | ` +
      `lag=${lagMs}ms | activityTs=${activityTs} | detectedAt=${detectedAt} | ` +
      `title="${title}" | tx=${(act.transactionHash || '?').slice(0, 14)}`
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log(`[probe-api] Loading active traders from MongoDB...`);
  const traders = await loadActiveTraders();
  console.log(`[probe-api] Polling ${traders.length} active traders every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`[probe-api] Cursor starts at NOW — only new BUY trades will appear`);
  console.log(`[probe-api] Correlate with probe-onchain.ts using the tx= field\n`);

  let pollCount = 0;

  for (const trader of traders) {
    const poll = async () => {
      const start = Date.now();
      try {
        await pollTrader(trader);
      } catch (err: any) {
        const name = (err as any)?.name === 'AbortError' ? 'timeout (8s)' : err.message;
        console.warn(`[API-POLL] ${trader.label}: error — ${name}`);
      }
      const elapsed = Date.now() - start;
      setTimeout(poll, Math.max(0, POLL_INTERVAL_MS - elapsed));
    };

    // Stagger startup (0–1s) to spread API requests
    const stagger = Math.floor(Math.random() * 1000);
    setTimeout(poll, stagger);
  }

  // Heartbeat every 30s
  setInterval(() => {
    pollCount++;
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[API-POLL] ${ts} ♥ alive | poll cycle ~${pollCount * (POLL_INTERVAL_MS / 1000)}s elapsed | watching ${traders.length} traders`);
  }, 30_000);

  console.log(`[probe-api] Running... Press Ctrl+C to stop\n`);
}

run().catch((err) => {
  console.error('[probe-api] Fatal:', err.message);
  process.exit(1);
});
