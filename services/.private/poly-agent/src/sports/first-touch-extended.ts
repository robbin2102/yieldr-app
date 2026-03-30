/**
 * First-Touch + Reversal Analysis — Extended Price History
 *
 * Fetches 7-day price history (5-min intervals) for all markets,
 * finds the ACTUAL moment each side first crosses 75c/80c/85c/90c/95c,
 * tracks reversals, and computes WR/EV/PnL.
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/sports/first-touch-extended.ts
 *   npx tsx services/.private/poly-agent/src/sports/first-touch-extended.ts --days=14
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

const CLOB_API = 'https://clob.polymarket.com';
const RATE_LIMIT_MS = 300;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const daysArg = args.find(a => a.startsWith('--days='));
const LOOKBACK_DAYS = daysArg ? parseInt(daysArg.split('=')[1]) : 7;
const THRESHOLDS = [0.75, 0.80, 0.85, 0.90, 0.95];

interface PricePoint { t: number; p: number; }

interface TouchResult {
  conditionId: string;
  question: string;
  category: string;
  threshold: number;
  side: 'Yes' | 'No';         // which side crossed the threshold
  sideWon: boolean;             // did that side win?
  entryPrice: number;           // price at first touch (should be close to threshold)
  entryTime: number;            // timestamp of first touch
  minsBeforeClose: number;      // how far before resolution
  hoursBeforeClose: number;
  // Reversal tracking
  reversed: boolean;            // did price drop back below threshold after entry?
  maxDrawdown: number;          // biggest drop from entry price
  minPriceAfter: number;        // lowest price after entry
  recoveredAfterReversal: boolean; // if reversed, did it come back above threshold?
  // Price trajectory
  priceAtClose: number;         // price at resolution
  priceRange: number;           // max - min after entry
}

async function fetchPriceHistory(tokenId: string, endTs: number, lookbackSecs: number): Promise<PricePoint[]> {
  try {
    const start = endTs - lookbackSecs;
    // fidelity=5 for 5-min intervals over long periods
    const url = `${CLOB_API}/prices-history?market=${tokenId}&startTs=${start}&endTs=${endTs}&fidelity=5`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as { history: PricePoint[] };
    return data.history || [];
  } catch { return []; }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   First-Touch + Reversal — Extended Price History      ║');
  console.log(`║   Lookback: ${LOOKBACK_DAYS} days | 5-min intervals                  ║`);
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);

  // Load market metadata from both collections
  console.log('  Loading market metadata...');
  const sportMarkets = await db.collection('sportMarkets').find({}).toArray();
  const generalMarkets = await db.collection('generalMarkets').find({}).toArray();
  const allMarkets = [
    ...sportMarkets.map(m => ({ ...m, source: 'sport', category: m.sport || 'other' })),
    ...generalMarkets.map(m => ({ ...m, source: 'general', category: m.category || 'other' })),
  ];

  console.log(`  Sport markets:   ${sportMarkets.length}`);
  console.log(`  General markets: ${generalMarkets.length}`);
  console.log(`  Total:           ${allMarkets.length}`);

  // ── Phase 1: Fetch extended price histories ───────────────────
  const lookbackSecs = LOOKBACK_DAYS * 86400;

  console.log(`\n  Phase 1: Fetching ${LOOKBACK_DAYS}-day price histories (5-min intervals)...`);
  console.log(`  Est. time: ${Math.ceil(allMarkets.length * 0.7 / 60)} min\n`);

  const allTouches: TouchResult[] = [];
  let fetched = 0;
  let errors = 0;
  let noData = 0;
  let marketsWithTouch = 0;

  for (const market of allMarkets) {
    const tokenIds = market.tokenIds || [];
    if (tokenIds.length < 2) { errors++; continue; }

    const endTs = market.endDate ? Math.floor(new Date(market.endDate).getTime() / 1000) : 0;
    if (!endTs || isNaN(endTs)) { errors++; continue; }

    // Fetch YES token price history
    let history = await fetchPriceHistory(tokenIds[0], endTs, lookbackSecs);
    await sleep(RATE_LIMIT_MS);

    if (history.length < 5 && tokenIds[1]) {
      // Try NO token and invert
      const noHist = await fetchPriceHistory(tokenIds[1], endTs, lookbackSecs);
      await sleep(RATE_LIMIT_MS);
      if (noHist.length >= 5) {
        history = noHist.map(p => ({ t: p.t, p: Math.round((1 - p.p) * 1000) / 1000 }));
      }
    }

    if (history.length < 5) { noData++; continue; }

    history.sort((a, b) => a.t - b.t);
    fetched++;

    // Find first touch for each threshold
    let hadTouch = false;
    for (const thresh of THRESHOLDS) {
      const touch = findFirstTouch(history, thresh, endTs, market.winnerIndex);
      if (touch) {
        touch.conditionId = market.conditionId;
        touch.question = market.question || '?';
        touch.category = market.category;
        allTouches.push(touch);
        hadTouch = true;
      }
    }
    if (hadTouch) marketsWithTouch++;

    if ((fetched + errors + noData) % 20 === 0) {
      const progress = fetched + errors + noData;
      const pct = ((progress / allMarkets.length) * 100).toFixed(0);
      console.log(`  [${progress}/${allMarkets.length}] ${pct}% | ✅${fetched} | ❌${errors}err | ⚠${noData}nodata | Touches: ${allTouches.length} | ${market.question?.slice(0, 40)}`);
    }
  }

  console.log(`\n  Phase 1 done: ${fetched} fetched | ${errors} errors | ${noData} no data`);
  console.log(`  Markets with ≥1 touch: ${marketsWithTouch} | Total touches: ${allTouches.length}\n`);

  // ── Phase 2: Analysis ─────────────────────────────────────────

  // 1. FIRST-TOUCH WIN RATE BY THRESHOLD
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  1. FIRST-TOUCH WIN RATE (entry at threshold price)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`  ${'Entry'.padEnd(6)} | ${'N'.padEnd(5)} | ${'Wins'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'AvgEntry'.padEnd(9)} | ${'Hrs→Res'.padEnd(8)} | ${'Reversed'.padEnd(9)} | ${'AvgDD'.padEnd(6)} | Edge    | EV/$100`);
  console.log(`  ${'-'.repeat(95)}`);

  for (const thresh of THRESHOLDS) {
    const touches = allTouches.filter(t => t.threshold === thresh);
    if (touches.length === 0) continue;
    const wins = touches.filter(t => t.sideWon).length;
    const wr = wins / touches.length;
    const avgEntry = touches.reduce((s, t) => s + t.entryPrice, 0) / touches.length;
    const avgHrs = touches.reduce((s, t) => s + t.hoursBeforeClose, 0) / touches.length;
    const reversals = touches.filter(t => t.reversed).length;
    const avgDD = touches.reduce((s, t) => s + t.maxDrawdown, 0) / touches.length;
    // EV using THRESHOLD as entry price (limit order)
    const evAtThresh = wr * (100 / thresh - 100) - (1 - wr) * 100;
    // Edge using actual entry price
    const edge = wr - avgEntry;

    console.log(
      `  ${(thresh*100).toFixed(0)}c`.padEnd(7) +
      `| ${String(touches.length).padEnd(5)} | ${String(wins).padEnd(5)} | ${(wr*100).toFixed(1).padEnd(6)}% | ` +
      `${(avgEntry*100).toFixed(1).padEnd(8)}c | ${avgHrs.toFixed(0).padEnd(7)}h | ` +
      `${String(reversals).padEnd(4)}(${(reversals/touches.length*100).toFixed(0)}%)  | ` +
      `${(avgDD*100).toFixed(1).padEnd(5)}c | ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1).padEnd(6)}% | $${evAtThresh.toFixed(2)}`
    );
  }

  // 2. REVERSAL ANALYSIS
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  2. REVERSAL ANALYSIS — What happens after first touch?');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const thresh of THRESHOLDS) {
    const touches = allTouches.filter(t => t.threshold === thresh);
    if (touches.length === 0) continue;

    const reversed = touches.filter(t => t.reversed);
    const notReversed = touches.filter(t => !t.reversed);

    const revWins = reversed.filter(t => t.sideWon).length;
    const noRevWins = notReversed.filter(t => t.sideWon).length;

    console.log(`  Entry at ${(thresh*100).toFixed(0)}c:`);
    console.log(`    No reversal:  ${notReversed.length} markets | ${noRevWins}W | WR ${notReversed.length > 0 ? (noRevWins/notReversed.length*100).toFixed(1) : 0}%`);
    console.log(`    Reversed:     ${reversed.length} markets | ${revWins}W | WR ${reversed.length > 0 ? (revWins/reversed.length*100).toFixed(1) : 0}%`);
    if (reversed.length > 0) {
      const recovered = reversed.filter(t => t.recoveredAfterReversal).length;
      const avgRevDD = reversed.reduce((s, t) => s + t.maxDrawdown, 0) / reversed.length;
      console.log(`    Recovered after reversal: ${recovered}/${reversed.length} (${(recovered/reversed.length*100).toFixed(0)}%)`);
      console.log(`    Avg drawdown in reversals: ${(avgRevDD*100).toFixed(1)}c`);
    }
    console.log('');
  }

  // 3. HOLDING PERIOD DISTRIBUTION
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  3. HOLDING PERIOD — How long from entry to resolution?');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const holdBuckets = [
    { label: '<1hr', min: 0, max: 1 },
    { label: '1-6hr', min: 1, max: 6 },
    { label: '6-24hr', min: 6, max: 24 },
    { label: '1-3 days', min: 24, max: 72 },
    { label: '3-7 days', min: 72, max: 168 },
  ];

  for (const thresh of [0.75, 0.85, 0.95]) {
    const touches = allTouches.filter(t => t.threshold === thresh);
    if (touches.length === 0) continue;
    console.log(`  Entry at ${(thresh*100).toFixed(0)}c:`);
    console.log(`  ${'Hold Period'.padEnd(12)} | ${'N'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'Rev%'.padEnd(6)} | AvgDD`);
    console.log(`  ${'-'.repeat(48)}`);

    for (const hb of holdBuckets) {
      const bucket = touches.filter(t => t.hoursBeforeClose >= hb.min && t.hoursBeforeClose < hb.max);
      if (bucket.length === 0) continue;
      const w = bucket.filter(t => t.sideWon).length;
      const rev = bucket.filter(t => t.reversed).length;
      const avgDD = bucket.reduce((s, t) => s + t.maxDrawdown, 0) / bucket.length;
      const flag = bucket.length < 10 ? ' ⚠' : '';
      console.log(`  ${hb.label.padEnd(12)} | ${String(bucket.length).padEnd(5)} | ${(w/bucket.length*100).toFixed(1).padEnd(6)}% | ${(rev/bucket.length*100).toFixed(0).padEnd(5)}% | ${(avgDD*100).toFixed(1)}c${flag}`);
    }
    console.log('');
  }

  // 4. BY CATEGORY × THRESHOLD
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  4. BY CATEGORY × THRESHOLD');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const categories = [...new Set(allTouches.map(t => t.category))].sort();

  for (const thresh of THRESHOLDS) {
    console.log(`  Entry at ${(thresh*100).toFixed(0)}c:`);
    console.log(`  ${'Category'.padEnd(15)} | ${'N'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'Hrs→Res'.padEnd(8)} | ${'Rev%'.padEnd(6)} | ${'AvgDD'.padEnd(6)} | EV/$100`);
    console.log(`  ${'-'.repeat(65)}`);

    for (const cat of categories) {
      const touches = allTouches.filter(t => t.threshold === thresh && t.category === cat);
      if (touches.length < 2) continue;
      const w = touches.filter(t => t.sideWon).length;
      const wr = w / touches.length;
      const avgHrs = touches.reduce((s, t) => s + t.hoursBeforeClose, 0) / touches.length;
      const rev = touches.filter(t => t.reversed).length;
      const avgDD = touches.reduce((s, t) => s + t.maxDrawdown, 0) / touches.length;
      const ev = wr * (100 / thresh - 100) - (1 - wr) * 100;
      const flag = touches.length < 10 ? ' ⚠' : '';
      console.log(`  ${cat.padEnd(15)} | ${String(touches.length).padEnd(5)} | ${(wr*100).toFixed(1).padEnd(6)}% | ${avgHrs.toFixed(0).padEnd(7)}h | ${(rev/touches.length*100).toFixed(0).padEnd(5)}% | ${(avgDD*100).toFixed(1).padEnd(5)}c | $${ev.toFixed(2)}${flag}`);
    }
    console.log('');
  }

  // 5. OOS VALIDATION
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  5. OUT-OF-SAMPLE VALIDATION');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const uniqueIds = [...new Set(allTouches.map(t => t.conditionId))];
  const splitIdx = Math.floor(uniqueIds.length * 0.6);
  const trainIds = new Set(uniqueIds.slice(0, splitIdx));

  console.log(`  Train: ${trainIds.size} markets | Validate: ${uniqueIds.length - trainIds.size} markets\n`);
  console.log(`  ${'Entry'.padEnd(6)} | ${'Train WR'.padEnd(9)} | ${'Train EV/$100'.padEnd(14)} | ${'Val WR'.padEnd(9)} | ${'Val EV/$100'.padEnd(12)} | Survived?`);
  console.log(`  ${'-'.repeat(70)}`);

  for (const thresh of THRESHOLDS) {
    const train = allTouches.filter(t => t.threshold === thresh && trainIds.has(t.conditionId));
    const val = allTouches.filter(t => t.threshold === thresh && !trainIds.has(t.conditionId));
    if (train.length < 5 || val.length < 5) continue;

    const tWr = train.filter(t => t.sideWon).length / train.length;
    const vWr = val.filter(t => t.sideWon).length / val.length;
    const tEv = tWr * (100 / thresh - 100) - (1 - tWr) * 100;
    const vEv = vWr * (100 / thresh - 100) - (1 - vWr) * 100;
    const survived = tEv > 0 && vEv > 0 ? '✅ YES' : tEv > 0 && vEv <= 0 ? '❌ NO' : '—';

    console.log(
      `  ${(thresh*100).toFixed(0)}c`.padEnd(7) +
      `| ${(tWr*100).toFixed(1).padEnd(8)}% | $${tEv.toFixed(2).padEnd(12)} | ` +
      `${(vWr*100).toFixed(1).padEnd(8)}% | $${vEv.toFixed(2).padEnd(10)} | ${survived}`
    );
  }

  // 6. PnL SIMULATION
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  6. PnL SIMULATION — $100 limit order at threshold');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const thresh of THRESHOLDS) {
    const touches = allTouches.filter(t => t.threshold === thresh);
    if (touches.length === 0) continue;
    const wins = touches.filter(t => t.sideWon).length;
    const profitPerWin = 100 / thresh - 100;
    const pnl = wins * profitPerWin - (touches.length - wins) * 100;
    console.log(`  ${(thresh*100).toFixed(0)}c: ${touches.length} markets | ${wins}W/${touches.length-wins}L | WR ${(wins/touches.length*100).toFixed(1)}% | Profit/win $${profitPerWin.toFixed(2)} | PnL $${pnl.toFixed(0)} (${(pnl/(touches.length*100)*100).toFixed(1)}% ROI)`);
  }

  // 7. LOSS DETAIL
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  7. ALL LOSSES at ≥85c first touch');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const losses = allTouches.filter(t => t.threshold >= 0.85 && !t.sideWon);
  if (losses.length === 0) {
    console.log('  No losses!\n');
  } else {
    console.log(`  ${'Thresh'.padEnd(7)} | ${'Side'.padEnd(4)} | ${'Entry'.padEnd(6)} | ${'Cat'.padEnd(12)} | ${'Hrs→Res'.padEnd(8)} | ${'DD'.padEnd(5)} | ${'Rev?'.padEnd(5)} | Market`);
    console.log(`  ${'-'.repeat(90)}`);
    for (const t of losses) {
      console.log(`  ${(t.threshold*100).toFixed(0)}c`.padEnd(8) + `| ${t.side.padEnd(4)} | ${(t.entryPrice*100).toFixed(0)}c`.padEnd(8) + `| ${t.category.padEnd(12)} | ${t.hoursBeforeClose.toFixed(0).padEnd(7)}h | ${(t.maxDrawdown*100).toFixed(0).padEnd(4)}c | ${t.reversed ? 'Y' : 'N'}`.padEnd(7) + `| ${t.question.slice(0, 45)}`);
    }
  }

  // SUMMARY
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   SUMMARY                                              ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Markets fetched: ${fetched} | With touches: ${marketsWithTouch}`);
  console.log(`  Lookback: ${LOOKBACK_DAYS} days | Data points: 5-min intervals\n`);
  for (const thresh of THRESHOLDS) {
    const t = allTouches.filter(x => x.threshold === thresh);
    if (t.length === 0) continue;
    const w = t.filter(x => x.sideWon).length;
    const ev = (w/t.length) * (100/thresh - 100) - (1 - w/t.length) * 100;
    console.log(`  ${(thresh*100).toFixed(0)}c: ${t.length} markets | WR ${(w/t.length*100).toFixed(1)}% | EV $${ev.toFixed(2)}/bet | ${t.filter(x=>x.reversed).length} reversals`);
  }
  console.log('');

  await client.close();
}

function findFirstTouch(
  history: PricePoint[],
  threshold: number,
  endTs: number,
  winnerIndex: number,
): TouchResult | null {
  // history sorted earliest first
  // Track both sides separately
  for (let i = 0; i < history.length; i++) {
    const yesPrice = history[i].p;
    const noPrice = 1 - history[i].p;

    let side: 'Yes' | 'No' | null = null;
    let sidePrice = 0;

    // Check if Yes side crosses threshold for the FIRST time
    if (yesPrice >= threshold) {
      // Verify it wasn't already above in previous point
      if (i === 0 || history[i - 1].p < threshold) {
        side = 'Yes';
        sidePrice = yesPrice;
      }
    }
    // Check No side
    if (!side && noPrice >= threshold) {
      if (i === 0 || (1 - history[i - 1].p) < threshold) {
        side = 'No';
        sidePrice = noPrice;
      }
    }

    // If first data point is already above threshold, count it
    // (the actual first cross happened before our window)
    if (i === 0 && !side) {
      if (yesPrice >= threshold) { side = 'Yes'; sidePrice = yesPrice; }
      else if (noPrice >= threshold) { side = 'No'; sidePrice = noPrice; }
    }

    if (!side) continue;

    const sideWon = side === 'Yes' ? (winnerIndex === 0) : (winnerIndex === 1);
    const minsBeforeClose = (endTs - history[i].t) / 60;
    const hoursBeforeClose = minsBeforeClose / 60;

    // Track what happens after entry
    let minPriceAfter = sidePrice;
    let maxPriceAfter = sidePrice;
    let reversed = false;
    let recoveredAfterReversal = false;
    let lastPrice = sidePrice;

    for (let j = i + 1; j < history.length; j++) {
      const lp = side === 'Yes' ? history[j].p : (1 - history[j].p);
      if (lp < minPriceAfter) minPriceAfter = lp;
      if (lp > maxPriceAfter) maxPriceAfter = lp;
      lastPrice = lp;

      if (lp < threshold) {
        reversed = true;
      }
      if (reversed && lp >= threshold) {
        recoveredAfterReversal = true;
      }
    }

    return {
      conditionId: '', question: '', category: '',
      threshold, side, sideWon,
      entryPrice: sidePrice,
      entryTime: history[i].t,
      minsBeforeClose, hoursBeforeClose,
      reversed, maxDrawdown: sidePrice - minPriceAfter,
      minPriceAfter, recoveredAfterReversal,
      priceAtClose: lastPrice,
      priceRange: maxPriceAfter - minPriceAfter,
    };
  }
  return null;
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
