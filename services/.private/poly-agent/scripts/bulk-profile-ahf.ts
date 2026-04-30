/**
 * AI Hedge Fund — Bulk Profile (AHF)
 *
 * Reads wallets from polymarket-consistentTraders (where should_profile=true),
 * runs profileTrader() from profile-trader-v3.ts on each, and upserts results
 * into polymarket-traderProfiles.
 *
 * Features:
 *   - Batch processing with configurable concurrency delay
 *   - Resume support via progress file (skips already-processed wallets)
 *   - --sample=N flag to profile only first N wallets (for testing)
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/bulk-profile-ahf.ts
 *   npx tsx scripts/ai-hedge-fund/bulk-profile-ahf.ts --sample=10
 *   npx tsx scripts/ai-hedge-fund/bulk-profile-ahf.ts --reset-progress
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import fs from 'fs';

import { profileTrader } from './profile-trader-v3.js';

// ── Env loading (same order as profile-trader-v3.ts) ──────────────────────────
const envLocations = [
  // __dirname-based: works from any cwd (script lives at <root>/scripts/)
  path.resolve(__dirname, '../env.polyagent'),
  path.resolve(__dirname, '../.env.polyagent'),
  path.resolve(__dirname, '../.env.local'),
  path.resolve(__dirname, '../.env'),
  // cwd-based fallbacks (run from repo root)
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/env.polyagent'),
];
for (const envPath of envLocations) {
  const result = dotenv.config({ path: envPath });
  if (!result.error && process.env.MONGODB_URI) break;
}

// ── CONFIG (identical to existing bulk scripts) ───────────────────────────────
const CONFIG = {
  BATCH_SIZE: 5,                                  // wallets per batch
  DELAY_BETWEEN_WALLETS_MS: 3000,                 // ms between wallets
  DELAY_BETWEEN_BATCHES_MS: 5000,                 // extra ms between batches
  PROGRESS_FILE: path.resolve(process.cwd(), '.bulk-profile-ahf-progress.json'),
  SOURCE_COLLECTION: 'polymarket-consistentTraders',
  DEST_COLLECTION: 'polymarket-traderProfiles',
  CONVICTION_MULTIPLIER: 10,
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface Progress {
  processedWallets: string[];
  failedWallets: string[];
  lastRunAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function loadProgress(): Progress {
  try {
    if (fs.existsSync(CONFIG.PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.PROGRESS_FILE, 'utf8')) as Progress;
    }
  } catch {
    // corrupt file — start fresh
  }
  return { processedWallets: [], failedWallets: [], lastRunAt: '' };
}

function saveProgress(progress: Progress): void {
  progress.lastRunAt = new Date().toISOString();
  fs.writeFileSync(CONFIG.PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function extractDbName(uri: string): string {
  try {
    const url = new URL(uri);
    const name = url.pathname.replace('/', '');
    return name || 'polymarket-test';
  } catch {
    const match = uri.match(/\/([^/?]+)(\?|$)/);
    return match?.[1] || 'polymarket-test';
  }
}

function parseSampleArg(): number | null {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--sample=(\d+)$/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(`--${flag}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const sampleLimit    = parseSampleArg();
  const resetProgress  = hasFlag('reset-progress');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set in environment');
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('               BULK PROFILE — AI HEDGE FUND                   ');
  console.log('═══════════════════════════════════════════════════════════════');
  if (sampleLimit !== null) console.log(`  Mode:     SAMPLE (first ${sampleLimit} wallets)`);
  else if (resetProgress) console.log('  Mode:     FULL (progress reset)');
  else console.log('  Mode:     FULL (resume)');
  console.log(`  Source:   ${CONFIG.SOURCE_COLLECTION}`);
  console.log(`  Dest:     ${CONFIG.DEST_COLLECTION}`);
  console.log(`  Batch:    ${CONFIG.BATCH_SIZE} wallets | ${CONFIG.DELAY_BETWEEN_WALLETS_MS}ms delay`);
  console.log(`  Progress: ${CONFIG.PROGRESS_FILE}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── Connect ────────────────────────────────────────────────────────────────
  console.log('Connecting to MongoDB...');
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = process.env.MONGODB_DB_NAME || extractDbName(mongoUri);
  const db = client.db(dbName);
  console.log(`Connected → db: ${dbName}\n`);

  // ── Load wallets from polymarket-consistentTraders (should_profile=true) ──
  console.log(`Loading wallets from ${CONFIG.SOURCE_COLLECTION} where should_profile=true...`);
  const traderDocs = await db
    .collection(CONFIG.SOURCE_COLLECTION)
    .find({ should_profile: true })
    .project({ wallet: 1 })
    .sort({ wallet: 1 })
    .toArray();

  let allWallets: string[] = traderDocs.map(doc => doc.wallet as string).filter(Boolean);
  console.log(`  Found ${allWallets.length} wallets to profile`);

  // ── Load progress / resume ─────────────────────────────────────────────────
  const progress = resetProgress
    ? { processedWallets: [], failedWallets: [], lastRunAt: '' }
    : loadProgress();
  const processedSet = new Set(progress.processedWallets);
  const failedSet = new Set(progress.failedWallets);

  const skipped = allWallets.filter(w => processedSet.has(w)).length;
  const pending = allWallets.filter(w => !processedSet.has(w));

  console.log(`  Already processed: ${skipped} | Pending: ${pending.length} | Failed (prev): ${failedSet.size}`);

  // ── Apply sample limit ─────────────────────────────────────────────────────
  const wallets = sampleLimit !== null ? pending.slice(0, sampleLimit) : pending;
  const total = wallets.length;

  if (total === 0) {
    console.log('\nNothing left to process. All wallets done.');
    await client.close();
    return;
  }

  console.log(`\nProcessing ${total} wallets...\n`);

  // ── Batch processing ───────────────────────────────────────────────────────
  const destCollection     = db.collection(CONFIG.DEST_COLLECTION);
  const positionsCollection = db.collection('polymarket-traderPositions');
  await positionsCollection.createIndex({ wallet: 1 }, { unique: true, background: true });

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const position = `[${i + 1}/${total}]`;
    const isBatchEnd = (i + 1) % CONFIG.BATCH_SIZE === 0;

    process.stdout.write(`${position} ${wallet.slice(0, 10)}... `);
    const startMs = Date.now();
    // Heartbeat: print a dot every 5s so terminal doesn't appear frozen
    const ticker = setInterval(() => process.stdout.write('.'), 5000);

    try {
      const { core, positions } = await profileTrader(wallet, {
        convictionMultiplier: CONFIG.CONVICTION_MULTIPLIER,
        verbose: false,
      });
      clearInterval(ticker);
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

      // Replace both collection docs cleanly (no stale fields from old format)
      await destCollection.replaceOne({ wallet }, core, { upsert: true });
      await positionsCollection.replaceOne({ wallet }, positions, { upsert: true });

      // ── Per-trader summary line ──
      const wr          = core.win_rate;
      const sample      = core.win_rate_sample_size;
      const pf          = core.profitFactor;
      const tf30        = core.timeframePnL?.['30d'] as { roce: number; maxDrawdownPct?: number | null } | undefined;
      const roce30      = tf30?.roce ?? 0;
      const dd30        = tf30?.maxDrawdownPct ?? null;
      const capTrend    = core.capital_trend ?? 'n/a';
      const ddTrend     = core.drawdown_trend ?? 'n/a';
      const consistency = core.tradingConsistency as { daysWonRate: number; sortinoRatio: number | null } | null;
      const daysWon     = consistency?.daysWonRate ?? 0;
      const sortino     = consistency?.sortinoRatio != null ? consistency.sortinoRatio.toFixed(2) : 'n/a';
      const identity    = core.display_name ? 'yes' : 'no';
      const insider     = core.insider_probability ?? 'n/a';

      console.log(
        ` OK ${elapsed}s | wr:${wr.toFixed(1)}% n:${sample} ` +
        `pf:${pf.toFixed(2)} roce30:${roce30.toFixed(1)}% ` +
        `dd30:${dd30 != null ? dd30.toFixed(1) + '%' : 'n/a'} ` +
        `daysWon:${daysWon.toFixed(1)}% sortino:${sortino} ` +
        `cap:${capTrend} dd:${ddTrend} id:${identity} ins:${insider}`
      );

      // Mark as processed
      progress.processedWallets.push(wallet);
      failedSet.delete(wallet);
      progress.failedWallets = Array.from(failedSet);
      saveProgress(progress);
      processedSet.add(wallet);
      succeeded++;

    } catch (err: unknown) {
      clearInterval(ticker);
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(` FAILED ${elapsed}s — ${msg}`);

      failedSet.add(wallet);
      progress.failedWallets = Array.from(failedSet);
      saveProgress(progress);
      failed++;
    }

    // Delay between wallets
    if (i < wallets.length - 1) {
      const delay = isBatchEnd
        ? CONFIG.DELAY_BETWEEN_BATCHES_MS
        : CONFIG.DELAY_BETWEEN_WALLETS_MS;
      await sleep(delay);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                         SUMMARY                               ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total processed this run:  ${total}`);
  console.log(`  Succeeded:                 ${succeeded}`);
  console.log(`  Failed:                    ${failed}`);
  console.log(`  All-time processed:        ${progress.processedWallets.length}`);
  console.log(`  All-time failed:           ${progress.failedWallets.length}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  await client.close();
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
