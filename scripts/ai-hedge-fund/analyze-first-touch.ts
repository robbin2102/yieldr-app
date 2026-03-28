/**
 * First-Touch Reversal Analysis — 2s Resolution
 *
 * Uses live orderbook data collected by btc-5m-bot (btc5mOrderbook collection)
 * to simulate first-touch fills at bestBid+1c and measure reversal rates.
 *
 * For each cycle:
 *   1. Determine winner (last snapshot's dominant side OR BTC vs strike)
 *   2. For each entry threshold (85c, 90c, 95c):
 *      - Find FIRST snapshot where bestAsk >= threshold + 1c (trigger)
 *      - Simulated fill at bestBid + 1c on that side (maker fill)
 *      - Once filled, position is locked — no switching, no cancellation
 *      - Compare filled side vs winner → win or reversal
 *   3. Test with and without delta filters (0, 15, 30)
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/analyze-first-touch.ts
 */

import dotenv from 'dotenv';
import path from 'path';
import { MongoClient } from 'mongodb';

const envLocations = [
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
];
for (const envPath of envLocations) {
  const r = dotenv.config({ path: envPath });
  if (r.parsed && r.parsed.MONGODB_URI) break;
}

const BUDGET = 100; // $100 per trade
const ENTRY_THRESHOLDS = [0.85, 0.90, 0.95];
const DELTA_FILTERS = [0, 15, 30];
const WINDOWS = [60, 90]; // seconds before close
const TRIGGER_SPREAD = 0.01; // trigger when bestAsk >= threshold + 1c

interface Snapshot {
  slug: string;
  secsBeforeClose: number;
  btcPrice: number;
  priceToBeat: number;
  delta: number;
  absDelta: number;
  up: { bestAsk: number | null; bestBid: number | null; askDepth: number };
  down: { bestAsk: number | null; bestBid: number | null; askDepth: number };
}

interface CycleData {
  slug: string;
  snapshots: Snapshot[];
  priceToBeat: number;
  winner: 'Up' | 'Down' | 'Unknown';
  finalBtcPrice: number;
  finalDelta: number;
}

