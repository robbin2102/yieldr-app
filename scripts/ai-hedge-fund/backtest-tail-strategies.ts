/**
 * BTC 5m Tail Strategy Backtester
 *
 * Backtests two strategies on historical BTC 5m market activity data:
 *
 * Strategy A — Naked Tails:
 *   Buy at extreme prices (0-10c or 85-100c) in last 1-2 minutes before resolution.
 *   If price is near 0c (tail low) → buy Up cheap, hoping for reversal.
 *   If price is near 100c (tail high) → buy Down cheap (implied <15c).
 *   Pure directional bet on tail probability.
 *
 * Strategy B — Hedged Tails:
 *   Buy the high-probability side (85-90c) with 2x shares + hedge with 1x shares
 *   on the opposite side (10-15c). Locks in profit if the favored side wins,
 *   limited loss if it reverses. Combined cost ~97c for 2x+1x structure.
 *
 * Data source: polyMarket5mLiveData collection (from fetch-live-btc5m-data.ts)
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/backtest-tail-strategies.ts [options]
 *
 * Options:
 *   --slug <slug>           Filter to specific market slug in DB (default: latest)
 *   --budget <N>            USDC budget per cycle (default: 100)
 *   --entry-window <secs>   Seconds before resolution to enter (default: 120)
 *   --tail-low <price>      Max price for "cheap" side (default: 0.15)
 *   --tail-high <price>     Min price for "expensive" side (default: 0.85)
 */

import dotenv from 'dotenv';
import path from 'path';
import { MongoClient } from 'mongodb';

const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
];
for (const envPath of envLocations) {
  const result = dotenv.config({ path: envPath });
  if (result.parsed && result.parsed.MONGODB_URI) break;
}

// ── CLI Args ──────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const OPT = (name: string, fallback: string): string => {
  const idx = ARGS.indexOf(`--${name}`);
  return idx !== -1 && ARGS[idx + 1] ? ARGS[idx + 1] : fallback;
};

const SLUG_FILTER = OPT('slug', '');
const BUDGET_PER_CYCLE = parseFloat(OPT('budget', '100'));
const ENTRY_WINDOW_SECS = parseInt(OPT('entry-window', '120'));  // last 2 minutes
const TAIL_LOW = parseFloat(OPT('tail-low', '0.15'));
const TAIL_HIGH = parseFloat(OPT('tail-high', '0.85'));

interface Activity {
  conditionId: string;
  type: string;
  side?: string;
  usdcSize: number;
  price: number;
  timestamp: number;
  title: string;
  outcome?: string;
  outcomeIndex?: number;
  slug?: string;
  size?: number;
}

interface MarketCycle {
  conditionId: string;
  title: string;
  slug: string;
  cycleOpenTs: number;
  cycleCloseTs: number;
  activities: Activity[];
  // Observed prices in last N seconds
  lastMinutePrices: { ts: number; side: string; price: number }[];
  // Resolution result (inferred from redeems)
  winner: 'Up' | 'Down' | 'Unknown';
  redeemUsdc: number;
}

interface TradeResult {
  cycle: string;
  strategy: string;
  side: string;
  entryPrice: number;
  shares: number;
  cost: number;
  pnl: number;
  won: boolean;
  secsBeforeClose: number;
  hedgeSide?: string;
  hedgePrice?: number;
  hedgeShares?: number;
  hedgeCost?: number;
  combinedCost?: number;
}

