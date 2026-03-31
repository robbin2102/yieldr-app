/**
 * AI Hedge Fund — Find Consistent Traders
 *
 * Reads polymarket-leaderboardSnapshots and identifies wallets that appear
 * profitable (pnl > 0) across ALL three time periods (DAY, WEEK, MONTH) in
 * at least one category.
 *
 * Minimum thresholds per period:
 *   DAY   pnl >= 50
 *   WEEK  pnl >= 100
 *   MONTH pnl >= 500
 *
 * Output: polymarket-consistentTraders
 *   {
 *     wallet,
 *     leaderboard: { [category]: { day, week, month } },
 *     consistent_categories: string[],
 *     should_profile: boolean,   // true if any consistent category outside CRYPTO/CULTURE
 *     updatedAt,
 *   }
 *
 * Categories excluded from should_profile:
 *   CRYPTO, CULTURE  (high-volume noise, less actionable for copy-trading)
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/find-consistent-traders.ts
 *   npx tsx scripts/ai-hedge-fund/find-consistent-traders.ts --dry-run
 *   npx tsx scripts/ai-hedge-fund/find-consistent-traders.ts --categories=SPORTS,POLITICS
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

const ALL_CATEGORIES = [
  'POLITICS', 'SPORTS', 'CRYPTO', 'CULTURE',
  'MENTIONS', 'WEATHER', 'ECONOMICS', 'TECH', 'FINANCE',
] as const;

// Categories where should_profile is false (noisy / less actionable)
const EXCLUDE_FROM_PROFILING = new Set(['CRYPTO', 'CULTURE']);

// Minimum PnL thresholds per time period to count as "consistent"
const MIN_PNL: Record<string, number> = {
  DAY:   50,
  WEEK:  100,
  MONTH: 500,
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface LeaderboardEntry {
  wallet: string;
  category: string;
  timePeriod: string;
  rank: number;
  pnl: number;
  vol: number;
  userName?: string | null;
  xUsername?: string | null;
  verifiedBadge?: boolean;
}

interface PeriodSnapshot {
  pnl: number;
  vol: number;
  rank: number;
}

interface CategoryLeaderboard {
  day?: PeriodSnapshot;
  week?: PeriodSnapshot;
  month?: PeriodSnapshot;
}

interface ConsistentTrader {
  wallet: string;
  leaderboard: Record<string, CategoryLeaderboard>;
  consistent_categories: string[];
  should_profile: boolean;
  updatedAt: Date;
  userName?: string | null;
  xUsername?: string | null;
  verifiedBadge?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractDbName(uri: string): string {
  try {
    const url = new URL(uri);
    return url.pathname.replace('/', '') || 'polymarket-test';
  } catch {
    return uri.match(/\/([^/?]+)(\?|$)/)?.[1] ?? 'polymarket-test';
  }
}

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

function isConsistentInCategory(lb: CategoryLeaderboard): boolean {
  const day   = lb.day?.pnl ?? -Infinity;
  const week  = lb.week?.pnl ?? -Infinity;
  const month = lb.month?.pnl ?? -Infinity;
  return (
    day   >= MIN_PNL['DAY']   &&
    week  >= MIN_PNL['WEEK']  &&
    month >= MIN_PNL['MONTH']
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const isDryRun = hasFlag('dry-run');
  const catArg   = parseArg('categories');
  const categories = catArg
    ? catArg.split(',').map(s => s.trim().toUpperCase()).filter(c => (ALL_CATEGORIES as readonly string[]).includes(c))
    : [...ALL_CATEGORIES];

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('             FIND CONSISTENT TRADERS                           ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mode:        ${isDryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`  Categories:  ${categories.join(', ')}`);
  console.log(`  Min PnL:     DAY >= $${MIN_PNL.DAY} | WEEK >= $${MIN_PNL.WEEK} | MONTH >= $${MIN_PNL.MONTH}`);
  console.log(`  Exclude from profiling: ${[...EXCLUDE_FROM_PROFILING].join(', ')}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(extractDbName(mongoUri));
  const snapCol = db.collection('polymarket-leaderboardSnapshots');
  const outCol  = db.collection('polymarket-consistentTraders');
  console.log(`Connected → db: ${extractDbName(mongoUri)}\n`);

  if (!isDryRun) {
    await outCol.createIndex({ wallet: 1 }, { unique: true, background: true });
    await outCol.createIndex({ should_profile: 1 }, { background: true });
    await outCol.createIndex({ consistent_categories: 1 }, { background: true });
  }

  // ── Load all leaderboard entries for selected categories ──────────────────
  console.log('Loading leaderboard snapshots...');
  const allEntries = await snapCol
    .find({ category: { $in: categories } })
    .project({ wallet: 1, category: 1, timePeriod: 1, rank: 1, pnl: 1, vol: 1, userName: 1, xUsername: 1, verifiedBadge: 1 })
    .toArray() as unknown as LeaderboardEntry[];

  console.log(`  Loaded ${allEntries.length} snapshot entries\n`);

  // ── Group by wallet ────────────────────────────────────────────────────────
  // walletMap: wallet → { category → { day, week, month } }
  const walletMap = new Map<string, {
    leaderboard: Record<string, CategoryLeaderboard>;
    userName?: string | null;
    xUsername?: string | null;
    verifiedBadge?: boolean;
  }>();

  for (const entry of allEntries) {
    const { wallet, category, timePeriod, pnl, vol, rank, userName, xUsername, verifiedBadge } = entry;
    if (!wallet) continue;

    if (!walletMap.has(wallet)) {
      walletMap.set(wallet, {
        leaderboard: {},
        userName: userName ?? null,
        xUsername: xUsername ?? null,
        verifiedBadge: verifiedBadge ?? false,
      });
    }

    const wData = walletMap.get(wallet)!;

    // Update identity fields with latest non-null values
    if (userName) wData.userName = userName;
    if (xUsername) wData.xUsername = xUsername;
    if (verifiedBadge) wData.verifiedBadge = verifiedBadge;

    if (!wData.leaderboard[category]) wData.leaderboard[category] = {};

    const periodKey = timePeriod.toLowerCase() as 'day' | 'week' | 'month';
    if (periodKey === 'day' || periodKey === 'week' || periodKey === 'month') {
      wData.leaderboard[category][periodKey] = { pnl, vol, rank };
    }
  }

  console.log(`  Unique wallets in snapshots: ${walletMap.size}`);

  // ── Find consistent wallets ───────────────────────────────────────────────
  const updatedAt = new Date();
  const consistentTraders: ConsistentTrader[] = [];

  for (const [wallet, wData] of walletMap.entries()) {
    const consistent_categories: string[] = [];

    for (const cat of categories) {
      const lb = wData.leaderboard[cat];
      if (lb && isConsistentInCategory(lb)) {
        consistent_categories.push(cat);
      }
    }

    if (consistent_categories.length === 0) continue;

    const should_profile = consistent_categories.some(c => !EXCLUDE_FROM_PROFILING.has(c));

    consistentTraders.push({
      wallet,
      leaderboard: wData.leaderboard,
      consistent_categories,
      should_profile,
      updatedAt,
      userName: wData.userName ?? null,
      xUsername: wData.xUsername ?? null,
      verifiedBadge: wData.verifiedBadge ?? false,
    });
  }

  consistentTraders.sort((a, b) => b.consistent_categories.length - a.consistent_categories.length);

  // ── Stats ─────────────────────────────────────────────────────────────────
  const profileCount = consistentTraders.filter(t => t.should_profile).length;
  const catCounts: Record<string, number> = {};
  for (const t of consistentTraders) {
    for (const c of t.consistent_categories) {
      catCounts[c] = (catCounts[c] ?? 0) + 1;
    }
  }

  console.log(`\nConsistent traders found: ${consistentTraders.length}`);
  console.log(`  → should_profile = true:  ${profileCount}`);
  console.log(`  → should_profile = false: ${consistentTraders.length - profileCount}`);
  console.log('\nBreakdown by category:');
  for (const cat of categories) {
    const n = catCounts[cat] ?? 0;
    const excluded = EXCLUDE_FROM_PROFILING.has(cat) ? ' (excluded from profiling)' : '';
    console.log(`  ${cat.padEnd(10)}: ${n}${excluded}`);
  }

  // ── Sample output ─────────────────────────────────────────────────────────
  if (consistentTraders.length > 0) {
    console.log('\nTop 5 most consistent traders:');
    for (const t of consistentTraders.slice(0, 5)) {
      const id = t.userName || t.xUsername || t.wallet.slice(0, 10) + '...';
      console.log(`  ${id} — categories: ${t.consistent_categories.join(', ')} | profile: ${t.should_profile}`);
    }
  }

  if (isDryRun) {
    console.log('\n[DRY RUN] Skipping MongoDB writes.');
    await client.close();
    return;
  }

  // ── Upsert into polymarket-consistentTraders ──────────────────────────────
  process.stdout.write(`\nUpserting ${consistentTraders.length} documents to MongoDB... `);
  const bulkOps = consistentTraders.map(doc => ({
    updateOne: {
      filter: { wallet: doc.wallet },
      update: { $set: doc },
      upsert: true,
    },
  }));
  await outCol.bulkWrite(bulkOps, { ordered: false });
  const upserted = consistentTraders.length;
  process.stdout.write('done\n');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                         SUMMARY                               ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Snapshots loaded:          ${allEntries.length}`);
  console.log(`  Unique wallets scanned:    ${walletMap.size}`);
  console.log(`  Consistent traders found:  ${consistentTraders.length}`);
  console.log(`  Should profile:            ${profileCount}`);
  console.log(`  Upserted to MongoDB:       ${upserted}`);
  console.log(`  Collection:                polymarket-consistentTraders`);
  console.log(`  Updated at:                ${updatedAt.toISOString()}`);
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
