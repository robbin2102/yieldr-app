/**
 * AI Hedge Fund — Bulk Profile (AHF)
 *
 * Reads unique wallets from polyMarketHolders collection, runs profileTrader()
 * from profile-trader-v2.ts on each, and upserts results into
 * polymarket-traderProfiles.
 *
 * Features:
 *   - Batch processing with configurable concurrency delay
 *   - Resume support via progress file (skips already-processed wallets)
 *   - --sample=N flag to profile only first N wallets (for testing)
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/bulk-profile-ahf.ts
 *   npx tsx scripts/ai-hedge-fund/bulk-profile-ahf.ts --sample=10
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import fs from 'fs';

import { profileTrader } from './profile-trader-v2.js';

// ── Env loading (same order as profile-trader-v2.ts) ──────────────────────────
const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
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
  SOURCE_COLLECTION: 'polyMarketHolders',
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const sampleLimit = parseSampleArg();

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set in environment');
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('               BULK PROFILE — AI HEDGE FUND                   ');
  console.log('═══════════════════════════════════════════════════════════════');
  if (sampleLimit !== null) console.log(`  Mode:     SAMPLE (first ${sampleLimit} wallets)`);
  else console.log('  Mode:     FULL');
  console.log(`  Source:   ${CONFIG.SOURCE_COLLECTION}`);
  console.log(`  Dest:     ${CONFIG.DEST_COLLECTION}`);
  console.log(`  Batch:    ${CONFIG.BATCH_SIZE} wallets | ${CONFIG.DELAY_BETWEEN_WALLETS_MS}ms delay`);
  console.log(`  Progress: ${CONFIG.PROGRESS_FILE}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── Connect ────────────────────────────────────────────────────────────────
  console.log('Connecting to MongoDB...');
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = extractDbName(mongoUri);
  const db = client.db(dbName);
  console.log(`Connected → db: ${dbName}\n`);

  // ── Load unique wallets from polyMarketHolders ─────────────────────────────
  console.log(`Loading unique wallets from ${CONFIG.SOURCE_COLLECTION}...`);
  const agg = await db
    .collection(CONFIG.SOURCE_COLLECTION)
    .aggregate([
      { $unwind: '$holders' },
      { $group: { _id: { $toLower: '$holders.proxyWallet' } } },
      { $match: { _id: { $ne: null, $ne: '' } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  let allWallets: string[] = agg.map(doc => doc._id as string);
  console.log(`  Found ${allWallets.length} unique wallets`);

  // ── Load progress / resume ─────────────────────────────────────────────────
  const progress = loadProgress();
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
  const destCollection = db.collection(CONFIG.DEST_COLLECTION);

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const position = `[${i + 1}/${total}]`;
    const isBatchEnd = (i + 1) % CONFIG.BATCH_SIZE === 0;

    process.stdout.write(`${position} ${wallet} ... `);

    try {
      const profileData = await profileTrader(wallet, {
        convictionMultiplier: CONFIG.CONVICTION_MULTIPLIER,
        verbose: false,
      });

      // Upsert into destination collection
      await destCollection.updateOne(
        { wallet },
        { $set: profileData },
        { upsert: true }
      );

      // ── Per-trader summary line ──
      const wr          = profileData.win_rate as number;
      const sample      = profileData.win_rate_sample_size as number;
      const pf          = profileData.profitFactor as number;
      const tf30        = profileData.timeframePnL as Record<string, { roce: number }>;
      const roce30      = tf30['30d']?.roce ?? 0;
      const capTrend    = (profileData.capital_trend as string | null) ?? 'n/a';
      const ddTrend     = profileData.drawdown_trend as string;
      const identity    = profileData.display_name ? 'yes' : 'no';
      const insider     = profileData.insider_probability as string;

      console.log(
        `OK (wr:${wr.toFixed(1)}% sample:${sample} ` +
        `pf:${pf.toFixed(2)} roce:${roce30.toFixed(1)}% ` +
        `capital:${capTrend} drawdown:${ddTrend} ` +
        `identity:${identity} insider:${insider})`
      );

      // Mark as processed
      progress.processedWallets.push(wallet);
      failedSet.delete(wallet);
      progress.failedWallets = Array.from(failedSet);
      saveProgress(progress);
      processedSet.add(wallet);
      succeeded++;

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAILED — ${msg}`);

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
