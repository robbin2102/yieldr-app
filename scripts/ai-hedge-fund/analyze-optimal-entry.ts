/**
 * Optimal Entry Price Analyzer for BTC 5m Markets
 *
 * Phase 1: Collects price history data for ALL BTC 5m markets over X days,
 *          caches to a JSON file.
 * Phase 2: Runs statistical analysis to find the optimal late-stage entry
 *          price that minimizes reversals and maximizes EV.
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/analyze-optimal-entry.ts --days 3
 *   npx tsx scripts/ai-hedge-fund/analyze-optimal-entry.ts --days 7 --refresh
 *   npx tsx scripts/ai-hedge-fund/analyze-optimal-entry.ts --days 1 --concurrency 30
 */

import * as fs from 'fs';
import * as path from 'path';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

// ── CLI args ──────────────────────────────────────────────────────────────────

const ARGS = process.argv.slice(2);
const OPT = (name: string, fallback: string): string => {
  const idx = ARGS.indexOf(`--${name}`);
  return idx !== -1 && ARGS[idx + 1] ? ARGS[idx + 1] : fallback;
};
const FLAG = (name: string): boolean => ARGS.includes(`--${name}`);

const DAYS = parseInt(OPT('days', '3'));
const CONCURRENCY = parseInt(OPT('concurrency', '20'));
const FORCE_REFRESH = FLAG('refresh');

// ── Types ─────────────────────────────────────────────────────────────────────

interface PricePoint { t: number; p: number; }

interface MarketInfo {
  slug: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  cycleOpen: number;
  cycleClose: number;
  priceToBeat: number;
  finalPrice: number;
  winner: 'Up' | 'Down' | 'Unknown';
}

interface CycleData {
  market: MarketInfo;
  upPrices: PricePoint[];
  downPrices: PricePoint[];
}

interface CacheFile {
  fetchedAt: number;
  days: number;
  cycles: CycleData[];
}

// ── Phase 1: Data Collection ──────────────────────────────────────────────────

function generateSlugs(days: number): string[] {
  const now = Math.floor(Date.now() / 1000);
  const start = now - (days * 24 * 60 * 60);
  const slugs: string[] = [];
  let ts = Math.floor(start / 300) * 300;
  while (ts < now - 600) {
    slugs.push(`btc-updown-5m-${ts}`);
    ts += 300;
  }
  return slugs;
}

async function fetchMarketWithResolution(slug: string): Promise<MarketInfo | null> {
  try {
    const res = await fetch(`${GAMMA_API}/events?slug=${slug}`);
    if (!res.ok) return null;
    const events = await res.json() as any[];
    if (!events?.[0]?.markets?.[0]) return null;

    const event = events[0];
    const market = event.markets[0];
    const meta = event.eventMetadata || {};

    let tokenIds: string[] = [];
    try { tokenIds = JSON.parse(market.clobTokenIds); }
    catch { tokenIds = (market.clobTokenIds || '').split(',').map((s: string) => s.trim()); }

    const cycleOpen = parseInt(slug.match(/btc-updown-5m-(\d+)/)?.[1] || '0');
    const priceToBeat = meta.priceToBeat || 0;
    const finalPrice = meta.finalPrice || 0;

    let winner: 'Up' | 'Down' | 'Unknown' = 'Unknown';
    if (finalPrice > 0 && priceToBeat > 0) {
      winner = finalPrice > priceToBeat ? 'Up' : 'Down';
    } else {
      const op = market.outcomePrices;
      if (op === '["1", "0"]' || op === '[1, 0]') winner = 'Up';
      else if (op === '["0", "1"]' || op === '[0, 1]') winner = 'Down';
    }

    return {
      slug, conditionId: market.conditionId,
      upTokenId: tokenIds[0] || '', downTokenId: tokenIds[1] || '',
      cycleOpen, cycleClose: cycleOpen + 300,
      priceToBeat, finalPrice, winner,
    };
  } catch { return null; }
}

