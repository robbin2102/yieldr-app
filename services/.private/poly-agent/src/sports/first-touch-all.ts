/**
 * First-Touch Entry Analysis — All Markets
 *
 * For each market, finds when the leading side FIRST crosses each
 * price threshold (75c, 80c, 85c, 90c, 95c) in the price history.
 * Measures WR, time-to-resolution, and PnL from that entry point.
 *
 * This simulates what a bot would do: monitor markets and buy
 * when the leading side first hits the target price.
 *
 * Uses existing data from sportPriceHistory + generalPriceHistory.
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/sports/first-touch-all.ts
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

interface TouchEntry {
  conditionId: string;
  question: string;
  category: string;   // sport type or general category
  source: string;     // 'sport' or 'general'
  threshold: number;
  entryPrice: number; // actual price at first touch
  entryMinsBeforeClose: number;
  leadingSideIsYes: boolean;
  leadingSideWon: boolean;
  // After entry
  minPriceAfter: number;
  maxDrawdown: number;
  minsToResolution: number;
  // Price trajectory
  priceAtEntry: number;
  priceAt30mLater: number | null;
  priceAt60mLater: number | null;
}

function findFirstTouch(
  series: PricePoint[],
  threshold: number,
  winnerIndex: number,
): TouchEntry | null {
  // series is sorted earliest first (highest minsBeforeClose first)
  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    const yesPrice = p.p;
    const noPrice = 1 - p.p;

    // Check if either side crosses the threshold
    let leadingSideIsYes: boolean;
    let leadingPrice: number;

    if (yesPrice >= threshold && yesPrice > noPrice) {
      leadingSideIsYes = true;
      leadingPrice = yesPrice;
    } else if (noPrice >= threshold && noPrice > yesPrice) {
      leadingSideIsYes = false;
      leadingPrice = noPrice;
    } else {
      continue;
    }

    const leadingSideWon = leadingSideIsYes ? (winnerIndex === 0) : (winnerIndex === 1);

    // Track what happens after entry
    let minPriceAfter = leadingPrice;
    let priceAt30m: number | null = null;
    let priceAt60m: number | null = null;

    for (let j = i + 1; j < series.length; j++) {
      const lp = leadingSideIsYes ? series[j].p : (1 - series[j].p);
      if (lp < minPriceAfter) minPriceAfter = lp;

      const minsAfterEntry = (series[j].t - p.t) / 60;
      if (priceAt30m === null && minsAfterEntry >= 30) {
        priceAt30m = lp;
      }
      if (priceAt60m === null && minsAfterEntry >= 60) {
        priceAt60m = lp;
      }
    }

    return {
      conditionId: '', question: '', category: '', source: '',
      threshold, entryPrice: leadingPrice,
      entryMinsBeforeClose: p.minsBeforeClose,
      leadingSideIsYes, leadingSideWon,
      minPriceAfter, maxDrawdown: leadingPrice - minPriceAfter,
      minsToResolution: p.minsBeforeClose,
      priceAtEntry: leadingPrice,
      priceAt30mLater: priceAt30m,
      priceAt60mLater: priceAt60m,
    };
  }
  return null;
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   First-Touch Entry Analysis — All Markets             ║');
  console.log('║   "When price first hits Xc, should we buy?"           ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);

  // Load from both collections
  console.log('  Loading price histories...');
  const sportHist = await db.collection('sportPriceHistory').find({ dataPoints: { $gte: 20 } }).toArray();
  const generalHist = await db.collection('generalPriceHistory').find({ dataPoints: { $gte: 5 } }).toArray();

  console.log(`  Sport markets:   ${sportHist.length}`);
  console.log(`  General markets: ${generalHist.length}`);
  console.log(`  Total:           ${sportHist.length + generalHist.length}\n`);

  const THRESHOLDS = [0.75, 0.80, 0.85, 0.90, 0.95];

  // Process all markets
  const allTouches: TouchEntry[] = [];
  let processed = 0;

  for (const market of [...sportHist, ...generalHist]) {
    const series: PricePoint[] = market.timeSeries || [];
    if (series.length < 5) continue;

    const source = sportHist.includes(market) ? 'sport' : 'general';
    const category = market.sport || market.category || 'other';

    for (const thresh of THRESHOLDS) {
      const touch = findFirstTouch(series, thresh, market.winnerIndex);
      if (touch) {
        touch.conditionId = market.conditionId;
        touch.question = market.question || '?';
        touch.category = category;
        touch.source = source;
        allTouches.push(touch);
      }
    }

    processed++;
    if (processed % 100 === 0) console.log(`  Processing... ${processed} markets`);
  }

  console.log(`  Processed: ${processed} markets | ${allTouches.length} first-touch entries\n`);

  // ── 1. OVERALL: WR by threshold ───────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  1. FIRST-TOUCH WIN RATE BY ENTRY THRESHOLD');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`  ${'Entry'.padEnd(6)} | ${'Markets'.padEnd(8)} | ${'Wins'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'Avg Entry'.padEnd(10)} | ${'Avg Mins to Res'.padEnd(16)} | ${'Avg DD'.padEnd(7)} | Edge    | EV/$100`);
  console.log(`  ${'-'.repeat(95)}`);

  for (const thresh of THRESHOLDS) {
    const touches = allTouches.filter(t => t.threshold === thresh);
    if (touches.length === 0) continue;
    const wins = touches.filter(t => t.leadingSideWon).length;
    const wr = wins / touches.length;
    const avgEntry = touches.reduce((s, t) => s + t.entryPrice, 0) / touches.length;
    const avgMins = touches.reduce((s, t) => s + t.minsToResolution, 0) / touches.length;
    const avgDD = touches.reduce((s, t) => s + t.maxDrawdown, 0) / touches.length;
    const edge = wr - avgEntry;
    const ev = wr * (100 / avgEntry - 100) - (1 - wr) * 100;

    console.log(
      `  ${(thresh * 100).toFixed(0)}c`.padEnd(7) +
      `| ${String(touches.length).padEnd(8)} | ${String(wins).padEnd(5)} | ${(wr*100).toFixed(1).padEnd(6)}% | ` +
      `${(avgEntry*100).toFixed(1).padEnd(9)}c | ${avgMins.toFixed(0).padEnd(15)}m | ${(avgDD*100).toFixed(1).padEnd(6)}c | ` +
      `${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1).padEnd(6)}% | $${ev.toFixed(2)}`
    );
  }

  // ── 2. BY CATEGORY × THRESHOLD ────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  2. FIRST-TOUCH BY CATEGORY (≥75c entry)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const categories = [...new Set(allTouches.map(t => t.category))].sort();

  for (const thresh of [0.75, 0.85, 0.90, 0.95]) {
    console.log(`  Entry at ${(thresh*100).toFixed(0)}c:`);
    console.log(`  ${'Category'.padEnd(15)} | ${'N'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'AvgEntry'.padEnd(9)} | ${'Mins→Res'.padEnd(9)} | ${'AvgDD'.padEnd(6)} | Edge`);
    console.log(`  ${'-'.repeat(70)}`);

    for (const cat of categories) {
      const touches = allTouches.filter(t => t.threshold === thresh && t.category === cat);
      if (touches.length < 2) continue;
      const wins = touches.filter(t => t.leadingSideWon).length;
      const wr = wins / touches.length;
      const avgEntry = touches.reduce((s, t) => s + t.entryPrice, 0) / touches.length;
      const avgMins = touches.reduce((s, t) => s + t.minsToResolution, 0) / touches.length;
      const avgDD = touches.reduce((s, t) => s + t.maxDrawdown, 0) / touches.length;
      const edge = wr - avgEntry;
      const flag = touches.length < 10 ? ' ⚠' : '';
      console.log(`  ${cat.padEnd(15)} | ${String(touches.length).padEnd(5)} | ${(wr*100).toFixed(1).padEnd(6)}% | ${(avgEntry*100).toFixed(1).padEnd(8)}c | ${avgMins.toFixed(0).padEnd(8)}m | ${(avgDD*100).toFixed(1).padEnd(5)}c | ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1)}%${flag}`);
    }
    console.log('');
  }

  // ── 3. TIME-TO-RESOLUTION DISTRIBUTION ────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  3. HOW FAR BEFORE RESOLUTION DOES FIRST TOUCH HAPPEN?');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const timeBuckets = [
    { label: '<10m', min: 0, max: 10 },
    { label: '10-30m', min: 10, max: 30 },
    { label: '30-60m', min: 30, max: 60 },
    { label: '1-2hr', min: 60, max: 120 },
    { label: '2-6hr', min: 120, max: 360 },
    { label: '6hr+', min: 360, max: Infinity },
  ];

  for (const thresh of [0.75, 0.85, 0.95]) {
    const touches = allTouches.filter(t => t.threshold === thresh);
    console.log(`  Entry at ${(thresh*100).toFixed(0)}c (${touches.length} markets):`);
    console.log(`  ${'Time to Res'.padEnd(12)} | ${'N'.padEnd(5)} | ${'WR%'.padEnd(7)} | Edge    | Avg DD`);
    console.log(`  ${'-'.repeat(50)}`);

    for (const tb of timeBuckets) {
      const bucket = touches.filter(t => t.minsToResolution >= tb.min && t.minsToResolution < tb.max);
      if (bucket.length === 0) continue;
      const wins = bucket.filter(t => t.leadingSideWon).length;
      const wr = wins / bucket.length;
      const avgEntry = bucket.reduce((s, t) => s + t.entryPrice, 0) / bucket.length;
      const avgDD = bucket.reduce((s, t) => s + t.maxDrawdown, 0) / bucket.length;
      const edge = wr - avgEntry;
      const flag = bucket.length < 10 ? ' ⚠' : '';
      console.log(`  ${tb.label.padEnd(12)} | ${String(bucket.length).padEnd(5)} | ${(wr*100).toFixed(1).padEnd(6)}% | ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1).padEnd(6)}% | ${(avgDD*100).toFixed(1)}c${flag}`);
    }
    console.log('');
  }

  // ── 4. DRAWDOWN ANALYSIS ──────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  4. DRAWDOWN AFTER ENTRY — Max pain before resolution');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const thresh of THRESHOLDS) {
    const touches = allTouches.filter(t => t.threshold === thresh);
    if (touches.length === 0) continue;

    const dds = touches.map(t => t.maxDrawdown * 100).sort((a, b) => a - b);
    const avg = dds.reduce((a, b) => a + b, 0) / dds.length;
    const p50 = dds[Math.floor(dds.length * 0.5)];
    const p90 = dds[Math.floor(dds.length * 0.9)];
    const p99 = dds[Math.floor(dds.length * 0.99)];
    const max = dds[dds.length - 1];
    const dropBelow50 = touches.filter(t => t.minPriceAfter < 0.50).length;

    console.log(`  Entry at ${(thresh*100).toFixed(0)}c: avg DD ${avg.toFixed(1)}c | median ${p50.toFixed(1)}c | p90 ${p90.toFixed(1)}c | worst ${max.toFixed(1)}c | drops <50c: ${dropBelow50}/${touches.length}`);
  }

  // ── 5. OUT-OF-SAMPLE VALIDATION ───────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  5. OUT-OF-SAMPLE — Does first-touch edge survive?');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Split by conditionId chronologically (using the market's endDate order from DB load)
  const allIds = [...new Set(allTouches.map(t => t.conditionId))];
  const splitIdx = Math.floor(allIds.length * 0.6);
  const trainIds = new Set(allIds.slice(0, splitIdx));

  console.log(`  Train: ${trainIds.size} markets | Validate: ${allIds.length - trainIds.size} markets\n`);

  console.log(`  ${'Entry'.padEnd(6)} | ${'Train N'.padEnd(8)} | ${'Train WR'.padEnd(9)} | ${'Train Edge'.padEnd(11)} | ${'Val N'.padEnd(6)} | ${'Val WR'.padEnd(9)} | ${'Val Edge'.padEnd(9)} | Survived?`);
  console.log(`  ${'-'.repeat(80)}`);

  for (const thresh of THRESHOLDS) {
    const train = allTouches.filter(t => t.threshold === thresh && trainIds.has(t.conditionId));
    const val = allTouches.filter(t => t.threshold === thresh && !trainIds.has(t.conditionId));

    const tWr = train.length > 0 ? train.filter(t => t.leadingSideWon).length / train.length : 0;
    const tAvg = train.length > 0 ? train.reduce((s, t) => s + t.entryPrice, 0) / train.length : 0;
    const tEdge = tWr - tAvg;
    const vWr = val.length > 0 ? val.filter(t => t.leadingSideWon).length / val.length : 0;
    const vAvg = val.length > 0 ? val.reduce((s, t) => s + t.entryPrice, 0) / val.length : 0;
    const vEdge = vWr - vAvg;

    const survived = tEdge > 0.02 && vEdge > 0.02 ? '✅ YES' : tEdge > 0.02 && vEdge <= 0.02 ? '❌ NO' : '—';

    console.log(
      `  ${(thresh*100).toFixed(0)}c`.padEnd(7) +
      `| ${String(train.length).padEnd(8)} | ${(tWr*100).toFixed(1).padEnd(8)}% | ${(tEdge >= 0 ? '+' : '') + (tEdge*100).toFixed(1)}%`.padEnd(14) +
      `| ${String(val.length).padEnd(6)} | ${(vWr*100).toFixed(1).padEnd(8)}% | ${(vEdge >= 0 ? '+' : '') + (vEdge*100).toFixed(1)}%`.padEnd(11) +
      ` | ${survived}`
    );
  }

  // ── 6. SIMULATED PnL ─────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  6. SIMULATED PnL — $100 per first-touch entry');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const thresh of THRESHOLDS) {
    const touches = allTouches.filter(t => t.threshold === thresh);
    if (touches.length === 0) continue;
    const wins = touches.filter(t => t.leadingSideWon).length;
    let pnl = 0;
    for (const t of touches) {
      pnl += t.leadingSideWon ? (100 / t.entryPrice - 100) : -100;
    }
    const invested = touches.length * 100;
    console.log(`  Entry at ${(thresh*100).toFixed(0)}c: ${touches.length} markets | ${wins}W/${touches.length-wins}L | WR ${(wins/touches.length*100).toFixed(1)}% | Invested $${invested} | PnL $${pnl.toFixed(0)} (${(pnl/invested*100).toFixed(1)}% ROI)`);
  }

  // ── 7. LOSS DETAIL ────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  7. ALL LOSSES — Markets where first touch at ≥85c lost');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const losses85 = allTouches.filter(t => t.threshold >= 0.85 && !t.leadingSideWon);
  if (losses85.length === 0) {
    console.log('  No losses at ≥85c entry!\n');
  } else {
    console.log(`  ${'Entry'.padEnd(5)} | ${'Cat'.padEnd(12)} | ${'Mins→Res'.padEnd(9)} | ${'DD'.padEnd(5)} | Market`);
    console.log(`  ${'-'.repeat(75)}`);
    for (const t of losses85.sort((a, b) => a.threshold - b.threshold)) {
      console.log(`  ${(t.entryPrice*100).toFixed(0)}c`.padEnd(6) + `| ${t.category.padEnd(12)} | ${t.minsToResolution.toFixed(0).padEnd(8)}m | ${(t.maxDrawdown*100).toFixed(0).padEnd(4)}c | ${(t.question).slice(0, 50)}`);
    }
  }

  // ── SUMMARY ───────────────────────────────────────────────────
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   SUMMARY                                              ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Total markets: ${processed} | First-touch entries: ${allTouches.length}`);
  for (const thresh of THRESHOLDS) {
    const t = allTouches.filter(x => x.threshold === thresh);
    const w = t.filter(x => x.leadingSideWon).length;
    const avgE = t.reduce((s, x) => s + x.entryPrice, 0) / t.length;
    console.log(`  ${(thresh*100).toFixed(0)}c: ${t.length} markets | WR ${(w/t.length*100).toFixed(1)}% | AvgEntry ${(avgE*100).toFixed(1)}c | Edge ${(w/t.length - avgE >= 0 ? '+' : '')}${((w/t.length - avgE)*100).toFixed(1)}%`);
  }
  console.log('');

  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
