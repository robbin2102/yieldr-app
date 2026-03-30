/**
 * Analyze Overnight Bot Performance
 *
 * Queries btc5mBotTrades in MongoDB and produces a full breakdown of:
 * - Wins/losses, fill rate, PnL
 * - Losing trades analysis (delta, timing, reversals)
 * - Hourly performance
 * - Delta bucket analysis
 *
 * Usage:
 *   npx tsx services/.private/poly-agent/src/analyze-overnight.ts
 */

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';

const envPaths = [
  path.resolve(process.cwd(), '.env.polyagent'),           // running from poly-agent/
  path.resolve(process.cwd(), '.env.local'),               // running from poly-agent/
  path.resolve(process.cwd(), '.env'),                     // running from poly-agent/
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'), // from repo root
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.local'),
];
for (const p of envPaths) {
  const r = dotenv.config({ path: p });
  if (r.parsed?.MONGODB_URI) break;
}

if (!process.env.MONGODB_URI) {
  console.error('Fatal: MONGODB_URI not found. Run from repo root or poly-agent/ directory.');
  process.exit(1);
}

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const db = client.db();
  const trades = db.collection('btc5mBotTrades');
  const cycles = db.collection('btc5mBotCycles');

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Overnight Bot Performance Analysis                   ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  // ── 1. Overview ────────────────────────────────────────────────
  const allTrades = await trades.find({}).toArray();
  const filled = allTrades.filter(t => t.fillType !== 'unfilled');
  const unfilled = allTrades.filter(t => t.fillType === 'unfilled');
  const resolved = filled.filter(t => t.won !== null);
  const wins = resolved.filter(t => t.won === true);
  const losses = resolved.filter(t => t.won === false);
  const unresolved = filled.filter(t => t.won === null);

  console.log('═══ 1. OVERVIEW ═══');
  console.log(`  Total trade records: ${allTrades.length}`);
  console.log(`  Filled trades:      ${filled.length}`);
  console.log(`  Unfilled triggers:  ${unfilled.length}`);
  console.log(`  Fill rate:          ${filled.length > 0 ? ((filled.length / (filled.length + unfilled.length)) * 100).toFixed(1) : 0}%`);
  console.log(`  Resolved:           ${resolved.length}`);
  console.log(`  Unresolved:         ${unresolved.length}`);
  console.log(`  Wins:               ${wins.length}`);
  console.log(`  Losses:             ${losses.length}`);
  console.log(`  Win rate:           ${resolved.length > 0 ? ((wins.length / resolved.length) * 100).toFixed(1) : 0}%`);

  const totalPnl = resolved.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalCost = filled.reduce((s, t) => s + (t.costUsdc || 0), 0);
  const winPnl = wins.reduce((s, t) => s + (t.pnl || 0), 0);
  const lossPnl = losses.reduce((s, t) => s + (t.pnl || 0), 0);

  console.log(`\n  Total PnL:          $${totalPnl.toFixed(2)}`);
  console.log(`  Win PnL:            +$${winPnl.toFixed(2)}`);
  console.log(`  Loss PnL:           -$${Math.abs(lossPnl).toFixed(2)}`);
  console.log(`  Total deployed:     $${totalCost.toFixed(2)}`);
  console.log(`  ROI:                ${totalCost > 0 ? ((totalPnl / totalCost) * 100).toFixed(1) : 0}%`);

  // ── 2. Fill Type Breakdown ─────────────────────────────────────
  console.log('\n═══ 2. FILL TYPE BREAKDOWN ═══');
  const makerFills = filled.filter(t => t.fillType === 'maker');
  const takerFills = filled.filter(t => t.fillType === 'taker');
  console.log(`  Maker fills: ${makerFills.length} (${filled.length > 0 ? ((makerFills.length / filled.length) * 100).toFixed(0) : 0}%)`);
  console.log(`  Taker fills: ${takerFills.length} (${filled.length > 0 ? ((takerFills.length / filled.length) * 100).toFixed(0) : 0}%)`);
  if (makerFills.length > 0) {
    const avgMaker = makerFills.reduce((s, t) => s + t.filledPrice, 0) / makerFills.length;
    console.log(`  Avg maker price:    ${(avgMaker * 100).toFixed(1)}c`);
  }
  if (takerFills.length > 0) {
    const avgTaker = takerFills.reduce((s, t) => s + t.filledPrice, 0) / takerFills.length;
    console.log(`  Avg taker price:    ${(avgTaker * 100).toFixed(1)}c`);
  }

  // ── 3. All Losing Trades ───────────────────────────────────────
  console.log('\n═══ 3. LOSING TRADES (sorted by PnL) ═══');
  const sortedLosses = losses.sort((a, b) => (a.pnl || 0) - (b.pnl || 0));
  for (const t of sortedLosses) {
    const delta = Math.abs(t.delta || 0);
    const slug = t.slug?.split('-').slice(-2).join('-') || '?'; // Last 2 parts for readability
    console.log(`  ${t.side?.padEnd(4)} @${((t.filledPrice || 0) * 100).toFixed(0)}c | PnL: $${(t.pnl || 0).toFixed(2)} | Δ=${delta.toFixed(0)} | -${t.secsBeforeClose}s | winner=${t.winner} | ${slug}`);
  }

  // ── 4. All Winning Trades ──────────────────────────────────────
  console.log('\n═══ 4. WINNING TRADES (sample) ═══');
  const sortedWins = wins.sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
  for (const t of sortedWins.slice(0, 10)) {
    const delta = Math.abs(t.delta || 0);
    console.log(`  ${t.side?.padEnd(4)} @${((t.filledPrice || 0) * 100).toFixed(0)}c | PnL: +$${(t.pnl || 0).toFixed(2)} | Δ=${delta.toFixed(0)} | -${t.secsBeforeClose}s`);
  }
  if (sortedWins.length > 10) console.log(`  ... and ${sortedWins.length - 10} more wins`);

  // ── 5. Delta Bucket Analysis ───────────────────────────────────
  console.log('\n═══ 5. DELTA BUCKET ANALYSIS ═══');
  const deltaBuckets = [
    { label: '0-10', min: 0, max: 10 },
    { label: '10-20', min: 10, max: 20 },
    { label: '20-30', min: 20, max: 30 },
    { label: '30-50', min: 30, max: 50 },
    { label: '50-100', min: 50, max: 100 },
    { label: '100-200', min: 100, max: 200 },
    { label: '200+', min: 200, max: Infinity },
  ];

  console.log(`  ${'Δ Range'.padEnd(10)} | ${'Trades'.padEnd(7)} | ${'Wins'.padEnd(5)} | ${'Losses'.padEnd(7)} | ${'WR'.padEnd(6)} | PnL`);
  console.log(`  ${'-'.repeat(60)}`);
  for (const b of deltaBuckets) {
    const bucket = resolved.filter(t => {
      const d = Math.abs(t.delta || 0);
      return d >= b.min && d < b.max;
    });
    if (bucket.length === 0) continue;
    const bWins = bucket.filter(t => t.won).length;
    const bLosses = bucket.length - bWins;
    const bPnl = bucket.reduce((s, t) => s + (t.pnl || 0), 0);
    const wr = ((bWins / bucket.length) * 100).toFixed(0);
    console.log(`  ${b.label.padEnd(10)} | ${String(bucket.length).padEnd(7)} | ${String(bWins).padEnd(5)} | ${String(bLosses).padEnd(7)} | ${(wr + '%').padEnd(6)} | $${bPnl.toFixed(2)}`);
  }

  // ── 6. Timing Analysis (seconds before close) ─────────────────
  console.log('\n═══ 6. TIMING ANALYSIS (secs before close) ═══');
  const timeBuckets = [
    { label: '0-15s', min: 0, max: 15 },
    { label: '15-30s', min: 15, max: 30 },
    { label: '30-45s', min: 30, max: 45 },
    { label: '45-60s', min: 45, max: 60 },
    { label: '60-90s', min: 60, max: 90 },
    { label: '90+s', min: 90, max: Infinity },
  ];

  console.log(`  ${'Window'.padEnd(10)} | ${'Trades'.padEnd(7)} | ${'Wins'.padEnd(5)} | ${'Losses'.padEnd(7)} | ${'WR'.padEnd(6)} | PnL`);
  console.log(`  ${'-'.repeat(60)}`);
  for (const b of timeBuckets) {
    const bucket = resolved.filter(t => {
      const s = t.secsBeforeClose || 0;
      return s >= b.min && s < b.max;
    });
    if (bucket.length === 0) continue;
    const bWins = bucket.filter(t => t.won).length;
    const bLosses = bucket.length - bWins;
    const bPnl = bucket.reduce((s, t) => s + (t.pnl || 0), 0);
    const wr = ((bWins / bucket.length) * 100).toFixed(0);
    console.log(`  ${b.label.padEnd(10)} | ${String(bucket.length).padEnd(7)} | ${String(bWins).padEnd(5)} | ${String(bLosses).padEnd(7)} | ${(wr + '%').padEnd(6)} | $${bPnl.toFixed(2)}`);
  }

  // ── 7. Hourly Performance ──────────────────────────────────────
  console.log('\n═══ 7. HOURLY PERFORMANCE (UTC) ═══');
  const hourMap = new Map<number, { trades: number; wins: number; pnl: number }>();
  for (const t of resolved) {
    const h = new Date(t.filledAt).getUTCHours();
    const entry = hourMap.get(h) || { trades: 0, wins: 0, pnl: 0 };
    entry.trades++;
    if (t.won) entry.wins++;
    entry.pnl += t.pnl || 0;
    hourMap.set(h, entry);
  }
  const sortedHours = [...hourMap.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`  ${'Hour'.padEnd(6)} | ${'Trades'.padEnd(7)} | ${'WR'.padEnd(6)} | PnL`);
  console.log(`  ${'-'.repeat(40)}`);
  for (const [h, data] of sortedHours) {
    const wr = ((data.wins / data.trades) * 100).toFixed(0);
    console.log(`  ${String(h).padStart(2, '0')}:00  | ${String(data.trades).padEnd(7)} | ${(wr + '%').padEnd(6)} | $${data.pnl.toFixed(2)}`);
  }

  // ── 8. Reversal Analysis ───────────────────────────────────────
  console.log('\n═══ 8. REVERSAL ANALYSIS ═══');
  // Losses where side != winner = the market reversed
  const reversals = losses.filter(t => t.side && t.winner && t.side !== t.winner);
  const nonReversals = losses.filter(t => !t.winner || t.winner === 'Unknown');
  console.log(`  Losses from reversals:  ${reversals.length} (we bet ${reversals.map(t => t.side).join(', ')})`);
  console.log(`  Losses (unknown win):   ${nonReversals.length}`);
  if (reversals.length > 0) {
    const avgReversalDelta = reversals.reduce((s, t) => s + Math.abs(t.delta || 0), 0) / reversals.length;
    const avgReversalSecs = reversals.reduce((s, t) => s + (t.secsBeforeClose || 0), 0) / reversals.length;
    console.log(`  Avg delta at reversal:  ${avgReversalDelta.toFixed(0)} pts`);
    console.log(`  Avg secs before close:  ${avgReversalSecs.toFixed(0)}s`);
  }

  // ── 9. Price Analysis ──────────────────────────────────────────
  console.log('\n═══ 9. FILL PRICE ANALYSIS ═══');
  if (filled.length > 0) {
    const avgFillPrice = filled.reduce((s, t) => s + (t.filledPrice || 0), 0) / filled.length;
    const avgShares = filled.reduce((s, t) => s + (t.shares || 0), 0) / filled.length;
    const avgCost = filled.reduce((s, t) => s + (t.costUsdc || 0), 0) / filled.length;
    console.log(`  Avg fill price:   ${(avgFillPrice * 100).toFixed(1)}c`);
    console.log(`  Avg shares:       ${avgShares.toFixed(1)}`);
    console.log(`  Avg cost/trade:   $${avgCost.toFixed(2)}`);

    // Win fill price vs loss fill price
    if (wins.length > 0) {
      const avgWinPrice = wins.reduce((s, t) => s + (t.filledPrice || 0), 0) / wins.length;
      console.log(`  Avg win price:    ${(avgWinPrice * 100).toFixed(1)}c`);
    }
    if (losses.length > 0) {
      const avgLossPrice = losses.reduce((s, t) => s + (t.filledPrice || 0), 0) / losses.length;
      console.log(`  Avg loss price:   ${(avgLossPrice * 100).toFixed(1)}c`);
    }
  }

  // ── 10. Cycle Coverage ─────────────────────────────────────────
  console.log('\n═══ 10. CYCLE COVERAGE ═══');
  const allCycles = await cycles.find({}).toArray();
  console.log(`  Cycles in DB:      ${allCycles.length}`);
  const uniqueSlugs = new Set(allTrades.map(t => t.slug));
  console.log(`  Cycles with trades: ${uniqueSlugs.size}`);
  const filledSlugs = new Set(filled.map(t => t.slug));
  console.log(`  Cycles with fills:  ${filledSlugs.size}`);

  // ── 11. Cumulative PnL Timeline ────────────────────────────────
  console.log('\n═══ 11. CUMULATIVE PnL TIMELINE ═══');
  const timeline = resolved
    .filter(t => t.filledAt)
    .sort((a, b) => new Date(a.filledAt).getTime() - new Date(b.filledAt).getTime());

  let cumPnl = 0;
  let peakPnl = 0;
  let maxDrawdown = 0;
  for (const t of timeline) {
    cumPnl += t.pnl || 0;
    if (cumPnl > peakPnl) peakPnl = cumPnl;
    const dd = peakPnl - cumPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  console.log(`  Peak PnL:         $${peakPnl.toFixed(2)}`);
  console.log(`  Max drawdown:     $${maxDrawdown.toFixed(2)}`);
  console.log(`  Final PnL:        $${cumPnl.toFixed(2)}`);

  // Print last 20 trades in timeline
  console.log(`\n  Last 20 resolved trades:`);
  const last20 = timeline.slice(-20);
  let runPnl = cumPnl - last20.reduce((s, t) => s + (t.pnl || 0), 0);
  for (const t of last20) {
    runPnl += t.pnl || 0;
    const time = new Date(t.filledAt).toISOString().slice(11, 19);
    const icon = t.won ? '✅' : '❌';
    console.log(`  ${time} ${icon} ${t.side?.padEnd(4)} @${((t.filledPrice || 0) * 100).toFixed(0)}c PnL:${(t.pnl || 0) >= 0 ? '+' : ''}$${(t.pnl || 0).toFixed(2)} cum:$${runPnl.toFixed(2)}`);
  }

  // ── Summary ────────────────────────────────────────────────────
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   SUMMARY                                              ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Trades: ${resolved.length} resolved (${wins.length}W / ${losses.length}L) | WR: ${resolved.length > 0 ? ((wins.length / resolved.length) * 100).toFixed(1) : 0}%`);
  console.log(`  PnL:    $${totalPnl.toFixed(2)} ($${totalCost.toFixed(2)} deployed)`);
  console.log(`  Avg win:  +$${wins.length > 0 ? (winPnl / wins.length).toFixed(2) : '0'} | Avg loss: -$${losses.length > 0 ? (Math.abs(lossPnl) / losses.length).toFixed(2) : '0'}`);
  console.log(`  Peak: $${peakPnl.toFixed(2)} | Drawdown: $${maxDrawdown.toFixed(2)}`);
  console.log(`  Fill rate: ${((filled.length / (filled.length + unfilled.length)) * 100).toFixed(1)}% (${filled.length}/${filled.length + unfilled.length})`);
  console.log('');

  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