async function fetchPriceHistory(tokenId: string, startTs: number, endTs: number): Promise<PricePoint[]> {
  try {
    const res = await fetch(`${CLOB_API}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=1`);
    if (!res.ok) return [];
    const data = await res.json() as { history: PricePoint[] };
    return data.history || [];
  } catch { return []; }
}

async function fetchAllCycles(slugs: string[], concurrency: number): Promise<CycleData[]> {
  const cycles: CycleData[] = [];
  let idx = 0;
  let fetched = 0, failed = 0, noData = 0;

  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= slugs.length) break;

      const market = await fetchMarketWithResolution(slugs[i]);
      if (!market || !market.upTokenId || market.winner === 'Unknown') { failed++; continue; }

      const [upPrices, downPrices] = await Promise.all([
        fetchPriceHistory(market.upTokenId, market.cycleOpen, market.cycleClose),
        fetchPriceHistory(market.downTokenId, market.cycleOpen, market.cycleClose),
      ]);

      if (upPrices.length === 0 && downPrices.length === 0) { noData++; continue; }

      cycles.push({ market, upPrices, downPrices });
      fetched++;

      if (fetched % 50 === 0) {
        console.log(`  ${fetched} fetched, ${failed} failed, ${noData} no data (${((i + 1) / slugs.length * 100).toFixed(0)}%)`);
      }
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  console.log(`  Done: ${fetched} cycles, ${failed} failed, ${noData} no data`);
  return cycles.sort((a, b) => a.market.cycleOpen - b.market.cycleOpen);
}

function getCachePath(days: number): string {
  return path.join(__dirname, `btc5m-price-data-${days}d.json`);
}

function isCacheValid(cachePath: string): boolean {
  if (!fs.existsSync(cachePath)) return false;
  const stat = fs.statSync(cachePath);
  const ageMs = Date.now() - stat.mtimeMs;
  const sixHours = 6 * 60 * 60 * 1000;
  return ageMs < sixHours;
}

async function loadOrFetchData(days: number, concurrency: number, forceRefresh: boolean): Promise<CycleData[]> {
  const cachePath = getCachePath(days);

  if (!forceRefresh && isCacheValid(cachePath)) {
    console.log(`[Cache] Loading from ${path.basename(cachePath)} (< 6 hours old)`);
    const raw: CacheFile = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    console.log(`[Cache] Loaded ${raw.cycles.length} cycles (fetched ${new Date(raw.fetchedAt).toISOString()})`);
    return raw.cycles;
  }

  console.log(`[Fetch] Generating slugs for ${days} day(s)...`);
  const slugs = generateSlugs(days);
  console.log(`[Fetch] ${slugs.length} slugs generated. Fetching with concurrency=${concurrency}...`);

  const cycles = await fetchAllCycles(slugs, concurrency);

  const cacheData: CacheFile = { fetchedAt: Date.now(), days, cycles };
  fs.writeFileSync(cachePath, JSON.stringify(cacheData));
  const sizeMb = (fs.statSync(cachePath).size / 1024 / 1024).toFixed(1);
  console.log(`[Cache] Saved ${cycles.length} cycles to ${path.basename(cachePath)} (${sizeMb} MB)`);

  return cycles;
}

// ── Phase 2: Statistical Analysis ─────────────────────────────────────────────

const ENTRY_THRESHOLDS = [0.75, 0.80, 0.85, 0.90, 0.95];
const WINDOWS = [60, 90, 120, 150, 180, 240];

interface EntryAnalysis {
  threshold: number;
  window: number;
  triggered: number;
  wins: number;
  losses: number;
  winRate: number;
  reversalRate: number;
  evPerDollar: number;
  pnlPer100: number;
  annRoce: number;
  // For Sharpe-like calculation
  pnlValues: number[];
}

