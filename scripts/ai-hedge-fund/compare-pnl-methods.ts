/**
 * PnL Method Comparison — with timeframe breakdown
 *
 * Compares three PnL approaches for 1d / 7d / 30d / all-time:
 *
 *   Method A — Positions-based (Polymarket-style):
 *     PnL = sum(closedPosition.realizedPnl where closed in window)
 *           + sum(openPosition.cashPnl)   ← unrealized, always included
 *
 *   Method B — Cash-flow window (current profiler approach):
 *     PnL = sells + redeems + endingValue - buys   (activities in window only)
 *     Problem: redeems from pre-window buys inflate short timeframes.
 *
 *   Method C — Cost-corrected cash-flow:
 *     For each conditionId redeemed/sold in the window, fetch TOTAL buy cost
 *     across all time (not just within window), then:
 *     PnL = proceeds_in_window - total_cost_for_those_positions + unrealized_open
 *
 * Known Polymarket UI values (manual, paste here):
 *   1d:  $264
 *   7d:  $576
 *   1m:  $12,868
 *   All: $38,077
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/compare-pnl-methods.ts <wallet>
 */

const API_BASE = 'https://data-api.polymarket.com';
const wallet = process.argv[2];

if (!wallet) {
  console.error('Usage: npx tsx scripts/ai-hedge-fund/compare-pnl-methods.ts <wallet>');
  process.exit(1);
}

