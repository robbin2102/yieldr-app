/**
 * PnL Method Comparison — with timeframe breakdown + Method D (Modified Dietz)
 *
 *   Method A — Positions-based (Polymarket-style):
 *     PnL = sum(closedPosition.realizedPnl where closed in window)
 *           + sum(openPosition.cashPnl)   ← total unrealized (not delta)
 *     Problem: unrealized is all-time, not delta-in-window → overstates short frames
 *
 *   Method B — Cash-flow window (current profiler approach):
 *     PnL = sells + redeems + endingValue - buys   (activities in window only)
 *     Problem: redeems from pre-window buys inflate short timeframes massively
 *
 *   Method C — Cost-corrected cash-flow:
 *     PnL = proceeds_in_window - total_historical_cost_for_exited_positions + unrealized_open
 *     Problem: still uses all-time unrealized, same as Method A for that component
 *
 *   Method D — Modified Dietz (correct approach):
 *     PnL = portfolioValue_NOW - portfolioValue_at_WINDOW_START + netCashOut_in_window
 *     Uses CLOB price history API to get market prices at window start.
 *     Falls back to last-known activity price if CLOB unavailable.
 *
 * Known Polymarket UI values (hardcoded for this wallet):
 *   1d: $264  |  7d: $576  |  30d: $12,868  |  all: $38,077
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/compare-pnl-methods.ts <wallet>
 */

const DATA_API  = 'https://data-api.polymarket.com';
const CLOB_API  = 'https://clob.polymarket.com';
const wallet = process.argv[2];

if (!wallet) {
  console.error('Usage: npx tsx scripts/ai-hedge-fund/compare-pnl-methods.ts <wallet>');
  process.exit(1);
}