function parseCycleOpen(slug: string): number {
  const match = slug?.match(/btc-updown-5m-(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

function inferWinnerFromSharesAndRedeems(activities: Activity[]): 'Up' | 'Down' | 'Unknown' {
  // Winning side's shares pay $1 each → redeemUsdc ≈ winning shares count
  const buys = activities.filter(a => a.type === 'TRADE' && a.side === 'BUY');
  const redeems = activities.filter(a => a.type === 'REDEEM' && a.usdcSize > 0);
  const redeemUsdc = redeems.reduce((s, r) => s + r.usdcSize, 0);
  if (redeemUsdc === 0) {
    // No redeems — market may not have resolved yet. Try price-based fallback.
    return inferWinnerFromPrices(activities, buys);
  }

  // Count shares per side
  const upShares = buys
    .filter(b => b.outcome === 'Up' || b.outcomeIndex === 0)
    .reduce((s, b) => s + (b.size || b.usdcSize / Math.max(b.price, 0.001)), 0);
  const downShares = buys
    .filter(b => b.outcome === 'Down' || b.outcomeIndex === 1)
    .reduce((s, b) => s + (b.size || b.usdcSize / Math.max(b.price, 0.001)), 0);

  // redeemUsdc should match the winning side's shares (within 10% tolerance)
  const upDiff = Math.abs(redeemUsdc - upShares) / Math.max(redeemUsdc, 1);
  const downDiff = Math.abs(redeemUsdc - downShares) / Math.max(redeemUsdc, 1);

  if (upDiff < 0.15 && upDiff < downDiff) return 'Up';
  if (downDiff < 0.15 && downDiff < upDiff) return 'Down';

  // Fallback: whichever side's shares are closer to redeem amount
  return upDiff < downDiff ? 'Up' : 'Down';
}

function inferWinnerFromPrices(activities: Activity[], buys: Activity[]): 'Up' | 'Down' | 'Unknown' {
  // Use the latest trade prices — high Up price near end = Up likely won
  if (buys.length === 0) return 'Unknown';
  const sorted = [...buys].sort((a, b) => b.timestamp - a.timestamp);
  const latestUp = sorted.find(b => b.outcome === 'Up' || b.outcomeIndex === 0);
  const latestDown = sorted.find(b => b.outcome === 'Down' || b.outcomeIndex === 1);

  if (latestUp && latestDown) {
    return latestUp.price > latestDown.price ? 'Up' : 'Down';
  }
  if (latestUp) return latestUp.price > 0.5 ? 'Up' : 'Down';
  if (latestDown) return latestDown.price > 0.5 ? 'Down' : 'Up';
  return 'Unknown';
}


function buildMarketCycles(allActivities: Activity[]): MarketCycle[] {
  const byCondition = new Map<string, Activity[]>();
  for (const a of allActivities) {
    const list = byCondition.get(a.conditionId) || [];
    list.push(a);
    byCondition.set(a.conditionId, list);
  }

  const cycles: MarketCycle[] = [];
  for (const [conditionId, acts] of byCondition) {
    const buys = acts.filter(a => a.type === 'TRADE' && a.side === 'BUY');
    if (buys.length < 3) continue;

    const slug = buys[0].slug || '';
    if (!slug.includes('btc-updown-5m')) continue;

    const title = buys[0].title || '';
    const cycleOpenTs = parseCycleOpen(slug);
    if (cycleOpenTs === 0) continue;
    const cycleCloseTs = cycleOpenTs + 300;

    // Get prices in last ENTRY_WINDOW_SECS
    const lastMinutePrices = buys
      .filter(b => (cycleCloseTs - b.timestamp) <= ENTRY_WINDOW_SECS && (cycleCloseTs - b.timestamp) > 0)
      .map(b => ({
        ts: b.timestamp,
        side: b.outcome || (b.outcomeIndex === 0 ? 'Up' : 'Down'),
        price: b.price,
      }));

    const redeems = acts.filter(a => a.type === 'REDEEM');
    const redeemUsdc = redeems.reduce((s, r) => s + r.usdcSize, 0);
    const winner = inferWinnerFromSharesAndRedeems(acts);

    cycles.push({
      conditionId, title, slug, cycleOpenTs, cycleCloseTs,
      activities: acts,
      lastMinutePrices,
      winner, redeemUsdc,
    });
  }

  return cycles.sort((a, b) => a.cycleOpenTs - b.cycleOpenTs);
}

// ── Strategy A: Naked Tails ───────────────────────────────────
function backtestNakedTails(cycles: MarketCycle[], budget: number): TradeResult[] {
  const results: TradeResult[] = [];

  for (const c of cycles) {
    if (c.winner === 'Unknown') continue;
    if (c.lastMinutePrices.length === 0) continue;

    // Find best tail entry in the window
    // Option 1: Buy the cheap side (price < TAIL_LOW)
    const cheapEntries = c.lastMinutePrices.filter(p => p.price <= TAIL_LOW);
    // Option 2: Buy the expensive side (price >= TAIL_HIGH) — the "near certain" side
    const expensiveEntries = c.lastMinutePrices.filter(p => p.price >= TAIL_HIGH);

    // Strategy A1: Buy cheap tails (contrarian — buying the losing side cheaply)
    if (cheapEntries.length > 0) {
      const entry = cheapEntries[0]; // first available cheap entry
      const shares = budget / entry.price;
      const pnl = entry.side === c.winner ? shares - budget : -budget;
      const secsBeforeClose = c.cycleCloseTs - entry.ts;

      results.push({
        cycle: c.title.match(/\d+:\d+[AP]M-\d+:\d+[AP]M/)?.[0] || c.slug,
        strategy: 'NAKED_TAIL_CHEAP',
        side: entry.side,
        entryPrice: entry.price,
        shares,
        cost: budget,
        pnl,
        won: entry.side === c.winner,
        secsBeforeClose,
      });
    }

    // Strategy A2: Buy expensive tails (momentum — buying the winning side at 85c+)
    if (expensiveEntries.length > 0) {
      const entry = expensiveEntries[0];
      const shares = budget / entry.price;
      const pnl = entry.side === c.winner ? shares - budget : -budget;
      const secsBeforeClose = c.cycleCloseTs - entry.ts;

      results.push({
        cycle: c.title.match(/\d+:\d+[AP]M-\d+:\d+[AP]M/)?.[0] || c.slug,
        strategy: 'NAKED_TAIL_EXPENSIVE',
        side: entry.side,
        entryPrice: entry.price,
        shares,
        cost: budget,
        pnl,
        won: entry.side === c.winner,
        secsBeforeClose,
      });
    }
  }

  return results;
}

// ── Strategy B: Hedged Tails ──────────────────────────────────
function backtestHedgedTails(cycles: MarketCycle[], budget: number): TradeResult[] {
  const results: TradeResult[] = [];

  for (const c of cycles) {
    if (c.winner === 'Unknown') continue;
    if (c.lastMinutePrices.length === 0) continue;

    // Find expensive side (85-90c) and cheap side (10-15c) at similar times
    const expensive = c.lastMinutePrices.filter(p => p.price >= TAIL_HIGH && p.price <= 0.95);
    const cheap = c.lastMinutePrices.filter(p => p.price >= 0.05 && p.price <= TAIL_LOW);

    if (expensive.length === 0 || cheap.length === 0) continue;

    // Must be DIFFERENT sides
    const expEntry = expensive[0];
    const cheapEntry = cheap.find(p => p.side !== expEntry.side);
    if (!cheapEntry) continue;

    // Hedged structure: 2x shares on expensive side + 1x shares on cheap side
    const expBudget = budget * 0.67;  // 2/3 of budget on expensive side
    const cheapBudget = budget * 0.33; // 1/3 on cheap side (hedge)

    const expShares = expBudget / expEntry.price;
    const cheapShares = cheapBudget / cheapEntry.price;
    const totalCost = expBudget + cheapBudget;
    const combinedCostPerPair = expEntry.price + cheapEntry.price;

    // P&L depends on which side wins
    let pnl: number;
    if (expEntry.side === c.winner) {
      // Expensive side wins: get $1 per expensive share, lose cheap side
      pnl = expShares - totalCost;
    } else {
      // Cheap side wins: get $1 per cheap share, lose expensive side
      pnl = cheapShares - totalCost;
    }

    const secsBeforeClose = Math.min(c.cycleCloseTs - expEntry.ts, c.cycleCloseTs - cheapEntry.ts);

    results.push({
      cycle: c.title.match(/\d+:\d+[AP]M-\d+:\d+[AP]M/)?.[0] || c.slug,
      strategy: 'HEDGED_TAIL',
      side: expEntry.side,
      entryPrice: expEntry.price,
      shares: expShares,
      cost: totalCost,
      pnl,
      won: pnl > 0,
      secsBeforeClose,
      hedgeSide: cheapEntry.side,
      hedgePrice: cheapEntry.price,
      hedgeShares: cheapShares,
      hedgeCost: cheapBudget,
      combinedCost: combinedCostPerPair,
    });
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error('MONGODB_URI not set'); process.exit(1); }
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(dbName);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('       BTC 5m TAIL STRATEGY BACKTESTER                        ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Budget/cycle:    $${BUDGET_PER_CYCLE}`);
  console.log(`  Entry window:    ${ENTRY_WINDOW_SECS}s before close`);
  console.log(`  Tail low:        <${(TAIL_LOW * 100).toFixed(0)}c`);
  console.log(`  Tail high:       >${(TAIL_HIGH * 100).toFixed(0)}c`);

  // Load activities from MongoDB
  console.log('\n[1] Loading activities from polyMarket5mLiveData...');
  const query = SLUG_FILTER ? { slug: SLUG_FILTER } : {};
  const docs = await db.collection('polyMarket5mLiveData').find(query).toArray();

  if (docs.length === 0) {
    console.log('  No data found. Run fetch-live-btc5m-data.ts first.');
    await client.close();
    return;
  }

  // Merge all wallet activities
  let allActivities: Activity[] = [];
  for (const doc of docs) {
    for (const wa of (doc.walletActivities || [])) {
      allActivities = allActivities.concat(wa.activities || []);
    }
  }
  console.log(`  Loaded ${allActivities.length} activities from ${docs.length} document(s)`);

  // Build market cycles
  const cycles = buildMarketCycles(allActivities);
  const knownCycles = cycles.filter(c => c.winner !== 'Unknown');
  console.log(`  ${cycles.length} market cycles detected, ${knownCycles.length} with known winner`);

  // Run backtests
  console.log('\n[2] Running backtests...\n');

  const nakedResults = backtestNakedTails(knownCycles, BUDGET_PER_CYCLE);
  const hedgedResults = backtestHedgedTails(knownCycles, BUDGET_PER_CYCLE);

  // ── Strategy A Results ──────────────────────────────
  const nakedCheap = nakedResults.filter(r => r.strategy === 'NAKED_TAIL_CHEAP');
  const nakedExpensive = nakedResults.filter(r => r.strategy === 'NAKED_TAIL_EXPENSIVE');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       STRATEGY A1: NAKED TAIL — CHEAP (Contrarian)           ');
  console.log('═══════════════════════════════════════════════════════════════');
  if (nakedCheap.length > 0) {
    const wins = nakedCheap.filter(r => r.won);
    const totalPnl = nakedCheap.reduce((s, r) => s + r.pnl, 0);
    const totalCost = nakedCheap.reduce((s, r) => s + r.cost, 0);
    const avgEntry = nakedCheap.reduce((s, r) => s + r.entryPrice, 0) / nakedCheap.length;
    const avgSecsBeforeClose = nakedCheap.reduce((s, r) => s + r.secsBeforeClose, 0) / nakedCheap.length;

    console.log(`  Trades: ${nakedCheap.length} | Wins: ${wins.length} (${(wins.length / nakedCheap.length * 100).toFixed(0)}%)`);
    console.log(`  Total PnL: $${totalPnl.toFixed(2)} | Total Cost: $${totalCost.toFixed(0)} | ROCE: ${(totalPnl / totalCost * 100).toFixed(1)}%`);
    console.log(`  Avg entry: ${(avgEntry * 100).toFixed(1)}c | Avg secs before close: ${avgSecsBeforeClose.toFixed(0)}s`);
    console.log(`  Avg win: $${wins.length > 0 ? (wins.reduce((s, r) => s + r.pnl, 0) / wins.length).toFixed(2) : 0}`);
    const losses = nakedCheap.filter(r => !r.won);
    console.log(`  Avg loss: $${losses.length > 0 ? (losses.reduce((s, r) => s + r.pnl, 0) / losses.length).toFixed(2) : 0}`);
    console.log('');
    console.log('  Per-cycle:');
    for (const r of nakedCheap.slice(0, 20)) {
      console.log(`    ${r.cycle?.padEnd(22) || '?'} | ${r.side.padEnd(4)} @${(r.entryPrice * 100).toFixed(0)}c | -${r.secsBeforeClose}s | ${r.won ? '✓' : '✗'} $${r.pnl.toFixed(0)}`);
    }
  } else {
    console.log('  No trades triggered (no prices below tail threshold in entry window)');
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('       STRATEGY A2: NAKED TAIL — EXPENSIVE (Momentum)         ');
  console.log('═══════════════════════════════════════════════════════════════');
  if (nakedExpensive.length > 0) {
    const wins = nakedExpensive.filter(r => r.won);
    const totalPnl = nakedExpensive.reduce((s, r) => s + r.pnl, 0);
    const totalCost = nakedExpensive.reduce((s, r) => s + r.cost, 0);
    const avgEntry = nakedExpensive.reduce((s, r) => s + r.entryPrice, 0) / nakedExpensive.length;
    const avgSecsBeforeClose = nakedExpensive.reduce((s, r) => s + r.secsBeforeClose, 0) / nakedExpensive.length;

    console.log(`  Trades: ${nakedExpensive.length} | Wins: ${wins.length} (${(wins.length / nakedExpensive.length * 100).toFixed(0)}%)`);
    console.log(`  Total PnL: $${totalPnl.toFixed(2)} | Total Cost: $${totalCost.toFixed(0)} | ROCE: ${(totalPnl / totalCost * 100).toFixed(1)}%`);
    console.log(`  Avg entry: ${(avgEntry * 100).toFixed(1)}c | Avg secs before close: ${avgSecsBeforeClose.toFixed(0)}s`);
    console.log(`  Avg win: $${wins.length > 0 ? (wins.reduce((s, r) => s + r.pnl, 0) / wins.length).toFixed(2) : 0}`);
    const losses = nakedExpensive.filter(r => !r.won);
    console.log(`  Avg loss: $${losses.length > 0 ? (losses.reduce((s, r) => s + r.pnl, 0) / losses.length).toFixed(2) : 0}`);
    console.log('');
    console.log('  Per-cycle:');
    for (const r of nakedExpensive.slice(0, 20)) {
      console.log(`    ${r.cycle?.padEnd(22) || '?'} | ${r.side.padEnd(4)} @${(r.entryPrice * 100).toFixed(0)}c | -${r.secsBeforeClose}s | ${r.won ? '✓' : '✗'} $${r.pnl.toFixed(0)}`);
    }
  } else {
    console.log('  No trades triggered');
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('       STRATEGY B: HEDGED TAIL (2x expensive + 1x cheap)      ');
  console.log('═══════════════════════════════════════════════════════════════');
  if (hedgedResults.length > 0) {
    const wins = hedgedResults.filter(r => r.won);
    const totalPnl = hedgedResults.reduce((s, r) => s + r.pnl, 0);
    const totalCost = hedgedResults.reduce((s, r) => s + r.cost, 0);
    const avgCombined = hedgedResults.reduce((s, r) => s + (r.combinedCost || 0), 0) / hedgedResults.length;
    const avgSecsBeforeClose = hedgedResults.reduce((s, r) => s + r.secsBeforeClose, 0) / hedgedResults.length;

    console.log(`  Trades: ${hedgedResults.length} | Wins: ${wins.length} (${(wins.length / hedgedResults.length * 100).toFixed(0)}%)`);
    console.log(`  Total PnL: $${totalPnl.toFixed(2)} | Total Cost: $${totalCost.toFixed(0)} | ROCE: ${(totalPnl / totalCost * 100).toFixed(1)}%`);
    console.log(`  Avg combined cost: ${(avgCombined * 100).toFixed(1)}c | Avg secs before close: ${avgSecsBeforeClose.toFixed(0)}s`);
    console.log(`  Avg win: $${wins.length > 0 ? (wins.reduce((s, r) => s + r.pnl, 0) / wins.length).toFixed(2) : 0}`);
    const losses = hedgedResults.filter(r => !r.won);
    console.log(`  Avg loss: $${losses.length > 0 ? (losses.reduce((s, r) => s + r.pnl, 0) / losses.length).toFixed(2) : 0}`);
    console.log('');
    console.log('  Per-cycle:');
    for (const r of hedgedResults.slice(0, 20)) {
      console.log(`    ${r.cycle?.padEnd(22) || '?'} | ${r.side.padEnd(4)} @${(r.entryPrice * 100).toFixed(0)}c + ${r.hedgeSide} @${((r.hedgePrice || 0) * 100).toFixed(0)}c | comb ${((r.combinedCost || 0) * 100).toFixed(0)}c | -${r.secsBeforeClose}s | ${r.won ? '✓' : '✗'} $${r.pnl.toFixed(0)}`);
    }
  } else {
    console.log('  No trades triggered (need both expensive AND cheap side available)');
  }

  // ── Save results to MongoDB ─────────────────────────
  console.log('\n[3] Saving results to MongoDB (polyMarket5mBacktestResults)...');
  const resultsCollection = db.collection('polyMarket5mBacktestResults');
  await resultsCollection.createIndex({ runAt: -1 });

  const runDoc = {
    runAt: new Date(),
    params: { budget: BUDGET_PER_CYCLE, entryWindow: ENTRY_WINDOW_SECS, tailLow: TAIL_LOW, tailHigh: TAIL_HIGH },
    cyclesAnalyzed: knownCycles.length,
    strategies: {
      nakedTailCheap: {
        trades: nakedCheap.length,
        wins: nakedCheap.filter(r => r.won).length,
        winRate: nakedCheap.length > 0 ? nakedCheap.filter(r => r.won).length / nakedCheap.length : 0,
        totalPnl: nakedCheap.reduce((s, r) => s + r.pnl, 0),
        totalCost: nakedCheap.reduce((s, r) => s + r.cost, 0),
        results: nakedCheap,
      },
      nakedTailExpensive: {
        trades: nakedExpensive.length,
        wins: nakedExpensive.filter(r => r.won).length,
        winRate: nakedExpensive.length > 0 ? nakedExpensive.filter(r => r.won).length / nakedExpensive.length : 0,
        totalPnl: nakedExpensive.reduce((s, r) => s + r.pnl, 0),
        totalCost: nakedExpensive.reduce((s, r) => s + r.cost, 0),
        results: nakedExpensive,
      },
      hedgedTail: {
        trades: hedgedResults.length,
        wins: hedgedResults.filter(r => r.won).length,
        winRate: hedgedResults.length > 0 ? hedgedResults.filter(r => r.won).length / hedgedResults.length : 0,
        totalPnl: hedgedResults.reduce((s, r) => s + r.pnl, 0),
        totalCost: hedgedResults.reduce((s, r) => s + r.cost, 0),
        results: hedgedResults,
      },
    },
  };

  await resultsCollection.insertOne(runDoc);
  console.log('  Saved backtest results');

  // ── Summary ─────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('       SUMMARY                                                ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Cycles analyzed:     ${knownCycles.length}`);
  console.log(`  A1 Naked Cheap:      ${nakedCheap.length} trades, $${nakedCheap.reduce((s, r) => s + r.pnl, 0).toFixed(0)} PnL, ${nakedCheap.length > 0 ? (nakedCheap.filter(r => r.won).length / nakedCheap.length * 100).toFixed(0) : 0}% WR`);
  console.log(`  A2 Naked Expensive:  ${nakedExpensive.length} trades, $${nakedExpensive.reduce((s, r) => s + r.pnl, 0).toFixed(0)} PnL, ${nakedExpensive.length > 0 ? (nakedExpensive.filter(r => r.won).length / nakedExpensive.length * 100).toFixed(0) : 0}% WR`);
  console.log(`  B  Hedged Tail:      ${hedgedResults.length} trades, $${hedgedResults.reduce((s, r) => s + r.pnl, 0).toFixed(0)} PnL, ${hedgedResults.length > 0 ? (hedgedResults.filter(r => r.won).length / hedgedResults.length * 100).toFixed(0) : 0}% WR`);
  console.log('═══════════════════════════════════════════════════════════════');

  await client.close();
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
