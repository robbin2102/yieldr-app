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

/**
 * Method E — Method A + CLOB delta (fixes both realized and unrealized)
 *
 * For closed positions closed in window:
 *   shares ≈ totalBought / avgPrice
 *   If position existed at window start (CLOB price available):
 *     preWindowGain = shares × priceAtStart - totalBought
 *     inWindowPnl = realizedPnl - preWindowGain
 *   Else (opened during window):
 *     inWindowPnl = realizedPnl (full amount is in-window)
 *
 * For open positions:
 *   If existed at window start:
 *     deltaUnrealized = size × (curPrice - priceAtStart)
 *   Else (opened during window):
 *     deltaUnrealized = cashPnl (full unrealized is in-window)
 */
interface MethodEDebug {
  type: 'closed' | 'open';
  title: string;
  outcome: string;
  shares: number;
  allTimePnl: number;
  priceAtStart: number | null;
  preWindowGain: number | null;
  inWindowPnl: number;
  source: 'clob' | 'no_clob_opened_in_window' | 'no_clob_fallback';
}

async function methodE(
  closed: ClosedPosition[],
  open: OpenPosition[],
  activities: Activity[],
  days: number | null,
): Promise<{
  pnl: number;
  realizedInWindow: number;
  unrealizedDelta: number;
  closedCount: number;
  openCount: number;
  debug: MethodEDebug[];
}> {
  const start = windowStart(days);
  const debug: MethodEDebug[] = [];

  // ── All-time: same as Method A ────────────────────────────────────────────
  if (start === 0) {
    const realized   = closed.reduce((s, p) => s + p.realizedPnl, 0);
    const unrealized = open.reduce((s, p) => s + p.cashPnl, 0);
    return { pnl: realized + unrealized, realizedInWindow: realized, unrealizedDelta: unrealized, closedCount: closed.length, openCount: open.length, debug: [] };
  }

  // ── Fetch CLOB prices for closed positions in window + open positions ─────
  const closedInWindow = closed.filter(p => p.timestamp >= start);
  const allAssets = new Set<string>();
  for (const p of closedInWindow) allAssets.add(p.asset);
  for (const p of open) allAssets.add(p.asset);
  await Promise.all(Array.from(allAssets).map(a => fetchPriceHistory(a)));

  // ── Build set of assets with pre-window buys (to know if position existed before window) ──
  const preWindowBuyAssets = new Set<string>();
  for (const a of activities) {
    if (a.timestamp < start && a.type === 'TRADE' && a.side === 'BUY') {
      preWindowBuyAssets.add(a.asset);
    }
  }

  // ── Realized: adjust closed positions for pre-window gains ────────────────
  let realizedInWindow = 0;
  for (const pos of closedInWindow) {
    const shares = pos.avgPrice > 0 ? pos.totalBought / pos.avgPrice : 0;
    const history = _priceCache.get(pos.asset) ?? [];
    const pAtStart = priceAt(history, start);
    const existedBefore = preWindowBuyAssets.has(pos.asset);

    let inWindowPnl: number;
    let preWindowGain: number | null = null;
    let source: MethodEDebug['source'];

    if (existedBefore && pAtStart !== null) {
      // Position existed before window — subtract pre-window gain
      preWindowGain = shares * pAtStart - pos.totalBought;
      inWindowPnl = pos.realizedPnl - preWindowGain;
      source = 'clob';
    } else if (!existedBefore) {
      // Position opened during window — full realizedPnl is in-window
      inWindowPnl = pos.realizedPnl;
      source = 'no_clob_opened_in_window';
    } else {
      // Existed before but no CLOB price — use full realizedPnl as fallback
      inWindowPnl = pos.realizedPnl;
      source = 'no_clob_fallback';
    }

    realizedInWindow += inWindowPnl;
    debug.push({
      type: 'closed',
      title: pos.title,
      outcome: pos.outcome,
      shares,
      allTimePnl: pos.realizedPnl,
      priceAtStart: pAtStart,
      preWindowGain,
      inWindowPnl,
      source,
    });
  }

  // ── Unrealized: delta for open positions using CLOB prices ────────────────
  let unrealizedDelta = 0;
  for (const pos of open) {
    const history = _priceCache.get(pos.asset) ?? [];
    const pAtStart = priceAt(history, start);
    const existedBefore = preWindowBuyAssets.has(pos.asset);

    let delta: number;
    let source: MethodEDebug['source'];

    if (existedBefore && pAtStart !== null) {
      delta = pos.size * (pos.curPrice - pAtStart);
      source = 'clob';
    } else if (!existedBefore) {
      // Opened during window — full cashPnl is in-window
      delta = pos.cashPnl;
      source = 'no_clob_opened_in_window';
    } else {
      delta = pos.cashPnl;
      source = 'no_clob_fallback';
    }

    unrealizedDelta += delta;
    debug.push({
      type: 'open',
      title: pos.title,
      outcome: pos.outcome,
      shares: pos.size,
      allTimePnl: pos.cashPnl,
      priceAtStart: pAtStart,
      preWindowGain: existedBefore && pAtStart !== null ? pos.size * pAtStart - pos.initialValue : null,
      inWindowPnl: delta,
      source,
    });
  }

  return {
    pnl: realizedInWindow + unrealizedDelta,
    realizedInWindow,
    unrealizedDelta,
    closedCount: closedInWindow.length,
    openCount: open.length,
    debug,
  };
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
 *      NOTE: grouped by ASSET (tokenId), not conditionId — each Yes/No outcome is separate
 *   2. Fetching the market price at window start from CLOB price history
 *   3. Falling back to last-known activity price if CLOB unavailable
 */

interface PositionDebug {
  asset: string;
  conditionId: string;
  title: string;
  outcome: string;
  sharesAtStart: number;
  priceAtStart: number | null;
  valueAtStart: number;
  priceSource: 'clob' | 'fallback' | 'missing';
  stillOpen: boolean;
  currentValue: number;
  cashFlowInWindow: number; // positive = net outflow for this position
}

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
  debug: PositionDebug[];
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
    return { pnl: valueNow + sells + redeems - buys, valueNow, valueAtStart: 0, netCashOut: sells + redeems - buys, positionsAtStart: 0, clobUsed: 0, fallbackUsed: 0, missingPrice: 0, debug: [] };
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
  // KEY: group by ASSET (tokenId), not conditionId. Each Yes/No outcome has
  // a different asset. Grouping by conditionId would merge Yes+No shares and
  // use the wrong price for one side.
  type Pos = { shares: number; asset: string; conditionId: string; title: string; outcome: string; lastPrice: number };
  const posAtStart = new Map<string, Pos>(); // keyed by asset (tokenId)

  const preWindow = activities.filter(a => a.timestamp < start).sort((a, b) => a.timestamp - b.timestamp);

  for (const a of preWindow) {
    const cur = posAtStart.get(a.asset) ?? { shares: 0, asset: a.asset, conditionId: a.conditionId, title: a.title, outcome: a.outcome, lastPrice: 0 };

    if (a.type === 'TRADE' && a.side === 'BUY') {
      cur.shares    += a.size;
      cur.lastPrice  = a.price;
    } else if (a.type === 'TRADE' && a.side === 'SELL') {
      cur.shares    -= a.size;
      cur.lastPrice  = a.price;
    } else if (a.type === 'REDEEM') {
      cur.shares = 0;
    }

    posAtStart.set(a.asset, cur);
  }

  // Filter to positions with meaningful share count at window start
  const activeAtStart = Array.from(posAtStart.entries()).filter(([, v]) => v.shares > 0.001);

  // ── Per-position cash flows within window (for debug) ─────────────────────
  const assetCashFlowInWindow = new Map<string, number>();
  for (const a of windowActs) {
    const cur = assetCashFlowInWindow.get(a.asset) ?? 0;
    if (a.type === 'TRADE' && a.side === 'BUY')  assetCashFlowInWindow.set(a.asset, cur - a.usdcSize);
    if (a.type === 'TRADE' && a.side === 'SELL') assetCashFlowInWindow.set(a.asset, cur + a.usdcSize);
    if (a.type === 'REDEEM')                      assetCashFlowInWindow.set(a.asset, cur + a.usdcSize);
  }

  // ── Fetch CLOB price history for each unique asset ────────────────────────
  const assetsNeeded = new Set(activeAtStart.map(([asset]) => asset));
  // Also fetch for open positions (needed for debug table)
  for (const p of open) assetsNeeded.add(p.asset);
  await Promise.all(Array.from(assetsNeeded).map(asset => fetchPriceHistory(asset)));

  // ── Compute portfolio value at window start ───────────────────────────────
  let valueAtStart = 0;
  let clobUsed = 0, fallbackUsed = 0, missingPrice = 0;
  const debug: PositionDebug[] = [];

  const openByAsset = new Map(open.map(p => [p.asset, p]));

  for (const [asset, pos] of activeAtStart) {
    const history = _priceCache.get(asset) ?? [];
    let price = priceAt(history, start);
    let priceSource: 'clob' | 'fallback' | 'missing' = 'clob';

    if (price !== null) {
      clobUsed++;
    } else {
      price = pos.lastPrice > 0 ? pos.lastPrice : null;
      if (price !== null) {
        fallbackUsed++;
        priceSource = 'fallback';
      } else {
        missingPrice++;
        priceSource = 'missing';
      }
    }

    const posValue = price !== null ? pos.shares * price : 0;
    valueAtStart += posValue;

    const openPos = openByAsset.get(asset);
    debug.push({
      asset,
      conditionId: pos.conditionId,
      title: pos.title,
      outcome: pos.outcome,
      sharesAtStart: pos.shares,
      priceAtStart: price,
      valueAtStart: posValue,
      priceSource,
      stillOpen: !!openPos,
      currentValue: openPos?.currentValue ?? 0,
      cashFlowInWindow: assetCashFlowInWindow.get(asset) ?? 0,
    });
  }

  // Sort debug by valueAtStart desc
  debug.sort((a, b) => b.valueAtStart - a.valueAtStart);

  const pnl = (valueNow - valueAtStart) + netCashOut;
  return { pnl, valueNow, valueAtStart, netCashOut, positionsAtStart: activeAtStart.length, clobUsed, fallbackUsed, missingPrice, debug };
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

  // Pre-compute Method E for all frames (needs async CLOB fetch)
  console.log('Computing Method E (Method A + CLOB delta)...');
  const eResults: Record<string, Awaited<ReturnType<typeof methodE>>> = {};
  for (const { label, days } of frames) {
    eResults[label] = await methodE(closed, open, activities, days);
    await sleep(50);
  }

  // ── Comparison table ──────────────────────────────────────────────────────
  const W   = 12;
  const pad = (s: string | number, w = W) => String(s).padStart(w);
  const fmt = (n: number) => `$${n.toFixed(0)}`;
  const fmtDiff = (d: number | null) =>
    d === null ? pad('N/A') : (d >= 0 ? `+${fmt(d)}` : fmt(d)).padStart(W);

  console.log('\n' + '═'.repeat(100));
  console.log('  PnL COMPARISON TABLE');
  console.log('═'.repeat(100));
  console.log(
    `  ${'Frame'.padEnd(6)}` +
    `${pad('Method A')}` +
    `${pad('Method B')}` +
    `${pad('Method E')}` +
    `${pad('Poly UI')}` +
    `  ${pad('A-UI', 10)}  ${pad('E-UI', 10)}  ${pad('E-err%', 10)}`
  );
  console.log(
    `  ${''.padEnd(6)}` +
    `${pad('(positions)')}` +
    `${pad('(cashflow)')}` +
    `${pad('(A+CLOB)')}` +
    `${pad('(ref)')}` +
    `  ${''.padStart(10)}  ${''.padStart(10)}  ${''.padStart(10)}`
  );
  console.log('  ' + '─'.repeat(98));

  for (const { label, days } of frames) {
    const a  = methodA(closed, open, days);
    const b  = methodB(activities, open, days);
    const e  = eResults[label];
    const ui = POLY_UI[label];

    const diffA = ui !== null ? a.pnl - ui : null;
    const diffE = ui !== null ? e.pnl - ui : null;
    const errPct = ui !== null && ui !== 0 ? ((e.pnl - ui) / ui * 100) : null;

    console.log(
      `  ${label.padEnd(6)}` +
      `${pad(fmt(a.pnl))}` +
      `${pad(fmt(b.pnl))}` +
      `${pad(fmt(e.pnl))}` +
      `${pad(ui !== null ? fmt(ui) : 'N/A')}` +
      `  ${fmtDiff(diffA)}  ${fmtDiff(diffE)}  ${errPct !== null ? (errPct >= 0 ? '+' : '') + errPct.toFixed(1) + '%' : 'N/A'.padStart(10)}`
    );
  }
  console.log('  ' + '─'.repeat(98));
  console.log('  Method E = Method A with CLOB-corrected realized + delta unrealized\n');

  // ── Method E detail ────────────────────────────────────────────────────────
  console.log('═'.repeat(100));
  console.log('  METHOD E SUMMARY');
  console.log('═'.repeat(100));
  for (const { label, days } of frames) {
    const e = eResults[label];
    console.log(
      `  ${label.padEnd(5)} ` +
      `realizedInWindow=${fmt(e.realizedInWindow)}  ` +
      `unrealizedDelta=${fmt(e.unrealizedDelta)}  ` +
      `→ PnL=${fmt(e.pnl)}` +
      `  [${e.closedCount} closed + ${e.openCount} open]`
    );
  }

  // ── Method E per-position debug for each timeframe ──────────────────────────
  for (const { label, days } of frames) {
    if (days === null) continue;
    const e = eResults[label];
    if (e.debug.length === 0) continue;

    console.log('\n' + '═'.repeat(120));
    console.log(`  METHOD E DEBUG — ${label} window`);
    console.log('═'.repeat(120));
    console.log(
      `  ${'Type'.padEnd(7)}` +
      `${'Title'.padEnd(38)}` +
      `${'Outc'.padEnd(5)}` +
      `${'Shares'.padStart(10)}` +
      `${'AllTimePnl'.padStart(12)}` +
      `${'P@Start'.padStart(9)}` +
      `${'PreWinGain'.padStart(12)}` +
      `${'InWinPnl'.padStart(12)}` +
      `${'Source'.padStart(14)}`
    );
    console.log(`  ${'─'.repeat(118)}`);

    // Show closed positions first, then open
    const sorted = [...e.debug].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'closed' ? -1 : 1;
      return Math.abs(b.inWindowPnl) - Math.abs(a.inWindowPnl);
    });

    let totalInWindow = 0;
    let lastType = '';
    for (const p of sorted) {
      if (p.type !== lastType && lastType !== '') {
        console.log(`  ${'─'.repeat(118)}`);
      }
      lastType = p.type;
      totalInWindow += p.inWindowPnl;
      console.log(
        `  ${p.type.toUpperCase().padEnd(7)}` +
        `${p.title.slice(0, 37).padEnd(38)}` +
        `${p.outcome.slice(0, 4).padEnd(5)}` +
        `${p.shares.toFixed(1).padStart(10)}` +
        `${('$' + p.allTimePnl.toFixed(0)).padStart(12)}` +
        `${p.priceAtStart !== null ? p.priceAtStart.toFixed(3).padStart(9) : '     N/A'}` +
        `${p.preWindowGain !== null ? ('$' + p.preWindowGain.toFixed(0)).padStart(12) : '         N/A'}` +
        `${((p.inWindowPnl >= 0 ? '+' : '') + '$' + p.inWindowPnl.toFixed(0)).padStart(12)}` +
        `${p.source.padStart(14)}`
      );
    }
    console.log(`  ${'─'.repeat(118)}`);
    console.log(`  TOTAL in-window PnL: $${totalInWindow.toFixed(0)}  (realized=${fmt(e.realizedInWindow)} + unrealized=${fmt(e.unrealizedDelta)})`);
    console.log(`  Poly UI: ${POLY_UI[label] !== null ? '$' + POLY_UI[label] : 'N/A'}  |  Diff: ${POLY_UI[label] !== null ? '$' + (e.pnl - POLY_UI[label]!).toFixed(0) : 'N/A'}`);
  }

  console.log('\n' + '═'.repeat(120) + '\n');
}

main().catch(console.error);
