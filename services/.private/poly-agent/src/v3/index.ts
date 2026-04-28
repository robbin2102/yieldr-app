/**
 * v3 entry point — mempool pending tx detection vs confirmed block detection.
 *
 * Runs two detectors in parallel:
 *   - PendingTxDetector: sees trades in mempool BEFORE block inclusion
 *   - OnChainDetector:   sees trades AFTER confirmed on-chain (same as v2)
 *
 * Cross-references by txHash to measure the advance time on each trade.
 * Detection-only — no orders placed. Run alongside v2 for comparison.
 *
 * Usage:
 *   npx tsx src/v3/index.ts
 *
 * Requirements:
 *   - Same env vars as v2 (POLYGON_WS_URL, MONGODB_URI, etc.)
 *   - QuickNode Growth plan for full pending tx objects
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

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

import { PendingTxDetector } from './pendingTxDetector';
import { OnChainDetector }   from '../modules/onChainDetector';
import { ConfirmationTracker } from './confirmationTracker';
import { StatsAggregator }   from './statsAggregator';
import { connectDB }         from '../db/connection';

function required(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`[v3] Missing required env: ${name}`); process.exit(1); }
  return v!;
}
function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

const POLYGON_WS   = required('POLYGON_WS_URL');
const POLYGON_HTTP = POLYGON_WS.replace(/^wss?:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
const MONGO_URI    = process.env.MONGODB_URI || process.env.MONGO_PUBLIC_URL || required('MONGODB_URI');
const DB_NAME      = optional('MONGODB_DB_NAME', 'yieldr');

// ── Formatters ────────────────────────────────────────────────────────────────

function confIcon(c: string): string {
  return c === 'HIGH' ? '🟢' : c === 'MEDIUM' ? '🟡' : '🔴';
}

async function main() {
  console.log('[v3] ════════════════════════════════════════════════════════');
  console.log('[v3] Mempool vs Confirmed detector — compare mode (no execution)');
  console.log('[v3] ════════════════════════════════════════════════════════\n');

  await connectDB();

  const stats   = new StatsAggregator();
  const tracker = new ConfirmationTracker();

  // ── Pending tx detector ───────────────────────────────────────────────────────

  const pendingDet = new PendingTxDetector({ wsUrl: POLYGON_WS, mongoUri: MONGO_URI, dbName: DB_NAME });

  pendingDet.on('connected',    ()  => console.log(`[v3-Pending]   Connected — watching ${pendingDet.walletCount} wallets`));
  pendingDet.on('reconnecting', ()  => console.log('[v3-Pending]   Reconnecting...'));
  pendingDet.on('error',        (e) => console.error('[v3-Pending]   Error:', e.message));

  pendingDet.on('pending', (trade) => {
    stats.recordPending(trade);
    tracker.onPending(trade, (dropped) => {
      stats.recordDropped(dropped);
      const ts = new Date().toISOString().slice(11, 19);
      console.log(`[${ts}] [v3] ⚠  DROPPED   ${dropped.label} ${dropped.side} $${dropped.usdcAmount.toFixed(0)} @$${dropped.impliedPrice.toFixed(3)} tx=${dropped.txHash.slice(0, 12)}... (no confirmation in 30s)`);
    });

    const ts = new Date().toISOString().slice(11, 19);
    console.log(
      `[${ts}] [v3] ⚡ PENDING   ${trade.label} ${trade.side}` +
      ` $${trade.usdcAmount.toFixed(0)} @$${trade.impliedPrice.toFixed(3)}` +
      ` (${trade.tokenAmount.toFixed(1)}sh)` +
      ` tx=${trade.txHash.slice(0, 12)}...` +
      ` gas=${trade.gasGwei.toFixed(0)}gwei ${confIcon(trade.confidence)}${trade.confidence}`
    );
  });

  // ── Confirmed (on-chain) detector ─────────────────────────────────────────────

  const confirmedDet = new OnChainDetector({ wsUrl: POLYGON_WS, httpUrl: POLYGON_HTTP, mongoUri: MONGO_URI, dbName: DB_NAME });

  confirmedDet.on('connected',    ()  => console.log('[v3-Confirmed] Connected'));
  confirmedDet.on('reconnecting', (e) => console.log(`[v3-Confirmed] Reconnecting (delay=${e.delayMs}ms)`));
  confirmedDet.on('error',        (e) => console.error('[v3-Confirmed] Error:', e.message));

  confirmedDet.on('trade', (trade) => {
    if (trade.isStale) return; // skip catch-up replays for comparison purposes

    const now   = Date.now();
    const match = tracker.onConfirmed(trade.txHash, now);
    const ts    = new Date().toISOString().slice(11, 19);
    const blk   = new Date(trade.blockTimestampMs).toISOString().slice(11, 19);
    const lagStr = trade.lagMs >= 0 ? `+${trade.lagMs}ms` : `${trade.lagMs}ms`;
    const base  = `[${ts}] [v3]    CONFIRMED  ${trade.label} ${trade.side}` +
                  ` $${trade.usdcAmount.toFixed(0)} @$${trade.impliedPrice.toFixed(3)}` +
                  ` (${trade.tokenAmount.toFixed(1)}sh) block=${blk} lag=${lagStr}`;

    if (match) {
      stats.recordConfirmed(match);
      const adv = match.advanceMs >= 0
        ? `⚡ pending was ${match.advanceMs}ms earlier`
        : `⚠  pending was ${Math.abs(match.advanceMs)}ms LATER (unusual)`;
      console.log(`${base} | ${adv}`);
    } else {
      // Confirmed but never seen in mempool — likely private/flash tx or plan limitation
      console.log(`${base} | (no pending match — private tx or plan limitation)`);
    }
  });

  // ── Start both ────────────────────────────────────────────────────────────────

  await pendingDet.start();
  await confirmedDet.start();

  console.log('\n[v3] Both detectors running. Ctrl+C for final stats.\n');

  const shutdown = async () => {
    console.log('\n[v3] Shutting down — final stats:');
    stats.print();
    stats.stop();
    tracker.stop();
    pendingDet.stop();
    confirmedDet.stop();
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[v3] Fatal:', err.message);
  process.exit(1);
});
