/**
 * Analyze Non-Sports/Crypto Market Edge
 *
 * Deduplicated: one row per unique market. Measures WR vs entry price
 * at 75c, 80c, 85c, 90c, 95c. Out-of-sample validation.
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/sports/analyze-general-edge.ts
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

function getPriceAtMins(series: PricePoint[], targetMins: number): number | null {
  let best: PricePoint | null = null;
  let bestDist = Infinity;
  for (const p of series) {
    const dist = Math.abs(p.minsBeforeClose - targetMins);
    if (dist < bestDist) { bestDist = dist; best = p; }
  }
  return best && bestDist < 10 ? best.p : null;
}

interface MarketRow {
  conditionId: string;
  question: string;
  category: string;
  endDate: string;
  winnerIndex: number;
  leadingPrice: number;     // at 5m before close
  leadingSideIsYes: boolean;
  leadingSideWon: boolean;
  price60m: number | null;
  price30m: number | null;
  price15m: number | null;
  price5m: number | null;
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   General Market Edge Analysis (Non-Sports/Crypto)     ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);

  const histories = await db.collection('generalPriceHistory')
    .find({ dataPoints: { $gte: 5 } })
    .sort({ endDate: 1 })
    .toArray();

  console.log(`  Markets with price history: ${histories.length}\n`);
  if (histories.length === 0) {
    console.log('  No data! Run fetch-general-markets.ts first.');
    await client.close();
    return;
  }

  // ── Build market rows (deduplicated) ──────────────────────────
  const rows: MarketRow[] = [];

  for (const market of histories) {
    const series: PricePoint[] = market.timeSeries || [];
    if (series.length < 3) continue;

    const p5 = getPriceAtMins(series, 5);
    const p15 = getPriceAtMins(series, 15);
    const p30 = getPriceAtMins(series, 30);
    const p60 = getPriceAtMins(series, 60);

    const refPrice = p5 ?? p15 ?? series[series.length - 1]?.p ?? 0.5;
    const leadingSideIsYes = refPrice > 0.5;
    const leadingPrice = leadingSideIsYes ? refPrice : (1 - refPrice);
    const leadingSideWon = leadingSideIsYes
      ? (market.winnerIndex === 0)
      : (market.winnerIndex === 1);

    const lp5 = p5 !== null ? (leadingSideIsYes ? p5 : 1 - p5) : null;
    const lp15 = p15 !== null ? (leadingSideIsYes ? p15 : 1 - p15) : null;
    const lp30 = p30 !== null ? (leadingSideIsYes ? p30 : 1 - p30) : null;
    const lp60 = p60 !== null ? (leadingSideIsYes ? p60 : 1 - p60) : null;

    rows.push({
      conditionId: market.conditionId,
      question: market.question || '?',
      category: market.category || 'other',
      endDate: market.endDate || '',
      winnerIndex: market.winnerIndex,
      leadingPrice, leadingSideIsYes, leadingSideWon,
      price60m: lp60, price30m: lp30, price15m: lp15, price5m: lp5,
    });
  }

  console.log(`  Unique markets: ${rows.length}\n`);

  // Category breakdown
  const cats = new Map<string, number>();
  for (const r of rows) cats.set(r.category, (cats.get(r.category) || 0) + 1);

  // ── 1. OVERALL BASELINE ───────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  1. OVERALL — Win Rate by Price Bucket (unique markets)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const priceBuckets = [
    { label: '<60c', min: 0.50, max: 0.60 },
    { label: '60-70c', min: 0.60, max: 0.70 },
    { label: '70-75c', min: 0.70, max: 0.75 },
    { label: '75-80c', min: 0.75, max: 0.80 },
    { label: '80-85c', min: 0.80, max: 0.85 },
    { label: '85-90c', min: 0.85, max: 0.90 },
    { label: '90-95c', min: 0.90, max: 0.95 },
    { label: '95c+', min: 0.95, max: 1.01 },
  ];

  console.log(`  ${'Price'.padEnd(10)} | ${'N'.padEnd(5)} | ${'Wins'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'AvgPrice'.padEnd(9)} | Edge    | EV/$100`);
  console.log(`  ${'-'.repeat(65)}`);

  for (const b of priceBuckets) {
    const bucket = rows.filter(r => r.leadingPrice >= b.min && r.leadingPrice < b.max);
    if (bucket.length === 0) continue;
    const w = bucket.filter(r => r.leadingSideWon).length;
    const avgP = bucket.reduce((s, r) => s + r.leadingPrice, 0) / bucket.length;
    const wr = w / bucket.length;
    const edge = wr - avgP;
    const ev = wr * (100 / avgP - 100) - (1 - wr) * 100;
    const flag = bucket.length < 10 ? ' ⚠' : '';
    console.log(`  ${b.label.padEnd(10)} | ${String(bucket.length).padEnd(5)} | ${String(w).padEnd(5)} | ${(wr*100).toFixed(1).padEnd(6)}% | ${(avgP*100).toFixed(1).padEnd(8)}c | ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1).padEnd(6)}% | $${ev.toFixed(2)}${flag}`);
  }

  // ── 2. BY CATEGORY ────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  2. BY CATEGORY — Edge at ≥75c (unique markets)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const sortedCats = [...cats.entries()].sort((a, b) => b[1] - a[1]);

  console.log(`  ${'Category'.padEnd(15)} | ${'Total'.padEnd(5)} | ${'≥75c'.padEnd(5)} | ${'Wins'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'AvgP'.padEnd(6)} | Edge    | PnL/$100`);
  console.log(`  ${'-'.repeat(75)}`);

  for (const [cat] of sortedCats) {
    const catRows = rows.filter(r => r.category === cat);
    const q75 = catRows.filter(r => r.leadingPrice >= 0.75);
    if (q75.length === 0) {
      console.log(`  ${cat.padEnd(15)} | ${String(catRows.length).padEnd(5)} | 0     |       |         |        |         |`);
      continue;
    }
    const w = q75.filter(r => r.leadingSideWon).length;
    const avgP = q75.reduce((s, r) => s + r.leadingPrice, 0) / q75.length;
    const wr = w / q75.length;
    const edge = wr - avgP;
    let pnl = 0;
    for (const r of q75) { pnl += r.leadingSideWon ? (100 / r.leadingPrice - 100) : -100; }
    const flag = q75.length < 10 ? ' ⚠' : '';
    console.log(`  ${cat.padEnd(15)} | ${String(catRows.length).padEnd(5)} | ${String(q75.length).padEnd(5)} | ${String(w).padEnd(5)} | ${(wr*100).toFixed(1).padEnd(6)}% | ${(avgP*100).toFixed(1).padEnd(5)}c | ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1).padEnd(6)}% | $${pnl.toFixed(0)}${flag}`);
  }

  // ── 3. PRICE BUCKET × CATEGORY ────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  3. PRICE BUCKET × CATEGORY (top categories only)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const topCats = sortedCats.filter(([_, n]) => n >= 10).slice(0, 6).map(([c]) => c);

  for (const cat of topCats) {
    const catRows = rows.filter(r => r.category === cat);
    console.log(`  ${cat.toUpperCase()} (${catRows.length} markets):`);
    console.log(`  ${'Price'.padEnd(10)} | ${'N'.padEnd(4)} | ${'W'.padEnd(4)} | ${'WR%'.padEnd(7)} | ${'AvgP'.padEnd(6)} | Edge`);
    console.log(`  ${'-'.repeat(45)}`);

    for (const b of priceBuckets) {
      const bucket = catRows.filter(r => r.leadingPrice >= b.min && r.leadingPrice < b.max);
      if (bucket.length === 0) continue;
      const w = bucket.filter(r => r.leadingSideWon).length;
      const avgP = bucket.reduce((s, r) => s + r.leadingPrice, 0) / bucket.length;
      const wr = w / bucket.length;
      const edge = wr - avgP;
      const flag = bucket.length < 10 ? ' ⚠' : '';
      console.log(`  ${b.label.padEnd(10)} | ${String(bucket.length).padEnd(4)} | ${String(w).padEnd(4)} | ${(wr*100).toFixed(1).padEnd(6)}% | ${(avgP*100).toFixed(1).padEnd(5)}c | ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1)}%${flag}`);
    }
    console.log('');
  }

  // ── 4. OUT-OF-SAMPLE VALIDATION ───────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  4. OUT-OF-SAMPLE — Train (60%) vs Validate (40%)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const splitIdx = Math.floor(rows.length * 0.6);
  const trainRows = rows.slice(0, splitIdx);
  const valRows = rows.slice(splitIdx);

  console.log(`  Train: ${trainRows.length} markets | Validate: ${valRows.length} markets\n`);

  console.log(`  ${'Price'.padEnd(10)} | ${'Train N'.padEnd(8)} | ${'Train WR'.padEnd(9)} | ${'Train Edge'.padEnd(11)} | ${'Val N'.padEnd(6)} | ${'Val WR'.padEnd(9)} | ${'Val Edge'.padEnd(9)} | Survived?`);
  console.log(`  ${'-'.repeat(85)}`);

  for (const b of priceBuckets) {
    const train = trainRows.filter(r => r.leadingPrice >= b.min && r.leadingPrice < b.max);
    const val = valRows.filter(r => r.leadingPrice >= b.min && r.leadingPrice < b.max);
    if (train.length < 3 && val.length < 3) continue;

    const tWr = train.length > 0 ? train.filter(r => r.leadingSideWon).length / train.length : 0;
    const tAvg = train.length > 0 ? train.reduce((s, r) => s + r.leadingPrice, 0) / train.length : 0;
    const tEdge = tWr - tAvg;
    const vWr = val.length > 0 ? val.filter(r => r.leadingSideWon).length / val.length : 0;
    const vAvg = val.length > 0 ? val.reduce((s, r) => s + r.leadingPrice, 0) / val.length : 0;
    const vEdge = vWr - vAvg;

    const survived = tEdge > 0.02 && vEdge > 0.02 ? '✅ YES' : tEdge > 0.02 && vEdge <= 0 ? '❌ NO' : '—';

    console.log(
      `  ${b.label.padEnd(10)} | ${String(train.length).padEnd(8)} | ${(tWr*100).toFixed(1).padEnd(8)}% | ${(tEdge >= 0 ? '+' : '') + (tEdge*100).toFixed(1) + '%'}`.padEnd(54) +
      ` | ${String(val.length).padEnd(6)} | ${(vWr*100).toFixed(1).padEnd(8)}% | ${(vEdge >= 0 ? '+' : '') + (vEdge*100).toFixed(1)}% | ${survived}`
    );
  }

  // Per-category OOS for ≥75c
  console.log(`\n  Per-category OOS (≥75c):`);
  console.log(`  ${'Category'.padEnd(15)} | ${'Train'.padEnd(6)} | ${'Train Edge'.padEnd(11)} | ${'Val'.padEnd(5)} | ${'Val Edge'.padEnd(9)} | Survived?`);
  console.log(`  ${'-'.repeat(60)}`);

  for (const [cat] of sortedCats.filter(([_, n]) => n >= 10)) {
    const catTrain = trainRows.filter(r => r.category === cat && r.leadingPrice >= 0.75);
    const catVal = valRows.filter(r => r.category === cat && r.leadingPrice >= 0.75);
    if (catTrain.length < 3 && catVal.length < 3) continue;

    const tWr = catTrain.length > 0 ? catTrain.filter(r => r.leadingSideWon).length / catTrain.length : 0;
    const tAvg = catTrain.length > 0 ? catTrain.reduce((s, r) => s + r.leadingPrice, 0) / catTrain.length : 0;
    const vWr = catVal.length > 0 ? catVal.filter(r => r.leadingSideWon).length / catVal.length : 0;
    const vAvg = catVal.length > 0 ? catVal.reduce((s, r) => s + r.leadingPrice, 0) / catVal.length : 0;
    const tEdge = tWr - tAvg;
    const vEdge = vWr - vAvg;
    const survived = tEdge > 0.02 && vEdge > 0.02 ? '✅' : tEdge > 0.02 && vEdge <= 0 ? '❌' : '—';

    console.log(`  ${cat.padEnd(15)} | ${String(catTrain.length).padEnd(6)} | ${(tEdge >= 0 ? '+' : '') + (tEdge*100).toFixed(1)}%`.padEnd(40) + ` | ${String(catVal.length).padEnd(5)} | ${(vEdge >= 0 ? '+' : '') + (vEdge*100).toFixed(1)}% | ${survived}`);
  }

  // ── 5. OPPORTUNITY VOLUME ─────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  5. OPPORTUNITY VOLUME — Markets per week at ≥75c');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Calculate date range
  const dates = rows.map(r => new Date(r.endDate).getTime()).filter(d => !isNaN(d));
  if (dates.length > 1) {
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    const weeks = (maxDate.getTime() - minDate.getTime()) / (7 * 86400000);

    console.log(`  Date range: ${minDate.toISOString().slice(0, 10)} to ${maxDate.toISOString().slice(0, 10)} (${weeks.toFixed(1)} weeks)\n`);

    console.log(`  ${'Category'.padEnd(15)} | ${'Total ≥75c'.padEnd(11)} | ${'Per week'.padEnd(9)} | ${'WR%'.padEnd(7)} | Edge`);
    console.log(`  ${'-'.repeat(55)}`);

    for (const [cat] of sortedCats) {
      const q75 = rows.filter(r => r.category === cat && r.leadingPrice >= 0.75);
      if (q75.length === 0) continue;
      const perWeek = q75.length / Math.max(weeks, 1);
      const w = q75.filter(r => r.leadingSideWon).length;
      const avgP = q75.reduce((s, r) => s + r.leadingPrice, 0) / q75.length;
      const edge = w / q75.length - avgP;
      console.log(`  ${cat.padEnd(15)} | ${String(q75.length).padEnd(11)} | ${perWeek.toFixed(1).padEnd(9)} | ${(w/q75.length*100).toFixed(1).padEnd(6)}% | ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1)}%`);
    }

    const allQ75 = rows.filter(r => r.leadingPrice >= 0.75);
    console.log(`  ${'TOTAL'.padEnd(15)} | ${String(allQ75.length).padEnd(11)} | ${(allQ75.length / Math.max(weeks, 1)).toFixed(1).padEnd(9)} | ${(allQ75.filter(r => r.leadingSideWon).length/allQ75.length*100).toFixed(1).padEnd(6)}% |`);
  }

  // ── 6. SIMULATED PnL ─────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  6. SIMULATED PnL — $100 per qualifying market');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const thresh of [0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95]) {
    const q = rows.filter(r => r.leadingPrice >= thresh);
    if (q.length === 0) continue;
    let pnl = 0;
    const w = q.filter(r => r.leadingSideWon).length;
    for (const r of q) { pnl += r.leadingSideWon ? (100 / r.leadingPrice - 100) : -100; }
    console.log(`  ≥${(thresh*100).toFixed(0)}c: ${q.length} markets | ${w}W/${q.length-w}L | WR ${(w/q.length*100).toFixed(1)}% | PnL $${pnl.toFixed(0)} (${(pnl/(q.length*100)*100).toFixed(1)}% ROI)`);
  }

  // ── SUMMARY ───────────────────────────────────────────────────
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   SUMMARY                                              ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Markets: ${rows.length} unique | Categories: ${cats.size}`);
  const q75 = rows.filter(r => r.leadingPrice >= 0.75);
  const q75w = q75.filter(r => r.leadingSideWon).length;
  console.log(`  ≥75c: ${q75.length} markets | WR ${(q75w/q75.length*100).toFixed(1)}% | AvgPrice ${(q75.reduce((s,r)=>s+r.leadingPrice,0)/q75.length*100).toFixed(1)}c`);
  console.log('');

  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
