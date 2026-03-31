/**
 * AI Hedge Fund — Edge-Ranked Traders
 *
 * Scans ALL polymarket-traderProfiles (no hard filters on ROCE/win_rate/etc.)
 * Ranks purely by statistical edge confidence + magnitude.
 * Only shows confirmed (p < 0.05, n >= 20) and likely (p < 0.15, n >= 10) traders.
 *
 * Edge = actual_win_rate beats implied odds (avg entry price) by a statistically
 * significant margin. Profitable traders without edge may be lucky or size-skillful
 * but are not directionally sharp enough to copy.
 *
 * Output collection: ahf-edgeRankedTraders
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/edge-ranked-traders.ts
 *   npx tsx scripts/ai-hedge-fund/edge-ranked-traders.ts --top=100
 *   npx tsx scripts/ai-hedge-fund/edge-ranked-traders.ts --confidence=confirmed
 *   npx tsx scripts/ai-hedge-fund/edge-ranked-traders.ts --specialty=Soccer
 *   npx tsx scripts/ai-hedge-fund/edge-ranked-traders.ts --dry-run
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

// ── Env ───────────────────────────────────────────────────────────────────────
const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/env.polyagent'),
];
for (const e of envLocations) {
  const r = dotenv.config({ path: e });
  if (!r.error && process.env.MONGODB_URI) break;
}

function extractDbName(uri: string): string {
  try { return new URL(uri).pathname.replace('/', '') || 'polymarket-test'; }
  catch { return uri.match(/\/([^/?]+)(\?|$)/)?.[1] ?? 'polymarket-test'; }
}
function parseArg(flag: string): string | null {
  for (const a of process.argv.slice(2)) {
    const m = a.match(new RegExp(`^--${flag}=(.+)$`));
    if (m) return m[1];
  }
  return null;
}
function hasFlag(flag: string) { return process.argv.slice(2).includes(`--${flag}`); }
function fmtPval(p: number): string {
  if (p < 0.0001) return p.toExponential(1);   // e.g. 3.2e-8
  if (p < 0.001)  return p.toFixed(4);
  return p.toFixed(3);
}
  if (days == null) return '—';
  if (days < 1) return Math.max(1, Math.round(days * 24)) + 'h';
  return Math.round(days) + 'd';
}

// ── Math (same as filter-alpha) ───────────────────────────────────────────────

function logFact(n: number): number {
  let r = 0; for (let i = 2; i <= n; i++) r += Math.log(i); return r;
}
function normalCDF(z: number): number {
  if (z < 0) return 1 - normalCDF(-z);
  const t = 1 / (1 + 0.2316419 * z);
  const p = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-z * z / 2) * p;
}
function pValue(n: number, wins: number, p: number): number {
  if (p <= 0) return wins > 0 ? 0 : 1;
  if (p >= 1) return wins < n ? 0 : 1;
  if (n > 50) {
    const mean = n * p, std = Math.sqrt(n * p * (1 - p));
    if (std === 0) return wins > mean ? 0 : 1;
    return 1 - normalCDF((wins - mean) / std);
  }
  let sum = 0;
  for (let i = wins; i <= n; i++) {
    sum += Math.exp(logFact(n) - logFact(i) - logFact(n - i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(Math.max(sum, 0), 1);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Profile {
  wallet: string;
  display_name?: string | null;
  pseudonym?: string | null;
  specialty?: string;
  win_rate: number;
  win_rate_sample_size: number;
  profitFactor: number;
  wins_closed?: number;
  losses_closed?: number;
  wins_open_resolved?: number;
  losses_open_resolved?: number;
  avg_entry_price_wins?: number | null;
  avg_entry_price_losses?: number | null;
  timeframePnL?: Record<string, {
    roce: number; pnl: number; hasData: boolean;
    tradesPerDay?: number; wins?: number; losses?: number;
  }>;
  tradingConsistency?: { daysWonRate: number; sortinoRatio: number | null; tradingDays: number };
  last_active_days_ago?: number | null;
  insider_probability?: string;
  insider_score?: number;
  totalActivities?: number;
  periodDays?: number;
  category_breakdown?: Array<{
    category: string;
    win_rate: number;
    total_pnl: number;
    capital_deployed?: number;
    capitalDeployed?: number;
    roce?: number;
    closed_positions?: number;
  }>;
}

// ── Specialty metrics (same logic as alpha-trader-analysis) ───────────────────

function getCap(c: { capital_deployed?: number; capitalDeployed?: number }): number {
  return c.capital_deployed ?? c.capitalDeployed ?? 0;
}

function specialtyWinRate(profile: Profile): number | null {
  const breakdown = profile.category_breakdown ?? [];
  const sp = (profile.specialty ?? '').toLowerCase();
  if (!sp || sp === 'other') return null;

  const rows = breakdown.filter(c => {
    const cat = (c.category ?? '').toLowerCase();
    return cat === sp || cat.includes(sp) || sp.includes(cat);
  });
  if (rows.length === 0) return null;

  const aggCap = rows.reduce((s, c) => s + getCap(c), 0);
  return aggCap > 0
    ? rows.reduce((s, c) => s + (c.win_rate ?? 0) * getCap(c), 0) / aggCap
    : rows.reduce((s, c) => s + (c.win_rate ?? 0), 0) / rows.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const topN       = parseInt(parseArg('top') ?? '50', 10);
  const confFilter = parseArg('confidence') ?? null;  // confirmed | likely | both (default both)
  const spFilter   = parseArg('specialty')  ?? null;
  const isDryRun   = hasFlag('dry-run');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error('MONGODB_URI not set'); process.exit(1); }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(extractDbName(mongoUri));

  // Load all v3 profiles (must have tradingConsistency)
  process.stdout.write('Loading profiles... ');
  const profiles = await db
    .collection<Profile>('polymarket-traderProfiles')
    .find({ tradingConsistency: { $exists: true } })
    .toArray();
  console.log(`${profiles.length} v3 profiles loaded`);

  // ── Compute edge for every profile ────────────────────────────────────────
  type Scored = {
    wallet: string;
    display_name: string | null;
    specialty: string;
    win_rate: number;
    n: number;
    expected_wr: number;
    edge: number;
    p_val: number;
    confidence: string;
    rank_score: number;
    roce_30d: number;
    pnl_30d: number;
    pf: number;
    days_won_rate: number | null;
    sortino: number | null;
    act_per_day: number | null;
    last_active: number | null;
    insider: string;
    insider_score: number;
    spc_wr: number | null;
  };

  const scored: Scored[] = [];

  for (const p of profiles) {
    const n   = p.win_rate_sample_size ?? 0;
    if (n < 8) continue;  // absolute minimum — below this, pure noise

    const tf30 = p.timeframePnL?.['30d'];
    if (!tf30?.hasData) continue;

    const wins   = (p.wins_closed ?? 0) + (p.wins_open_resolved ?? 0);
    const losses = (p.losses_closed ?? 0) + (p.losses_open_resolved ?? 0);
    const total  = wins + losses;

    // Expected win rate from implied odds (avg entry price of wins/losses)
    let exp_wr: number;
    if (p.avg_entry_price_wins != null && p.avg_entry_price_losses != null && total > 0) {
      exp_wr = (wins * p.avg_entry_price_wins + losses * p.avg_entry_price_losses) / total;
    } else if (p.avg_entry_price_wins != null) {
      exp_wr = p.avg_entry_price_wins;
    } else {
      exp_wr = 0.50;
    }

    const actual_wr  = p.win_rate / 100;
    const actual_wins = Math.round(actual_wr * n);
    const pv          = pValue(n, actual_wins, exp_wr);
    const edge        = actual_wr - exp_wr;

    // Confidence label
    let confidence: string;
    if      (pv < 0.05 && n >= 20) confidence = 'confirmed';
    else if (pv < 0.15 && n >= 10) confidence = 'likely';
    else if (pv < 0.30)            confidence = 'watch';
    else                           confidence = 'watch';

    // Only keep confirmed + likely (unless overridden)
    const allowedConf = confFilter === 'confirmed'
      ? ['confirmed']
      : confFilter === 'likely'
        ? ['likely']
        : ['confirmed', 'likely'];
    if (!allowedConf.includes(confidence)) continue;

    // Specialty filter
    const specialty = p.specialty ?? 'Other';
    if (spFilter && !specialty.toLowerCase().includes(spFilter.toLowerCase())) continue;

    // Rank score: edge × log(n+1) × confidence × ROCE boost
    const roceBoost = Math.log(1 + Math.max(tf30.roce, 0) / 100);
    const rank_score = edge * Math.log(n + 1) * (1 - Math.min(pv, 1)) * roceBoost;

    const apd = p.totalActivities != null
      ? p.totalActivities / (p.periodDays ?? 30)
      : null;

    scored.push({
      wallet:       p.wallet,
      display_name: p.display_name ?? p.pseudonym ?? null,
      specialty,
      win_rate:     p.win_rate,
      n,
      expected_wr:  exp_wr,
      edge,
      p_val:        pv,
      confidence,
      rank_score,
      roce_30d:     tf30.roce,
      pnl_30d:      tf30.pnl,
      pf:           p.profitFactor ?? 1,
      days_won_rate: p.tradingConsistency?.daysWonRate ?? null,
      sortino:       p.tradingConsistency?.sortinoRatio ?? null,
      act_per_day:  apd,
      last_active:  p.last_active_days_ago ?? null,
      insider:      p.insider_probability ?? 'none',
      insider_score: p.insider_score ?? 0,
      spc_wr:       specialtyWinRate(p),
    });
  }

  // Sort by rank_score descending
  scored.sort((a, b) => b.rank_score - a.rank_score);

  // ── Print table ─────────────────────────────────────────────────────────────
  const header = [
    'Rank'.padEnd(5),
    'Wallet'.padEnd(44),
    'WinRate'.padEnd(9),
    'ExpWR'.padEnd(7),
    'n'.padEnd(5),
    'Edge'.padEnd(7),
    'P-val'.padEnd(7),
    'Conf'.padEnd(11),
    'ROCE30'.padEnd(8),
    'PnL30'.padEnd(10),
    'PF'.padEnd(6),
    'DaysW%'.padEnd(8),
    'Sortino'.padEnd(9),
    'SpcWR%'.padEnd(8),
    'Act/d'.padEnd(7),
    'Last'.padEnd(6),
    'Insider'.padEnd(8),
    'Specialty',
  ].join('');
  const div = '─'.repeat(header.length);

  const confLabel = confFilter ?? 'confirmed+likely';
  const totalInPool = scored.length;

  console.log('\n' + div);
  console.log(`  EDGE-RANKED TRADERS  |  pool: ${totalInPool}  |  showing top: ${Math.min(topN, totalInPool)}  |  filter: ${confLabel}${spFilter ? ' / ' + spFilter : ''}`);
  console.log(`  Source: ALL ${profiles.length} v3 profiles — no hard filters on ROCE/win_rate/PF`);
  console.log(`  Edge = actual win rate beats implied odds (avg entry price) at p<0.05 (confirmed) or p<0.15 (likely)`);
  console.log(div);
  console.log(header);
  console.log(div);

  // Specialty column breakouts
  const confCounts: Record<string, number> = {};
  const spCounts:   Record<string, number> = {};

  scored.slice(0, topN).forEach((t, i) => {
    confCounts[t.confidence] = (confCounts[t.confidence] ?? 0) + 1;
    spCounts[t.specialty]    = (spCounts[t.specialty] ?? 0) + 1;

    const row = [
      String(i + 1).padEnd(5),
      t.wallet.padEnd(44),
      (t.win_rate.toFixed(1) + '%').padEnd(9),
      (t.expected_wr * 100).toFixed(1).padEnd(7),
      String(t.n).padEnd(5),
      t.edge.toFixed(3).padEnd(7),
      fmtPval(t.p_val).padEnd(7),
      t.confidence.padEnd(11),
      (t.roce_30d.toFixed(0) + '%').padEnd(8),
      ('$' + (t.pnl_30d / 1000).toFixed(1) + 'k').padEnd(10),
      t.pf.toFixed(2).padEnd(6),
      t.days_won_rate != null ? (t.days_won_rate.toFixed(1) + '%').padEnd(8) : '—'.padEnd(8),
      t.sortino       != null ? t.sortino.toFixed(2).padEnd(9)               : '—'.padEnd(9),
      t.spc_wr        != null ? (t.spc_wr.toFixed(1) + '%').padEnd(8)        : '—'.padEnd(8),
      t.act_per_day   != null ? t.act_per_day.toFixed(1).padEnd(7)           : '—'.padEnd(7),
      fmtAge(t.last_active).padEnd(6),
      t.insider.padEnd(8),
      t.specialty,
    ].join('');
    console.log(row);
  });

  console.log(div);

  // Summary
  const confStr = Object.entries(confCounts).map(([k, v]) => `${k}=${v}`).join(', ');
  const spStr   = Object.entries(spCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  console.log(`\nTotal in edge pool: ${totalInPool} | Showing: ${Math.min(topN, totalInPool)}`);
  console.log(`Confidence: ${confStr}`);
  console.log(`Specialties (top ${Math.min(topN, totalInPool)}): ${spStr}`);

  if (isDryRun) {
    console.log('\n[dry-run] Skipping MongoDB write.');
    await client.close();
    return;
  }

  // ── Upsert to ahf-edgeRankedTraders ───────────────────────────────────────
  process.stdout.write(`\nSaving ${scored.length} edge traders to ahf-edgeRankedTraders... `);
  const col  = db.collection('ahf-edgeRankedTraders');
  const now  = new Date();
  const ops  = scored.map((t, i) => ({
    updateOne: {
      filter: { wallet: t.wallet },
      update: { $set: { ...t, overall_rank: i + 1, updatedAt: now } },
      upsert: true,
    },
  }));
  await col.bulkWrite(ops, { ordered: false });
  await col.createIndex({ wallet: 1 },      { unique: true, background: true });
  await col.createIndex({ rank_score: -1 }, { background: true });
  await col.createIndex({ confidence: 1 },  { background: true });
  await col.createIndex({ specialty: 1 },   { background: true });
  // Remove traders that no longer qualify (were in previous run but no longer confirmed/likely)
  const deleted = await col.deleteMany({ updatedAt: { $lt: now } });
  if (deleted.deletedCount > 0) console.log(`(removed ${deleted.deletedCount} stale) `);
  process.stdout.write('done\n');

  console.log(`\nUsage:`);
  console.log(`  --top=100              show top 100`);
  console.log(`  --confidence=confirmed only confirmed (p<0.05, n>=20)`);
  console.log(`  --confidence=likely    only likely (p<0.15, n>=10)`);
  console.log(`  --specialty=Soccer     filter to specialty`);
  console.log(`  --dry-run              skip DB write\n`);

  await client.close();
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(err => { console.error('Error:', err.message); process.exit(1); });
}
