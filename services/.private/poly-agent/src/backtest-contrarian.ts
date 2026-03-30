/**
 * Contrarian Reversal Backtest — Buy cheap side in last 15-30s when delta < 10
 *
 * Strategy: When BTC is near the strike (delta < 10), buy the LOSING side
 * at 3-5c. If BTC reverses across the strike, the 3-5c token pays $1.
 *
 * Uses btc5mOrderbook (2s resolution) collected by the live bot.
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/backtest-contrarian.ts
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

const BUDGET = 5;  // $5 per trade (same as live bot)
const ENTRY_PRICES = [0.03, 0.05, 0.07, 0.10, 0.15];
const WINDOWS = [10, 15, 30];
const DELTA_FILTERS = [5, 10, 15, 20];
const TAKER_FEE_RATE = 0.0625; // Polymarket taker fee

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
  closestSecsToResolution: number;
}

interface TradeResult {
  slug: string;
  entryPrice: number;
  window: number;
  maxDelta: number;
  triggered: boolean;
  side: string;         // Which side we bought (the CHEAP/losing side)
  fillPrice: number;    // What we paid (bestAsk on cheap side)
  fillFee: number;
  shares: number;
  costUsdc: number;     // Total cost including fee
  btcPriceAtEntry: number;
  deltaAtEntry: number;
  secsBeforeClose: number;
  won: boolean;
  pnl: number;
  returnPct: number;    // % return if won
}

function getTakerFee(price: number): number {
  return price * (1 - price) * TAKER_FEE_RATE;
}

async function main() {
  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Contrarian Reversal Backtest — Buy Cheap Side        ║');
  console.log('║   "Buy losers at 3-5c, profit 20x on reversal"        ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  // Load orderbook data
  const allSnaps = await db.collection('btc5mOrderbook')
    .find({ btcPrice: { $gt: 0 } })
    .sort({ slug: 1, secsBeforeClose: -1 })
    .toArray() as any[];

  console.log(`  Orderbook snapshots: ${allSnaps.length}`);

  // Load cycle strike prices
  const cyclesDb = await db.collection('btc5mBotCycles').find({}).toArray() as any[];
  const strikeMap = new Map<string, number>();
  for (const c of cyclesDb) {
    if (c.priceToBeat > 0) strikeMap.set(c.slug, c.priceToBeat);
  }

  // Group by cycle
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

  // Build cycles with winner
  const cycles: CycleData[] = [];
  for (const [slug, snaps] of cycleMap) {
    if (snaps.length < 5) continue;
    snaps.sort((a, b) => b.secsBeforeClose - a.secsBeforeClose); // earliest first

    const ptb = snaps[0].priceToBeat || strikeMap.get(slug) || 0;
    if (ptb === 0) continue;

    // Use CLOSEST snapshot to resolution for winner determination
    const lastSnap = snaps[snaps.length - 1];
    const finalBtcPrice = lastSnap.btcPrice;
    if (finalBtcPrice <= 0) continue;

    const winner: 'Up' | 'Down' = finalBtcPrice > ptb ? 'Up' : 'Down';

    cycles.push({
      slug, snapshots: snaps, priceToBeat: ptb, winner,
      finalBtcPrice, finalDelta: finalBtcPrice - ptb,
      closestSecsToResolution: lastSnap.secsBeforeClose,
    });
  }

  console.log(`  Complete cycles: ${cycles.length}`);
  console.log(`  Avg closest snapshot to resolution: ${(cycles.reduce((s, c) => s + c.closestSecsToResolution, 0) / cycles.length).toFixed(1)}s\n`);

  // Check how many cycles have low delta in the last 30s
  let lowDeltaCycles = 0;
  for (const cycle of cycles) {
    const hasLowDelta = cycle.snapshots.some(s =>
      s.secsBeforeClose <= 30 && s.secsBeforeClose > 0 && s.absDelta < 10
    );
    if (hasLowDelta) lowDeltaCycles++;
  }
  console.log(`  Cycles with delta<10 in last 30s: ${lowDeltaCycles} (${(lowDeltaCycles / cycles.length * 100).toFixed(1)}%)\n`);

  // Run backtest for all combinations
  const allResults: TradeResult[] = [];

  for (const cycle of cycles) {
    for (const maxEntry of ENTRY_PRICES) {
      for (const window of WINDOWS) {
        for (const maxDelta of DELTA_FILTERS) {
          const result = simulateContrarian(cycle, maxEntry, window, maxDelta);
          allResults.push(result);
        }
      }
    }
  }

  // === MAIN RESULTS TABLE ===
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  CONTRARIAN RESULTS — buy LOSING side cheap, profit on reversal');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  console.log(`  Entry | Window | MaxΔ | Triggers | Wins | WR%   | AvgFill | AvgWinPnl | AvgLoss | TotalPnl | PnL/cyc | EV/$`);
  console.log(`  ${'-'.repeat(95)}`);

  type StratSummary = {
    key: string; triggers: number; wins: number; wr: number;
    avgFill: number; totalPnl: number; pnlPerCycle: number; ev: number;
    avgWinPnl: number; avgLoss: number;
  };
  const summaries: StratSummary[] = [];

  for (const maxEntry of ENTRY_PRICES) {
    for (const window of WINDOWS) {
      for (const maxDelta of DELTA_FILTERS) {
        const results = allResults.filter(r =>
          r.entryPrice === maxEntry && r.window === window && r.maxDelta === maxDelta
        );
        const triggered = results.filter(r => r.triggered);
        const wins = triggered.filter(r => r.won);
        const losses = triggered.filter(r => !r.won);

        if (triggered.length === 0) continue;

        const wr = wins.length / triggered.length;
        const avgFill = triggered.reduce((s, r) => s + r.fillPrice, 0) / triggered.length;
        const totalPnl = triggered.reduce((s, r) => s + r.pnl, 0);
        const avgWinPnl = wins.length > 0 ? wins.reduce((s, r) => s + r.pnl, 0) / wins.length : 0;
        const avgLoss = losses.length > 0 ? losses.reduce((s, r) => s + r.pnl, 0) / losses.length : 0;
        const pnlPerCycle = totalPnl / cycles.length;
        const ev = avgFill > 0 ? wr * (1 / avgFill - 1) - (1 - wr) : 0;

        const entryStr = `${(maxEntry * 100).toFixed(0)}c`.padEnd(5);
        const winStr = `${(wr * 100).toFixed(1)}%`.padEnd(5);
        const fillStr = `${(avgFill * 100).toFixed(1)}c`.padEnd(7);
        const winPnlStr = wins.length > 0 ? `+$${avgWinPnl.toFixed(2)}` : 'N/A';
        const lossStr = `$${avgLoss.toFixed(2)}`;

        console.log(
          `  ${entryStr} | ${String(window).padStart(4)}s  | ${String(maxDelta).padStart(3)}  | ` +
          `${String(triggered.length).padStart(6)}   | ${String(wins.length).padStart(4)} | ${winStr} | ` +
          `${fillStr} | ${winPnlStr.padEnd(9)} | ${lossStr.padEnd(7)} | ` +
          `$${totalPnl.toFixed(2).padStart(7)} | $${pnlPerCycle.toFixed(2).padStart(5)} | ${ev.toFixed(3)}`
        );

        summaries.push({
          key: `${(maxEntry * 100).toFixed(0)}c/${window}s/Δ<${maxDelta}`,
          triggers: triggered.length, wins: wins.length, wr,
          avgFill, totalPnl, pnlPerCycle, ev, avgWinPnl, avgLoss,
        });
      }
    }
    console.log('');
  }

  // === WINNING TRADES DETAIL ===
  const bestStrat = summaries.sort((a, b) => b.pnlPerCycle - a.pnlPerCycle)[0];
  if (bestStrat) {
    console.log(`\n═══ BEST STRATEGY: ${bestStrat.key} ═══`);
    console.log(`  Triggers: ${bestStrat.triggers} | Wins: ${bestStrat.wins} | WR: ${(bestStrat.wr * 100).toFixed(1)}%`);
    console.log(`  Total PnL: $${bestStrat.totalPnl.toFixed(2)} | PnL/cycle: $${bestStrat.pnlPerCycle.toFixed(2)}`);
    console.log(`  Avg win: +$${bestStrat.avgWinPnl.toFixed(2)} | Avg loss: $${bestStrat.avgLoss.toFixed(2)}`);
  }

  // Show all winning trades for the best strategy
  const bestParams = bestStrat?.key.match(/(\d+)c\/(\d+)s\/Δ<(\d+)/);
  if (bestParams) {
    const bEntry = parseInt(bestParams[1]) / 100;
    const bWindow = parseInt(bestParams[2]);
    const bDelta = parseInt(bestParams[3]);
    const bestTrades = allResults.filter(r =>
      r.entryPrice === bEntry && r.window === bWindow && r.maxDelta === bDelta && r.triggered
    );
    const bestWins = bestTrades.filter(r => r.won);
    const bestLosses = bestTrades.filter(r => !r.won);

    if (bestWins.length > 0) {
      console.log(`\n  WINNING TRADES (${bestWins.length}):`);
      console.log(`  ${'Side'.padEnd(5)} | ${'Fill'.padEnd(5)} | ${'PnL'.padEnd(8)} | ${'Return'.padEnd(7)} | ${'Δ'.padEnd(5)} | ${'Secs'.padEnd(4)} | Slug`);
      console.log(`  ${'-'.repeat(65)}`);
      for (const w of bestWins) {
        console.log(`  ${w.side.padEnd(5)} | ${(w.fillPrice * 100).toFixed(0)}c   | +$${w.pnl.toFixed(2).padEnd(6)} | ${(w.returnPct).toFixed(0)}%`.padEnd(10) + ` | ${w.deltaAtEntry.toFixed(0).padEnd(5)} | ${w.secsBeforeClose}s`.padEnd(6) + ` | ${w.slug.slice(-10)}`);
      }
    }

    console.log(`\n  LOSING TRADES (sample, ${bestLosses.length} total):`);
    for (const l of bestLosses.slice(0, 5)) {
      console.log(`  ${l.side.padEnd(5)} | ${(l.fillPrice * 100).toFixed(0)}c   | $${l.pnl.toFixed(2)} | Δ${l.deltaAtEntry.toFixed(0)} | -${l.secsBeforeClose}s | ${l.slug.slice(-10)}`);
    }
  }

  // === REVERSAL FREQUENCY ===
  console.log('\n═══ REVERSAL FREQUENCY BY DELTA BUCKET ═══');
  console.log('  How often does the losing side at T seconds before close become the winner?\n');

  for (const window of [10, 15, 30]) {
    console.log(`  Window: last ${window}s`);
    console.log(`  ${'Δ Bucket'.padEnd(10)} | ${'Cycles'.padEnd(8)} | ${'Reversals'.padEnd(10)} | Rev%`);
    console.log(`  ${'-'.repeat(45)}`);

    for (const maxD of [5, 10, 15, 20, 30]) {
      let cyclesInBucket = 0;
      let reversals = 0;

      for (const cycle of cycles) {
        // Find first snapshot in window with delta < maxD
        const inWindow = cycle.snapshots.filter(s =>
          s.secsBeforeClose <= window && s.secsBeforeClose > 0 && s.absDelta < maxD
        );
        if (inWindow.length === 0) continue;
        cyclesInBucket++;

        // At that snapshot, which side was losing?
        const snap = inWindow[0]; // earliest in window
        const losingSide = snap.delta > 0 ? 'Down' : 'Up';

        // Did the losing side win? = reversal
        if (cycle.winner === losingSide) reversals++;
      }

      if (cyclesInBucket === 0) continue;
      const revRate = (reversals / cyclesInBucket * 100).toFixed(1);
      console.log(`  Δ<${String(maxD).padEnd(7)} | ${String(cyclesInBucket).padEnd(8)} | ${String(reversals).padEnd(10)} | ${revRate}%`);
    }
    console.log('');
  }

  // === CHEAP SIDE AVAILABILITY ===
  console.log('═══ CHEAP SIDE PRICE AVAILABILITY ═══');
  console.log('  How often is the losing side available at cheap prices in the last 30s?\n');

  for (const maxD of [5, 10, 15]) {
    let total = 0;
    const available: Record<string, number> = { '≤3c': 0, '≤5c': 0, '≤7c': 0, '≤10c': 0, '≤15c': 0 };

    for (const cycle of cycles) {
      const inWindow = cycle.snapshots.filter(s =>
        s.secsBeforeClose <= 30 && s.secsBeforeClose > 0 && s.absDelta < maxD
      );
      if (inWindow.length === 0) continue;
      total++;

      // Find cheapest ask on losing side
      let cheapestAsk = Infinity;
      for (const snap of inWindow) {
        const losingSide = snap.delta > 0 ? 'down' : 'up';
        const ask = (losingSide === 'up' ? snap.up.bestAsk : snap.down.bestAsk) ?? Infinity;
        if (ask > 0.01 && ask < cheapestAsk) cheapestAsk = ask;
      }

      if (cheapestAsk <= 0.03) available['≤3c']++;
      if (cheapestAsk <= 0.05) available['≤5c']++;
      if (cheapestAsk <= 0.07) available['≤7c']++;
      if (cheapestAsk <= 0.10) available['≤10c']++;
      if (cheapestAsk <= 0.15) available['≤15c']++;
    }

    console.log(`  Delta < ${maxD} (${total} qualifying cycles):`);
    for (const [label, count] of Object.entries(available)) {
      console.log(`    ${label}: ${count} cycles (${total > 0 ? (count / total * 100).toFixed(1) : 0}%)`);
    }
    console.log('');
  }

  // === RANKING ===
  console.log('═══ STRATEGY RANKING (by PnL/cycle) ═══\n');
  const ranked = summaries.filter(s => s.triggers >= 3).sort((a, b) => b.pnlPerCycle - a.pnlPerCycle);
  console.log(`  ${'Rank'.padEnd(5)} | ${'Strategy'.padEnd(18)} | ${'Triggers'.padEnd(9)} | ${'Wins'.padEnd(5)} | ${'WR%'.padEnd(6)} | ${'TotalPnl'.padEnd(10)} | PnL/cycle`);
  console.log(`  ${'-'.repeat(75)}`);
  for (let i = 0; i < Math.min(15, ranked.length); i++) {
    const s = ranked[i];
    console.log(`  ${String(i + 1).padEnd(5)} | ${s.key.padEnd(18)} | ${String(s.triggers).padEnd(9)} | ${String(s.wins).padEnd(5)} | ${(s.wr * 100).toFixed(1).padEnd(5)}% | $${s.totalPnl.toFixed(2).padStart(8)} | $${s.pnlPerCycle.toFixed(2)}`);
  }

  console.log(`\n  Total cycles analyzed: ${cycles.length}`);
  console.log('');

  await client.close();
}

function simulateContrarian(
  cycle: CycleData, maxEntry: number, window: number, maxDelta: number
): TradeResult {
  const empty: TradeResult = {
    slug: cycle.slug, entryPrice: maxEntry, window, maxDelta,
    triggered: false, side: '', fillPrice: 0, fillFee: 0, shares: 0, costUsdc: 0,
    btcPriceAtEntry: 0, deltaAtEntry: 0, secsBeforeClose: 0,
    won: false, pnl: 0, returnPct: 0,
  };

  for (const snap of cycle.snapshots) {
    // Must be within window
    if (snap.secsBeforeClose > window || snap.secsBeforeClose <= 0) continue;

    // Delta must be LOW (choppy market)
    if (snap.absDelta >= maxDelta) continue;

    // Determine the LOSING side (cheap side to buy)
    // delta > 0 = BTC above strike = Up winning = Down is cheap
    // delta < 0 = BTC below strike = Down winning = Up is cheap
    const cheapSide: 'Up' | 'Down' = snap.delta > 0 ? 'Down' : 'Up';
    const cheapBook = cheapSide === 'Up' ? snap.up : snap.down;

    // Check if cheap side has asks at our max entry price
    if (cheapBook.bestAsk === null || cheapBook.bestAsk <= 0.01) continue;
    if (cheapBook.bestAsk > maxEntry) continue;

    // Fill at bestAsk (taker — we want immediate fill)
    const fillPrice = cheapBook.bestAsk;
    const fee = getTakerFee(fillPrice);
    const costPerShare = fillPrice + fee;
    const shares = BUDGET / costPerShare;
    const totalCost = BUDGET;

    // Did the cheap side win? (= reversal happened)
    const won = cycle.winner === cheapSide;
    const pnl = won ? (shares * 1.0 - totalCost) : (-totalCost);
    const returnPct = won ? ((shares - totalCost) / totalCost * 100) : -100;

    return {
      slug: cycle.slug, entryPrice: maxEntry, window, maxDelta,
      triggered: true, side: cheapSide, fillPrice, fillFee: fee,
      shares, costUsdc: totalCost,
      btcPriceAtEntry: snap.btcPrice, deltaAtEntry: snap.absDelta,
      secsBeforeClose: snap.secsBeforeClose,
      won, pnl, returnPct,
    };
  }

  return empty;
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