// ─── Polymarket UI reference values (paste manually) ─────────────────────────
const POLY_UI: Record<string, number | null> = {
  '1d':  264,
  '7d':  576,
  '30d': 12868,
  'all': 38077,
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface OpenPosition {
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

interface ClosedPosition {
  conditionId: string;
  title: string;
  outcome: string;
  realizedPnl: number;
  totalBought: number;
  timestamp: number;
}

interface Activity {
  conditionId: string;
  title: string;
  type: 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL';
  usdcSize: number;
  timestamp: number;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllOpenPositions(): Promise<OpenPosition[]> {
  const LIMIT = 500;
  let all: OpenPosition[] = [];
  let offset = 0;
  while (true) {
    const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=${LIMIT}&offset=${offset}`;
    const res = await fetch(url);
    if (res.status === 400) break;
    if (!res.ok) throw new Error(`positions API ${res.status}`);
    const batch = await res.json() as OpenPosition[];
    if (batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await sleep(100);
  }
  console.log(`  open positions fetched: ${all.length}`);
  return all;
}

async function fetchAllClosedPositions(): Promise<ClosedPosition[]> {
  const LIMIT = 50;
  let all: ClosedPosition[] = [];
  let offset = 0;
  while (true) {
    const url = `${API_BASE}/v1/closed-positions?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const res = await fetch(url);
    if (res.status === 400) break;
    if (!res.ok) throw new Error(`closed-positions API ${res.status}`);
    const batch = await res.json() as ClosedPosition[];
    if (batch.length === 0) break;
    all = all.concat(batch);
    const last = batch[batch.length - 1]?.timestamp;
    process.stdout.write(`\r  closed positions fetched: ${all.length} (last: ${last ? new Date(last * 1000).toISOString().split('T')[0] : '?'})`);
    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await sleep(100);
  }
  console.log();
  return all;
}

async function fetchAllActivities(): Promise<Activity[]> {
  const LIMIT = 500;
  let all: Activity[] = [];
  let offset = 0;
  while (offset <= 10000) {
    const url = `${API_BASE}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const res = await fetch(url);
    if (res.status === 400) { console.log(`\n  activities: 400 cap at offset=${offset}`); break; }
    if (!res.ok) throw new Error(`activities API ${res.status}`);
    const batch = await res.json() as Activity[];
    if (batch.length === 0) break;
    all = all.concat(batch);
    const last = batch[batch.length - 1]?.timestamp;
    process.stdout.write(`\r  activities fetched: ${all.length} (last: ${last ? new Date(last * 1000).toISOString().split('T')[0] : '?'})`);
    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await sleep(100);
  }
  console.log();
  return all;
}

// ─── PnL computation helpers ──────────────────────────────────────────────────

function windowStart(days: number | null): number {
  if (days === null) return 0;
  return Math.floor(Date.now() / 1000) - days * 86400;
}

/**
 * Method A — Positions-based (Polymarket-style)
 * Closed positions resolved within window + all unrealized open PnL.
 */
function methodA(
  closedPositions: ClosedPosition[],
  openPositions: OpenPosition[],
  days: number | null,
): { pnl: number; realized: number; unrealized: number; closedCount: number } {
  const start = windowStart(days);
  const inWindow = closedPositions.filter(p => p.timestamp >= start);
  const realized = inWindow.reduce((s, p) => s + p.realizedPnl, 0);
  const unrealized = openPositions.reduce((s, p) => s + p.cashPnl, 0);
  return { pnl: realized + unrealized, realized, unrealized, closedCount: inWindow.length };
}

/**
 * Method B — Current profiler cash-flow (activities in window only).
 * Known issue: redeems from pre-window buys inflate short windows.
 */
function methodB(
  activities: Activity[],
  openPositions: OpenPosition[],
  days: number | null,
): { pnl: number; buys: number; sells: number; redeems: number; endingValue: number } {
  const start = windowStart(days);
  const windowActs = activities.filter(a => a.timestamp >= start);

  let buys = 0, sells = 0, redeems = 0;
  const conditionIds = new Set<string>();

  for (const a of windowActs) {
    conditionIds.add(a.conditionId);
    if (a.type === 'TRADE' && a.side === 'BUY')  buys    += a.usdcSize;
    if (a.type === 'TRADE' && a.side === 'SELL') sells   += a.usdcSize;
    if (a.type === 'REDEEM')                      redeems += a.usdcSize;
  }

  const openMap = new Map(openPositions.map(p => [p.conditionId, p]));
  let endingValue = 0;
  for (const cid of conditionIds) {
    const p = openMap.get(cid);
    if (p && p.curPrice > 0.001) endingValue += p.currentValue;
  }

  return { pnl: sells + redeems + endingValue - buys, buys, sells, redeems, endingValue };
}

/**
 * Method C — Cost-corrected cash-flow.
 * For each conditionId that had a redeem/sell in the window,
 * use the TOTAL buy cost across all activities (not just window).
 * PnL = proceeds_in_window - full_cost_for_touched_positions + unrealized_open
 */
function methodC(
  activities: Activity[],
  openPositions: OpenPosition[],
  days: number | null,
): { pnl: number; proceeds: number; fullCost: number; unrealized: number; positionsUsed: number } {
  const start = windowStart(days);
  const windowActs = activities.filter(a => a.timestamp >= start);

  // Positions that had a redeem or sell in the window
  const exitedInWindow = new Set<string>();
  for (const a of windowActs) {
    if (a.type === 'REDEEM' || (a.type === 'TRADE' && a.side === 'SELL')) {
      exitedInWindow.add(a.conditionId);
    }
  }

  // Proceeds from those positions within window
  let proceeds = 0;
  for (const a of windowActs) {
    if (!exitedInWindow.has(a.conditionId)) continue;
    if (a.type === 'REDEEM' || (a.type === 'TRADE' && a.side === 'SELL')) {
      proceeds += a.usdcSize;
    }
  }

  // Full buy cost across ALL time for those positions
  let fullCost = 0;
  for (const a of activities) {
    if (exitedInWindow.has(a.conditionId) && a.type === 'TRADE' && a.side === 'BUY') {
      fullCost += a.usdcSize;
    }
  }

  // Also add proceeds from pure-buy positions opened in window (not yet exited)
  // — these contribute endingValue as unrealized
  const openMap = new Map(openPositions.map(p => [p.conditionId, p]));
  const unrealized = openPositions.reduce((s, p) => s + p.cashPnl, 0);

  return {
    pnl: proceeds - fullCost + unrealized,
    proceeds,
    fullCost,
    unrealized,
    positionsUsed: exitedInWindow.size,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nWallet: ${wallet}\n`);
  console.log('Fetching data...');

  const [openPositions, closedPositions, activities] = await Promise.all([
    fetchAllOpenPositions(),
    fetchAllClosedPositions(),
    fetchAllActivities(),
  ]);

  const oldestActivity = activities.length > 0
    ? new Date(Math.min(...activities.map(a => a.timestamp)) * 1000).toISOString().split('T')[0]
    : 'N/A';
  const oldestClosed = closedPositions.length > 0
    ? new Date(Math.min(...closedPositions.map(p => p.timestamp)) * 1000).toISOString().split('T')[0]
    : 'N/A';

  console.log(`\n  Activity history goes back to: ${oldestActivity}`);
  console.log(`  Closed positions go back to:   ${oldestClosed}`);

  const frames: Array<{ label: string; days: number | null }> = [
    { label: '1d',  days: 1   },
    { label: '7d',  days: 7   },
    { label: '30d', days: 30  },
    { label: 'all', days: null },
  ];

  const W = 12;
  const pad = (s: string | number, w = W) => String(s).padStart(w);
  const fmt = (n: number) => `$${n.toFixed(0)}`;

  console.log('\n' + '═'.repeat(78));
  console.log('  PnL COMPARISON TABLE');
  console.log('═'.repeat(78));
  console.log(
    `  ${'Frame'.padEnd(6)}` +
    `${pad('Method A')}` +
    `${pad('Method B')}` +
    `${pad('Method C')}` +
    `${pad('Poly UI')}` +
    `  ${pad('A vs UI', 10)}  ${pad('B vs UI', 10)}  ${pad('C vs UI', 10)}`
  );
  console.log(
    `  ${''.padEnd(6)}` +
    `${pad('(positions)')}` +
    `${pad('(cashflow)')}` +
    `${pad('(corrected)')}` +
    `${pad('(ref)')}` +
    `  ${''.padStart(10)}  ${''.padStart(10)}  ${''.padStart(10)}`
  );
  console.log('  ' + '─'.repeat(76));

  for (const { label, days } of frames) {
    const a = methodA(closedPositions, openPositions, days);
    const b = methodB(activities, openPositions, days);
    const c = methodC(activities, openPositions, days);
    const ui = POLY_UI[label];

    const diffA = ui !== null ? a.pnl - ui : null;
    const diffB = ui !== null ? b.pnl - ui : null;
    const diffC = ui !== null ? c.pnl - ui : null;

    const fmtDiff = (d: number | null) =>
      d === null ? pad('N/A') : (d >= 0 ? `+${fmt(d)}` : fmt(d)).padStart(W);

    console.log(
      `  ${label.padEnd(6)}` +
      `${pad(fmt(a.pnl))}` +
      `${pad(fmt(b.pnl))}` +
      `${pad(fmt(c.pnl))}` +
      `${pad(ui !== null ? fmt(ui) : 'N/A')}` +
      `  ${fmtDiff(diffA)}  ${fmtDiff(diffB)}  ${fmtDiff(diffC)}`
    );
  }

  console.log('  ' + '─'.repeat(76));
  console.log('\n  (A vs UI = how far Method A is from Polymarket UI, closer to 0 = better)');

  // ── Detailed breakdown per frame ──────────────────────────────────────────
  console.log('\n' + '═'.repeat(78));
  console.log('  DETAILED BREAKDOWN');
  console.log('═'.repeat(78));

  for (const { label, days } of frames) {
    const a = methodA(closedPositions, openPositions, days);
    const b = methodB(activities, openPositions, days);
    const c = methodC(activities, openPositions, days);

    console.log(`\n  ── ${label} ───────────────────────────────────────────`);
    console.log(`  Method A  realized=${fmt(a.realized)}  unrealized=${fmt(a.unrealized)}  (${a.closedCount} closed positions in window)`);
    console.log(`  Method B  buys=${fmt(b.buys)}  sells=${fmt(b.sells)}  redeems=${fmt(b.redeems)}  endingVal=${fmt(b.endingValue)}`);
    console.log(`  Method C  proceeds=${fmt(c.proceeds)}  fullCost=${fmt(c.fullCost)}  unrealized=${fmt(c.unrealized)}  (${c.positionsUsed} exited positions)`);
  }

  console.log('\n' + '═'.repeat(78) + '\n');
}

main().catch(console.error);