const POLY_UI: Record<string, number | null> = {
  '1d':  264,
  '7d':  576,
  '30d': 12868,
  'all': 38077,
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface OpenPosition {
  conditionId: string;
  asset: string;
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
  asset: string;
  title: string;
  outcome: string;
  realizedPnl: number;
  totalBought: number;
  timestamp: number;
}

interface Activity {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  type: 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL';
  size: number;
  price: number;
  usdcSize: number;
  timestamp: number;
  transactionHash: string;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllOpenPositions(): Promise<OpenPosition[]> {
  const LIMIT = 500;
  let all: OpenPosition[] = [];
  let offset = 0;
  while (true) {
    const res = await fetch(`${DATA_API}/positions?user=${wallet}&sizeThreshold=0.1&limit=${LIMIT}&offset=${offset}`);
    if (res.status === 400) break;
    if (!res.ok) throw new Error(`positions ${res.status}`);
    const batch = await res.json() as OpenPosition[];
    if (batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await sleep(100);
  }
  console.log(`  open positions: ${all.length}`);
  return all;
}

async function fetchAllClosedPositions(): Promise<ClosedPosition[]> {
  const LIMIT = 50;
  let all: ClosedPosition[] = [];
  let offset = 0;
  while (true) {
    const res = await fetch(`${DATA_API}/v1/closed-positions?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`);
    if (res.status === 400) break;
    if (!res.ok) throw new Error(`closed-positions ${res.status}`);
    const batch = await res.json() as ClosedPosition[];
    if (batch.length === 0) break;
    all = all.concat(batch);
    const last = batch[batch.length - 1]?.timestamp;
    process.stdout.write(`\r  closed positions: ${all.length} (last: ${last ? new Date(last * 1000).toISOString().split('T')[0] : '?'})`);
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
    const res = await fetch(`${DATA_API}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`);
    if (res.status === 400) { console.log(`\n  activities: 400 cap at offset=${offset}`); break; }
    if (!res.ok) throw new Error(`activities ${res.status}`);
    const batch = await res.json() as Activity[];
    if (batch.length === 0) break;
    all = all.concat(batch);
    const last = batch[batch.length - 1]?.timestamp;
    process.stdout.write(`\r  activities: ${all.length} (last: ${last ? new Date(last * 1000).toISOString().split('T')[0] : '?'})`);
    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await sleep(100);
  }
  console.log();
  return all;
}

// ─── CLOB price history ───────────────────────────────────────────────────────

const _priceCache = new Map<string, Array<{ t: number; p: number }>>();
let _clobAvailable: boolean | null = null;

async function fetchPriceHistory(tokenId: string): Promise<Array<{ t: number; p: number }>> {
  if (_priceCache.has(tokenId)) return _priceCache.get(tokenId)!;
  if (_clobAvailable === false) return [];

  try {
    // fidelity=1440 = one data point per day (minute-level granularity, 1440min/day)
    const res = await fetch(`${CLOB_API}/prices-history?market=${tokenId}&interval=max&fidelity=1440`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      if (_clobAvailable === null) {
        console.log(`  [CLOB] price history unavailable (${res.status}) — Method D will use activity-price fallback`);
        _clobAvailable = false;
      }
      return [];
    }
    _clobAvailable = true;
    const data = await res.json() as { history: Array<{ t: number; p: number }> };
    const history = (data.history ?? []).sort((a, b) => a.t - b.t);
    _priceCache.set(tokenId, history);
    return history;
  } catch {
    if (_clobAvailable === null) {
      console.log(`  [CLOB] unreachable — Method D will use activity-price fallback`);
      _clobAvailable = false;
    }
    return [];
  }
}

/**
 * Get the market price for tokenId at or just before the target timestamp.
 * Returns null if no data available.
 */
function priceAt(history: Array<{ t: number; p: number }>, ts: number): number | null {
  if (history.length === 0) return null;
  // Last point at or before ts
  let best: { t: number; p: number } | null = null;
  for (const pt of history) {
    if (pt.t <= ts) { best = pt; } else break; // sorted ascending, stop early
  }
  // If nothing before ts, use earliest available (position may have just opened)
  if (best === null) best = history[0];
  return best?.p ?? null;
}

// ─── PnL methods ──────────────────────────────────────────────────────────────

function windowStart(days: number | null): number {
  if (days === null) return 0;
  return Math.floor(Date.now() / 1000) - days * 86400;
}

/** Method A: closed positions bucketed by close-timestamp + total unrealized */
function methodA(closed: ClosedPosition[], open: OpenPosition[], days: number | null) {
  const start = windowStart(days);
  const inWindow = closed.filter(p => p.timestamp >= start);
  const realized   = inWindow.reduce((s, p) => s + p.realizedPnl, 0);
  const unrealized = open.reduce((s, p) => s + p.cashPnl, 0);
  return { pnl: realized + unrealized, realized, unrealized, closedCount: inWindow.length };
}

/** Method B: cash-flow window (current profiler) */
function methodB(activities: Activity[], open: OpenPosition[], days: number | null) {
  const start = windowStart(days);
  const acts = activities.filter(a => a.timestamp >= start);
  let buys = 0, sells = 0, redeems = 0;
  const cids = new Set<string>();
  for (const a of acts) {
    cids.add(a.conditionId);
    if (a.type === 'TRADE' && a.side === 'BUY')  buys    += a.usdcSize;
    if (a.type === 'TRADE' && a.side === 'SELL') sells   += a.usdcSize;
    if (a.type === 'REDEEM')                      redeems += a.usdcSize;
  }
  const openMap = new Map(open.map(p => [p.conditionId, p]));
  let endingValue = 0;
  for (const cid of cids) {
    const p = openMap.get(cid);
    if (p && p.curPrice > 0.001) endingValue += p.currentValue;
  }
  return { pnl: sells + redeems + endingValue - buys, buys, sells, redeems, endingValue };
}

/** Method C: cost-corrected cash-flow */
function methodC(activities: Activity[], open: OpenPosition[], days: number | null) {
  const start = windowStart(days);
  const acts  = activities.filter(a => a.timestamp >= start);
  const exited = new Set<string>();
  for (const a of acts) {
    if (a.type === 'REDEEM' || (a.type === 'TRADE' && a.side === 'SELL')) exited.add(a.conditionId);
  }
  let proceeds = 0, fullCost = 0;
  for (const a of acts) {
    if (exited.has(a.conditionId) && (a.type === 'REDEEM' || (a.type === 'TRADE' && a.side === 'SELL')))
      proceeds += a.usdcSize;
  }
  for (const a of activities) {
    if (exited.has(a.conditionId) && a.type === 'TRADE' && a.side === 'BUY')
      fullCost += a.usdcSize;
  }
  const unrealized = open.reduce((s, p) => s + p.cashPnl, 0);
  return { pnl: proceeds - fullCost + unrealized, proceeds, fullCost, unrealized, positionsUsed: exited.size };
}

/**
 * Method D — Modified Dietz with CLOB historical prices.
 *
 *   PnL = portfolioValue_NOW
 *       - portfolioValue_at_WINDOW_START
 *       + (cashOut_in_window - cashIn_in_window)
 *
 * portfolioValue_at_WINDOW_START is computed by:
 *   1. Reconstructing share-count for each position at window start from activities
 *   2. Fetching the market price at window start from CLOB price history
 *   3. Falling back to last-known activity price if CLOB unavailable
 */
async function methodD(
  activities: Activity[],
  open: OpenPosition[],
  days: number | null,
): Promise<{
  pnl: number;
  valueNow: number;
  valueAtStart: number;
  netCashOut: number;
  positionsAtStart: number;
  clobUsed: number;
  fallbackUsed: number;
  missingPrice: number;
}> {
  const now   = Math.floor(Date.now() / 1000);
  const start = windowStart(days);

  // ── All-time: start value = 0 ────────────────────────────────────────────
  if (start === 0) {
    let buys = 0, sells = 0, redeems = 0;
    for (const a of activities) {
      if (a.type === 'TRADE' && a.side === 'BUY')  buys    += a.usdcSize;
      if (a.type === 'TRADE' && a.side === 'SELL') sells   += a.usdcSize;
      if (a.type === 'REDEEM')                      redeems += a.usdcSize;
    }
    const valueNow = open.reduce((s, p) => s + p.currentValue, 0);
    return { pnl: valueNow + sells + redeems - buys, valueNow, valueAtStart: 0, netCashOut: sells + redeems - buys, positionsAtStart: 0, clobUsed: 0, fallbackUsed: 0, missingPrice: 0 };
  }

  // ── Net cash flows within window ─────────────────────────────────────────
  const windowActs = activities.filter(a => a.timestamp >= start);
  let cashIn = 0, cashOut = 0;
  for (const a of windowActs) {
    if (a.type === 'TRADE' && a.side === 'BUY')  cashIn  += a.usdcSize;
    if (a.type === 'TRADE' && a.side === 'SELL') cashOut += a.usdcSize;
    if (a.type === 'REDEEM')                      cashOut += a.usdcSize;
  }
  const netCashOut = cashOut - cashIn;

  // ── Portfolio value NOW ───────────────────────────────────────────────────
  const valueNow = open.reduce((s, p) => s + p.currentValue, 0);

  // ── Reconstruct positions at window start from pre-window activities ──────
  // Track (shares, asset, title, last-activity-price) per conditionId
  type Pos = { shares: number; asset: string; title: string; lastPrice: number };
  const posAtStart = new Map<string, Pos>();

  // Walk all activities sorted oldest-first, stop before window start
  const preWindow = activities.filter(a => a.timestamp < start).sort((a, b) => a.timestamp - b.timestamp);

  for (const a of preWindow) {
    const cur = posAtStart.get(a.conditionId) ?? { shares: 0, asset: a.asset, title: a.title, lastPrice: 0 };

    if (a.type === 'TRADE' && a.side === 'BUY') {
      cur.shares    += a.size;
      cur.lastPrice  = a.price;
    } else if (a.type === 'TRADE' && a.side === 'SELL') {
      cur.shares    -= a.size;
      cur.lastPrice  = a.price;
    } else if (a.type === 'REDEEM') {
      cur.shares = 0; // fully redeemed = closed
    }

    posAtStart.set(a.conditionId, cur);
  }

  // Filter to positions with meaningful share count at window start
  const activeAtStart = Array.from(posAtStart.entries()).filter(([, v]) => v.shares > 0.001);

  // ── Fetch CLOB price history for each unique asset ────────────────────────
  const assetsNeeded = new Set(activeAtStart.map(([, v]) => v.asset));
  await Promise.all(Array.from(assetsNeeded).map(asset => fetchPriceHistory(asset)));

  // ── Compute portfolio value at window start ───────────────────────────────
  let valueAtStart = 0;
  let clobUsed = 0, fallbackUsed = 0, missingPrice = 0;

  for (const [condId, pos] of activeAtStart) {
    const history = _priceCache.get(pos.asset) ?? [];
    let price = priceAt(history, start);

    if (price !== null) {
      clobUsed++;
    } else {
      // Fallback: last-known activity price before window start
      price = pos.lastPrice > 0 ? pos.lastPrice : null;
      if (price !== null) {
        fallbackUsed++;
        console.log(`  [D fallback] ${pos.title.slice(0, 45)} — using last activity price ${price.toFixed(3)}`);
      } else {
        missingPrice++;
        console.log(`  [D missing ] ${pos.title.slice(0, 45)} — no price available, skipping`);
      }
    }

    if (price !== null) {
      valueAtStart += pos.shares * price;
    }
  }

  const pnl = (valueNow - valueAtStart) + netCashOut;
  return { pnl, valueNow, valueAtStart, netCashOut, positionsAtStart: activeAtStart.length, clobUsed, fallbackUsed, missingPrice };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nWallet: ${wallet}\n`);
  console.log('Fetching data...');
  const [open, closed, activities] = await Promise.all([
    fetchAllOpenPositions(),
    fetchAllClosedPositions(),
    fetchAllActivities(),
  ]);

  const oldestAct    = activities.length ? new Date(Math.min(...activities.map(a => a.timestamp)) * 1000).toISOString().split('T')[0] : 'N/A';
  const oldestClosed = closed.length     ? new Date(Math.min(...closed.map(p => p.timestamp))     * 1000).toISOString().split('T')[0] : 'N/A';
  console.log(`\n  Activity history: ${oldestAct}  |  Closed positions: ${oldestClosed}\n`);

  const frames = [
    { label: '1d',  days: 1    },
    { label: '7d',  days: 7    },
    { label: '30d', days: 30   },
    { label: 'all', days: null },
  ] as const;

  // Pre-compute Method D for all frames (needs async CLOB fetch)
  console.log('Computing Method D (Modified Dietz)...');
  const dResults: Record<string, Awaited<ReturnType<typeof methodD>>> = {};
  for (const { label, days } of frames) {
    dResults[label] = await methodD(activities, open, days);
    await sleep(50);
  }

  // ── Comparison table ──────────────────────────────────────────────────────
  const W   = 12;
  const pad = (s: string | number, w = W) => String(s).padStart(w);
  const fmt = (n: number) => `$${n.toFixed(0)}`;
  const fmtDiff = (d: number | null) =>
    d === null ? pad('N/A') : (d >= 0 ? `+${fmt(d)}` : fmt(d)).padStart(W);

  console.log('\n' + '═'.repeat(90));
  console.log('  PnL COMPARISON TABLE');
  console.log('═'.repeat(90));
  console.log(
    `  ${'Frame'.padEnd(6)}` +
    `${pad('Method A')}` +
    `${pad('Method B')}` +
    `${pad('Method C')}` +
    `${pad('Method D')}` +
    `${pad('Poly UI')}` +
    `  ${pad('A-UI', 10)}  ${pad('D-UI', 10)}`
  );
  console.log(
    `  ${''.padEnd(6)}` +
    `${pad('(positions)')}` +
    `${pad('(cashflow)')}` +
    `${pad('(corrected)')}` +
    `${pad('(mod.dietz)')}` +
    `${pad('(ref)')}` +
    `  ${''.padStart(10)}  ${''.padStart(10)}`
  );
  console.log('  ' + '─'.repeat(88));

  for (const { label, days } of frames) {
    const a  = methodA(closed, open, days);
    const b  = methodB(activities, open, days);
    const c  = methodC(activities, open, days);
    const d  = dResults[label];
    const ui = POLY_UI[label];

    const diffA = ui !== null ? a.pnl - ui : null;
    const diffD = ui !== null ? d.pnl - ui : null;

    console.log(
      `  ${label.padEnd(6)}` +
      `${pad(fmt(a.pnl))}` +
      `${pad(fmt(b.pnl))}` +
      `${pad(fmt(c.pnl))}` +
      `${pad(fmt(d.pnl))}` +
      `${pad(ui !== null ? fmt(ui) : 'N/A')}` +
      `  ${fmtDiff(diffA)}  ${fmtDiff(diffD)}`
    );
  }
  console.log('  ' + '─'.repeat(88));
  console.log('  Closest to 0 in the diff columns = best match to Polymarket UI\n');

  // ── Detailed breakdown ─────────────────────────────────────────────────────
  console.log('═'.repeat(90));
  console.log('  METHOD D DETAIL (Modified Dietz)');
  console.log('═'.repeat(90));
  for (const { label, days } of frames) {
    const d = dResults[label];
    console.log(
      `  ${label.padEnd(5)} ` +
      `valueNow=${fmt(d.valueNow)}  ` +
      `valueAtStart=${fmt(d.valueAtStart)}  ` +
      `netCashOut=${fmt(d.netCashOut)}  ` +
      `→ PnL=${fmt(d.pnl)}` +
      (label !== 'all' ? `  [${d.positionsAtStart} positions at start: ${d.clobUsed} CLOB / ${d.fallbackUsed} fallback / ${d.missingPrice} missing]` : '')
    );
  }

  // ── Open positions at window start (debug) ─────────────────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  OPEN POSITIONS (current) — used as valueNow in Method D');
  console.log('═'.repeat(90));
  const sortedOpen = [...open].sort((a, b) => b.currentValue - a.currentValue);
  for (const p of sortedOpen) {
    const clobHistory = _priceCache.get(p.asset) ?? [];
    const p1d  = priceAt(clobHistory, Math.floor(Date.now() / 1000) - 1  * 86400);
    const p7d  = priceAt(clobHistory, Math.floor(Date.now() / 1000) - 7  * 86400);
    const p30d = priceAt(clobHistory, Math.floor(Date.now() / 1000) - 30 * 86400);
    const cur  = p.curPrice;
    console.log(
      `  ${p.title.slice(0, 42).padEnd(42)} [${p.outcome.slice(0,3)}]` +
      `  size=${p.size.toFixed(1).padStart(8)}` +
      `  cur=${cur.toFixed(3)}` +
      `  1dAgo=${p1d !== null ? p1d.toFixed(3) : ' N/A '}` +
      `  7dAgo=${p7d !== null ? p7d.toFixed(3) : ' N/A '}` +
      `  30dAgo=${p30d !== null ? p30d.toFixed(3) : ' N/A'}`
    );
  }
  console.log('');
}

main().catch(console.error);