interface TouchResult {
  slug: string;
  threshold: number;
  window: number;
  minDelta: number;
  triggered: boolean;
  side: string;
  fillPrice: number;      // bestBid + 1c at trigger moment
  marketAsk: number;      // bestAsk at trigger moment
  spread: number;         // ask - bid at trigger moment
  btcPrice: number;
  delta: number;
  absDelta: number;
  secsBeforeClose: number;
  won: boolean;
  pnl: number;            // $100 budget
  shares: number;
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error('MONGODB_URI not set'); process.exit(1); }
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(dbName);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('       FIRST-TOUCH REVERSAL ANALYSIS — 2s Resolution          ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Load all orderbook snapshots grouped by cycle
  const allSnaps = await db.collection('btc5mOrderbook')
    .find({ btcPrice: { $gt: 0 } })
    .sort({ slug: 1, secsBeforeClose: -1 })
    .toArray() as any[];

  console.log(`Loaded ${allSnaps.length} orderbook snapshots`);

  // Load cycle data for strike prices
  const cyclesDb = await db.collection('btc5mBotCycles').find({}).toArray() as any[];
  const strikeMap = new Map<string, number>();
  for (const c of cyclesDb) {
    if (c.priceToBeat > 0) strikeMap.set(c.slug, c.priceToBeat);
  }

  // Group snapshots by cycle
  const cycleMap = new Map<string, Snapshot[]>();
  for (const s of allSnaps) {
    const list = cycleMap.get(s.slug) || [];
    list.push({
      slug: s.slug,
      secsBeforeClose: s.secsBeforeClose,
      btcPrice: s.btcPrice || 0,
      priceToBeat: s.priceToBeat || strikeMap.get(s.slug) || 0,
      delta: s.delta || 0,
      absDelta: s.absDelta || Math.abs(s.delta || 0),
      up: { bestAsk: s.up?.bestAsk ?? null, bestBid: s.up?.bestBid ?? null, askDepth: s.up?.askDepth || 0 },
      down: { bestAsk: s.down?.bestAsk ?? null, bestBid: s.down?.bestBid ?? null, askDepth: s.down?.askDepth || 0 },
    });
    cycleMap.set(s.slug, list);
  }

  // Build cycles with winner determination
  const cycles: CycleData[] = [];
  for (const [slug, snaps] of cycleMap) {
    if (snaps.length < 10) continue; // skip incomplete cycles

    // Sort by secsBeforeClose descending (earliest first)
    snaps.sort((a, b) => b.secsBeforeClose - a.secsBeforeClose);

    const ptb = snaps[0].priceToBeat || strikeMap.get(slug) || 0;
    if (ptb === 0) continue;

    // Winner: use last snapshot's BTC price vs strike
    const lastSnap = snaps[snaps.length - 1];
    const finalBtcPrice = lastSnap.btcPrice;
    const finalDelta = finalBtcPrice - ptb;
    let winner: 'Up' | 'Down' | 'Unknown' = 'Unknown';

    if (finalBtcPrice > 0 && ptb > 0) {
      winner = finalBtcPrice > ptb ? 'Up' : 'Down';
    }
    // Fallback: use last snapshot's orderbook
    if (winner === 'Unknown') {
      const upAsk = lastSnap.up.bestAsk;
      const downAsk = lastSnap.down.bestAsk;
      if (upAsk !== null && downAsk !== null) {
        winner = upAsk > downAsk ? 'Up' : 'Down';
      }
    }

    if (winner === 'Unknown') continue;

    cycles.push({ slug, snapshots: snaps, priceToBeat: ptb, winner, finalBtcPrice, finalDelta });
  }

  console.log(`${cycles.length} complete cycles with known winner`);
  const upWins = cycles.filter(c => c.winner === 'Up').length;
  console.log(`Up wins: ${upWins} (${(upWins / cycles.length * 100).toFixed(1)}%) | Down wins: ${cycles.length - upWins} (${((cycles.length - upWins) / cycles.length * 100).toFixed(1)}%)\n`);

  // Run analysis for all combinations
  const allResults: TouchResult[] = [];

  for (const cycle of cycles) {
    for (const threshold of ENTRY_THRESHOLDS) {
      for (const window of WINDOWS) {
        for (const minDelta of DELTA_FILTERS) {
          const result = simulateFirstTouch(cycle, threshold, window, minDelta);
          if (result) allResults.push(result);
        }
      }
    }
  }

  // === MAIN RESULTS TABLE ===
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  FIRST-TOUCH RESULTS — bestBid+1c fill, no protection       ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('Entry | Window | Delta | Cycles | Touches | Wins | Rev |   WR% |  Rev% |  AvgFill |  EV/$  | PnL/$100 | $/cycle');
  console.log('───── | ────── | ───── | ────── | ─────── | ──── | ─── | ───── | ───── | ──────── | ────── | ──────── | ───────');

  for (const threshold of ENTRY_THRESHOLDS) {
    for (const window of WINDOWS) {
      for (const minDelta of DELTA_FILTERS) {
        const results = allResults.filter(r =>
          r.threshold === threshold && r.window === window && r.minDelta === minDelta
        );
        const triggered = results.filter(r => r.triggered);
        const wins = triggered.filter(r => r.won);
        const losses = triggered.filter(r => !r.won);

        if (triggered.length === 0) {
          console.log(`${(threshold * 100).toFixed(0)}c   | ${window}s    | ${String(minDelta).padStart(3)}   | ${String(cycles.length).padStart(4)}   |       0 |    0 |   0 |    0% |    0% |      N/A |    N/A |      N/A |     N/A`);
          continue;
        }

        const wr = wins.length / triggered.length;
        const revRate = losses.length / triggered.length;
        const avgFill = triggered.reduce((s, r) => s + r.fillPrice, 0) / triggered.length;
        const totalPnl = triggered.reduce((s, r) => s + r.pnl, 0);
        const avgPnlPerTrigger = totalPnl / triggered.length;
        const profitPerDollar = avgFill > 0 ? wr * (1 / avgFill - 1) - (1 - wr) * 1 : 0;

        console.log(
          `${(threshold * 100).toFixed(0)}c   | ${window}s    | ${String(minDelta).padStart(3)}   | ` +
          `${String(cycles.length).padStart(4)}   | ${String(triggered.length).padStart(5)}   | ${String(wins.length).padStart(4)} | ${String(losses.length).padStart(3)} | ` +
          `${(wr * 100).toFixed(1).padStart(4)}% | ${(revRate * 100).toFixed(1).padStart(4)}% | ` +
          `${(avgFill * 100).toFixed(1).padStart(5)}c   | ${profitPerDollar.toFixed(3).padStart(6)} | ` +
          `$${avgPnlPerTrigger.toFixed(2).padStart(7)} | $${(totalPnl / cycles.length).toFixed(2)}`
        );
      }
    }
    console.log('');
  }

  // === FILL PRICE DISTRIBUTION ===
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  FILL PRICE DISTRIBUTION (bestBid + 1c at trigger)           ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const threshold of ENTRY_THRESHOLDS) {
    const triggered = allResults.filter(r => r.threshold === threshold && r.window === 90 && r.minDelta === 0 && r.triggered);
    if (triggered.length === 0) continue;

    const fills = triggered.map(r => r.fillPrice).sort((a, b) => a - b);
    const avg = fills.reduce((a, b) => a + b, 0) / fills.length;
    const median = fills[Math.floor(fills.length / 2)];
    const min = fills[0];
    const max = fills[fills.length - 1];
    const spreads = triggered.map(r => r.spread);
    const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;

    console.log(`  ${(threshold * 100).toFixed(0)}c strategy (90s window, no delta filter):`);
    console.log(`    Fills: ${fills.length} | Avg: ${(avg * 100).toFixed(1)}c | Median: ${(median * 100).toFixed(1)}c | Min: ${(min * 100).toFixed(1)}c | Max: ${(max * 100).toFixed(1)}c`);
    console.log(`    Avg spread at fill: ${(avgSpread * 100).toFixed(1)}c`);
    console.log(`    Profit if win: avg ${((1 / avg - 1) * 100).toFixed(1)}% | min ${((1 / max - 1) * 100).toFixed(1)}% | max ${((1 / min - 1) * 100).toFixed(1)}%`);
    console.log('');
  }

  // === TIMING ANALYSIS ===
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TIMING — When does first touch happen?                      ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const threshold of ENTRY_THRESHOLDS) {
    const triggered = allResults.filter(r => r.threshold === threshold && r.window === 90 && r.minDelta === 0 && r.triggered);
    if (triggered.length === 0) continue;

    const buckets = {
      '90-60s': { count: 0, wins: 0 },
      '60-30s': { count: 0, wins: 0 },
      '30-10s': { count: 0, wins: 0 },
      '<10s': { count: 0, wins: 0 },
    };

    for (const r of triggered) {
      const s = r.secsBeforeClose;
      const bucket = s >= 60 ? '90-60s' : s >= 30 ? '60-30s' : s >= 10 ? '30-10s' : '<10s';
      buckets[bucket as keyof typeof buckets].count++;
      if (r.won) buckets[bucket as keyof typeof buckets].wins++;
    }

    console.log(`  ${(threshold * 100).toFixed(0)}c strategy:`);
    for (const [bucket, data] of Object.entries(buckets)) {
      if (data.count === 0) continue;
      const wr = (data.wins / data.count * 100).toFixed(1);
      const rev = ((data.count - data.wins) / data.count * 100).toFixed(1);
      console.log(`    ${bucket.padEnd(8)}: ${String(data.count).padStart(4)} touches | ${String(data.wins).padStart(4)} wins | WR ${wr}% | Rev ${rev}%`);
    }
    console.log('');
  }

  // === REVERSAL DETAIL ===
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  REVERSAL DETAIL — Cycles where first touch lost             ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const threshold of ENTRY_THRESHOLDS) {
    const reversals = allResults.filter(r => r.threshold === threshold && r.window === 90 && r.minDelta === 0 && r.triggered && !r.won);
    if (reversals.length === 0) {
      console.log(`  ${(threshold * 100).toFixed(0)}c: No reversals!`);
      continue;
    }

    console.log(`  ${(threshold * 100).toFixed(0)}c reversals (${reversals.length}):`);
    for (const r of reversals) {
      console.log(`    ${r.slug.slice(-10)} | filled ${r.side}@${(r.fillPrice * 100).toFixed(1)}c | ask=${(r.marketAsk * 100).toFixed(0)}c | delta=${r.delta.toFixed(0)} | -${r.secsBeforeClose}s | winner=${r.won ? r.side : r.side === 'Up' ? 'Down' : 'Up'}`);
    }
    console.log('');
  }

  // === DELTA IMPACT ===
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  DELTA IMPACT — Does delta filter improve win rate?           ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const threshold of ENTRY_THRESHOLDS) {
    console.log(`  ${(threshold * 100).toFixed(0)}c at 90s window:`);
    for (const minDelta of DELTA_FILTERS) {
      const triggered = allResults.filter(r => r.threshold === threshold && r.window === 90 && r.minDelta === minDelta && r.triggered);
      const wins = triggered.filter(r => r.won);
      if (triggered.length === 0) { console.log(`    delta>=${minDelta}: No triggers`); continue; }
      const totalPnl = triggered.reduce((s, r) => s + r.pnl, 0);
      console.log(`    delta>=${String(minDelta).padStart(2)}: ${String(triggered.length).padStart(4)} triggers | ${String(wins.length).padStart(4)} wins | WR ${(wins.length / triggered.length * 100).toFixed(1)}% | PnL $${totalPnl.toFixed(0)}`);
    }
    console.log('');
  }

  // === SUMMARY ===
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  BEST STRATEGY RECOMMENDATION                                ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Rank by PnL per cycle
  const strategyPnls: { key: string; pnlPerCycle: number; wr: number; triggers: number; ev: number }[] = [];
  for (const threshold of ENTRY_THRESHOLDS) {
    for (const window of WINDOWS) {
      for (const minDelta of DELTA_FILTERS) {
        const triggered = allResults.filter(r => r.threshold === threshold && r.window === window && r.minDelta === minDelta && r.triggered);
        if (triggered.length === 0) continue;
        const wins = triggered.filter(r => r.won);
        const totalPnl = triggered.reduce((s, r) => s + r.pnl, 0);
        const avgFill = triggered.reduce((s, r) => s + r.fillPrice, 0) / triggered.length;
        const wr = wins.length / triggered.length;
        const ev = avgFill > 0 ? wr * (1 / avgFill - 1) - (1 - wr) : 0;
        strategyPnls.push({
          key: `${(threshold * 100).toFixed(0)}c/${window}s/delta${minDelta}`,
          pnlPerCycle: totalPnl / cycles.length,
          wr: wr * 100,
          triggers: triggered.length,
          ev,
        });
      }
    }
  }

  strategyPnls.sort((a, b) => b.pnlPerCycle - a.pnlPerCycle);
  console.log('  Rank | Strategy             | Triggers | WR%   | EV/$  | PnL/cycle');
  console.log('  ──── | ──────────────────── | ──────── | ───── | ───── | ─────────');
  for (let i = 0; i < Math.min(10, strategyPnls.length); i++) {
    const s = strategyPnls[i];
    console.log(`  ${String(i + 1).padStart(4)} | ${s.key.padEnd(20)} | ${String(s.triggers).padStart(6)}   | ${s.wr.toFixed(1).padStart(4)}% | ${s.ev.toFixed(3)} | $${s.pnlPerCycle.toFixed(2)}`);
  }

  console.log(`\n  Total cycles: ${cycles.length}`);

  await client.close();
}

