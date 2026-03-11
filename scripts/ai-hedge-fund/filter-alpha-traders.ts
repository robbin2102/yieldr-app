/**
 * AI Hedge Fund — Filter Alpha Traders (Part 3)
 *
 * Stage 1: Hard filters on polymarket-traderProfiles
 * Stage 2: Edge scoring with binomial p-value (no external libs)
 * Stage 3: Upsert qualified traders to ahf-alphaTraders
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/filter-alpha-traders.ts
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, Db } from 'mongodb';

// ── Env loading ───────────────────────────────────────────────────────────────
const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
];
for (const envPath of envLocations) {
  const result = dotenv.config({ path: envPath });
  if (!result.error && process.env.MONGODB_URI) break;
}

// ── Env helpers ───────────────────────────────────────────────────────────────
function getEnvNum(key: string, def: number): number {
  const val = process.env[key];
  return val !== undefined ? parseFloat(val) : def;
}
function getEnvBool(key: string, def: boolean): boolean {
  const val = process.env[key];
  return val !== undefined ? val === 'true' : def;
}

// ── Math helpers (no external libs) ──────────────────────────────────────────

function logFactorial(n: number): number {
  let result = 0;
  for (let i = 2; i <= n; i++) result += Math.log(i);
  return result;
}

function logBinomialCoeff(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * Normal CDF via Abramowitz & Stegun approximation (7.1.26)
 */
function normalCDF(z: number): number {
  if (z < 0) return 1 - normalCDF(-z);
  const t = 1 / (1 + 0.2316419 * z);
  const poly =
    t * (0.31938153 +
    t * (-0.356563782 +
    t * (1.781477937 +
    t * (-1.821255978 +
    t * 1.330274429))));
  return 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-z * z / 2) * poly;
}

/**
 * One-tailed p-value: P(X >= actualWins | n, p)
 * Normal approximation for n > 50, exact binomial for n <= 50
 */
