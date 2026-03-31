/**
 * AI Hedge Fund — Fetch Leaderboard Snapshots
 *
 * Fetches top 1000 traders per category per time period from the Polymarket
 * leaderboard API and stores raw results in polymarket-leaderboardSnapshots.
 *
 * Categories: POLITICS, SPORTS, CRYPTO, CULTURE, MENTIONS, WEATHER, ECONOMICS, TECH, FINANCE
 * Periods:    DAY, WEEK, MONTH
 * Pages:      20 pages × 50 per page = 1000 entries per category/period
 * API calls:  9 × 3 × 20 = 540 total (~3 min at 300ms/call)
 *
 * Rate limiting: 300ms between calls, exponential backoff on 429 (2s→4s→8s→16s)
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/fetch-leaderboard.ts
 *   npx tsx scripts/ai-hedge-fund/fetch-leaderboard.ts --categories=SPORTS,POLITICS
 *   npx tsx scripts/ai-hedge-fund/fetch-leaderboard.ts --dry-run
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

// ── Env loading ───────────────────────────────────────────────────────────────
const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/env.polyagent'),
];
for (const envPath of envLocations) {
  const result = dotenv.config({ path: envPath });
  if (!result.error && process.env.MONGODB_URI) break;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE = (process.env.DATA_API_BASE ?? 'https://data-api.polymarket.com').replace(/\/$/, '');

const ALL_CATEGORIES = [
  'POLITICS', 'SPORTS', 'CRYPTO', 'CULTURE',
  'MENTIONS', 'WEATHER', 'ECONOMICS', 'TECH', 'FINANCE',
] as const;

const TIME_PERIODS = ['DAY', 'WEEK', 'MONTH'] as const;

const PAGE_SIZE   = 50;   // max allowed by API
const MAX_OFFSET  = 950;  // 0..950 → 20 pages × 50 = 1000 entries
const CALL_DELAY_MS     = 300;
const RETRY_DELAYS_MS   = [2000, 4000, 8000, 16000];

// ── Types ─────────────────────────────────────────────────────────────────────

interface LeaderboardEntry {
  rank: string;
  proxyWallet: string;
  userName?: string;
  vol: number;
  pnl: number;
  profileImage?: string;
  xUsername?: string;
  verifiedBadge?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function parseArg(flag: string): string | null {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(new RegExp(`^--${flag}=(.+)$`));
    if (m) return m[1];
  }
  return null;
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(`--${flag}`);
}

function extractDbName(uri: string): string {
  try {
    const url = new URL(uri);
    return url.pathname.replace('/', '') || 'polymarket-test';
  } catch {
    return uri.match(/\/([^/?]+)(\?|$)/)?.[1] ?? 'polymarket-test';
  }
}

async function fetchPage(
  category: string,
  timePeriod: string,
  offset: number,
): Promise<LeaderboardEntry[]> {
  const url = `${API_BASE}/v1/leaderboard?category=${category}&timePeriod=${timePeriod}&orderBy=PNL&limit=${PAGE_SIZE}&offset=${offset}`;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url);

      if (res.status === 429) {
        const waitMs = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
        console.warn(`    [429] rate limited — retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

      const data = await res.json() as LeaderboardEntry[];
      return Array.isArray(data) ? data : [];

    } catch (err: unknown) {
      if (attempt < RETRY_DELAYS_MS.length) {
        const waitMs = RETRY_DELAYS_MS[attempt];
        console.warn(`    [ERR] ${err instanceof Error ? err.message : err} — retry in ${waitMs}ms`);
        await sleep(waitMs);
      } else {
        throw err;
      }
    }
  }
  return [];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const isDryRun = hasFlag('dry-run');
  const catArg   = parseArg('categories');
  const categories = catArg
    ? catArg.split(',').map(s => s.trim().toUpperCase()).filter(c => (ALL_CATEGORIES as readonly string[]).includes(c))
    : [...ALL_CATEGORIES];

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('            FETCH LEADERBOARD SNAPSHOTS                        ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mode:        ${isDryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`  Categories:  ${categories.join(', ')}`);
  console.log(`  Periods:     ${TIME_PERIODS.join(', ')}`);
  console.log(`  Per combo:   1000 entries (20 pages × 50)`);
  console.log(`  Total calls: ${categories.length} × 3 × 20 = ${categories.length * 3 * 20}`);
  console.log(`  Est. time:   ~${Math.ceil((categories.length * 3 * 20 * CALL_DELAY_MS) / 60000)} min`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(extractDbName(mongoUri));
  const col = db.collection('polymarket-leaderboardSnapshots');
  console.log(`Connected → db: ${extractDbName(mongoUri)}`);
  console.log(`API base:        ${API_BASE}\n`);

  if (!isDryRun) {
    // Index for fast upsert + lookup
    await col.createIndex({ wallet: 1, category: 1, timePeriod: 1 }, { unique: true, background: true });
  }

  const snapshotAt = new Date();
  let totalEntries = 0;
  let totalUpserts = 0;

  for (const category of categories) {
    for (const timePeriod of TIME_PERIODS) {
      console.log(`\n── ${category} / ${timePeriod} ─────────────────────────`);

      let categoryEntries = 0;
      const docsToUpsert: Record<string, unknown>[] = [];

      for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE_SIZE) {
        const page = Math.floor(offset / PAGE_SIZE) + 1;
        process.stdout.write(`  Page ${String(page).padStart(2)}/20 (offset ${String(offset).padStart(4)}) ... `);

        const entries = await fetchPage(category, timePeriod, offset);
        process.stdout.write(`${entries.length} results\n`);

        for (const entry of entries) {
          if (!entry.proxyWallet) continue;
          const wallet = entry.proxyWallet.toLowerCase();
          docsToUpsert.push({
            wallet,
            category,
            timePeriod,
            rank: parseInt(entry.rank, 10) || 0,
            pnl: entry.pnl ?? 0,
            vol: entry.vol ?? 0,
            userName: entry.userName ?? null,
            xUsername: entry.xUsername ?? null,
            verifiedBadge: entry.verifiedBadge ?? false,
            snapshotAt,
          });
          categoryEntries++;
        }

        // Stop paginating if API returned fewer than PAGE_SIZE (end of results)
        if (entries.length < PAGE_SIZE) {
          console.log(`  ↳ Only ${entries.length} results — end of data at offset ${offset}`);
          break;
        }

        await sleep(CALL_DELAY_MS);
      }

      if (!isDryRun && docsToUpsert.length > 0) {
        process.stdout.write(`  Writing ${docsToUpsert.length} docs to MongoDB... `);
        const bulkOps = docsToUpsert.map(doc => ({
          updateOne: {
            filter: { wallet: doc.wallet, category: doc.category, timePeriod: doc.timePeriod },
            update: { $set: doc },
            upsert: true,
          },
        }));
        await col.bulkWrite(bulkOps, { ordered: false });
        process.stdout.write('done\n');
        totalUpserts += docsToUpsert.length;
      }

      totalEntries += categoryEntries;
      console.log(`  Total entries: ${categoryEntries} | Cumulative: ${totalEntries}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                         SUMMARY                               ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total entries fetched: ${totalEntries}`);
  console.log(`  Upserted to MongoDB:   ${isDryRun ? 'DRY RUN — skipped' : totalUpserts}`);
  console.log(`  Collection:            polymarket-leaderboardSnapshots`);
  console.log(`  Snapshot time:         ${snapshotAt.toISOString()}`);
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
