/**
 * Deep Dive: UFC + NFL Validation
 *
 * Deduplicated market-level analysis (not inflated by time buckets).
 * Subtypes, edge by subtype, unique market PnL simulation.
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/sports/deep-dive-ufc-nfl.ts
 */

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';

const envPaths = [
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.local'),
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
];
for (const p of envPaths) {
  const r = dotenv.config({ path: p });
  if (r.parsed?.BOT_PRIVATE_KEY) break;
}

if (!process.env.MONGODB_URI) { console.error('Fatal: MONGODB_URI not set'); process.exit(1); }

interface PricePoint { t: number; p: number; minsBeforeClose: number; }

function classifyNflSubtype(q: string): string {
  const ql = q.toLowerCase();
  if (/\bvs\.?\b/.test(ql) && /\b(game|matchup|winner)\b/.test(ql)) return 'game';
  if (/\b(vs\.?)\b/.test(ql) && !(/draft|pick|prop|mvp|award|inflation|starter|swift|usher|coin|tails/i.test(ql))) return 'game';
  if (/\b(draft|pick|taken with|first overall|round 1)\b/.test(ql)) return 'draft';
  if (/\b(super bowl|halftime|coin toss|tails|national anthem|usher|swift|parlay|shown more|offensive play)\b/.test(ql)) return 'prop';
  if (/\b(mvp|award|starter|week 1|season|division|playoff|conference)\b/.test(ql)) return 'futures';
  if (/\b(inflation|gdp|unemployment|economic)\b/.test(ql)) return 'non-sport';
  return 'other';
}

function classifyUfcSubtype(q: string): string {
  const ql = q.toLowerCase();
  if (/\bwho will win\b/.test(ql) || /\bvs\.?\b/.test(ql) && !/method|finish|decision|round|ko|submission/.test(ql)) return 'fight';
  if (/\b(finish|ko|tko|knockout|submission|decision|method|round)\b/.test(ql)) return 'method';
  return 'prop';
}

