/**
 * Pass 2+3: Analyze Sports Market Edge — Price Features + Win Rate
 *
 * For each market's price history, computes features at each time point:
 * - Price velocity (slope over trailing window)
 * - Price volatility (stdev of changes)
 * - Regime duration (how long above threshold)
 * - Max drawdown from peak
 * - Price acceleration
 *
 * Then buckets by feature combination and measures actual WR vs entry price
 * to find exploitable edge.
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

// ── Feature computation ─────────────────────────────────────

interface PricePoint { t: number; p: number; minsBeforeClose: number; }

interface Features {
  price: number;
  velocity5: number;    // slope over last 5 minutes
  velocity10: number;   // slope over last 10 minutes
  velocity20: number;   // slope over last 20 minutes
  volatility: number;   // stdev of price changes (last 10 min)
  regimeDuration85: number;  // minutes continuously above 85c
  regimeDuration90: number;  // minutes continuously above 90c
  maxDrawdown: number;  // biggest drop from peak so far
  acceleration: number; // velocity10 - velocity20 (is it speeding up?)
  minsBeforeClose: number;
}

function computeVelocity(series: PricePoint[], currentIdx: number, windowMins: number): number {
  const current = series[currentIdx];
  // Find point ~windowMins ago
  const targetTime = current.t - windowMins * 60;
  let pastIdx = currentIdx;
  for (let i = currentIdx - 1; i >= 0; i--) {
    if (series[i].t <= targetTime) { pastIdx = i; break; }
    pastIdx = i;
  }
  if (pastIdx === currentIdx) return 0;
  const dt = (current.t - series[pastIdx].t) / 60; // in minutes
  if (dt === 0) return 0;
  return (current.p - series[pastIdx].p) / dt; // price change per minute
}

function computeVolatility(series: PricePoint[], currentIdx: number, windowMins: number): number {
  const current = series[currentIdx];
  const cutoff = current.t - windowMins * 60;

  const changes: number[] = [];
  for (let i = currentIdx; i > 0 && series[i].t >= cutoff; i--) {
    changes.push(series[i].p - series[i - 1].p);
  }
  if (changes.length < 2) return 0;

  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((s, c) => s + (c - mean) ** 2, 0) / changes.length;
  return Math.sqrt(variance);
}

function computeRegimeDuration(series: PricePoint[], currentIdx: number, threshold: number): number {
  let duration = 0;
  for (let i = currentIdx; i >= 0; i--) {
    if (series[i].p >= threshold) {
      if (i > 0) {
        duration += (series[i].t - series[i - 1].t) / 60;
      }
    } else {
      break;
    }
  }
  return duration;
}

function computeMaxDrawdown(series: PricePoint[], currentIdx: number): number {
  let peak = 0;
  let maxDd = 0;
  for (let i = 0; i <= currentIdx; i++) {
    if (series[i].p > peak) peak = series[i].p;
    const dd = peak - series[i].p;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

function computeFeatures(series: PricePoint[], idx: number): Features {
  const p = series[idx];
  const v5 = computeVelocity(series, idx, 5);
  const v10 = computeVelocity(series, idx, 10);
  const v20 = computeVelocity(series, idx, 20);
  const vol = computeVolatility(series, idx, 10);
  const r85 = computeRegimeDuration(series, idx, 0.85);
  const r90 = computeRegimeDuration(series, idx, 0.90);
  const dd = computeMaxDrawdown(series, idx);
  const accel = v10 - v20;

  return {
    price: p.p,
    velocity5: v5, velocity10: v10, velocity20: v20,
    volatility: vol,
    regimeDuration85: r85, regimeDuration90: r90,
    maxDrawdown: dd, acceleration: accel,
    minsBeforeClose: p.minsBeforeClose,
  };
}

// ── Bucketing ───────────────────────────────────────────────

function bucketPrice(p: number): string {
  if (p >= 0.95) return '95c+';
  if (p >= 0.90) return '90-95c';
  if (p >= 0.85) return '85-90c';
  if (p >= 0.80) return '80-85c';
  return '<80c';
}

function bucketVelocity(v: number): string {
  if (v > 0.002) return 'rising';
  if (v < -0.002) return 'falling';
  return 'flat';
}

function bucketVolatility(v: number): string {
  if (v > 0.03) return 'high';
  if (v > 0.01) return 'medium';
  return 'low';
}

function bucketRegime(mins: number): string {
  if (mins >= 30) return '30m+';
  if (mins >= 10) return '10-30m';
  return '<10m';
}

function bucketTime(mins: number): string {
  if (mins <= 5) return '≤5m';
  if (mins <= 15) return '5-15m';
  if (mins <= 30) return '15-30m';
  if (mins <= 60) return '30-60m';
  return '60m+';
}

function bucketDrawdown(dd: number): string {
  if (dd >= 0.10) return '≥10c';
  if (dd >= 0.05) return '5-10c';
  return '<5c';
}

// ── Analysis ────────────────────────────────────────────────

interface BucketStats {
  count: number;
  wins: number;
  totalPrice: number;
  totalEdge: number;
  prices: number[];
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Sports Market Edge Analysis — Price Features         ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);

  const histories = await db.collection('sportPriceHistory').find({ dataPoints: { $gte: 20 } }).toArray();
  console.log(`  Markets with price history: ${histories.length}\n`);

  if (histories.length === 0) {
    console.log('  No data! Run fetch-sports-markets.ts and fetch-price-histories.ts first.');
    await client.close();
    return;
  }

  // ── Pass 2: Compute features at each time point ───────────
  // Sample at specific intervals before close
  const SAMPLE_INTERVALS = [5, 10, 15, 30, 60]; // minutes before close

  // Multi-dimensional bucketing
  const buckets = new Map<string, BucketStats>();

  // Simple price-only buckets for baseline
  const priceOnlyBuckets = new Map<string, BucketStats>();

  // Feature-combo buckets
  let totalObservations = 0;
  let marketsProcessed = 0;

  for (const market of histories) {
    const series: PricePoint[] = market.timeSeries || [];
    if (series.length < 20) continue;

    const winnerIndex = market.winnerIndex;

    // For each sample interval, find the closest data point
    for (const targetMins of SAMPLE_INTERVALS) {
      // Find snapshot closest to targetMins before close
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < series.length; i++) {
        const dist = Math.abs(series[i].minsBeforeClose - targetMins);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      if (bestIdx < 0 || bestDist > 3) continue; // skip if no data within 3 mins

      const features = computeFeatures(series, bestIdx);

      // Determine if the leading side won
      // If price > 0.5, outcome 0 (Yes) is leading
      // If price < 0.5, outcome 1 (No) is leading
      const leadingSideIsYes = features.price > 0.5;
      const leadingPrice = leadingSideIsYes ? features.price : (1 - features.price);
      const leadingSideWon = leadingSideIsYes ? (winnerIndex === 0) : (winnerIndex === 1);

      if (leadingPrice < 0.75) continue; // Only analyze when a side is clearly leading

      totalObservations++;

      // ── Price-only bucket ─────────────────────────────────
      const priceBucket = bucketPrice(leadingPrice);
      const timeBucket = bucketTime(targetMins);
      const priceTimeKey = `${priceBucket}|${timeBucket}`;
      addToBucket(priceOnlyBuckets, priceTimeKey, leadingPrice, leadingSideWon);

      // ── Full feature buckets ──────────────────────────────
      const velBucket = bucketVelocity(features.velocity10);
      const volBucket = bucketVolatility(features.volatility);
      const regBucket = bucketRegime(features.regimeDuration85);
      const ddBucket = bucketDrawdown(features.maxDrawdown);

      // Price + velocity
      addToBucket(buckets, `${priceBucket}|${velBucket}`, leadingPrice, leadingSideWon);

      // Price + volatility
      addToBucket(buckets, `${priceBucket}|${volBucket}`, leadingPrice, leadingSideWon);

      // Price + regime
      addToBucket(buckets, `${priceBucket}|${regBucket}`, leadingPrice, leadingSideWon);

      // Price + drawdown
      addToBucket(buckets, `${priceBucket}|${ddBucket}`, leadingPrice, leadingSideWon);

      // Triple: price + velocity + volatility
      addToBucket(buckets, `${priceBucket}|${velBucket}|${volBucket}`, leadingPrice, leadingSideWon);

      // Triple: price + velocity + regime
      addToBucket(buckets, `${priceBucket}|${velBucket}|${regBucket}`, leadingPrice, leadingSideWon);

      // Quad: price + velocity + volatility + regime
      addToBucket(buckets, `${priceBucket}|${velBucket}|${volBucket}|${regBucket}`, leadingPrice, leadingSideWon);
    }

    marketsProcessed++;
  }

  console.log(`  Markets processed: ${marketsProcessed}`);
  console.log(`  Total observations: ${totalObservations}\n`);

  // ── Pass 3: Measure edge ──────────────────────────────────

  // 1. Baseline: price-only WR by price bucket × time bucket
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  BASELINE — Win Rate by Price × Time to Close              ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const timeLabels = ['≤5m', '5-15m', '15-30m', '30-60m', '60m+'];
  const priceLabels = ['80-85c', '85-90c', '90-95c', '95c+'];

  console.log(`  ${'Price'.padEnd(10)} | ${'Time'.padEnd(8)} | ${'N'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'AvgPrice'.padEnd(9)} | Edge`);
  console.log(`  ${'-'.repeat(60)}`);

  for (const pl of priceLabels) {
    for (const tl of timeLabels) {
      const key = `${pl}|${tl}`;
      const b = priceOnlyBuckets.get(key);
      if (!b || b.count < 3) continue;

      const wr = b.wins / b.count;
      const avgPrice = b.totalPrice / b.count;
      const edge = wr - avgPrice;
      const edgeStr = edge >= 0 ? `+${(edge * 100).toFixed(1)}%` : `${(edge * 100).toFixed(1)}%`;

      console.log(
        `  ${pl.padEnd(10)} | ${tl.padEnd(8)} | ${String(b.count).padEnd(5)} | ` +
        `${(wr * 100).toFixed(1).padEnd(6)}% | ${(avgPrice * 100).toFixed(1).padEnd(8)}c | ${edgeStr}`
      );
    }
  }

  // 2. Feature-combo analysis — find high-edge buckets
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  FEATURE ANALYSIS — Edge by Feature Combination             ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Sort by edge, filter minimum sample size
  const MIN_SAMPLES = 10;
  const rankedBuckets = [...buckets.entries()]
    .filter(([_, b]) => b.count >= MIN_SAMPLES)
    .map(([key, b]) => {
      const wr = b.wins / b.count;
      const avgPrice = b.totalPrice / b.count;
      const edge = wr - avgPrice;
      return { key, ...b, wr, avgPrice, edge };
    })
    .sort((a, b) => b.edge - a.edge);

  console.log('  TOP 20 — Highest Edge Feature Combos (min 10 samples)\n');
  console.log(`  ${'Rank'.padEnd(5)} | ${'Features'.padEnd(35)} | ${'N'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'AvgPrice'.padEnd(9)} | Edge`);
  console.log(`  ${'-'.repeat(75)}`);

  for (let i = 0; i < Math.min(20, rankedBuckets.length); i++) {
    const b = rankedBuckets[i];
    const edgeStr = b.edge >= 0 ? `+${(b.edge * 100).toFixed(1)}%` : `${(b.edge * 100).toFixed(1)}%`;
    console.log(
      `  ${String(i + 1).padEnd(5)} | ${b.key.padEnd(35)} | ${String(b.count).padEnd(5)} | ` +
      `${(b.wr * 100).toFixed(1).padEnd(6)}% | ${(b.avgPrice * 100).toFixed(1).padEnd(8)}c | ${edgeStr}`
    );
  }

  console.log('\n  BOTTOM 10 — Worst Edge (traps to avoid)\n');
  const worst = rankedBuckets.slice(-10).reverse();
  for (const b of worst) {
    const edgeStr = `${(b.edge * 100).toFixed(1)}%`;
    console.log(
      `  ${b.key.padEnd(35)} | ${String(b.count).padEnd(5)} | ` +
      `${(b.wr * 100).toFixed(1).padEnd(6)}% | ${(b.avgPrice * 100).toFixed(1).padEnd(8)}c | ${edgeStr}`
    );
  }

  // 3. The key question: does low vol + rising + long regime = edge?
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  KEY HYPOTHESIS — Low Vol + Rising + Long Regime = Edge?    ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const hypothesisKeys = [
    '90-95c|rising|low',        // price rising, low vol
    '90-95c|flat|low',          // price flat, low vol
    '90-95c|falling|low',       // price falling, low vol
    '90-95c|rising|high',       // price rising, high vol
    '90-95c|falling|high',      // price falling, high vol
    '95c+|rising|low',
    '95c+|flat|low',
    '95c+|falling|low',
    '95c+|rising|high',
    '85-90c|rising|low',
    '85-90c|falling|high',
    '90-95c|rising|low|30m+',   // quad: all good signals
    '90-95c|rising|low|10-30m',
    '90-95c|rising|low|<10m',
    '90-95c|flat|low|30m+',
    '95c+|rising|low|30m+',
    '95c+|flat|low|30m+',
  ];

  console.log(`  ${'Features'.padEnd(35)} | ${'N'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'AvgPrice'.padEnd(9)} | Edge    | Verdict`);
  console.log(`  ${'-'.repeat(80)}`);

  for (const key of hypothesisKeys) {
    const b = buckets.get(key);
    if (!b || b.count < 3) {
      console.log(`  ${key.padEnd(35)} | ${'—'.padEnd(5)} | ${'—'.padEnd(7)} | ${'—'.padEnd(9)} | —       | no data`);
      continue;
    }
    const wr = b.wins / b.count;
    const avgPrice = b.totalPrice / b.count;
    const edge = wr - avgPrice;
    const edgeStr = edge >= 0 ? `+${(edge * 100).toFixed(1)}%` : `${(edge * 100).toFixed(1)}%`;
    const verdict = edge >= 0.05 ? '✅ EDGE' : edge >= 0.02 ? '⚠️ marginal' : edge >= 0 ? '➖ neutral' : '❌ negative';
    console.log(
      `  ${key.padEnd(35)} | ${String(b.count).padEnd(5)} | ` +
      `${(wr * 100).toFixed(1).padEnd(6)}% | ${(avgPrice * 100).toFixed(1).padEnd(8)}c | ${edgeStr.padEnd(8)} | ${verdict}`
    );
  }

  // 4. Summary statistics
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY                                                     ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const positiveEdge = rankedBuckets.filter(b => b.edge > 0.03 && b.count >= 20);
  console.log(`  Feature combos with >3% edge (n≥20): ${positiveEdge.length}`);
  if (positiveEdge.length > 0) {
    console.log(`  Best: ${positiveEdge[0].key} | Edge: +${(positiveEdge[0].edge * 100).toFixed(1)}% | n=${positiveEdge[0].count}`);
  }

  const negativeEdge = rankedBuckets.filter(b => b.edge < -0.05 && b.count >= 20);
  console.log(`  Feature combos with <-5% edge (n≥20): ${negativeEdge.length} (traps to avoid)`);

  console.log(`\n  Total markets: ${marketsProcessed} | Observations: ${totalObservations}`);
  console.log('');

  await client.close();
}

function addToBucket(map: Map<string, BucketStats>, key: string, price: number, won: boolean) {
  const b = map.get(key) || { count: 0, wins: 0, totalPrice: 0, totalEdge: 0, prices: [] };
  b.count++;
  if (won) b.wins++;
  b.totalPrice += price;
  b.prices.push(price);
  map.set(key, b);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