function analyzeEntry(cycles: CycleData[], threshold: number, window: number): EntryAnalysis {
  let triggered = 0;
  let wins = 0;
  let losses = 0;
  const pnlValues: number[] = [];

  for (const cycle of cycles) {
    const { market, upPrices, downPrices } = cycle;
    const windowStart = market.cycleClose - window;
    const windowEnd = market.cycleClose;

    // Find if either side reaches the threshold in the window
    let triggeredSide: 'Up' | 'Down' | null = null;
    let triggeredTime = Infinity;

    for (const p of upPrices) {
      if (p.t < windowStart || p.t > windowEnd) continue;
      if (p.p >= threshold) {
        if (p.t < triggeredTime) {
          triggeredSide = 'Up';
          triggeredTime = p.t;
        }
        break;
      }
    }

    for (const p of downPrices) {
      if (p.t < windowStart || p.t > windowEnd) continue;
      if (p.p >= threshold) {
        if (p.t < triggeredTime) {
          triggeredSide = 'Down';
          triggeredTime = p.t;
        }
        break;
      }
    }

    if (!triggeredSide) continue;

    triggered++;
    const won = triggeredSide === market.winner;
    if (won) {
      wins++;
      const profitPerDollar = 1 / threshold - 1;
      pnlValues.push(profitPerDollar);
    } else {
      losses++;
      pnlValues.push(-1);
    }
  }

  const winRate = triggered > 0 ? wins / triggered : 0;
  const reversalRate = triggered > 0 ? losses / triggered : 0;
  const profitPerDollar = 1 / threshold - 1;
  const evPerDollar = winRate * profitPerDollar - (1 - winRate) * 1;
  const pnlPer100 = evPerDollar * 100;

  // Annualized ROCE: assume cycles per day based on trigger rate
  const cyclesPerDay = cycles.length / DAYS;
  const triggeredPerDay = triggered / DAYS;
  const dailyRoce = triggeredPerDay > 0 ? evPerDollar * triggeredPerDay / cyclesPerDay : 0;
  const annRoce = dailyRoce * 365 * 100;

  return {
    threshold, window, triggered, wins, losses,
    winRate, reversalRate, evPerDollar, pnlPer100, annRoce,
    pnlValues,
  };
}

function computeSharpe(pnlValues: number[]): number {
  if (pnlValues.length < 2) return 0;
  const mean = pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length;
  const variance = pnlValues.reduce((s, v) => s + (v - mean) ** 2, 0) / (pnlValues.length - 1);
  const std = Math.sqrt(variance);
  return std > 0 ? mean / std : 0;
}

// ── Price Trajectory Analysis ─────────────────────────────────────────────────

interface TrajectoryBucket {
  secsBeforeClose: number;
  winningPrices: number[];
  losingPrices: number[];
}

function analyzeTrajectories(cycles: CycleData[]): TrajectoryBucket[] {
  const bucketSecs = [240, 210, 180, 150, 120, 90, 60, 30, 10];
  const buckets: TrajectoryBucket[] = bucketSecs.map(s => ({
    secsBeforeClose: s,
    winningPrices: [],
    losingPrices: [],
  }));

  for (const cycle of cycles) {
    const { market, upPrices, downPrices } = cycle;
    const winnerPrices = market.winner === 'Up' ? upPrices : downPrices;
    const loserPrices = market.winner === 'Up' ? downPrices : upPrices;

    for (const bucket of buckets) {
      const targetTime = market.cycleClose - bucket.secsBeforeClose;
      // Find closest price snapshot to target time
      const winSnap = findClosestPrice(winnerPrices, targetTime, 15);
      const loseSnap = findClosestPrice(loserPrices, targetTime, 15);
      if (winSnap !== null) bucket.winningPrices.push(winSnap);
      if (loseSnap !== null) bucket.losingPrices.push(loseSnap);
    }
  }

  return buckets;
}