function simulateFirstTouch(cycle: CycleData, threshold: number, window: number, minDelta: number): TouchResult | null {
  const triggerLevel = threshold + TRIGGER_SPREAD;

  for (const snap of cycle.snapshots) {
    // Must be within window
    if (snap.secsBeforeClose > window) continue;
    if (snap.secsBeforeClose <= 0) continue;

    // Delta filter
    if (minDelta > 0 && snap.absDelta < minDelta) continue;

    // Check Up side
    if (snap.up.bestAsk !== null && snap.up.bestAsk >= triggerLevel && snap.up.bestBid !== null) {
      const fillPrice = snap.up.bestBid + 0.01;
      const shares = BUDGET / fillPrice;
      const won = cycle.winner === 'Up';
      const pnl = won ? shares - BUDGET : -BUDGET;

      return {
        slug: cycle.slug, threshold, window, minDelta,
        triggered: true, side: 'Up', fillPrice, marketAsk: snap.up.bestAsk,
        spread: snap.up.bestAsk - snap.up.bestBid,
        btcPrice: snap.btcPrice, delta: snap.delta, absDelta: snap.absDelta,
        secsBeforeClose: snap.secsBeforeClose, won, pnl, shares,
      };
    }

    // Check Down side
    if (snap.down.bestAsk !== null && snap.down.bestAsk >= triggerLevel && snap.down.bestBid !== null) {
      const fillPrice = snap.down.bestBid + 0.01;
      const shares = BUDGET / fillPrice;
      const won = cycle.winner === 'Down';
      const pnl = won ? shares - BUDGET : -BUDGET;

      return {
        slug: cycle.slug, threshold, window, minDelta,
        triggered: true, side: 'Down', fillPrice, marketAsk: snap.down.bestAsk,
        spread: snap.down.bestAsk - snap.down.bestBid,
        btcPrice: snap.btcPrice, delta: snap.delta, absDelta: snap.absDelta,
        secsBeforeClose: snap.secsBeforeClose, won, pnl, shares,
      };
    }
  }

  // No trigger in this cycle
  return { slug: cycle.slug, threshold, window, minDelta, triggered: false, side: '', fillPrice: 0, marketAsk: 0, spread: 0, btcPrice: 0, delta: 0, absDelta: 0, secsBeforeClose: 0, won: false, pnl: 0, shares: 0 };
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
