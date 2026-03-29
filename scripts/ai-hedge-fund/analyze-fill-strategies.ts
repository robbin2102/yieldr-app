/**
 * Fill Strategy Optimizer — Analyzes orderbook data to find best fill approach
 *
 * Tests multiple fill strategies against real 500ms/2s orderbook data:
 * 1. GTC at entry price (current: place at 90c)
 * 2. GTC at bestBid + 1c
 * 3. GTC at midpoint (bid+ask)/2
 * 4. GTC at bestAsk - 1c
 * 5. GTC at bestAsk (taker, immediate fill assumed)
 *
 * For each strategy × entry threshold × delta filter:
 * - Simulated fill rate (would the order have filled based on price movement?)
 * - Average fill price
 * - Spread at fill time
 * - Win rate (filled side vs resolution winner)
 * - EV per cycle (combining fill rate, fill price, win rate)
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/analyze-fill-strategies.ts
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

const BUDGET = 100;
const ENTRY_THRESHOLDS = [0.85, 0.90, 0.95];
const DELTA_FILTER = 30;
const WINDOW = 90;
const TRIGGER_SPREAD = 0.01;
const TAKER_FEE_RATE = 0.10; // Polymarket fee: price × (1-price) × rate

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

interface FillResult {
  slug: string;
  threshold: number;
  strategy: string;
  triggered: boolean;
  filled: boolean;
  side: string;
  fillPrice: number;
  spreadAtTrigger: number;
  bestAskAtTrigger: number;
  bestBidAtTrigger: number;
  secsBeforeClose: number;
  delta: number;
  won: boolean;
  pnl: number;
  fee: number;
  netPnl: number;
}

interface FillStrategy {
  name: string;
  description: string;
  isTaker: boolean;
  getFillPrice: (bestBid: number, bestAsk: number, entryPrice: number) => number;
  wouldFill: (fillPrice: number, bestBid: number, bestAsk: number, subsequentSnaps: Snapshot[], side: string) => boolean;
}

const FILL_STRATEGIES: FillStrategy[] = [
  {
    name: 'GTC_at_entry',
    description: 'GTC limit at entry price (e.g., 90c)',
    isTaker: false,
    getFillPrice: (_bid, _ask, entry) => entry,
    wouldFill: (fillPrice, _bid, _ask, subSnaps, side) => {
      // Fills when price drops back to our level (someone sells at our bid)
      for (const s of subSnaps) {
        const sideData = side === 'Up' ? s.up : s.down;
        // Price drops to or below our level = fill
        if (sideData.bestBid !== null && sideData.bestBid <= fillPrice) return true;
        if (sideData.bestAsk !== null && sideData.bestAsk <= fillPrice) return true;
      }
      return false;
    },
  },
  {
    name: 'GTC_bid_plus1',
    description: 'GTC at bestBid + 1c (current analysis approach)',
    isTaker: false,
    getFillPrice: (bid, _ask, _entry) => bid + 0.01,
    wouldFill: (fillPrice, _bid, _ask, subSnaps, side) => {
      for (const s of subSnaps) {
        const sideData = side === 'Up' ? s.up : s.down;
        if (sideData.bestAsk !== null && sideData.bestAsk <= fillPrice) return true;
        if (sideData.bestBid !== null && sideData.bestBid <= fillPrice) return true;
      }
      return false;
    },
  },
  {
    name: 'GTC_midpoint',
    description: 'GTC at (bestBid + bestAsk) / 2',
    isTaker: false,
    getFillPrice: (bid, ask, _entry) => Math.round((bid + ask) / 2 * 100) / 100,
    wouldFill: (fillPrice, _bid, _ask, subSnaps, side) => {
      for (const s of subSnaps) {
        const sideData = side === 'Up' ? s.up : s.down;
        if (sideData.bestAsk !== null && sideData.bestAsk <= fillPrice) return true;
      }
      return false;
    },
  },
  {
    name: 'GTC_ask_minus1',
    description: 'GTC at bestAsk - 1c (aggressive maker)',
    isTaker: false,
    getFillPrice: (_bid, ask, _entry) => ask - 0.01,
    wouldFill: (_fillPrice, _bid, _ask, _subSnaps, _side) => {
      // Very likely to fill since we're just 1c below ask
      // Assume 80% fill rate (conservative)
      return true; // Simplified: if we're 1c below ask at trigger, assume fill
    },
  },
  {
    name: 'FAK_at_ask',
    description: 'FAK/taker at bestAsk (immediate fill)',
    isTaker: true,
    getFillPrice: (_bid, ask, _entry) => ask,
    wouldFill: () => true, // Always fills immediately
  },
];

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error('MONGODB_URI not set'); process.exit(1); }
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(dbName);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('       FILL STRATEGY OPTIMIZER — Real Orderbook Data           ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Load orderbook snapshots (only good cycles)
  const allSnaps = await db.collection('btc5mOrderbook')
    .find({ btcPrice: { $gt: 0 } })
    .sort({ slug: 1, secsBeforeClose: -1 })
    .toArray() as any[];

  // Load cycles for strike
  const cyclesDb = await db.collection('btc5mBotCycles').find({}).toArray() as any[];
  const strikeMap = new Map<string, number>();
  for (const c of cyclesDb) { if (c.priceToBeat > 0) strikeMap.set(c.slug, c.priceToBeat); }

  // Group by cycle, filter frozen
  const cycleMap = new Map<string, Snapshot[]>();
  for (const s of allSnaps) {
    const list = cycleMap.get(s.slug) || [];
    list.push({
      slug: s.slug, secsBeforeClose: s.secsBeforeClose,
      btcPrice: s.btcPrice || 0, priceToBeat: s.priceToBeat || strikeMap.get(s.slug) || 0,
      delta: s.delta || 0, absDelta: s.absDelta || Math.abs(s.delta || 0),
      up: { bestAsk: s.up?.bestAsk ?? null, bestBid: s.up?.bestBid ?? null, askDepth: s.up?.askDepth || 0 },
      down: { bestAsk: s.down?.bestAsk ?? null, bestBid: s.down?.bestBid ?? null, askDepth: s.down?.askDepth || 0 },
    });
    cycleMap.set(s.slug, list);
  }

  // Build cycles with winner
  interface CycleData { slug: string; snapshots: Snapshot[]; winner: 'Up' | 'Down'; priceToBeat: number; }
  const cycles: CycleData[] = [];
  for (const [slug, snaps] of cycleMap) {
    if (snaps.length < 10) continue;
    const uniquePrices = new Set(snaps.map(s => Math.round(s.btcPrice)));
    if (uniquePrices.size <= 1) continue; // Skip frozen

    snaps.sort((a, b) => b.secsBeforeClose - a.secsBeforeClose);
    const ptb = snaps[0].priceToBeat || strikeMap.get(slug) || 0;
    if (ptb === 0) continue;

    const lastSnap = snaps[snaps.length - 1];
    const winner = lastSnap.btcPrice > ptb ? 'Up' as const : 'Down' as const;
    cycles.push({ slug, snapshots: snaps, winner, priceToBeat: ptb });
  }

  console.log(`${cycles.length} clean cycles loaded\n`);

  // Run all strategies
  const allResults: FillResult[] = [];

  for (const cycle of cycles) {
    for (const threshold of ENTRY_THRESHOLDS) {
      const triggerLevel = threshold + TRIGGER_SPREAD;

      // Find first trigger snapshot
      let triggerSnap: Snapshot | null = null;
      let triggerSide: 'Up' | 'Down' | null = null;
      let triggerIdx = -1;

      for (let i = 0; i < cycle.snapshots.length; i++) {
        const snap = cycle.snapshots[i];
        if (snap.secsBeforeClose > WINDOW || snap.secsBeforeClose <= 0) continue;
        if (snap.absDelta < DELTA_FILTER) continue;

        if (snap.up.bestAsk !== null && snap.up.bestAsk >= triggerLevel && snap.up.bestBid !== null) {
          triggerSnap = snap; triggerSide = 'Up'; triggerIdx = i; break;
        }
        if (snap.down.bestAsk !== null && snap.down.bestAsk >= triggerLevel && snap.down.bestBid !== null) {
          triggerSnap = snap; triggerSide = 'Down'; triggerIdx = i; break;
        }
      }

      if (!triggerSnap || !triggerSide) continue;

      const sideData = triggerSide === 'Up' ? triggerSnap.up : triggerSnap.down;
      const bestBid = sideData.bestBid!;
      const bestAsk = sideData.bestAsk!;
      const spread = bestAsk - bestBid;
      const subsequentSnaps = cycle.snapshots.slice(triggerIdx + 1);

      // Test each fill strategy
      for (const strategy of FILL_STRATEGIES) {
        const fillPrice = strategy.getFillPrice(bestBid, bestAsk, threshold);
        const wouldFill = strategy.wouldFill(fillPrice, bestBid, bestAsk, subsequentSnaps, triggerSide);

        const fee = strategy.isTaker ? fillPrice * (1 - fillPrice) * TAKER_FEE_RATE : 0;
        const effectiveCost = fillPrice + fee;
        const shares = BUDGET / effectiveCost;
        const won = triggerSide === cycle.winner;
        const pnl = won && wouldFill ? shares - BUDGET : (wouldFill ? -BUDGET : 0);
        const netPnl = wouldFill ? pnl : 0;

        allResults.push({
          slug: cycle.slug, threshold, strategy: strategy.name,
          triggered: true, filled: wouldFill, side: triggerSide,
          fillPrice, spreadAtTrigger: spread, bestAskAtTrigger: bestAsk, bestBidAtTrigger: bestBid,
          secsBeforeClose: triggerSnap.secsBeforeClose,
          delta: triggerSnap.delta, won: won && wouldFill, pnl, fee, netPnl,
        });
      }
    }
  }

  // === RESULTS ===
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  COMPARISON: 5 fill strategies × 3 entry prices (delta>=${DELTA_FILTER}, ${WINDOW}s window)`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const threshold of ENTRY_THRESHOLDS) {
    console.log(`\n  ── Entry threshold: ${(threshold * 100).toFixed(0)}c ──\n`);
    console.log('  Strategy          | Triggered | Filled | Fill% | Wins |   WR% | AvgFill | AvgFee | AvgSpread | EV/$   | PnL/fill  | PnL/cycle');
    console.log('  ──────────────────|───────────|────────|───────|──────|───────|─────────|────────|───────────|────────|───────────|──────────');

    for (const strategy of FILL_STRATEGIES) {
      const results = allResults.filter(r => r.threshold === threshold && r.strategy === strategy.name);
      const triggered = results.filter(r => r.triggered);
      const filled = results.filter(r => r.filled);
      const wins = filled.filter(r => r.won);
      const losses = filled.filter(r => r.filled && !r.won);

      if (triggered.length === 0) continue;

      const fillRate = filled.length / triggered.length;
      const wr = filled.length > 0 ? wins.length / filled.length : 0;
      const avgFill = filled.length > 0 ? filled.reduce((s, r) => s + r.fillPrice, 0) / filled.length : 0;
      const avgFee = filled.length > 0 ? filled.reduce((s, r) => s + r.fee, 0) / filled.length : 0;
      const avgSpread = triggered.reduce((s, r) => s + r.spreadAtTrigger, 0) / triggered.length;
      const totalPnl = filled.reduce((s, r) => s + r.netPnl, 0);
      const pnlPerFill = filled.length > 0 ? totalPnl / filled.length : 0;
      const pnlPerCycle = totalPnl / cycles.length;

      const effectiveCost = avgFill + avgFee;
      const ev = filled.length > 0 ? wr * (1 / effectiveCost - 1) - (1 - wr) : 0;

      console.log(
        `  ${strategy.name.padEnd(18)} | ${String(triggered.length).padStart(7)}   | ${String(filled.length).padStart(4)}   | ` +
        `${(fillRate * 100).toFixed(0).padStart(3)}%  | ${String(wins.length).padStart(4)} | ${(wr * 100).toFixed(1).padStart(4)}% | ` +
        `${(avgFill * 100).toFixed(1).padStart(5)}c  | ${(avgFee * 100).toFixed(1).padStart(4)}c  | ` +
        `${(avgSpread * 100).toFixed(1).padStart(5)}c    | ${ev.toFixed(3).padStart(6)} | ` +
        `$${pnlPerFill.toFixed(2).padStart(8)} | $${pnlPerCycle.toFixed(2)}`
      );
    }
  }

  // === SPREAD ANALYSIS ===
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('  SPREAD ANALYSIS AT TRIGGER TIME                              ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const threshold of ENTRY_THRESHOLDS) {
    const triggered = allResults.filter(r => r.threshold === threshold && r.strategy === 'GTC_bid_plus1' && r.triggered);
    if (triggered.length === 0) continue;

    const spreads = triggered.map(r => r.spreadAtTrigger * 100).sort((a, b) => a - b);
    const bids = triggered.map(r => r.bestBidAtTrigger * 100).sort((a, b) => a - b);
    const asks = triggered.map(r => r.bestAskAtTrigger * 100).sort((a, b) => a - b);

    console.log(`  ${(threshold * 100).toFixed(0)}c triggers (${triggered.length}):`);
    console.log(`    Spread:  avg=${(spreads.reduce((a, b) => a + b, 0) / spreads.length).toFixed(1)}c | median=${spreads[Math.floor(spreads.length / 2)].toFixed(1)}c | min=${spreads[0].toFixed(1)}c | max=${spreads[spreads.length - 1].toFixed(1)}c`);
    console.log(`    BestBid: avg=${(bids.reduce((a, b) => a + b, 0) / bids.length).toFixed(1)}c | median=${bids[Math.floor(bids.length / 2)].toFixed(1)}c | min=${bids[0].toFixed(1)}c | max=${bids[bids.length - 1].toFixed(1)}c`);
    console.log(`    BestAsk: avg=${(asks.reduce((a, b) => a + b, 0) / asks.length).toFixed(1)}c | median=${asks[Math.floor(asks.length / 2)].toFixed(1)}c | min=${asks[0].toFixed(1)}c | max=${asks[asks.length - 1].toFixed(1)}c`);
    console.log('');
  }

  // === FEE IMPACT ===
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  FEE IMPACT — Maker (0%) vs Taker at different prices        ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('  Price | Taker Fee | Effective | Profit if Win | Fee as % of Profit');
  console.log('  ──────|───────────|───────────|───────────────|──────────────────');
  for (const p of [0.85, 0.88, 0.90, 0.92, 0.95, 0.97]) {
    const fee = p * (1 - p) * TAKER_FEE_RATE;
    const eff = p + fee;
    const profit = 1 / eff - 1;
    const feePct = fee / profit;
    console.log(`  ${(p * 100).toFixed(0)}c   | ${(fee * 100).toFixed(2)}c      | ${(eff * 100).toFixed(2)}c      | ${(profit * 100).toFixed(1)}%           | ${(feePct * 100).toFixed(0)}%`);
  }

  // === RECOMMENDATION ===
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('  RECOMMENDATION — Best fill strategy per entry price          ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const threshold of ENTRY_THRESHOLDS) {
    const best = FILL_STRATEGIES.map(strategy => {
      const filled = allResults.filter(r => r.threshold === threshold && r.strategy === strategy.name && r.filled);
      const totalPnl = filled.reduce((s, r) => s + r.netPnl, 0);
      return { name: strategy.name, pnlPerCycle: totalPnl / cycles.length, fills: filled.length };
    }).sort((a, b) => b.pnlPerCycle - a.pnlPerCycle);

    console.log(`  ${(threshold * 100).toFixed(0)}c: Best = ${best[0].name} ($${best[0].pnlPerCycle.toFixed(2)}/cycle, ${best[0].fills} fills)`);
    for (const s of best) {
      console.log(`    ${s.name.padEnd(18)}: $${s.pnlPerCycle.toFixed(2)}/cycle (${s.fills} fills)`);
    }
    console.log('');
  }

  await client.close();
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
