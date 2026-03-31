/**
 * AI Hedge Fund — Category Rankings
 *
 * Reads ahf-alphaTraders and produces a ranked list of top N traders
 * per specialty/category, using a composite score that rewards:
 *   - Specialty-focused ROCE (sub-league aggregated)
 *   - Statistical edge (edge_magnitude × confidence)
 *   - Sample size (log scale)
 *   - Consistency (daysWonRate)
 *
 * Score formula:
 *   specialty_score = specialty_roce_norm × log(n+1) × (1 - p_value) × (daysWonRate/100)
 *
 * Where specialty_roce_norm = log(1 + max(specialty_roce, 0) / 100)
 *
 * Output collection: ahf-categoryRankings
 * {
 *   specialty,
 *   rank,
 *   wallet,
 *   display_name,
 *   specialty_roce,
 *   roce_30d,
 *   win_rate,
 *   win_rate_sample_size,
 *   edge_magnitude,
 *   p_value,
 *   days_won_rate,
 *   sortino_ratio,
 *   insider_probability,
 *   rank_score,
 *   specialty_score,
 *   last_active_days_ago,
 *   category_breakdown,  // sub-league detail
 *   strengths,
 *   updatedAt,
 * }
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/category-rank.ts
 *   npx tsx scripts/ai-hedge-fund/category-rank.ts --top=10
 *   npx tsx scripts/ai-hedge-fund/category-rank.ts --dry-run
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

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

// ── Types ─────────────────────────────────────────────────────────────────────

interface AlphaTrader {
  wallet: string;
  display_name?: string | null;
  pseudonym?: string | null;
  x_username?: string | null;
  specialty: string;
  win_rate: number;
  win_rate_sample_size: number;
  profit_factor: number;
  roce_30d: number;
  pnl_30d: number;
  pnl_7d: number;
  days_won_rate?: number | null;
  sortino_ratio?: number | null;
  edge_magnitude: number;
  p_value: number;
  rank_score: number;
  specialty_roce?: number | null;
  insider_probability?: string;
  last_active_days_ago?: number | null;
  category_breakdown?: unknown[];
  strengths?: unknown[];
  weaknesses?: unknown[];
  filter_passed_at?: Date;
}

interface CategoryRankDoc {
  specialty: string;
  rank: number;
  wallet: string;
  display_name: string | null;
  x_username: string | null;
  specialty_score: number;
  specialty_roce: number | null;
  roce_30d: number;
  pnl_30d: number;
  win_rate: number;
  win_rate_sample_size: number;
  edge_magnitude: number;
  p_value: number;
  days_won_rate: number | null;
  sortino_ratio: number | null;
  insider_probability: string;
  rank_score: number;
  last_active_days_ago: number | null;
  category_breakdown: unknown[];
  strengths: unknown[];
  updatedAt: Date;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * specialty_score rewards traders who are:
 *   1. High ROCE in their specialty (not just overall)
 *   2. Statistically significant (low p-value, large sample)
 *   3. Consistently profitable (high daysWonRate)
 *
 * specialty_roce_norm: log(1 + max(roce, 0) / 100)
 *   - 50% ROCE  → 0.405
 *   - 100% ROCE → 0.693
 *   - 200% ROCE → 1.099
 *
 * When specialty_roce is null (no breakdown data), fall back to roce_30d.
 */
