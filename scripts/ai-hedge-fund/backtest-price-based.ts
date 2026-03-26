/**
 * BTC 5m Price-Based Backtester
 *
 * Uses CLOB prices-history API to get actual market prices for every 5m cycle,
 * then simulates tail strategies with real price data.
 *
 * Strategy 1: NAKED CHEAP TAIL — Buy the losing side at 5c or 10c
 * Strategy 2: NAKED EXPENSIVE TAIL — Buy the winning side at 90c or 95c
 *
 * For each cycle, places limit orders on BOTH sides. The side that reaches
 * the target price first gets filled. Winner is determined from final price.
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/backtest-price-based.ts [options]
 *
 * Options:
 *   --days N          Days to backtest (default: 1, max 3)
 *   --budget N        USDC per trade (default: 100)
 *   --cheap5          Enable 5c cheap tail (default: on)
 *   --cheap10         Enable 10c cheap tail (default: on)
 *   --exp90           Enable 90c expensive tail (default: on)
 *   --exp95           Enable 95c expensive tail (default: on)
 *   --window N        Entry window in seconds before close (default: 120)
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

const ARGS = process.argv.slice(2);
const OPT = (name: string, fallback: string): string => {
  const idx = ARGS.indexOf(`--${name}`);
  return idx !== -1 && ARGS[idx + 1] ? ARGS[idx + 1] : fallback;
};

const DAYS = parseInt(OPT('days', '1'));
const BUDGET = parseFloat(OPT('budget', '100'));
const ENTRY_WINDOW = parseInt(OPT('window', '120'));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface PricePoint { t: number; p: number; }

interface MarketInfo {
  slug: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  cycleOpen: number;
  cycleClose: number;
  priceToBeat: number;
}

interface CycleData {
  market: MarketInfo;
  upPrices: PricePoint[];
  downPrices: PricePoint[];
  winner: 'Up' | 'Down' | 'Unknown';
  lastUpPrice: number;
  lastDownPrice: number;
}

interface TradeResult {
  slug: string;
  strategy: string;
  targetPrice: number;
  filledSide: string;
  fillPrice: number;
  fillTime: number;       // seconds into cycle
  secsBeforeClose: number;
  shares: number;
  cost: number;
  pnl: number;
  won: boolean;
  winner: string;
}

// Generate slugs for N days ending now
function generateSlugs(days: number): string[] {
  const now = Math.floor(Date.now() / 1000);
  const start = now - (days * 24 * 60 * 60);
  const slugs: string[] = [];

  // Round start down to nearest 300s boundary
  let ts = Math.floor(start / 300) * 300;
  while (ts < now - 300) { // skip the most recent (may not be resolved)
    slugs.push(`btc-updown-5m-${ts}`);
    ts += 300;
  }
  return slugs;
}

// Fetch market info from Gamma API
async function fetchMarket(slug: string): Promise<MarketInfo | null> {
  try {
    const res = await fetch(`${GAMMA_API}/events?slug=${slug}`);
    if (!res.ok) return null;
    const events = await res.json() as any[];
    if (!events?.[0]?.markets?.[0]) return null;

    const event = events[0];
    const market = event.markets[0];

    let tokenIds: string[] = [];
    try { tokenIds = JSON.parse(market.clobTokenIds); }
    catch { tokenIds = (market.clobTokenIds || '').split(',').map((s: string) => s.trim()); }

    const cycleOpen = parseInt(slug.match(/btc-updown-5m-(\d+)/)?.[1] || '0');

    return {
      slug,
      conditionId: market.conditionId,
      upTokenId: tokenIds[0] || '',
      downTokenId: tokenIds[1] || '',
      cycleOpen,
      cycleClose: cycleOpen + 300,
      priceToBeat: event.eventMetadata?.priceToBeat || 0,
    };
  } catch {
    return null;
  }
}

// Fetch price history from CLOB API
async function fetchPriceHistory(tokenId: string, startTs: number, endTs: number): Promise<PricePoint[]> {
  try {
    const url = `${CLOB_API}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=1`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as { history: PricePoint[] };
    return data.history || [];
  } catch {
    return [];
  }
}

// Determine winner from last price points
function determineWinner(upPrices: PricePoint[], downPrices: PricePoint[]): 'Up' | 'Down' | 'Unknown' {
  const lastUp = upPrices.length > 0 ? upPrices[upPrices.length - 1].p : 0.5;
  const lastDown = downPrices.length > 0 ? downPrices[downPrices.length - 1].p : 0.5;

  if (lastUp > 0.7) return 'Up';
  if (lastDown > 0.7) return 'Down';
  if (lastUp > lastDown) return 'Up';
  if (lastDown > lastUp) return 'Down';
  return 'Unknown';
}

// Find the first price point at or beyond target within the entry window
function findFillInWindow(prices: PricePoint[], targetPrice: number, direction: 'above' | 'below', windowStart: number, windowEnd: number): PricePoint | null {
  for (const p of prices) {
    if (p.t < windowStart || p.t > windowEnd) continue;
    if (direction === 'above' && p.p >= targetPrice) return p;
    if (direction === 'below' && p.p <= targetPrice) return p;
  }
  return null;
}

// Simulate strategies for one cycle
function simulateCycle(cycle: CycleData, budget: number, entryWindow: number): TradeResult[] {
  const results: TradeResult[] = [];
  if (cycle.winner === 'Unknown') return results;

  const windowStart = cycle.market.cycleClose - entryWindow;
  const windowEnd = cycle.market.cycleClose;

  // Combine all price points for timeline reference
  const allUp = cycle.upPrices.filter(p => p.t >= windowStart && p.t <= windowEnd);
  const allDown = cycle.downPrices.filter(p => p.t >= windowStart && p.t <= windowEnd);

  // Strategy: NAKED CHEAP at target (5c or 10c)
  // We place limit orders on BOTH sides at the cheap price
  // The side whose price drops to the target gets filled
  for (const targetPrice of [0.05, 0.10]) {
    // Check if Up price drops to target (meaning Down is winning, Up is cheap)
    const upCheapFill = findFillInWindow(cycle.upPrices, targetPrice, 'below', windowStart, windowEnd);
    // Check if Down price drops to target
    const downCheapFill = findFillInWindow(cycle.downPrices, targetPrice, 'below', windowStart, windowEnd);

    // Take whichever fills first (earliest timestamp)
    let fill: { side: string; price: number; time: number } | null = null;
    if (upCheapFill && downCheapFill) {
      fill = upCheapFill.t <= downCheapFill.t
        ? { side: 'Up', price: upCheapFill.p, time: upCheapFill.t }
        : { side: 'Down', price: downCheapFill.p, time: downCheapFill.t };
    } else if (upCheapFill) {
      fill = { side: 'Up', price: upCheapFill.p, time: upCheapFill.t };
    } else if (downCheapFill) {
      fill = { side: 'Down', price: downCheapFill.p, time: downCheapFill.t };
    }

    if (fill) {
      const shares = budget / targetPrice; // buy at our limit price, not market
      const won = fill.side === cycle.winner;
      const pnl = won ? shares - budget : -budget;

      results.push({
        slug: cycle.market.slug,
        strategy: `CHEAP_${(targetPrice * 100).toFixed(0)}c`,
        targetPrice,
        filledSide: fill.side,
        fillPrice: fill.price,
        fillTime: fill.time - cycle.market.cycleOpen,
        secsBeforeClose: cycle.market.cycleClose - fill.time,
        shares,
        cost: budget,
        pnl,
        won,
        winner: cycle.winner,
      });
    }
  }

  // Strategy: NAKED EXPENSIVE at target (90c or 95c)
  // Place limit orders on BOTH sides at the expensive price
  // The side whose price rises to the target gets filled
  for (const targetPrice of [0.90, 0.95]) {
    const upExpFill = findFillInWindow(cycle.upPrices, targetPrice, 'above', windowStart, windowEnd);
    const downExpFill = findFillInWindow(cycle.downPrices, targetPrice, 'above', windowStart, windowEnd);

    let fill: { side: string; price: number; time: number } | null = null;
    if (upExpFill && downExpFill) {
      fill = upExpFill.t <= downExpFill.t
        ? { side: 'Up', price: upExpFill.p, time: upExpFill.t }
        : { side: 'Down', price: downExpFill.p, time: downExpFill.t };
    } else if (upExpFill) {
      fill = { side: 'Up', price: upExpFill.p, time: upExpFill.t };
    } else if (downExpFill) {
      fill = { side: 'Down', price: downExpFill.p, time: downExpFill.t };
    }

    if (fill) {
      const shares = budget / targetPrice;
      const won = fill.side === cycle.winner;
      const pnl = won ? shares - budget : -budget;

      results.push({
        slug: cycle.market.slug,
        strategy: `EXPENSIVE_${(targetPrice * 100).toFixed(0)}c`,
        targetPrice,
        filledSide: fill.side,
        fillPrice: fill.price,
        fillTime: fill.time - cycle.market.cycleOpen,
        secsBeforeClose: cycle.market.cycleClose - fill.time,
        shares,
        cost: budget,
        pnl,
        won,
        winner: cycle.winner,
      });
    }
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('       BTC 5m PRICE-BASED BACKTESTER                          ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Days:           ${DAYS}`);
  console.log(`  Budget/trade:   $${BUDGET}`);
  console.log(`  Entry window:   ${ENTRY_WINDOW}s before close`);

  // 1. Generate slugs
  const slugs = generateSlugs(DAYS);
  console.log(`\n[1] Generated ${slugs.length} slugs for ${DAYS} day(s)`);

  // 2. Fetch market data + price history for each
  console.log(`\n[2] Fetching market data + prices (this takes ~${Math.ceil(slugs.length * 0.9 / 60)} minutes)...`);

  const cycles: CycleData[] = [];
  let fetched = 0, failed = 0, noData = 0;

  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    const market = await fetchMarket(slug);
    await sleep(200);

    if (!market || !market.upTokenId) { failed++; continue; }

    const upPrices = await fetchPriceHistory(market.upTokenId, market.cycleOpen, market.cycleClose);
    await sleep(100);
    const downPrices = await fetchPriceHistory(market.downTokenId, market.cycleOpen, market.cycleClose);
    await sleep(100);

    if (upPrices.length === 0 && downPrices.length === 0) { noData++; continue; }

    const winner = determineWinner(upPrices, downPrices);
    const lastUpPrice = upPrices.length > 0 ? upPrices[upPrices.length - 1].p : 0;
    const lastDownPrice = downPrices.length > 0 ? downPrices[downPrices.length - 1].p : 0;

    cycles.push({ market, upPrices, downPrices, winner, lastUpPrice, lastDownPrice });
    fetched++;

    if ((i + 1) % 20 === 0) {
      const pct = ((i + 1) / slugs.length * 100).toFixed(0);
      console.log(`  [${i + 1}/${slugs.length}] ${pct}% | ${fetched} fetched, ${failed} failed, ${noData} no data`);
    }
  }

  console.log(`\n  Total: ${fetched} cycles with price data, ${failed} failed, ${noData} no price data`);
  const knownCycles = cycles.filter(c => c.winner !== 'Unknown');
  console.log(`  Known winner: ${knownCycles.length}/${cycles.length}`);

  // 3. Run backtests
  console.log(`\n[3] Simulating strategies on ${knownCycles.length} cycles...\n`);

  const allResults: TradeResult[] = [];
  for (const cycle of knownCycles) {
    const results = simulateCycle(cycle, BUDGET, ENTRY_WINDOW);
    allResults.push(...results);
  }

  // 4. Group and display results by strategy
  const strategies = ['CHEAP_5c', 'CHEAP_10c', 'EXPENSIVE_90c', 'EXPENSIVE_95c'];

  for (const strat of strategies) {
    const trades = allResults.filter(r => r.strategy === strat);
    if (trades.length === 0) {
      console.log(`═══ ${strat}: No trades triggered ═══\n`);
      continue;
    }

    const wins = trades.filter(t => t.won);
    const losses = trades.filter(t => !t.won);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const totalCost = trades.reduce((s, t) => s + t.cost, 0);
    const avgSecsBeforeClose = trades.reduce((s, t) => s + t.secsBeforeClose, 0) / trades.length;
    const winPnl = wins.reduce((s, t) => s + t.pnl, 0);
    const lossPnl = losses.reduce((s, t) => s + t.pnl, 0);

    console.log(`═══════════════════════════════════════════════════════════════`);
    console.log(`  ${strat} — ${ENTRY_WINDOW}s window`);
    console.log(`═══════════════════════════════════════════════════════════════`);
    console.log(`  Cycles: ${knownCycles.length} | Triggered: ${trades.length} (${(trades.length / knownCycles.length * 100).toFixed(0)}%)`);
    console.log(`  Wins: ${wins.length}/${trades.length} (${(wins.length / trades.length * 100).toFixed(0)}% WR)`);
    console.log(`  Total PnL: $${totalPnl.toFixed(2)} | Cost: $${totalCost.toFixed(0)} | ROCE: ${(totalPnl / totalCost * 100).toFixed(1)}%`);
    console.log(`  Avg win: $${wins.length > 0 ? (winPnl / wins.length).toFixed(2) : '0'} | Avg loss: $${losses.length > 0 ? (lossPnl / losses.length).toFixed(2) : '0'}`);
    console.log(`  Avg secs before close: ${avgSecsBeforeClose.toFixed(0)}s`);

    // Show per-trade detail (first 15 + last 5)
    const show = trades.length <= 20 ? trades : [...trades.slice(0, 15), ...trades.slice(-5)];
    console.log('');
    for (let i = 0; i < show.length; i++) {
      const t = show[i];
      if (i === 15 && trades.length > 20) console.log(`  ... (${trades.length - 20} more trades) ...`);
      const time = new Date(t.fillTime * 1000 + new Date().getTimezoneOffset() * 60000);
      console.log(`  ${t.slug.slice(-10)} | ${t.filledSide.padEnd(4)} @${(t.fillPrice * 100).toFixed(0)}c | -${t.secsBeforeClose}s | ${t.won ? '✓' : '✗'} $${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(0)} | winner=${t.winner}`);
    }
    console.log('');
  }

  // 5. Summary
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       SUMMARY                                                ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Cycles analyzed: ${knownCycles.length}`);
  for (const strat of strategies) {
    const trades = allResults.filter(r => r.strategy === strat);
    const wins = trades.filter(t => t.won);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${strat.padEnd(16)}: ${String(trades.length).padStart(4)} trades | ${String(wins.length).padStart(4)} wins (${trades.length > 0 ? (wins.length / trades.length * 100).toFixed(0) : '0'}%) | PnL $${totalPnl.toFixed(0)}`);
  }
  const grandTotal = allResults.reduce((s, t) => s + t.pnl, 0);
  console.log(`  ${'TOTAL'.padEnd(16)}: ${String(allResults.length).padStart(4)} trades | PnL $${grandTotal.toFixed(0)}`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
