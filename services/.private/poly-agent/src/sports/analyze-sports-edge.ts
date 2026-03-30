/**
 * Sports Market Edge Validation
 *
 * Validates the <80c edge signal found in initial analysis:
 * 1. Out-of-sample split (60/40 chronological)
 * 2. Per-sport breakdown
 * 3. Deep dive on every <80c observation
 * 4. Survival analysis (drawdown after entry)
 * 5. 85-90c trap analysis
 * 6. Price trajectory context (where was price 30m/60m/2hr before?)
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/sports/analyze-sports-edge.ts
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

interface Observation {
  conditionId: string;
  sport: string;
  question: string;
  endDate: string;
  winnerIndex: number;
  minsBeforeClose: number;
  price: number;            // leading side price
  leadingSideIsYes: boolean;
  leadingSideWon: boolean;
  // velocity: price change in cents over last 10 min
  velocity10: number;
  // volatility: stdev of 1-min changes over last 30 min
  volatility: number;
  // momentum: is current price the highest in last 30 min?
  momentum: boolean;
  // regime: consecutive minutes above 80c / 90c
  regime80: number;
  regime90: number;
  // price context
  price30mAgo: number | null;
  price60mAgo: number | null;
  price2hrAgo: number | null;
  peakPrice: number;         // highest leading-side price ever seen
  // drawdown after entry (for survival analysis)
  minPriceAfter: number;     // lowest price after this observation
  maxDrawdownAfter: number;  // peak-to-trough after entry
  minsToReach90: number | null; // how many mins after entry to hit 90c
  minsToReach95: number | null;
}

function getPriceAtMinsBefore(series: PricePoint[], targetMins: number): number | null {
  let best: PricePoint | null = null;
  let bestDist = Infinity;
  for (const p of series) {
    const dist = Math.abs(p.minsBeforeClose - targetMins);
    if (dist < bestDist) { bestDist = dist; best = p; }
  }
  return best && bestDist < 5 ? best.p : null;
}

function computeVelocity(series: PricePoint[], currentIdx: number, windowMins: number): number {
  const current = series[currentIdx];
  const targetTime = current.t - windowMins * 60;
  let pastIdx = currentIdx;
  for (let i = currentIdx - 1; i >= 0; i--) {
    if (series[i].t <= targetTime) { pastIdx = i; break; }
    pastIdx = i;
  }
  if (pastIdx === currentIdx) return 0;
  return (current.p - series[pastIdx].p) * 100; // in cents
}

function computeVolatility(series: PricePoint[], currentIdx: number, windowMins: number): number {
  const current = series[currentIdx];
  const cutoff = current.t - windowMins * 60;
  const changes: number[] = [];
  for (let i = currentIdx; i > 0 && series[i].t >= cutoff; i--) {
    changes.push((series[i].p - series[i - 1].p) * 100); // in cents
  }
  if (changes.length < 2) return 0;
  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((s, c) => s + (c - mean) ** 2, 0) / changes.length;
  return Math.sqrt(variance);
}

function computeRegime(series: PricePoint[], currentIdx: number, threshold: number): number {
  let mins = 0;
  for (let i = currentIdx; i > 0; i--) {
    if (series[i].p >= threshold) {
      mins += (series[i].t - series[i - 1].t) / 60;
    } else break;
  }
  return mins;
}

function bucketPrice(p: number): string {
  if (p >= 0.95) return '95c+';
  if (p >= 0.90) return '90-95c';
  if (p >= 0.85) return '85-90c';
  if (p >= 0.80) return '80-85c';
  return '<80c';
}

function bucketVelocity(v: number): string {
  if (v > 5) return 'surging';
  if (v > 2) return 'rising';
  if (v < -2) return 'falling';
  return 'flat';
}

function bucketTime(mins: number): string {
  if (mins <= 5) return '≤5m';
  if (mins <= 15) return '5-15m';
  if (mins <= 30) return '15-30m';
  if (mins <= 60) return '30-60m';
  return '60m+';
}

interface BucketStats { count: number; wins: number; totalPrice: number; }

function addToBucket(map: Map<string, BucketStats>, key: string, price: number, won: boolean) {
  const b = map.get(key) || { count: 0, wins: 0, totalPrice: 0 };
  b.count++;
  if (won) b.wins++;
  b.totalPrice += price;
  map.set(key, b);
}

function printBucketTable(map: Map<string, BucketStats>, keys: string[], minN: number = 0) {
  for (const key of keys) {
    const b = map.get(key);
    if (!b) continue;
    const wr = b.wins / b.count;
    const avgPrice = b.totalPrice / b.count;
    const edge = wr - avgPrice;
    const flag = b.count < 20 ? ' ⚠' : '';
    if (b.count < minN) continue;
    const edgeStr = edge >= 0 ? `+${(edge * 100).toFixed(1)}%` : `${(edge * 100).toFixed(1)}%`;
    console.log(`  ${key.padEnd(30)} | ${String(b.count).padEnd(5)} | ${(wr * 100).toFixed(1).padEnd(6)}% | ${(avgPrice * 100).toFixed(1).padEnd(5)}c | ${edgeStr}${flag}`);
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Sports Edge Validation — <80c Signal Analysis        ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);

  const histories = await db.collection('sportPriceHistory')
    .find({ dataPoints: { $gte: 20 } })
    .sort({ endDate: 1 }) // chronological for split
    .toArray();

  console.log(`  Markets with price history: ${histories.length}\n`);
  if (histories.length === 0) { await client.close(); return; }

  // ── Build observations ────────────────────────────────────────
  const SAMPLE_INTERVALS = [5, 10, 15, 30, 60];
  const allObs: Observation[] = [];

  for (const market of histories) {
    const series: PricePoint[] = market.timeSeries || [];
    if (series.length < 20) continue;

    for (const targetMins of SAMPLE_INTERVALS) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < series.length; i++) {
        const dist = Math.abs(series[i].minsBeforeClose - targetMins);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      if (bestIdx < 0 || bestDist > 3) continue;

      const leadingSideIsYes = series[bestIdx].p > 0.5;
      const leadingPrice = leadingSideIsYes ? series[bestIdx].p : (1 - series[bestIdx].p);
      const leadingSideWon = leadingSideIsYes ? (market.winnerIndex === 0) : (market.winnerIndex === 1);

      if (leadingPrice < 0.60) continue; // only analyze when someone is leading

      // Velocity & volatility
      const vel10 = computeVelocity(series, bestIdx, 10);
      const vol30 = computeVolatility(series, bestIdx, 30);

      // Momentum: is current price the max in last 30 min?
      const cutoff30 = series[bestIdx].t - 1800;
      let maxInWindow = 0;
      for (let i = bestIdx; i >= 0 && series[i].t >= cutoff30; i--) {
        const lp = series[i].p > 0.5 ? series[i].p : (1 - series[i].p);
        if (lp > maxInWindow) maxInWindow = lp;
      }
      const momentum = leadingPrice >= maxInWindow - 0.005;

      // Regime duration
      const regime80 = computeRegime(series, bestIdx, 0.80);
      const regime90 = computeRegime(series, bestIdx, 0.90);

      // Price context
      const price30m = getPriceAtMinsBefore(series, targetMins + 30);
      const price60m = getPriceAtMinsBefore(series, targetMins + 60);
      const price2hr = getPriceAtMinsBefore(series, targetMins + 120);

      // Peak price ever
      let peakPrice = 0;
      for (let i = 0; i <= bestIdx; i++) {
        const lp = series[i].p > 0.5 ? series[i].p : (1 - series[i].p);
        if (lp > peakPrice) peakPrice = lp;
      }

      // Survival: what happens after entry?
      let minPriceAfter = leadingPrice;
      let minsToReach90: number | null = null;
      let minsToReach95: number | null = null;
      for (let i = bestIdx + 1; i < series.length; i++) {
        const lp = leadingSideIsYes ? series[i].p : (1 - series[i].p);
        if (lp < minPriceAfter) minPriceAfter = lp;
        const minsAfter = (series[i].t - series[bestIdx].t) / 60;
        if (lp >= 0.90 && minsToReach90 === null) minsToReach90 = minsAfter;
        if (lp >= 0.95 && minsToReach95 === null) minsToReach95 = minsAfter;
      }
      const maxDrawdownAfter = leadingPrice - minPriceAfter;

      // Adjust context prices for leading side
      const ctx30 = price30m !== null ? (leadingSideIsYes ? price30m : 1 - price30m) : null;
      const ctx60 = price60m !== null ? (leadingSideIsYes ? price60m : 1 - price60m) : null;
      const ctx2hr = price2hr !== null ? (leadingSideIsYes ? price2hr : 1 - price2hr) : null;

      allObs.push({
        conditionId: market.conditionId, sport: market.sport || '?',
        question: market.question || '?', endDate: market.endDate || '',
        winnerIndex: market.winnerIndex, minsBeforeClose: targetMins,
        price: leadingPrice, leadingSideIsYes, leadingSideWon,
        velocity10: vel10, volatility: vol30, momentum,
        regime80, regime90,
        price30mAgo: ctx30, price60mAgo: ctx60, price2hrAgo: ctx2hr,
        peakPrice, minPriceAfter, maxDrawdownAfter,
        minsToReach90, minsToReach95,
      });
    }
  }

  console.log(`  Total observations: ${allObs.length}`);
  const sub80 = allObs.filter(o => o.price < 0.80);
  console.log(`  <80c observations: ${sub80.length}\n`);

  // ── 1. BASELINE ───────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  1. BASELINE — Win Rate by Price × Time');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const baseline = new Map<string, BucketStats>();
  for (const o of allObs) {
    const key = `${bucketPrice(o.price)}|${bucketTime(o.minsBeforeClose)}`;
    addToBucket(baseline, key, o.price, o.leadingSideWon);
  }

  console.log(`  ${'Price|Time'.padEnd(30)} | ${'N'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'Avg'.padEnd(6)} | Edge`);
  console.log(`  ${'-'.repeat(65)}`);
  const priceLabels = ['<80c', '80-85c', '85-90c', '90-95c', '95c+'];
  const timeLabels = ['≤5m', '5-15m', '15-30m', '30-60m', '60m+'];
  for (const pl of priceLabels) {
    for (const tl of timeLabels) {
      const key = `${pl}|${tl}`;
      const b = baseline.get(key);
      if (!b || b.count < 3) continue;
      const wr = b.wins / b.count;
      const avgP = b.totalPrice / b.count;
      const edge = wr - avgP;
      const flag = b.count < 20 ? ' ⚠' : '';
      console.log(`  ${key.padEnd(30)} | ${String(b.count).padEnd(5)} | ${(wr*100).toFixed(1).padEnd(6)}% | ${(avgP*100).toFixed(1).padEnd(5)}c | ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1)}%${flag}`);
    }
  }

  // ── 2. OUT-OF-SAMPLE SPLIT ────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  2. OUT-OF-SAMPLE — Train (60%) vs Validate (40%)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Split by market endDate chronologically
  const sortedMarketIds = histories.map(h => h.conditionId);
  const splitIdx = Math.floor(sortedMarketIds.length * 0.6);
  const trainIds = new Set(sortedMarketIds.slice(0, splitIdx));
  const valIds = new Set(sortedMarketIds.slice(splitIdx));

  const trainObs = allObs.filter(o => trainIds.has(o.conditionId));
  const valObs = allObs.filter(o => valIds.has(o.conditionId));

  console.log(`  Train: ${trainIds.size} markets, ${trainObs.length} observations`);
  console.log(`  Validate: ${valIds.size} markets, ${valObs.length} observations\n`);

  console.log(`  ${'Price'.padEnd(10)} | ${'Train N'.padEnd(8)} | ${'Train WR'.padEnd(9)} | ${'Train Edge'.padEnd(11)} | ${'Val N'.padEnd(7)} | ${'Val WR'.padEnd(9)} | Val Edge | Survived?`);
  console.log(`  ${'-'.repeat(85)}`);

  for (const pl of priceLabels) {
    const train = trainObs.filter(o => bucketPrice(o.price) === pl);
    const val = valObs.filter(o => bucketPrice(o.price) === pl);
    if (train.length < 3 && val.length < 3) continue;

    const tWr = train.length > 0 ? train.filter(o => o.leadingSideWon).length / train.length : 0;
    const tAvg = train.length > 0 ? train.reduce((s, o) => s + o.price, 0) / train.length : 0;
    const tEdge = tWr - tAvg;

    const vWr = val.length > 0 ? val.filter(o => o.leadingSideWon).length / val.length : 0;
    const vAvg = val.length > 0 ? val.reduce((s, o) => s + o.price, 0) / val.length : 0;
    const vEdge = vWr - vAvg;

    const survived = tEdge > 0.02 && vEdge > 0.02 ? '✅ YES' : tEdge > 0.02 && vEdge <= 0.02 ? '❌ NO' : '—';

    console.log(
      `  ${pl.padEnd(10)} | ${String(train.length).padEnd(8)} | ${(tWr*100).toFixed(1).padEnd(8)}% | ${(tEdge >= 0 ? '+' : '') + (tEdge*100).toFixed(1) + '%'}`.padEnd(52) +
      ` | ${String(val.length).padEnd(7)} | ${(vWr*100).toFixed(1).padEnd(8)}% | ${(vEdge >= 0 ? '+' : '') + (vEdge*100).toFixed(1)}% | ${survived}`
    );
  }

  // ── 3. PER-SPORT BREAKDOWN ────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  3. PER-SPORT — <80c Edge by Sport');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const sports = [...new Set(allObs.map(o => o.sport))].sort();
  console.log(`  ${'Sport'.padEnd(12)} | ${'N'.padEnd(5)} | ${'Wins'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'AvgPrice'.padEnd(9)} | Edge`);
  console.log(`  ${'-'.repeat(55)}`);

  for (const sport of sports) {
    const obs = allObs.filter(o => o.sport === sport && o.price < 0.80);
    if (obs.length === 0) continue;
    const wins = obs.filter(o => o.leadingSideWon).length;
    const avgP = obs.reduce((s, o) => s + o.price, 0) / obs.length;
    const edge = wins / obs.length - avgP;
    const flag = obs.length < 20 ? ' ⚠' : '';
    console.log(`  ${sport.padEnd(12)} | ${String(obs.length).padEnd(5)} | ${String(wins).padEnd(5)} | ${(wins/obs.length*100).toFixed(1).padEnd(6)}% | ${(avgP*100).toFixed(1).padEnd(8)}c | ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1)}%${flag}`);
  }

  // Also show 90-95c per sport for comparison
  console.log('\n  90-95c per sport (for comparison):');
  for (const sport of sports) {
    const obs = allObs.filter(o => o.sport === sport && o.price >= 0.90 && o.price < 0.95);
    if (obs.length < 3) continue;
    const wins = obs.filter(o => o.leadingSideWon).length;
    const avgP = obs.reduce((s, o) => s + o.price, 0) / obs.length;
    const edge = wins / obs.length - avgP;
    console.log(`  ${sport.padEnd(12)} | ${String(obs.length).padEnd(5)} | WR ${(wins/obs.length*100).toFixed(1)}% | Edge ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1)}%`);
  }

  // ── 4. DEEP DIVE — Every <80c observation ─────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  4. DEEP DIVE — All <80c Observations');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`  ${'W/L'} | ${'Price'.padEnd(5)} | ${'-Min'.padEnd(4)} | ${'Sport'.padEnd(8)} | ${'30m ago'.padEnd(7)} | ${'60m ago'.padEnd(7)} | ${'2hr ago'.padEnd(7)} | ${'Peak'.padEnd(5)} | ${'MinAfter'.padEnd(8)} | ${'DD'.padEnd(5)} | Market`);
  console.log(`  ${'-'.repeat(110)}`);

  const sorted80 = sub80.sort((a, b) => a.price - b.price);
  for (const o of sorted80) {
    const icon = o.leadingSideWon ? '✅' : '❌';
    const p30 = o.price30mAgo !== null ? `${(o.price30mAgo * 100).toFixed(0)}c` : '?';
    const p60 = o.price60mAgo !== null ? `${(o.price60mAgo * 100).toFixed(0)}c` : '?';
    const p2h = o.price2hrAgo !== null ? `${(o.price2hrAgo * 100).toFixed(0)}c` : '?';
    const peak = `${(o.peakPrice * 100).toFixed(0)}c`;
    const minA = `${(o.minPriceAfter * 100).toFixed(0)}c`;
    const dd = `${(o.maxDrawdownAfter * 100).toFixed(0)}c`;
    const title = (o.question || '?').slice(0, 35);
    console.log(`  ${icon} | ${(o.price * 100).toFixed(0).padEnd(4)}c | ${String(o.minsBeforeClose).padEnd(3)}m | ${o.sport.padEnd(8)} | ${p30.padEnd(7)} | ${p60.padEnd(7)} | ${p2h.padEnd(7)} | ${peak.padEnd(5)} | ${minA.padEnd(8)} | ${dd.padEnd(5)} | ${title}`);
  }

  // ── 5. SURVIVAL ANALYSIS ──────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  5. SURVIVAL — What happens after entry at <80c?');
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (sub80.length > 0) {
    const dropBelow70 = sub80.filter(o => o.minPriceAfter < 0.70).length;
    const dropBelow60 = sub80.filter(o => o.minPriceAfter < 0.60).length;
    const dropBelow50 = sub80.filter(o => o.minPriceAfter < 0.50).length;
    const avgDD = sub80.reduce((s, o) => s + o.maxDrawdownAfter, 0) / sub80.length;
    const maxDD = Math.max(...sub80.map(o => o.maxDrawdownAfter));
    const reachesG90 = sub80.filter(o => o.minsToReach90 !== null);
    const reaches95 = sub80.filter(o => o.minsToReach95 !== null);

    console.log(`  Drop below 70c after entry: ${dropBelow70}/${sub80.length} (${(dropBelow70/sub80.length*100).toFixed(0)}%)`);
    console.log(`  Drop below 60c after entry: ${dropBelow60}/${sub80.length} (${(dropBelow60/sub80.length*100).toFixed(0)}%)`);
    console.log(`  Drop below 50c after entry: ${dropBelow50}/${sub80.length} (${(dropBelow50/sub80.length*100).toFixed(0)}%)`);
    console.log(`  Avg max drawdown: ${(avgDD * 100).toFixed(1)}c | Worst: ${(maxDD * 100).toFixed(1)}c`);
    console.log(`  Reaches 90c before close: ${reachesG90.length}/${sub80.length} (${(reachesG90.length/sub80.length*100).toFixed(0)}%)`);
    if (reachesG90.length > 0) {
      const avgMinsTo90 = reachesG90.reduce((s, o) => s + (o.minsToReach90 || 0), 0) / reachesG90.length;
      console.log(`  Avg time to reach 90c: ${avgMinsTo90.toFixed(0)} min after entry`);
    }
    console.log(`  Reaches 95c before close: ${reaches95.length}/${sub80.length} (${(reaches95.length/sub80.length*100).toFixed(0)}%)`);

    // Price 2hr before tells us if this was pre-game or in-game
    const withCtx = sub80.filter(o => o.price2hrAgo !== null);
    if (withCtx.length > 0) {
      const wasAbove80 = withCtx.filter(o => o.price2hrAgo! > 0.80).length;
      const wasBelow80 = withCtx.filter(o => o.price2hrAgo! <= 0.80).length;
      console.log(`\n  Context: 2 hours before entry...`);
      console.log(`    Price was >80c: ${wasAbove80} (in-game decline to <80c)`);
      console.log(`    Price was ≤80c: ${wasBelow80} (was already below 80c — pre-game or early-game)`);
    }
  }

  // ── 6. THE 85-90c TRAP ────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  6. THE 85-90c TRAP — Why does this bucket fail?');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const trap = allObs.filter(o => o.price >= 0.85 && o.price < 0.90);
  if (trap.length > 0) {
    const trapWins = trap.filter(o => o.leadingSideWon);
    const trapLosses = trap.filter(o => !o.leadingSideWon);
    console.log(`  Total 85-90c observations: ${trap.length} | WR: ${(trapWins.length/trap.length*100).toFixed(1)}%`);
    console.log(`\n  Losses (${trapLosses.length}):`);
    for (const o of trapLosses.slice(0, 15)) {
      const p30 = o.price30mAgo !== null ? `${(o.price30mAgo * 100).toFixed(0)}c` : '?';
      console.log(`    ${(o.price*100).toFixed(0)}c | -${o.minsBeforeClose}m | ${o.sport.padEnd(8)} | 30m ago: ${p30} | vel: ${o.velocity10 >= 0 ? '+' : ''}${o.velocity10.toFixed(1)}c | ${(o.question || '').slice(0, 40)}`);
    }
  }

  // ── 7. FEATURE COMBOS for <80c ────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  7. FEATURE COMBOS — Which <80c entries have highest edge?');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const featureBuckets = new Map<string, BucketStats>();
  for (const o of sub80) {
    const vel = bucketVelocity(o.velocity10);
    const mom = o.momentum ? 'at-peak' : 'off-peak';
    const reg = o.regime80 >= 30 ? 'long-regime' : o.regime80 >= 10 ? 'mid-regime' : 'new-regime';

    addToBucket(featureBuckets, `vel:${vel}`, o.price, o.leadingSideWon);
    addToBucket(featureBuckets, `mom:${mom}`, o.price, o.leadingSideWon);
    addToBucket(featureBuckets, `reg:${reg}`, o.price, o.leadingSideWon);
    addToBucket(featureBuckets, `${vel}|${mom}`, o.price, o.leadingSideWon);
    addToBucket(featureBuckets, `${vel}|${reg}`, o.price, o.leadingSideWon);
  }

  console.log(`  ${'Feature'.padEnd(30)} | ${'N'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'Avg'.padEnd(6)} | Edge`);
  console.log(`  ${'-'.repeat(60)}`);
  const sortedFeatures = [...featureBuckets.entries()]
    .filter(([_, b]) => b.count >= 3)
    .sort((a, b) => (b[1].wins / b[1].count - b[1].totalPrice / b[1].count) - (a[1].wins / a[1].count - a[1].totalPrice / a[1].count));
  for (const [key, b] of sortedFeatures) {
    const wr = b.wins / b.count;
    const avg = b.totalPrice / b.count;
    const edge = wr - avg;
    const flag = b.count < 20 ? ' ⚠' : '';
    console.log(`  ${key.padEnd(30)} | ${String(b.count).padEnd(5)} | ${(wr*100).toFixed(1).padEnd(6)}% | ${(avg*100).toFixed(1).padEnd(5)}c | ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1)}%${flag}`);
  }

  // ── SUMMARY ───────────────────────────────────────────────────
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   SUMMARY                                              ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  console.log(`  Markets: ${histories.length} | Observations: ${allObs.length}`);
  console.log(`  <80c signal: ${sub80.length} obs | WR: ${sub80.length > 0 ? (sub80.filter(o=>o.leadingSideWon).length/sub80.length*100).toFixed(1) : '?'}% | Avg price: ${sub80.length > 0 ? (sub80.reduce((s,o)=>s+o.price,0)/sub80.length*100).toFixed(1) : '?'}c`);
  console.log('');

  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