function computeSpecialtyScore(trader: AlphaTrader): number {
  const roce = trader.specialty_roce ?? trader.roce_30d;
  const roceNorm = Math.log(1 + Math.max(roce, 0) / 100);
  const n = trader.win_rate_sample_size;
  const pConf = 1 - Math.min(trader.p_value, 1);
  const consistency = (trader.days_won_rate ?? 50) / 100;
  return roceNorm * Math.log(n + 1) * pConf * consistency;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const isDryRun = hasFlag('dry-run');
  const topN     = parseInt(parseArg('top') ?? '5', 10);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('              CATEGORY RANKINGS — AI HEDGE FUND                ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mode:  ${isDryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`  Top-N: ${topN} traders per specialty`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(extractDbName(mongoUri));
  console.log(`Connected → db: ${extractDbName(mongoUri)}\n`);

  // ── Load alpha traders ────────────────────────────────────────────────────
  console.log('Loading ahf-alphaTraders...');
  const traders = await db
    .collection<AlphaTrader>('ahf-alphaTraders')
    .find({})
    .toArray();

  console.log(`  Loaded ${traders.length} alpha traders\n`);

  if (traders.length === 0) {
    console.log('No alpha traders found. Run filter-alpha-traders.ts first.');
    await client.close();
    return;
  }

  // ── Group by specialty ────────────────────────────────────────────────────
  const grouped = new Map<string, AlphaTrader[]>();
  for (const t of traders) {
    const sp = t.specialty ?? 'Other';
    if (!grouped.has(sp)) grouped.set(sp, []);
    grouped.get(sp)!.push(t);
  }

  console.log(`Specialties found: ${[...grouped.keys()].join(', ')}\n`);

  // ── Rank within each specialty ────────────────────────────────────────────
  const updatedAt = new Date();
  const allRankDocs: CategoryRankDoc[] = [];

  // Sort specialties for deterministic output
  const specialties = [...grouped.keys()].sort();

  for (const specialty of specialties) {
    const group = grouped.get(specialty)!;

    // Compute specialty_score for each trader in this group
    const scored = group.map(t => ({
      trader: t,
      specialty_score: computeSpecialtyScore(t),
    }));

    // Sort by specialty_score descending
    scored.sort((a, b) => b.specialty_score - a.specialty_score);

    const top = scored.slice(0, topN);

    console.log(`\n── ${specialty} (${group.length} traders → top ${Math.min(topN, group.length)}) ─────────────`);

    // Table header
    const header = `${'Rank'.padEnd(5)} ${'Wallet'.padEnd(12)} ${'Name'.padEnd(20)} ${'SpcROCE'.padEnd(9)} ${'ROCE30'.padEnd(8)} ${'WR%'.padEnd(7)} ${'n'.padEnd(5)} ${'DaysW%'.padEnd(8)} ${'Edge'.padEnd(7)} ${'P-val'.padEnd(7)} ${'Score'.padEnd(8)} Insider`;
    const divider = '─'.repeat(header.length);
    console.log(divider);
    console.log(header);
    console.log(divider);

    for (let i = 0; i < top.length; i++) {
      const { trader: t, specialty_score } = top[i];
      const rank = i + 1;
      const name = (t.display_name ?? t.pseudonym ?? t.x_username ?? '') as string;
      const sRoce = t.specialty_roce != null ? t.specialty_roce.toFixed(0) + '%' : '—';

      const row = [
        String(rank).padEnd(5),
        t.wallet.slice(0, 10).padEnd(12),
        name.slice(0, 18).padEnd(20),
        sRoce.padEnd(9),
        (t.roce_30d.toFixed(0) + '%').padEnd(8),
        (t.win_rate.toFixed(1) + '%').padEnd(7),
        String(t.win_rate_sample_size).padEnd(5),
        ((t.days_won_rate ?? 0).toFixed(1) + '%').padEnd(8),
        t.edge_magnitude.toFixed(3).padEnd(7),
        t.p_value.toFixed(3).padEnd(7),
        specialty_score.toFixed(4).padEnd(8),
        t.insider_probability ?? 'none',
      ].join(' ');
      console.log(row);

      allRankDocs.push({
        specialty,
        rank,
        wallet: t.wallet,
        display_name: t.display_name ?? t.pseudonym ?? null,
        x_username: t.x_username ?? null,
        specialty_score,
        specialty_roce: t.specialty_roce ?? null,
        roce_30d: t.roce_30d,
        pnl_30d: t.pnl_30d,
        win_rate: t.win_rate,
        win_rate_sample_size: t.win_rate_sample_size,
        edge_magnitude: t.edge_magnitude,
        p_value: t.p_value,
        days_won_rate: t.days_won_rate ?? null,
        sortino_ratio: t.sortino_ratio ?? null,
        insider_probability: t.insider_probability ?? 'none',
        rank_score: t.rank_score,
        last_active_days_ago: t.last_active_days_ago ?? null,
        category_breakdown: t.category_breakdown ?? [],
        strengths: t.strengths ?? [],
        updatedAt,
      });
    }

    console.log(divider);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Total rankings produced: ${allRankDocs.length}`);
  console.log(`  Specialties ranked:      ${specialties.length}`);
  console.log(`  Top-N per specialty:     ${topN}`);
  console.log(`  Updated at:              ${updatedAt.toISOString()}`);
  if (isDryRun) {
    console.log('  [DRY RUN] Skipping MongoDB writes.');
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (isDryRun) {
    await client.close();
    return;
  }

  // ── Upsert to ahf-categoryRankings ────────────────────────────────────────
  process.stdout.write(`Upserting ${allRankDocs.length} ranking docs to MongoDB... `);
  const col = db.collection('ahf-categoryRankings');
  await col.createIndex({ specialty: 1, rank: 1 }, { unique: true, background: true });
  await col.createIndex({ wallet: 1 }, { background: true });
  await col.createIndex({ specialty: 1, specialty_score: -1 }, { background: true });

  const bulkOps = allRankDocs.map(doc => ({
    updateOne: {
      filter: { specialty: doc.specialty, rank: doc.rank },
      update: { $set: doc },
      upsert: true,
    },
  }));
  await col.bulkWrite(bulkOps, { ordered: false });
  process.stdout.write('done\n');

  // Remove stale rankings (old top-N that no longer qualify)
  const cutoff = new Date(updatedAt.getTime() - 1000); // docs older than this run
  const deleted = await col.deleteMany({ updatedAt: { $lt: cutoff } });
  if (deleted.deletedCount > 0) {
    console.log(`Removed ${deleted.deletedCount} stale ranking docs`);
  }

  console.log('Saved to ahf-categoryRankings\n');
  await client.close();
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
