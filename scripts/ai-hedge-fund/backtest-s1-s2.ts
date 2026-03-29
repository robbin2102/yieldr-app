/**
 * Strategy Tester — S1 (High Entry FAK) + S2 (Cheap Contrarian)
 *
 * Uses real orderbook data from btc5mOrderbook collection.
 *
 * S1: Late-stage high-price entries (96c-99c) using FAK/taker orders
 *     Tests at 15s, 30s, 45s, 60s, 90s windows
 *     With and without delta >= 10 filter
 *     Includes Polymarket taker fees
 *
 * S2: Cheap-side contrarian — buy losing side at <10c when delta < 10
 *     Tests at 10s, 15s windows with entries at 5c, 7c, 10c
 *     High payout (10-20x) but low win rate
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/backtest-s1-s2.ts
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

// Polymarket fee: price * (1 - price) * 0.0222 (from fee table)
// Actually the fee schedule matches: fee = price * (1-price) * rate
// At 96c: fee = 0.96 * 0.04 * rate. From table: 95c fee = $0.05 on $95 = 0.053%
// Let me derive rate from table: at 50c, fee = $0.78 on $50 = 1.56%
// fee_per_share = 0.50 * 0.50 * rate = 0.25 * rate = 0.78/50 shares = 0.0156
// rate = 0.0156 / 0.25 = 0.0624... hmm
// Actually from table: fee on $1 trade at 50c = $0.78/50 = 0.0156 per share
// fee = p * (1-p) * 0.0625 per share? Let me just use the table directly.

function takerFeePerShare(price: number): number {
  // Interpolate from the fee table
  // fee = price * (1-price) * 0.0625 (approximately)
  // This gives: 0.50 → 0.0156, 0.90 → 0.005625, 0.95 → 0.00297, 0.99 → 0.000619
  return price * (1 - price) * 0.0625;
}

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
  winner: 'Up' | 'Down';
  priceToBeat: number;
}

interface TradeResult {
  slug: string;
  strategy: string;
  window: number;
  deltaFilter: number;
  triggered: boolean;
  side: string;
  fillPrice: number;
  feePerShare: number;
  effectiveCost: number;
  secsBeforeClose: number;
  delta: number;
  won: boolean;
  shares: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error('MONGODB_URI not set'); process.exit(1); }
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(dbName);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('       S1 + S2 STRATEGY BACKTESTER — Real Orderbook Data       ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Load orderbook data
  const allSnaps = await db.collection('btc5mOrderbook')
    .find({ btcPrice: { $gt: 0 } })
    .sort({ slug: 1, secsBeforeClose: -1 })
    .toArray() as any[];

  const cyclesDb = await db.collection('btc5mBotCycles').find({}).toArray() as any[];
  const strikeMap = new Map<string, number>();
  for (const c of cyclesDb) { if (c.priceToBeat > 0) strikeMap.set(c.slug, c.priceToBeat); }

  // Build cycles
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

  const cycles: CycleData[] = [];
  for (const [slug, snaps] of cycleMap) {
    if (snaps.length < 10) continue;
    const uniquePrices = new Set(snaps.map(s => Math.round(s.btcPrice)));
    if (uniquePrices.size <= 1) continue;
    snaps.sort((a, b) => b.secsBeforeClose - a.secsBeforeClose);
    const ptb = snaps[0].priceToBeat || strikeMap.get(slug) || 0;
    if (ptb === 0) continue;
    const lastSnap = snaps[snaps.length - 1];
    const winner = lastSnap.btcPrice > ptb ? 'Up' as const : 'Down' as const;
    cycles.push({ slug, snapshots: snaps, winner, priceToBeat: ptb });
  }

  console.log(`${cycles.length} clean cycles loaded\n`);

  // ═══════════════════════════════════════════════════════════
  // S1: HIGH ENTRY FAK (96c-99c)
  // ═══════════════════════════════════════════════════════════

  const s1Entries = [0.96, 0.97, 0.98, 0.99];
  const s1Windows = [15, 30, 45, 60, 90];
  const s1Deltas = [0, 10]; // 0 = no filter, 10 = abs delta >= 10

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  S1: HIGH ENTRY FAK (taker fills with fees)                  ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const s1Results: TradeResult[] = [];

  for (const cycle of cycles) {
    for (const entry of s1Entries) {
      for (const window of s1Windows) {
        for (const minDelta of s1Deltas) {
          // Find first snapshot where either side has bestAsk >= entry
          for (const snap of cycle.snapshots) {
            if (snap.secsBeforeClose > window || snap.secsBeforeClose <= 0) continue;
            if (minDelta > 0 && snap.absDelta < minDelta) continue;

            let side = '';
            let fillPrice = 0;

            if (snap.up.bestAsk !== null && snap.up.bestAsk >= entry) {
              side = 'Up'; fillPrice = snap.up.bestAsk; // FAK fills at ask
            } else if (snap.down.bestAsk !== null && snap.down.bestAsk >= entry) {
              side = 'Down'; fillPrice = snap.down.bestAsk;
            }

            if (side) {
              const fee = takerFeePerShare(fillPrice);
              const effectiveCost = fillPrice + fee;
              const shares = BUDGET / effectiveCost;
              const won = side === cycle.winner;
              const grossPnl = won ? shares - BUDGET : -BUDGET;
              const fees = shares * fee;
              const netPnl = won ? shares - BUDGET - fees : -BUDGET;

              s1Results.push({
                slug: cycle.slug, strategy: `S1_${(entry*100).toFixed(0)}c`,
                window, deltaFilter: minDelta, triggered: true,
                side, fillPrice, feePerShare: fee, effectiveCost,
                secsBeforeClose: snap.secsBeforeClose, delta: snap.delta,
                won, shares, grossPnl, fees, netPnl,
              });
              break; // First touch only
            }
          }
        }
      }
    }
  }

  // S1 Results Table
  console.log('Entry | Window | Delta | Cycles | Hits |  WR% | AvgFill | AvgFee | Gross PnL | Fees    | Net PnL  | $/cycle');
  console.log('───── | ────── | ───── | ────── | ──── | ──── | ─────── | ────── | ───────── | ─────── | ──────── | ───────');

  for (const entry of s1Entries) {
    for (const window of s1Windows) {
      for (const minDelta of s1Deltas) {
        const trades = s1Results.filter(r => r.strategy === `S1_${(entry*100).toFixed(0)}c` && r.window === window && r.deltaFilter === minDelta);
        if (trades.length === 0) continue;
        const wins = trades.filter(t => t.won);
        const wr = wins.length / trades.length;
        const avgFill = trades.reduce((s, t) => s + t.fillPrice, 0) / trades.length;
        const avgFee = trades.reduce((s, t) => s + t.feePerShare, 0) / trades.length;
        const grossPnl = trades.reduce((s, t) => s + t.grossPnl, 0);
        const totalFees = trades.reduce((s, t) => s + t.fees, 0);
        const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);

        console.log(
          `${(entry*100).toFixed(0)}c   | ${String(window).padStart(3)}s   | ${String(minDelta).padStart(3)}   | ${String(cycles.length).padStart(4)}   | ${String(trades.length).padStart(4)} | ${(wr*100).toFixed(0).padStart(3)}% | ` +
          `${(avgFill*100).toFixed(1).padStart(5)}c  | ${(avgFee*100).toFixed(2).padStart(4)}c  | ` +
          `$${grossPnl.toFixed(0).padStart(8)} | $${totalFees.toFixed(0).padStart(6)} | $${netPnl.toFixed(0).padStart(7)} | $${(netPnl/cycles.length).toFixed(2)}`
        );
      }
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════
  // S2: CHEAP CONTRARIAN (buy losing side when delta < 10)
  // ═══════════════════════════════════════════════════════════

  const s2Entries = [0.05, 0.07, 0.10];
  const s2Windows = [10, 15, 30];
  const s2MaxDeltas = [10, 15, 20]; // Only enter when delta is LOW (choppy)

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  S2: CHEAP CONTRARIAN (buy losing side when delta < X)       ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const s2Results: TradeResult[] = [];

  for (const cycle of cycles) {
    for (const entry of s2Entries) {
      for (const window of s2Windows) {
        for (const maxDelta of s2MaxDeltas) {
          for (const snap of cycle.snapshots) {
            if (snap.secsBeforeClose > window || snap.secsBeforeClose <= 0) continue;
            if (snap.absDelta >= maxDelta) continue; // Only enter when delta is LOW

            let side = '';
            let fillPrice = 0;

            // Buy the CHEAP side (losing side) — look for bestAsk <= entry
            if (snap.up.bestAsk !== null && snap.up.bestAsk <= entry && snap.up.bestAsk > 0.01) {
              side = 'Up'; fillPrice = snap.up.bestAsk;
            } else if (snap.down.bestAsk !== null && snap.down.bestAsk <= entry && snap.down.bestAsk > 0.01) {
              side = 'Down'; fillPrice = snap.down.bestAsk;
            }

            if (side) {
              const fee = takerFeePerShare(fillPrice);
              const effectiveCost = fillPrice + fee;
              const shares = BUDGET / effectiveCost;
              const won = side === cycle.winner;
              const grossPnl = won ? shares - BUDGET : -BUDGET;
              const fees = shares * fee;
              const netPnl = won ? shares - BUDGET - fees : -BUDGET;

              s2Results.push({
                slug: cycle.slug, strategy: `S2_${(entry*100).toFixed(0)}c`,
                window, deltaFilter: maxDelta, triggered: true,
                side, fillPrice, feePerShare: fee, effectiveCost,
                secsBeforeClose: snap.secsBeforeClose, delta: snap.delta,
                won, shares, grossPnl, fees, netPnl,
              });
              break;
            }
          }
        }
      }
    }
  }

  // S2 Results Table
  console.log('Entry | Window | MaxΔ  | Cycles | Hits |  WR% | AvgFill | Payout | Gross PnL | Fees    | Net PnL  | $/cycle');
  console.log('───── | ────── | ───── | ────── | ──── | ──── | ─────── | ────── | ───────── | ─────── | ──────── | ───────');

  for (const entry of s2Entries) {
    for (const window of s2Windows) {
      for (const maxDelta of s2MaxDeltas) {
        const trades = s2Results.filter(r => r.strategy === `S2_${(entry*100).toFixed(0)}c` && r.window === window && r.deltaFilter === maxDelta);
        if (trades.length === 0) continue;
        const wins = trades.filter(t => t.won);
        const wr = wins.length / trades.length;
        const avgFill = trades.reduce((s, t) => s + t.fillPrice, 0) / trades.length;
        const payout = avgFill > 0 ? (1 / avgFill).toFixed(1) + 'x' : '?';
        const grossPnl = trades.reduce((s, t) => s + t.grossPnl, 0);
        const totalFees = trades.reduce((s, t) => s + t.fees, 0);
        const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);

        console.log(
          `${(entry*100).toFixed(0)}c    | ${String(window).padStart(3)}s   | <${String(maxDelta).padStart(2)}   | ${String(cycles.length).padStart(4)}   | ${String(trades.length).padStart(4)} | ${(wr*100).toFixed(0).padStart(3)}% | ` +
          `${(avgFill*100).toFixed(1).padStart(5)}c  | ${payout.padStart(5)} | ` +
          `$${grossPnl.toFixed(0).padStart(8)} | $${totalFees.toFixed(0).padStart(6)} | $${netPnl.toFixed(0).padStart(7)} | $${(netPnl/cycles.length).toFixed(2)}`
        );
      }
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════
  // S2 REVERSAL DETAIL
  // ═══════════════════════════════════════════════════════════

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  S2: WINNING TRADES DETAIL (cheap side that actually won)     ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const s2Wins = s2Results.filter(r => r.won && r.window === 15 && r.deltaFilter === 10);
  if (s2Wins.length > 0) {
    for (const t of s2Wins.slice(0, 20)) {
      console.log(`  ${t.slug.slice(-10)} | ${t.side} @${(t.fillPrice*100).toFixed(0)}c | delta=${t.delta.toFixed(0)} | -${t.secsBeforeClose}s | net $${t.netPnl.toFixed(0)}`);
    }
  } else {
    console.log('  No S2 wins in 15s/delta<10 bucket');
  }

  // ═══════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  TOP STRATEGIES BY PnL/cycle                                  ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const allResults = [...s1Results, ...s2Results];
  const stratKeys = new Map<string, TradeResult[]>();
  for (const r of allResults) {
    const key = `${r.strategy}/${r.window}s/delta${r.deltaFilter}`;
    const list = stratKeys.get(key) || [];
    list.push(r);
    stratKeys.set(key, list);
  }

  const ranked = [...stratKeys.entries()].map(([key, trades]) => {
    const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
    const wins = trades.filter(t => t.won).length;
    return { key, trades: trades.length, wins, wr: wins / trades.length, netPnl, pnlPerCycle: netPnl / cycles.length };
  }).sort((a, b) => b.pnlPerCycle - a.pnlPerCycle);

  console.log('  Rank | Strategy              | Hits | WR%  | Net PnL  | $/cycle');
  console.log('  ──── | ───────────────────── | ──── | ──── | ──────── | ───────');
  for (let i = 0; i < Math.min(15, ranked.length); i++) {
    const s = ranked[i];
    console.log(`  ${String(i+1).padStart(4)} | ${s.key.padEnd(21)} | ${String(s.trades).padStart(4)} | ${(s.wr*100).toFixed(0).padStart(3)}% | $${s.netPnl.toFixed(0).padStart(7)} | $${s.pnlPerCycle.toFixed(2)}`);
  }

  console.log(`\n  Total cycles: ${cycles.length}\n`);

  await client.close();
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