function computePValue(n: number, actualWins: number, p: number): number {
  if (p <= 0) return actualWins > 0 ? 0 : 1;
  if (p >= 1) return actualWins < n ? 0 : 1;

  if (n > 50) {
    const mean = n * p;
    const std = Math.sqrt(n * p * (1 - p));
    if (std === 0) return actualWins > mean ? 0 : 1;
    const z = (actualWins - mean) / std;
    return 1 - normalCDF(z);
  }

  // Exact binomial: P(X >= k) computed in log space
  let sum = 0;
  for (let i = actualWins; i <= n; i++) {
    const logProb =
      logBinomialCoeff(n, i) +
      i * Math.log(p) +
      (n - i) * Math.log(1 - p);
    sum += Math.exp(logProb);
  }
  return Math.min(Math.max(sum, 0), 1);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TimeframeBucket {
  roce: number;
  pnl: number;
  hasData: boolean;
  maxDrawdownAmt?: number | null;
  maxDrawdownPct?: number | null;
}

interface TraderProfile {
  wallet: string;
  display_name?: string | null;
  pseudonym?: string | null;
  x_username?: string | null;
  account_age_days?: number | null;
  last_active_days_ago?: number | null;
  specialty?: string;
  win_rate: number;
  win_rate_sample_size: number;
  profitFactor: number;
  timeframePnL?: Record<string, TimeframeBucket>;
  pnlConsistency?: { score: number };
  max_drawdown_30d_pct?: number | null;
  avg_unique_markets_per_day_7d?: { value: number; sample_days: number; is_low_sample: boolean } | null;
  fragmentation_ratio?: number | null;
  wins_closed?: number;
  losses_closed?: number;
  wins_open_resolved?: number;
  losses_open_resolved?: number;
  avg_entry_price_wins?: number | null;
  avg_entry_price_losses?: number | null;
  insider_probability?: string;
  insider_score?: number;
  insider_signals_fired?: string[];
  capital_trend?: string;
  drawdown_trend?: string;
  baseline_snapshot?: Record<string, unknown>;
  category_breakdown?: unknown[];
  market_titles_summary?: unknown[];
  strengths?: unknown[];
  weaknesses?: unknown[];
  profiledAt?: Date;
}

export interface FilterResult {
  passed: number;
  scanned: number;
  confirmed: number;
  likely: number;
  watch: number;
  insiderHigh: number;
  insiderMedium: number;
  insiderLow: number;
  activeCount: number;
  staleFiltered: number;
  botFiltered: number;
  specialties: Record<string, number>;
}

// ── Core logic (exported for pipeline use) ────────────────────────────────────

export async function filterAlphaTraders(db: Db): Promise<FilterResult> {
  // Filter thresholds from .env.local with defaults
  const THRESHOLDS = {
    minSampleSize:     getEnvNum('FILTER_MIN_WIN_RATE_SAMPLE_SIZE', 8),
    minWinRate:        getEnvNum('FILTER_MIN_WIN_RATE', 50),
    minProfitFactor:   getEnvNum('FILTER_MIN_PROFIT_FACTOR', 1.1),
    minRoce30d:        getEnvNum('FILTER_MIN_ROCE_30D', 20),
    minConsistency:    getEnvNum('FILTER_MIN_PNL_CONSISTENCY', 30),
    maxInactiveDays:   getEnvNum('FILTER_MAX_INACTIVE_DAYS', 14),
    maxMarketsPerDay:  getEnvNum('FILTER_MAX_MARKETS_PER_DAY_7D', 15),
    maxDrawdown30d:    getEnvNum('FILTER_MAX_DRAWDOWN_30D_PCT', 40),
    requirePos7d:      getEnvBool('FILTER_REQUIRE_POSITIVE_7D', true),
    requirePos30d:     getEnvBool('FILTER_REQUIRE_POSITIVE_30D', true),
  };

  console.log('  Thresholds:');
  console.log(`    win_rate >= ${THRESHOLDS.minWinRate}% | sample >= ${THRESHOLDS.minSampleSize} | PF >= ${THRESHOLDS.minProfitFactor}`);
  console.log(`    ROCE30 >= ${THRESHOLDS.minRoce30d}% | consistency >= ${THRESHOLDS.minConsistency} | maxDD <= ${THRESHOLDS.maxDrawdown30d}%`);
  console.log(`    inactive <= ${THRESHOLDS.maxInactiveDays}d | max_markets/day <= ${THRESHOLDS.maxMarketsPerDay} | pos7d:${THRESHOLDS.requirePos7d} pos30d:${THRESHOLDS.requirePos30d}`);

  console.log('\n  Loading profiles...');
  const profiles = await db
    .collection<TraderProfile>('polymarket-traderProfiles')
    .find({})
    .toArray();

  const scanned = profiles.length;
  console.log(`  Loaded ${scanned} profiles\n`);

  const alphaTraders: Record<string, unknown>[] = [];
  let staleFiltered = 0;
  let botFiltered = 0;
  const specialties: Record<string, number> = {};
  const stats = {
    confirmed: 0, likely: 0, watch: 0,
    insiderHigh: 0, insiderMedium: 0, insiderLow: 0,
    activeCount: 0,
  };

  for (const profile of profiles) {

    // ── STAGE 1: HARD FILTERS ─────────────────────────────────────────────────

    // Minimum sample size for any statistical validity
    if ((profile.win_rate_sample_size ?? 0) < THRESHOLDS.minSampleSize) continue;

    // Uses corrected win rate from 1000 closed + resolved open positions
    if ((profile.win_rate ?? 0) < THRESHOLDS.minWinRate) continue;

    // cashFlow-based: profitFactor = totalInflows/totalBuys
    // 1.0 = break even, 1.5 = 50% return on all capital deployed
    if ((profile.profitFactor ?? 0) < THRESHOLDS.minProfitFactor) continue;

    const tf30 = profile.timeframePnL?.['30d'];
    const tf7  = profile.timeframePnL?.['7d'];
    if (!tf30?.hasData) continue;
    if ((tf30.roce ?? -Infinity) < THRESHOLDS.minRoce30d) continue;

    if ((profile.pnlConsistency?.score ?? -Infinity) < THRESHOLDS.minConsistency) continue;

    // Skip if inactive too long (skip filter if null)
    if (profile.last_active_days_ago != null) {
      if (profile.last_active_days_ago > THRESHOLDS.maxInactiveDays) {
        staleFiltered++;
        continue;
      }
    }

    // Bot filter — skip if null
    const marketsPerDay = profile.avg_unique_markets_per_day_7d?.value;
    if (marketsPerDay != null) {
      if (marketsPerDay > THRESHOLDS.maxMarketsPerDay) {
        botFiltered++;
        continue;
      }
    }

    // Skip if null
    const maxDD = profile.max_drawdown_30d_pct;
    if (maxDD != null && maxDD > THRESHOLDS.maxDrawdown30d) continue;

    if (THRESHOLDS.requirePos7d && tf7?.hasData && tf7.pnl <= 0) continue;
    if (THRESHOLDS.requirePos30d && tf30.pnl <= 0) continue;

    // ── STAGE 2: EDGE SCORING ─────────────────────────────────────────────────

    const winsCount   = (profile.wins_closed ?? 0) + (profile.wins_open_resolved ?? 0);
    const lossesCount = (profile.losses_closed ?? 0) + (profile.losses_open_resolved ?? 0);
    const total = winsCount + lossesCount;

    let expected_win_rate: number;
    const haveWinPrice  = profile.avg_entry_price_wins  != null;
    const haveLossPrice = profile.avg_entry_price_losses != null;

    if (haveWinPrice && haveLossPrice && total > 0) {
      // Weighted avg implied probability across all their bets
      expected_win_rate =
        (winsCount * profile.avg_entry_price_wins! + lossesCount * profile.avg_entry_price_losses!) / total;
    } else if (haveWinPrice) {
      expected_win_rate = profile.avg_entry_price_wins!;
    } else {
      expected_win_rate = 0.50; // fallback
    }

    const actual_win_rate = profile.win_rate / 100;
    const n               = profile.win_rate_sample_size;
    const actual_wins     = Math.round(actual_win_rate * n);

    const p_value       = computePValue(n, actual_wins, expected_win_rate);
    const edge_magnitude = actual_win_rate - expected_win_rate;
    const rank_score    = edge_magnitude * Math.log(n + 1) * (1 - Math.min(p_value, 1));

    let edge_confidence: string;
    if (n < 8) {
      edge_confidence = 'insufficient'; // should not reach here given sample_size filter above
    } else if (p_value < 0.05 && n >= 20) {
      edge_confidence = 'confirmed';
      stats.confirmed++;
    } else if (p_value < 0.15 && n >= 10) {
      edge_confidence = 'likely';
      stats.likely++;
    } else if (p_value < 0.30 || n < 10) {
      edge_confidence = 'watch';
      stats.watch++;
    } else {
      edge_confidence = 'watch';
      stats.watch++;
    }

    // ── Track stats ───────────────────────────────────────────────────────────
    if (profile.last_active_days_ago != null && profile.last_active_days_ago <= 14) {
      stats.activeCount++;
    }
    if (profile.insider_probability === 'high')        stats.insiderHigh++;
    else if (profile.insider_probability === 'medium') stats.insiderMedium++;
    else if (profile.insider_probability === 'low')    stats.insiderLow++;

    const specialty = profile.specialty ?? 'Other';
    specialties[specialty] = (specialties[specialty] ?? 0) + 1;

    // ── STAGE 3: BUILD ahf-alphaTraders DOCUMENT ──────────────────────────────
    alphaTraders.push({
      wallet: profile.wallet.toLowerCase(),
      display_name:  profile.display_name  ?? null,
      pseudonym:     profile.pseudonym     ?? null,
      x_username:    profile.x_username    ?? null,
      account_age_days:    profile.account_age_days    ?? null,
      last_active_days_ago: profile.last_active_days_ago ?? null,
      specialty,

      // Core filter metrics
      win_rate:              profile.win_rate,
      win_rate_sample_size:  n,
      profit_factor:         profile.profitFactor,
      roce_30d:              tf30.roce,
      pnl_7d:                tf7?.pnl  ?? 0,
      pnl_30d:               tf30.pnl,
      pnl_consistency_score: profile.pnlConsistency?.score ?? 0,
      max_drawdown_30d_pct:  profile.max_drawdown_30d_pct  ?? null,
      avg_unique_markets_per_day_7d: profile.avg_unique_markets_per_day_7d ?? null,
      fragmentation_ratio:   profile.fragmentation_ratio   ?? null,

      // Edge scoring
      expected_win_rate,
      edge_magnitude,
      p_value,
      rank_score,
      edge_confidence,

      // Insider
      insider_probability:   profile.insider_probability  ?? 'none',
      insider_score:         profile.insider_score        ?? 0,
      insider_signals_fired: profile.insider_signals_fired ?? [],

      // For LLM (Part 4)
      category_breakdown:   profile.category_breakdown   ?? [],
      market_titles_summary: (profile.market_titles_summary ?? []).slice(0, 50),
      strengths:            profile.strengths  ?? [],
      weaknesses:           profile.weaknesses ?? [],
      avg_entry_price_wins:   profile.avg_entry_price_wins   ?? null,
      avg_entry_price_losses: profile.avg_entry_price_losses ?? null,

      // LLM outputs — null until edge-discovery-batch runs
      edge_type:        null,
      edge_hypothesis:  null,
      strength_markets: null,
      weakness_markets: null,
      price_range_min:  null,
      price_range_max:  null,
      sustainability:   null,
      follow_rules:     null,
      llm_analyzed_at:  null,

      // Signal tracking — null until generate-signals runs
      signal_count:   0,
      last_signal_at: null,

      // Monitoring
      baseline_snapshot:  profile.baseline_snapshot ?? null,
      profiled_at:        profile.profiledAt ?? null,
      filter_passed_at:   new Date(),
      last_monitored_at:  null,
    });
  }

  // ── Upsert to ahf-alphaTraders ────────────────────────────────────────────
  const col = db.collection('ahf-alphaTraders');
  for (const doc of alphaTraders) {
    await col.updateOne(
      { wallet: doc.wallet },
      { $set: doc },
      { upsert: true }
    );
  }

  // ── Create indexes ────────────────────────────────────────────────────────
  await col.createIndex({ wallet: 1 }, { unique: true, background: true });
  await col.createIndex({ rank_score: -1 }, { background: true });
  await col.createIndex({ edge_confidence: 1 }, { background: true });
  await col.createIndex({ last_active_days_ago: 1 }, { background: true });

  // ── Console output: sorted table (top 100) ────────────────────────────────
  const sorted = [...alphaTraders].sort(
    (a, b) => (b.rank_score as number) - (a.rank_score as number)
  );

  const COL = [5, 12, 20, 9, 8, 7, 9, 14, 12, 10, 0];
  const headers = ['Rank', 'Wallet', 'Name', 'WinRate', 'Sample', 'PF', 'ROCE30', 'PnL30', 'EdgeConf', 'Insider', 'Specialty'];
  const divider = '─'.repeat(116);

  console.log('\n' + divider);
  console.log(headers.map((h, i) => i < COL.length - 1 ? h.padEnd(COL[i]) : h).join(''));
  console.log(divider);

  sorted.slice(0, 100).forEach((t, i) => {
    const cells = [
      String(i + 1),
      (t.wallet as string).slice(0, 10),
      ((t.display_name ?? t.pseudonym ?? '') as string).slice(0, 18) || '—',
      (t.win_rate as number).toFixed(1) + '%',
      String(t.win_rate_sample_size),
      (t.profit_factor as number).toFixed(2),
      (t.roce_30d as number).toFixed(1) + '%',
      '$' + ((t.pnl_30d as number) / 1000).toFixed(1) + 'k',
      t.edge_confidence as string,
      (t.insider_probability as string) ?? 'none',
      t.specialty as string,
    ];
    console.log(cells.map((c, i) => i < COL.length - 1 ? c.padEnd(COL[i]) : c).join(''));
  });

  console.log(divider);

  // Summary
  console.log(`\nScanned ${scanned} profiles → passed filters: ${alphaTraders.length}`);
  console.log(`Confidence: confirmed=${stats.confirmed}, likely=${stats.likely}, watch=${stats.watch}`);
  console.log(`Insider: high=${stats.insiderHigh}, medium=${stats.insiderMedium}, low=${stats.insiderLow}`);
  console.log(`Active (<=14d): ${stats.activeCount} | Filtered stale: ${staleFiltered}`);
  console.log(`Bot filtered (>15 mkts/day): ${botFiltered}`);

  const specOrder = ['Soccer', 'NBA', 'NFL', 'Politics', 'Crypto', 'Other'];
  const specParts = specOrder
    .filter(s => specialties[s])
    .map(s => `${s}=${specialties[s]}`);
  for (const [k, v] of Object.entries(specialties)) {
    if (!specOrder.includes(k)) specParts.push(`${k}=${v}`);
  }
  console.log(`Specialties: ${specParts.join(', ')}`);
  console.log('Saved to ahf-alphaTraders');

  return {
    passed: alphaTraders.length,
    scanned,
    ...stats,
    staleFiltered,
    botFiltered,
    specialties,
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function extractDbName(uri: string): string {
  try {
    const url = new URL(uri);
    return url.pathname.replace('/', '') || 'polymarket-test';
  } catch {
    return uri.match(/\/([^/?]+)(\?|$)/)?.[1] ?? 'polymarket-test';
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(extractDbName(mongoUri));
  console.log(`Connected → db: ${extractDbName(mongoUri)}\n`);

  try {
    await filterAlphaTraders(db);
  } finally {
    await client.close();
  }
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