function findClosestPrice(prices: PricePoint[], targetTime: number, toleranceSecs: number): number | null {
  let closest: PricePoint | null = null;
  let minDist = Infinity;
  for (const p of prices) {
    const dist = Math.abs(p.t - targetTime);
    if (dist < minDist) {
      minDist = dist;
      closest = p;
    }
  }
  return closest && minDist <= toleranceSecs ? closest.p : null;
}

// ── Reversal Timing Analysis ──────────────────────────────────────────────────

interface ReversalTiming {
  threshold: number;
  earlyReversals: number; // triggered in first half of window, then lost
  lateReversals: number;  // triggered in second half of window, then lost
  earlyTotal: number;
  lateTotal: number;
}

function analyzeReversalTiming(cycles: CycleData[]): ReversalTiming[] {
  const results: ReversalTiming[] = [];
  const window = 180; // Use 180s window for timing analysis

  for (const threshold of ENTRY_THRESHOLDS) {
    let earlyReversals = 0, lateReversals = 0;
    let earlyTotal = 0, lateTotal = 0;

    for (const cycle of cycles) {
      const { market, upPrices, downPrices } = cycle;
      const windowStart = market.cycleClose - window;
      const windowMid = market.cycleClose - window / 2;
      const windowEnd = market.cycleClose;

      let triggeredSide: 'Up' | 'Down' | null = null;
      let triggeredTime = Infinity;

      for (const p of upPrices) {
        if (p.t < windowStart || p.t > windowEnd) continue;
        if (p.p >= threshold && p.t < triggeredTime) {
          triggeredSide = 'Up';
          triggeredTime = p.t;
          break;
        }
      }
      for (const p of downPrices) {
        if (p.t < windowStart || p.t > windowEnd) continue;
        if (p.p >= threshold && p.t < triggeredTime) {
          triggeredSide = 'Down';
          triggeredTime = p.t;
          break;
        }
      }

      if (!triggeredSide) continue;

      const isEarly = triggeredTime < windowMid;
      const lost = triggeredSide !== market.winner;

      if (isEarly) {
        earlyTotal++;
        if (lost) earlyReversals++;
      } else {
        lateTotal++;
        if (lost) lateReversals++;
      }
    }

    results.push({ threshold, earlyReversals, lateReversals, earlyTotal, lateTotal });
  }

  return results;
}

// ── Output Formatting ─────────────────────────────────────────────────────────