function getPriceAtMins(series: PricePoint[], targetMins: number): number | null {
  let best: PricePoint | null = null;
  let bestDist = Infinity;
  for (const p of series) {
    const dist = Math.abs(p.minsBeforeClose - targetMins);
    if (dist < bestDist) { bestDist = dist; best = p; }
  }
  return best && bestDist < 5 ? best.p : null;
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Deep Dive: UFC + NFL — Market-Level Validation       ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);

  const histories = await db.collection('sportPriceHistory')
    .find({ sport: { $in: ['ufc', 'nfl'] }, dataPoints: { $gte: 20 } })
    .toArray();

  console.log(`  UFC + NFL markets with price history: ${histories.length}\n`);

  // Process each sport separately
  for (const sport of ['ufc', 'nfl'] as const) {
    const sportMarkets = histories.filter(h => h.sport === sport);
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  ${sport.toUpperCase()} — ${sportMarkets.length} unique markets`);
    console.log(`${'═'.repeat(70)}\n`);

    // ── A. Market-level breakdown (deduplicated) ────────────────
    console.log('  A. MARKET-LEVEL BREAKDOWN (one row per market)\n');

    interface MarketRow {
      question: string;
      subtype: string;
      winner: string;
      winnerIndex: number;
      price5m: number | null;
      price30m: number | null;
      price60m: number | null;
      price2hr: number | null;
      leadingPrice5m: number;
      leadingSideWon: boolean;
      priceRange2hr: number; // max - min in last 2 hours
      conditionId: string;
    }

    const rows: MarketRow[] = [];

    console.log(`  ${'W'.padEnd(2)} | ${'@60m'.padEnd(5)} | ${'@30m'.padEnd(5)} | ${'@5m'.padEnd(5)} | ${'Type'.padEnd(8)} | Market`);
    console.log(`  ${'-'.repeat(75)}`);

    for (const market of sportMarkets) {
      const series: PricePoint[] = market.timeSeries || [];
      if (series.length < 5) continue;

      const subtype = sport === 'nfl'
        ? classifyNflSubtype(market.question || '')
        : classifyUfcSubtype(market.question || '');

      const p5 = getPriceAtMins(series, 5);
      const p30 = getPriceAtMins(series, 30);
      const p60 = getPriceAtMins(series, 60);
      const p2hr = getPriceAtMins(series, 120);

      // Leading side at 5 min before close
      const refPrice = p5 ?? p30 ?? series[series.length - 1]?.p ?? 0.5;
      const leadingSideIsYes = refPrice > 0.5;
      const leadingPrice = leadingSideIsYes ? refPrice : (1 - refPrice);
      const leadingSideWon = leadingSideIsYes
        ? (market.winnerIndex === 0)
        : (market.winnerIndex === 1);

      // Context prices (leading side perspective)
      const lp5 = p5 !== null ? (leadingSideIsYes ? p5 : 1 - p5) : null;
      const lp30 = p30 !== null ? (leadingSideIsYes ? p30 : 1 - p30) : null;
      const lp60 = p60 !== null ? (leadingSideIsYes ? p60 : 1 - p60) : null;
      const lp2hr = p2hr !== null ? (leadingSideIsYes ? p2hr : 1 - p2hr) : null;

      // Price range in last 2 hours
      const last2hr = series.filter(s => s.minsBeforeClose <= 120);
      const prices = last2hr.map(s => leadingSideIsYes ? s.p : 1 - s.p);
      const priceRange = prices.length > 1 ? Math.max(...prices) - Math.min(...prices) : 0;

      rows.push({
        question: market.question || '?',
        subtype, winner: market.winner || '?',
        winnerIndex: market.winnerIndex,
        price5m: lp5, price30m: lp30, price60m: lp60, price2hr: lp2hr,
        leadingPrice5m: leadingPrice, leadingSideWon, priceRange2hr: priceRange,
        conditionId: market.conditionId,
      });

      const icon = leadingSideWon ? '✅' : '❌';
      const f5 = lp5 !== null ? `${(lp5 * 100).toFixed(0)}c` : '?';
      const f30 = lp30 !== null ? `${(lp30 * 100).toFixed(0)}c` : '?';
      const f60 = lp60 !== null ? `${(lp60 * 100).toFixed(0)}c` : '?';
      console.log(`  ${icon} | ${f60.padEnd(5)} | ${f30.padEnd(5)} | ${f5.padEnd(5)} | ${subtype.padEnd(8)} | ${(market.question || '?').slice(0, 45)}`);
    }

    // ── B. Edge by subtype ──────────────────────────────────────
    console.log(`\n  B. EDGE BY SUBTYPE\n`);

    const subtypes = [...new Set(rows.map(r => r.subtype))].sort();
    console.log(`  ${'Subtype'.padEnd(12)} | ${'N'.padEnd(4)} | ${'Wins'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'AvgPrice'.padEnd(9)} | Edge`);
    console.log(`  ${'-'.repeat(55)}`);

    for (const st of subtypes) {
      const stRows = rows.filter(r => r.subtype === st);
      const wins = stRows.filter(r => r.leadingSideWon).length;
      const avgP = stRows.reduce((s, r) => s + r.leadingPrice5m, 0) / stRows.length;
      const edge = wins / stRows.length - avgP;
      const flag = stRows.length < 10 ? ' ⚠' : '';
      console.log(`  ${st.padEnd(12)} | ${String(stRows.length).padEnd(4)} | ${String(wins).padEnd(5)} | ${(wins/stRows.length*100).toFixed(1).padEnd(6)}% | ${(avgP*100).toFixed(1).padEnd(8)}c | ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1)}%${flag}`);
    }

    // All combined
    const allWins = rows.filter(r => r.leadingSideWon).length;
    const allAvgP = rows.reduce((s, r) => s + r.leadingPrice5m, 0) / rows.length;
    const allEdge = allWins / rows.length - allAvgP;
    console.log(`  ${'ALL'.padEnd(12)} | ${String(rows.length).padEnd(4)} | ${String(allWins).padEnd(5)} | ${(allWins/rows.length*100).toFixed(1).padEnd(6)}% | ${(allAvgP*100).toFixed(1).padEnd(8)}c | ${allEdge >= 0 ? '+' : ''}${(allEdge*100).toFixed(1)}%`);

    // ── C. Key questions ────────────────────────────────────────
    console.log(`\n  C. KEY QUESTIONS\n`);

    // Pre-event vs in-event
    const preEvent = rows.filter(r => r.priceRange2hr < 0.10);
    const inEvent = rows.filter(r => r.priceRange2hr >= 0.10);
    console.log(`  Pre-event pricing (price moved <10c in 2hr): ${preEvent.length} markets`);
    console.log(`  In-event pricing (price moved ≥10c in 2hr):  ${inEvent.length} markets`);

    // Unique market count
    console.log(`  Unique markets: ${rows.length} (each row = 1 independent bet)`);

    // ── By price bucket (unique markets) ────────────────────────
    console.log(`\n  EDGE BY PRICE BUCKET (unique markets):\n`);
    const priceBuckets = [
      { label: '60-70c', min: 0.60, max: 0.70 },
      { label: '70-75c', min: 0.70, max: 0.75 },
      { label: '75-80c', min: 0.75, max: 0.80 },
      { label: '80-85c', min: 0.80, max: 0.85 },
      { label: '85-90c', min: 0.85, max: 0.90 },
      { label: '90-95c', min: 0.90, max: 0.95 },
      { label: '95c+', min: 0.95, max: 1.01 },
    ];
    console.log(`  ${'Price'.padEnd(10)} | ${'N'.padEnd(4)} | ${'Wins'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'AvgPrice'.padEnd(9)} | Edge    | EV per $100`);
    console.log(`  ${'-'.repeat(70)}`);

    for (const b of priceBuckets) {
      const bucket = rows.filter(r => r.leadingPrice5m >= b.min && r.leadingPrice5m < b.max);
      if (bucket.length === 0) continue;
      const w = bucket.filter(r => r.leadingSideWon).length;
      const avgP = bucket.reduce((s, r) => s + r.leadingPrice5m, 0) / bucket.length;
      const wr = w / bucket.length;
      const edge = wr - avgP;
      const evPer100 = wr * (100 / avgP - 100) - (1 - wr) * 100; // profit per $100 bet
      const flag = bucket.length < 10 ? ' ⚠' : '';
      console.log(`  ${b.label.padEnd(10)} | ${String(bucket.length).padEnd(4)} | ${String(w).padEnd(5)} | ${(wr*100).toFixed(1).padEnd(6)}% | ${(avgP*100).toFixed(1).padEnd(8)}c | ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1).padEnd(6)}% | $${evPer100.toFixed(2)}${flag}`);
    }

    // ── D. Simulated PnL ────────────────────────────────────────
    console.log(`\n  D. SIMULATED PnL — $100 bet on each qualifying market (leading side ≥75c)\n`);

    const qualifying = rows.filter(r => r.leadingPrice5m >= 0.75);
    let totalInvested = 0;
    let totalReturned = 0;
    let winCount = 0;
    let lossCount = 0;

    for (const r of qualifying) {
      const cost = 100; // $100 per bet
      const shares = cost / r.leadingPrice5m;
      totalInvested += cost;
      if (r.leadingSideWon) {
        totalReturned += shares * 1.0; // $1 per share on win
        winCount++;
      }
      // loss = $0 returned
      lossCount += r.leadingSideWon ? 0 : 1;
    }

    const pnl = totalReturned - totalInvested;
    console.log(`  Qualifying markets (≥75c): ${qualifying.length}`);
    console.log(`  Wins: ${winCount} | Losses: ${lossCount} | WR: ${(winCount/qualifying.length*100).toFixed(1)}%`);
    console.log(`  Total invested: $${totalInvested.toFixed(0)}`);
    console.log(`  Total returned: $${totalReturned.toFixed(0)}`);
    console.log(`  Net PnL: $${pnl.toFixed(2)} (${(pnl/totalInvested*100).toFixed(1)}% ROI)`);

    // Breakdown by subtype
    console.log(`\n  PnL by subtype (≥75c):`);
    for (const st of subtypes) {
      const stQ = qualifying.filter(r => r.subtype === st);
      if (stQ.length === 0) continue;
      let inv = 0, ret = 0, w = 0;
      for (const r of stQ) {
        inv += 100;
        if (r.leadingSideWon) { ret += 100 / r.leadingPrice5m; w++; }
      }
      console.log(`    ${st.padEnd(12)} | ${stQ.length} markets | ${w}W/${stQ.length-w}L | Invested $${inv} | PnL $${(ret-inv).toFixed(2)}`);
    }

    // Also simulate at different thresholds
    console.log(`\n  PnL at different entry thresholds:`);
    for (const thresh of [0.60, 0.65, 0.70, 0.75, 0.80]) {
      const q = rows.filter(r => r.leadingPrice5m >= thresh);
      if (q.length === 0) continue;
      let inv = 0, ret = 0, w = 0;
      for (const r of q) {
        inv += 100;
        if (r.leadingSideWon) { ret += 100 / r.leadingPrice5m; w++; }
      }
      console.log(`    ≥${(thresh*100).toFixed(0)}c: ${q.length} markets | ${w}W/${q.length-w}L | WR ${(w/q.length*100).toFixed(1)}% | PnL $${(ret-inv).toFixed(2)} (${((ret-inv)/inv*100).toFixed(1)}% ROI)`);
    }
  }

  console.log('\n');
  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
