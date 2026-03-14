/**
 * AI Hedge Fund — Bulk Trader Profiler
 *
 * Profiles all Polymarket traders with:
 *   - 5 concurrent traders (safe under 100 req/s Data API limit)
 *   - 429 exponential backoff
 *   - Skip-inactive logic for daily cron runs (--daily flag)
 *   - Progress tracking with ETA
 *
 * Usage:
 *   # Full initial index (all wallets from DB):
 *   npx tsx scripts/ai-hedge-fund/bulk-profile-ahf.ts
 *
 *   # Daily incremental (skip traders inactive >30d):
 *   npx tsx scripts/ai-hedge-fund/bulk-profile-ahf.ts --daily
 *
 *   # Custom concurrency:
 *   npx tsx scripts/ai-hedge-fund/bulk-profile-ahf.ts --concurrency 3
 *
 *   # Resume from a specific offset (skip first N wallets):
 *   npx tsx scripts/ai-hedge-fund/bulk-profile-ahf.ts --offset 2500
 *
 *   # Source wallets from Polymarket leaderboard instead of DB:
 *   npx tsx scripts/ai-hedge-fund/bulk-profile-ahf.ts --source leaderboard
 *
 *   # Source wallets from polyMarketHolders (top holders per market):
 *   npx tsx scripts/ai-hedge-fund/bulk-profile-ahf.ts --source holders
 *
 *   # Resume safely — skip wallets already in DB (order-independent):
 *   npx tsx scripts/ai-hedge-fund/bulk-profile-ahf.ts --source holders --skip-existing
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, Collection } from 'mongodb';
import { profileTrader } from './profile-trader-v2.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env — .env.local takes priority
const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
];
for (const envPath of envLocations) {
  const result = dotenv.config({ path: envPath });
  if (!result.error && process.env.MONGODB_URI) break;
}

const DATA_API_BASE = 'https://data-api.polymarket.com';

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

const ARGS = process.argv.slice(2);
const FLAG = (name: string) => ARGS.includes(`--${name}`);
const OPT = (name: string, fallback: string): string => {
  const idx = ARGS.indexOf(`--${name}`);
  return idx !== -1 && ARGS[idx + 1] ? ARGS[idx + 1] : fallback;
};

const CONCURRENCY    = parseInt(OPT('concurrency', '5'));
const START_OFFSET   = parseInt(OPT('offset', '0'));
const DAILY_MODE     = FLAG('daily');
const SKIP_EXISTING  = FLAG('skip-existing');   // skip wallets already profiled in DB
const SOURCE         = OPT('source', 'mongo');   // 'mongo' | 'leaderboard' | 'holders'

// Inactive threshold for --daily: skip wallets not seen in X days
const SKIP_INACTIVE_DAYS = 30;

// Leaderboard pagination
const LEADERBOARD_LIMIT  = 500;
const LEADERBOARD_MAX    = 50_000;

// ═══════════════════════════════════════════════════════════════
// MongoDB helpers
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// Wallet sources
// ═══════════════════════════════════════════════════════════════

async function walletsFromMongo(collection: Collection): Promise<string[]> {
  const docs = await collection
    .find({}, { projection: { wallet: 1, last_active_days_ago: 1 } })
    .toArray();

  if (DAILY_MODE) {
    const active = docs.filter(d => {
      if (d.last_active_days_ago == null) return true; // never profiled → include
      return d.last_active_days_ago <= SKIP_INACTIVE_DAYS;
    });
    console.log(`[daily] ${active.length} / ${docs.length} wallets active in last ${SKIP_INACTIVE_DAYS}d (skipping ${docs.length - active.length} inactive)`);
    return active.map(d => d.wallet as string);
  }

  return docs.map(d => d.wallet as string);
}

async function walletsFromLeaderboard(): Promise<string[]> {
  const wallets: string[] = [];
  let offset = 0;
  let page = 1;

  console.log('Fetching wallet list from Polymarket leaderboard...');

  while (offset < LEADERBOARD_MAX) {
    const url = `${DATA_API_BASE}/leaderboard?limit=${LEADERBOARD_LIMIT}&offset=${offset}&sortBy=VOLUME&sortDirection=DESC`;
    const res = await fetchWithBackoff(url);
    if (!res.ok) {
      console.warn(`  Leaderboard page ${page} returned ${res.status} — stopping`);
      break;
    }

    const batch = await res.json() as Array<{ address?: string; proxyWallet?: string }>;
    if (batch.length === 0) break;

    for (const entry of batch) {
      const addr = entry.address || entry.proxyWallet;
      if (addr) wallets.push(addr.toLowerCase());
    }

    console.log(`  Page ${page}: ${batch.length} wallets (total so far: ${wallets.length})`);

    if (batch.length < LEADERBOARD_LIMIT) break;
    offset += LEADERBOARD_LIMIT;
    page++;
    await sleep(200);
  }

  return wallets;
}

async function walletsFromHolders(db: import('mongodb').Db): Promise<string[]> {
  console.log('Fetching unique wallets from polyMarketHolders...');
  const wallets = await db
    .collection('polyMarketHolders')
    .distinct('holders.proxyWallet') as string[];
  const unique = wallets.filter(Boolean).map(w => w.toLowerCase());
  console.log(`  Found ${unique.length} unique wallets across all markets`);
  return unique;
}

// ═══════════════════════════════════════════════════════════════
// Fetch with 429 exponential backoff
// ═══════════════════════════════════════════════════════════════

async function fetchWithBackoff(url: string, maxRetries = 5): Promise<Response> {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(url);
    if (res.status !== 429) return res;
    console.warn(`  [429] Rate limited — waiting ${delay / 1000}s before retry ${attempt}/${maxRetries}`);
    await sleep(delay);
    delay = Math.min(delay * 2, 30_000); // cap at 30s
  }
  // Return last response even if still 429
  return fetch(url);
}

// ═══════════════════════════════════════════════════════════════
// Concurrency pool
// ═══════════════════════════════════════════════════════════════

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function eta(doneCount: number, total: number, elapsedMs: number): string {
  if (doneCount === 0) return 'calculating...';
  const msPerItem = elapsedMs / doneCount;
  const remaining = (total - doneCount) * msPerItem;
  const h = Math.floor(remaining / 3_600_000);
  const m = Math.floor((remaining % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set');
    process.exit(1);
  }

  const dbName = extractDbName(mongoUri);
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('           AI HEDGE FUND — BULK TRADER PROFILER             ');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Mode:        ${DAILY_MODE ? 'DAILY (skip inactive >' + SKIP_INACTIVE_DAYS + 'd)' : 'FULL'}`);
  console.log(`  Source:      ${SOURCE}`);
  console.log(`  Concurrency: ${CONCURRENCY} traders`);
  console.log(`  Offset:      ${START_OFFSET}`);
  console.log(`  Skip existing: ${SKIP_EXISTING}`);
  console.log(`  DB:          ${dbName}`);
  console.log('════════════════════════════════════════════════════════════\n');

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(dbName);
  const collection = db.collection('polymarket-traderProfiles');

  // ── Collect wallets ───────────────────────────────────────
  let wallets: string[];
  if (SOURCE === 'leaderboard') {
    wallets = await walletsFromLeaderboard();
  } else if (SOURCE === 'holders') {
    wallets = await walletsFromHolders(db);
  } else {
    wallets = await walletsFromMongo(collection);
  }

  // Apply offset (resume support)
  if (START_OFFSET > 0) {
    console.log(`Resuming from offset ${START_OFFSET} (skipping first ${START_OFFSET} wallets)\n`);
    wallets = wallets.slice(START_OFFSET);
  }

  // Skip wallets already profiled in DB
  if (SKIP_EXISTING) {
    console.log('Checking for already-profiled wallets...');
    const existingDocs = await collection
      .find({ wallet: { $in: wallets } }, { projection: { wallet: 1 } })
      .toArray();
    const existingSet = new Set(existingDocs.map(d => (d.wallet as string).toLowerCase()));
    const before = wallets.length;
    wallets = wallets.filter(w => !existingSet.has(w.toLowerCase()));
    console.log(`  Skipping ${before - wallets.length} already-profiled wallets → ${wallets.length} remaining\n`);
  }

  const total = wallets.length;
  if (total === 0) {
    console.log('No wallets to process.');
    await client.close();
    return;
  }

  console.log(`Processing ${total} wallets at concurrency=${CONCURRENCY}...\n`);

  // ── Stats tracking ────────────────────────────────────────
  let done = 0;
  let skipped = 0;
  let errors = 0;
  const startMs = Date.now();

  // ── Process wallets ───────────────────────────────────────
  await runWithConcurrency(wallets, CONCURRENCY, async (wallet, i) => {
    const globalIdx = START_OFFSET + i + 1;
    const totalGlobal = START_OFFSET + total;

    try {
      process.stdout.write(
        `[${globalIdx}/${totalGlobal}] ${wallet} ... `
      );

      const profileData = await profileTrader(wallet, { verbose: false });

      // Save to MongoDB
      await collection.updateOne(
        { wallet: wallet.toLowerCase() },
        { $set: profileData },
        { upsert: true }
      );

      done++;
      const elapsedMs = Date.now() - startMs;
      const etaStr = eta(done, total, elapsedMs);
      const elapsed = `${Math.floor(elapsedMs / 60_000)}m${Math.floor((elapsedMs % 60_000) / 1000)}s`;

      const p = profileData as Record<string, unknown>;
      const wr = typeof p.win_rate === 'number' ? p.win_rate.toFixed(1) : '?';
      const sample = typeof p.win_rate_sample_size === 'number' ? p.win_rate_sample_size : '?';
      const pf = typeof p.profitFactor === 'number' ? p.profitFactor.toFixed(2) : '?';
      const roce = (p.timeframePnL as Record<string, { roce?: number; hasData?: boolean } | undefined> | undefined)?.['30d']?.roce?.toFixed(1) ?? '?';
      const capital = typeof p.cashFlowPnL === 'object' && p.cashFlowPnL !== null
        ? ((p.cashFlowPnL as Record<string, unknown>).capitalTrend ?? 'stable')
        : 'stable';
      const insider = typeof p.insider_probability === 'string' ? p.insider_probability : '?';

      console.log(
        `OK (wr:${wr}% sample:${sample} pf:${pf} roce:${roce}% insider:${insider}) | elapsed:${elapsed} eta:${etaStr}`
      );
    } catch (err: unknown) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`ERROR: ${message}`);
    }
  });

  // ── Summary ───────────────────────────────────────────────
  const totalMs = Date.now() - startMs;
  const totalMin = Math.floor(totalMs / 60_000);
  const perTrader = (totalMs / Math.max(done, 1) / 1000).toFixed(1);

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('                       DONE                                 ');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Profiled:    ${done}`);
  console.log(`  Skipped:     ${skipped}`);
  console.log(`  Errors:      ${errors}`);
  console.log(`  Total time:  ${totalMin}m`);
  console.log(`  Per trader:  ${perTrader}s avg`);
  console.log('════════════════════════════════════════════════════════════\n');

  await client.close();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
