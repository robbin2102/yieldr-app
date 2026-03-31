/**
 * AI Hedge Fund — Alpha Trader Analysis Table
 *
 * Reads ahf-alphaTraders and prints a ranked table with specialty-level
 * metrics derived from category_breakdown (no reprofile needed).
 *
 * Columns:
 *   Rank  Wallet  Name  WinRate  n  PF  ROCE30  SpcWR%  SpcPnL  PnL30  Edge  P-val  EdgeConf  Insider  Specialty
 *
 * SpcWR%  = specialty win rate (weighted by capital, from category_breakdown)
 * SpcPnL  = specialty total_pnl (sum across all matching sub-league rows)
 *           NOTE: based on last ~1000 closed positions — NOT limited to 30d
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/alpha-trader-analysis.ts
 *   npx tsx scripts/ai-hedge-fund/alpha-trader-analysis.ts --sort=specialty_wr
 *   npx tsx scripts/ai-hedge-fund/alpha-trader-analysis.ts --specialty=Soccer
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

// ── Types ─────────────────────────────────────────────────────────────────────

interface CatRow {
  category: string;
  win_rate: number;
  total_pnl: number;
  capital_deployed: number;
  roce?: number;
  closed_positions?: number;
}

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
  category_breakdown?: CatRow[];
  strengths?: unknown[];
  weaknesses?: unknown[];
}

// ── Specialty metrics from category_breakdown ─────────────────────────────────

interface SpecialtyMetrics {
  win_rate: number | null;   // capital-weighted win rate across matching rows
  total_pnl: number | null;  // sum of total_pnl across matching rows
  roce: number | null;       // aggregated ROCE (re-derived from sums)
  rows: number;              // how many sub-league rows matched
  note: string;              // e.g. "1 row" / "3 rows (Soccer sub-leagues)" / "no match"
}

function getSpecialtyMetrics(trader: AlphaTrader): SpecialtyMetrics {
  const breakdown = trader.category_breakdown ?? [];
  const sp = trader.specialty?.toLowerCase() ?? '';

  if (breakdown.length === 0 || !sp || sp === 'other') {
    // For "Other", just return the "Other" row directly if it exists
    const otherRows = breakdown.filter(c => c.category?.toLowerCase() === 'other');
    if (otherRows.length === 0) return { win_rate: null, total_pnl: null, roce: null, rows: 0, note: 'no match' };
    const aggPnl = otherRows.reduce((s, c) => s + (c.total_pnl ?? 0), 0);
    const aggCap = otherRows.reduce((s, c) => s + (c.capital_deployed ?? 0), 0);
    const aggWr  = aggCap > 0
      ? otherRows.reduce((s, c) => s + (c.win_rate ?? 0) * (c.capital_deployed ?? 0), 0) / aggCap
      : null;
    return {
      win_rate: aggWr,
      total_pnl: aggPnl,
      roce: aggCap > 0 ? (aggPnl / aggCap) * 100 : null,
      rows: otherRows.length,
      note: `${otherRows.length} row(s)`,
    };
  }

  // Match rows where category contains or equals specialty
  const matching = breakdown.filter(c => {
    const cat = c.category?.toLowerCase() ?? '';
    return cat === sp || cat.includes(sp) || sp.includes(cat);
  });

  if (matching.length === 0) {
    return { win_rate: null, total_pnl: null, roce: null, rows: 0, note: 'no match' };
  }

  const aggPnl = matching.reduce((s, c) => s + (c.total_pnl ?? 0), 0);
  const aggCap = matching.reduce((s, c) => s + (c.capital_deployed ?? 0), 0);

  // Capital-weighted win rate
  const aggWr = aggCap > 0
    ? matching.reduce((s, c) => s + (c.win_rate ?? 0) * (c.capital_deployed ?? 0), 0) / aggCap
    : (matching.reduce((s, c) => s + (c.win_rate ?? 0), 0) / matching.length);

  const roce = aggCap > 0 ? (aggPnl / aggCap) * 100 : null;
  const rowLabel = matching.length === 1 ? '1 row' : `${matching.length} rows`;

  return { win_rate: aggWr, total_pnl: aggPnl, roce, rows: matching.length, note: rowLabel };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const sortBy    = parseArg('sort')     ?? 'rank_score';   // rank_score | specialty_wr | specialty_pnl
  const filterSp  = parseArg('specialty') ?? null;           // filter to single specialty

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(extractDbName(mongoUri));

  // ── Load alpha traders ──────────────────────────────────────────────────────
  const query = filterSp ? { specialty: new RegExp(filterSp, 'i') } : {};
  const traders = await db
    .collection<AlphaTrader>('ahf-alphaTraders')
    .find(query)
    .toArray();

  await client.close();

  if (traders.length === 0) {
    console.log('No alpha traders found. Run filter-alpha-traders.ts first.');
    return;
  }

  // ── Compute specialty metrics + sort ────────────────────────────────────────
  const rows = traders.map(t => ({
    trader: t,
    spc: getSpecialtyMetrics(t),
  }));

  if (sortBy === 'specialty_wr') {
    rows.sort((a, b) => (b.spc.win_rate ?? 0) - (a.spc.win_rate ?? 0));
  } else if (sortBy === 'specialty_pnl') {
    rows.sort((a, b) => (b.spc.total_pnl ?? 0) - (a.spc.total_pnl ?? 0));
  } else {
    rows.sort((a, b) => b.trader.rank_score - a.trader.rank_score);
  }

  // ── Print table ─────────────────────────────────────────────────────────────
  const header = [
    'Rank'.padEnd(5),
    'Wallet'.padEnd(12),
    'Name'.padEnd(20),
    'WinRate'.padEnd(9),
    'n'.padEnd(5),
    'PF'.padEnd(6),
    'ROCE30'.padEnd(8),
    'SpcWR%'.padEnd(8),   // replaces SpcROCE — specialty win rate (last ~1000 positions)
    'SpcPnL'.padEnd(10),  // specialty total PnL (last ~1000 positions)
    'PnL30'.padEnd(10),
    'Edge'.padEnd(7),
    'P-val'.padEnd(7),
    'EdgeConf'.padEnd(10),
    'Insider'.padEnd(8),
    'Specialty',
  ].join('');

  const divider = '─'.repeat(header.length);

  console.log('\n' + divider);
  console.log(`  ALPHA TRADER ANALYSIS  |  sorted by: ${sortBy}  |  traders: ${rows.length}`);
  if (filterSp) console.log(`  Filtered to specialty: ${filterSp}`);
  console.log(`  NOTE: SpcWR% and SpcPnL are from last ~1000 closed positions (not 30d-limited)`);
  console.log(divider);
  console.log(header);
  console.log(divider);

  rows.forEach(({ trader: t, spc }, i) => {
    const name = (t.display_name ?? t.pseudonym ?? t.x_username ?? '') as string;
    const spcWr   = spc.win_rate  != null ? spc.win_rate.toFixed(1) + '%'  : '—';
    const spcPnl  = spc.total_pnl != null
      ? (spc.total_pnl >= 0 ? '+' : '') + '$' + (spc.total_pnl / 1000).toFixed(1) + 'k'
      : '—';

    const cells = [
      String(i + 1).padEnd(5),
      t.wallet.slice(0, 10).padEnd(12),
      name.slice(0, 18).padEnd(20),
      (t.win_rate.toFixed(1) + '%').padEnd(9),
      String(t.win_rate_sample_size).padEnd(5),
      t.profit_factor.toFixed(2).padEnd(6),
      (t.roce_30d.toFixed(0) + '%').padEnd(8),
      spcWr.padEnd(8),
      spcPnl.padEnd(10),
      ('$' + (t.pnl_30d / 1000).toFixed(1) + 'k').padEnd(10),
      t.edge_magnitude.toFixed(3).padEnd(7),
      t.p_value.toFixed(3).padEnd(7),
      (t.edge_confidence as string ?? '?').padEnd(10),
      (t.insider_probability ?? 'none').padEnd(8),
      t.specialty,
    ].join('');
    console.log(cells);
  });

  console.log(divider);

  // ── Specialty summary ──────────────────────────────────────────────────────
  const bySp = new Map<string, typeof rows>();
  for (const r of rows) {
    const sp = r.trader.specialty;
    if (!bySp.has(sp)) bySp.set(sp, []);
    bySp.get(sp)!.push(r);
  }

  console.log('\n── Specialty Summary ─────────────────────────────────────────────');
  console.log(['Specialty'.padEnd(16), 'Count'.padEnd(7), 'AvgROCE30'.padEnd(12), 'AvgSpcWR%'.padEnd(12), 'TotalSpcPnL'].join(''));
  console.log('─'.repeat(70));

  const spSorted = [...bySp.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [sp, group] of spSorted) {
    const avgRoce  = group.reduce((s, r) => s + r.trader.roce_30d, 0) / group.length;
    const withWr   = group.filter(r => r.spc.win_rate != null);
    const avgSpcWr = withWr.length > 0
      ? withWr.reduce((s, r) => s + r.spc.win_rate!, 0) / withWr.length
      : null;
    const totalSpcPnl = group.reduce((s, r) => s + (r.spc.total_pnl ?? 0), 0);

    console.log([
      sp.padEnd(16),
      String(group.length).padEnd(7),
      (avgRoce.toFixed(0) + '%').padEnd(12),
      avgSpcWr != null ? (avgSpcWr.toFixed(1) + '%').padEnd(12) : '—'.padEnd(12),
      (totalSpcPnl >= 0 ? '+' : '') + '$' + (totalSpcPnl / 1000).toFixed(1) + 'k',
    ].join(''));
  }

  console.log('─'.repeat(70));
  console.log(`\nTotal: ${rows.length} alpha traders across ${bySp.size} specialties`);
  console.log(`\nUsage:`);
  console.log(`  --sort=rank_score    (default: overall rank)`);
  console.log(`  --sort=specialty_wr  (sort by SpcWR% descending)`);
  console.log(`  --sort=specialty_pnl (sort by SpcPnL descending)`);
  console.log(`  --specialty=Soccer   (filter to one specialty)\n`);
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
