/**
 * PnL Method Comparison — A vs B vs F (combined)
 *
 *   Method A — Positions-based:
 *     realized  = sum(closedPosition.realizedPnl where close_timestamp in window)
 *     unrealized = sum(openPosition.cashPnl)  ← all-time, not delta → overstates short windows
 *
 *   Method B — Cash-flow window (current profiler):
 *     PnL = sells + redeems + endingValue - buys  (activities in window only)
 *     Problem: redeems from pre-window positions inflate short windows massively
 *
 *   Method F — Combined (proposed fix):
 *     realized  = Method A realized (closedPositions by timestamp) — same for all windows
 *     unrealized:
 *       1d / 7d  → CLOB delta: size × (curPrice − price_N_days_ago)   [accurate]
 *       30d / all → full cashPnl                                        [CLOB stale for resolved markets]
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/compare-pnl-methods.ts <wallet> [1d_ui] [7d_ui] [30d_ui] [all_ui]
 *
 * Examples:
 *   npx tsx scripts/ai-hedge-fund/compare-pnl-methods.ts 0xabc...
 *   npx tsx scripts/ai-hedge-fund/compare-pnl-methods.ts 0xabc... 264 576 12868 38077
 */

const DATA_API  = 'https://data-api.polymarket.com';
const CLOB_API  = 'https://clob.polymarket.com';
const wallet = process.argv[2];

if (!wallet) {
  console.error('Usage: npx tsx scripts/ai-hedge-fund/compare-pnl-methods.ts <wallet>');
  process.exit(1);
}

// Optional Poly UI reference values — pass as CLI args, or leave null
const POLY_UI: Record<string, number | null> = {
  '1d':  process.argv[3] ? Number(process.argv[3]) : null,
  '7d':  process.argv[4] ? Number(process.argv[4]) : null,
  '30d': process.argv[5] ? Number(process.argv[5]) : null,
  'all': process.argv[6] ? Number(process.argv[6]) : null,
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

  // Pre-compute Method E for 1d and 7d only (CLOB delta unrealized)
  console.log('Computing Method F (combined: A realized + CLOB unrealized for 1d/7d)...');
  const eResults: Record<string, Awaited<ReturnType<typeof methodE>>> = {};
  for (const { label, days } of frames) {
    eResults[label] = await methodE(closed, open, activities, days);
    await sleep(50);
  }

  // Method F: A realized + CLOB unrealized for 1d/7d, A unrealized for 30d/all
  function methodF(label: string) {
    const e = eResults[label];
    const a = methodA(closed, open, label === 'all' ? null : Number(label.replace('d', '')));
    // 1d/7d: use CLOB delta unrealized from Method E
    // 30d/all: use full cashPnl (CLOB stale for resolved markets)
    if (label === '1d' || label === '7d') {
      return { pnl: e.realizedInWindow + e.unrealizedDelta, realized: e.realizedInWindow, unrealized: e.unrealizedDelta, note: 'A-realized + CLOB-delta' };
    }
    return { pnl: a.realized + a.unrealized, realized: a.realized, unrealized: a.unrealized, note: 'Method A (CLOB stale)' };
  }

  // ── Comparison table ──────────────────────────────────────────────────────
  const pad = (s: string | number, w = 12) => String(s).padStart(w);
  const fmt = (n: number) => `$${n.toFixed(0)}`;
  const fmtDiff = (d: number | null, w = 12) =>
    d === null ? 'N/A'.padStart(w) : (d >= 0 ? `+${fmt(d)}` : fmt(d)).padStart(w);

  console.log('\n' + '═'.repeat(96));
  console.log('  PnL COMPARISON TABLE');
  console.log('═'.repeat(96));
  console.log(
    `  ${'Frame'.padEnd(6)}` +
    `${'Method A'.padStart(12)}` +
    `${'Method B'.padStart(12)}` +
    `${'Method F'.padStart(12)}` +
    `${'Poly UI'.padStart(12)}` +
    `${'A-UI'.padStart(12)}` +
    `${'F-UI'.padStart(12)}`
  );
  console.log(
    `  ${''.padEnd(6)}` +
    `${'(positions)'.padStart(12)}` +
    `${'(cashflow)'.padStart(12)}` +
    `${'(combined)'.padStart(12)}` +
    `${'(ref)'.padStart(12)}` +
    `${''.padStart(12)}` +
    `${''.padStart(12)}`
  );
  console.log('  ' + '─'.repeat(94));

  for (const { label, days } of frames) {
    const a  = methodA(closed, open, days);
    const b  = methodB(activities, open, days);
    const f  = methodF(label);
    const ui = POLY_UI[label];
    console.log(
      `  ${label.padEnd(6)}` +
      `${pad(fmt(a.pnl))}` +
      `${pad(fmt(b.pnl))}` +
      `${pad(fmt(f.pnl))}` +
      `${pad(ui !== null ? fmt(ui) : 'N/A')}` +
      `${fmtDiff(ui !== null ? a.pnl - ui : null)}` +
      `${fmtDiff(ui !== null ? f.pnl - ui : null)}`
    );
  }
  console.log('  ' + '─'.repeat(94));
  console.log('  Method F: 1d/7d = A-realized + CLOB-delta-unrealized | 30d/all = Method A\n');

  // ── Method F detail ────────────────────────────────────────────────────────
  console.log('═'.repeat(96));
  console.log('  METHOD F BREAKDOWN');
  console.log('═'.repeat(96));
  for (const { label } of frames) {
    const f = methodF(label);
    const e = eResults[label];
    console.log(
      `  ${label.padEnd(5)} ` +
      `realized=${fmt(f.realized).padStart(10)}  ` +
      `unrealized=${fmt(f.unrealized).padStart(10)}  ` +
      `→ PnL=${fmt(f.pnl).padStart(10)}` +
      `  [${e.closedCount} closed + ${e.openCount} open]` +
      `  (${f.note})`
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