function pad(s: string, n: number, align: 'left' | 'right' = 'right'): string {
  return align === 'right' ? s.padStart(n) : s.padEnd(n);
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '='.repeat(65));
  console.log('       OPTIMAL ENTRY PRICE ANALYZER — BTC 5m Markets');
  console.log('='.repeat(65));
  console.log(`  Days:           ${DAYS}`);
  console.log(`  Concurrency:    ${CONCURRENCY}`);
  console.log(`  Force refresh:  ${FORCE_REFRESH}`);

  // ── Phase 1: Load or fetch data ──
  console.log(`\n${'─'.repeat(65)}`);
  console.log('  PHASE 1: Data Collection');
  console.log('─'.repeat(65));

  const cycles = await loadOrFetchData(DAYS, CONCURRENCY, FORCE_REFRESH);

  if (cycles.length === 0) {
    console.error('No cycle data available. Exiting.');
    process.exit(1);
  }

  console.log(`\n  Total cycles with data: ${cycles.length}`);
  const upWins = cycles.filter(c => c.market.winner === 'Up').length;
  const downWins = cycles.filter(c => c.market.winner === 'Down').length;
  console.log(`  Up wins: ${upWins} (${(upWins / cycles.length * 100).toFixed(1)}%) | Down wins: ${downWins} (${(downWins / cycles.length * 100).toFixed(1)}%)`);

  // ── Phase 2: Analysis ──
  console.log(`\n${'─'.repeat(65)}`);
  console.log('  PHASE 2: Statistical Analysis');
  console.log('─'.repeat(65));

  // Run analysis for all threshold/window combos
  const analyses: EntryAnalysis[] = [];
  for (const threshold of ENTRY_THRESHOLDS) {
    for (const window of WINDOWS) {
      analyses.push(analyzeEntry(cycles, threshold, window));
    }
  }

  // ── Main Results Table ──
  console.log(`\n${'='.repeat(95)}`);
  console.log(`       OPTIMAL ENTRY PRICE ANALYSIS — ${DAYS} days, ${cycles.length} cycles`);
  console.log('='.repeat(95));

  const hdr = [
    pad('Entry Price', 12, 'left'),
    pad('Window', 7, 'left'),
    pad('Triggered', 10),
    pad('Wins', 6),
    pad('WR%', 7),
    pad('Rev%', 7),
    pad('EV/$', 7),
    pad('PnL/$100', 9),
    pad('Ann.ROCE', 9),
  ].join(' | ');
  console.log(hdr);
  console.log(hdr.replace(/[^|]/g, '─').replace(/\|/g, '|'));

  for (const a of analyses) {
    if (a.triggered === 0) continue;
    const row = [
      pad(`${(a.threshold * 100).toFixed(0)}c`, 12, 'left'),
      pad(`${a.window}s`, 7, 'left'),
      pad(String(a.triggered), 10),
      pad(String(a.wins), 6),
      pad(pct(a.winRate), 7),
      pad(pct(a.reversalRate), 7),
      pad(a.evPerDollar.toFixed(3), 7),
      pad('$' + a.pnlPer100.toFixed(2), 9),
      pad((a.annRoce.toFixed(0)) + '%', 9),
    ].join(' | ');
    console.log(row);
  }

  // ── Price Trajectory Analysis ──
  console.log(`\n${'='.repeat(65)}`);
  console.log('  PRICE TRAJECTORY: Average price at time buckets');
  console.log('  (winning side vs losing side)');
  console.log('='.repeat(65));

  const trajectories = analyzeTrajectories(cycles);
  console.log(`  ${'Secs before close'.padEnd(20)} | ${'Winner avg'.padStart(11)} | ${'Loser avg'.padStart(11)} | ${'Spread'.padStart(8)} | ${'N'.padStart(5)}`);
  console.log(`  ${'─'.repeat(20)} | ${'─'.repeat(11)} | ${'─'.repeat(11)} | ${'─'.repeat(8)} | ${'─'.repeat(5)}`);

  for (const b of trajectories) {
    if (b.winningPrices.length === 0) continue;
    const wAvg = b.winningPrices.reduce((s, v) => s + v, 0) / b.winningPrices.length;
    const lAvg = b.losingPrices.length > 0
      ? b.losingPrices.reduce((s, v) => s + v, 0) / b.losingPrices.length
      : 0;
    const spread = wAvg - lAvg;
    console.log(
      `  ${(b.secsBeforeClose + 's').padEnd(20)} | ${wAvg.toFixed(3).padStart(11)} | ${lAvg.toFixed(3).padStart(11)} | ${spread.toFixed(3).padStart(8)} | ${String(b.winningPrices.length).padStart(5)}`
    );
  }

  // ── Reversal Timing Analysis ──
  console.log(`\n${'='.repeat(65)}`);
  console.log('  REVERSAL TIMING (180s window): Early vs Late triggers');
  console.log('  Early = triggered 180-90s before close');
  console.log('  Late  = triggered  90-0s before close');
  console.log('='.repeat(65));

  const reversalTimings = analyzeReversalTiming(cycles);
  console.log(`  ${'Threshold'.padEnd(10)} | ${'Early triggers'.padStart(15)} | ${'Early rev%'.padStart(11)} | ${'Late triggers'.padStart(14)} | ${'Late rev%'.padStart(10)}`);
  console.log(`  ${'─'.repeat(10)} | ${'─'.repeat(15)} | ${'─'.repeat(11)} | ${'─'.repeat(14)} | ${'─'.repeat(10)}`);

  for (const rt of reversalTimings) {
    const earlyRevPct = rt.earlyTotal > 0 ? (rt.earlyReversals / rt.earlyTotal * 100).toFixed(1) + '%' : 'N/A';
    const lateRevPct = rt.lateTotal > 0 ? (rt.lateReversals / rt.lateTotal * 100).toFixed(1) + '%' : 'N/A';
    console.log(
      `  ${((rt.threshold * 100).toFixed(0) + 'c').padEnd(10)} | ${String(rt.earlyTotal).padStart(15)} | ${earlyRevPct.padStart(11)} | ${String(rt.lateTotal).padStart(14)} | ${lateRevPct.padStart(10)}`
    );
  }

  // ── Best Strategy Recommendation ──
  console.log(`\n${'='.repeat(65)}`);
  console.log('  STRATEGY RECOMMENDATION (ranked by Sharpe-like EV/StdDev)');
  console.log('='.repeat(65));

  const ranked = analyses
    .filter(a => a.triggered >= 10)
    .map(a => ({
      ...a,
      sharpe: computeSharpe(a.pnlValues),
    }))
    .sort((a, b) => b.sharpe - a.sharpe);

  console.log(`  ${'Rank'.padEnd(5)} | ${'Entry'.padEnd(6)} | ${'Window'.padEnd(7)} | ${'Sharpe'.padStart(7)} | ${'EV/$'.padStart(7)} | ${'WR%'.padStart(7)} | ${'Trig'.padStart(5)} | ${'PnL/$100'.padStart(9)}`);
  console.log(`  ${'─'.repeat(5)} | ${'─'.repeat(6)} | ${'─'.repeat(7)} | ${'─'.repeat(7)} | ${'─'.repeat(7)} | ${'─'.repeat(7)} | ${'─'.repeat(5)} | ${'─'.repeat(9)}`);

  const topN = Math.min(15, ranked.length);
  for (let i = 0; i < topN; i++) {
    const a = ranked[i];
    console.log(
      `  ${String(i + 1).padEnd(5)} | ${((a.threshold * 100).toFixed(0) + 'c').padEnd(6)} | ${(a.window + 's').padEnd(7)} | ${a.sharpe.toFixed(3).padStart(7)} | ${a.evPerDollar.toFixed(3).padStart(7)} | ${pct(a.winRate).padStart(7)} | ${String(a.triggered).padStart(5)} | ${'$' + a.pnlPer100.toFixed(2).padStart(8)}`
    );
  }

  if (ranked.length > 0) {
    const best = ranked[0];
    console.log(`\n  >>> BEST STRATEGY: Buy at ${(best.threshold * 100).toFixed(0)}c within ${best.window}s of close`);
    console.log(`      Sharpe: ${best.sharpe.toFixed(3)} | EV/dollar: ${best.evPerDollar.toFixed(3)} | Win rate: ${pct(best.winRate)} | Reversals: ${pct(best.reversalRate)}`);
    console.log(`      Expected PnL per $100 wagered: $${best.pnlPer100.toFixed(2)}`);
    console.log(`      Triggered in ${best.triggered}/${cycles.length} cycles (${(best.triggered / cycles.length * 100).toFixed(1)}%)`);
  }

  // ── Quick reference: EV formula ──
  console.log(`\n${'─'.repeat(65)}`);
  console.log('  EV FORMULA REFERENCE:');
  console.log('    EV/$ = WR x profit_per_$ - (1-WR) x 1.0');
  console.log('    profit_per_$ at 75c = 1/0.75 - 1 = 0.333');
  console.log('    profit_per_$ at 80c = 1/0.80 - 1 = 0.250');
  console.log('    profit_per_$ at 85c = 1/0.85 - 1 = 0.176');
  console.log('    profit_per_$ at 90c = 1/0.90 - 1 = 0.111');
  console.log('    profit_per_$ at 95c = 1/0.95 - 1 = 0.053');
  console.log('─'.repeat(65));
  console.log('');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
