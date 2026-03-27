/**
 * BTC 5m Price-Based Backtester v2
 *
 * Uses CLOB prices-history + Gamma API resolution data for accurate backtesting.
 *
 * Strategy 1: NAKED CHEAP — Place limit buy at 5c/10c on BOTH sides.
 *   The losing side's price drops to the target → we get filled on the LOSING side.
 *   Profit only if market REVERSES after fill (losing side becomes winner).
 *   Tests at 60s, 120s, 180s windows to see how reversal probability changes.
 *
 * Strategy 2: NAKED EXPENSIVE — Place limit buy at 90c/95c on BOTH sides.
 *   The winning side's price rises to the target → we get filled on the WINNING side.
 *   Profit if market STAYS in same direction (very likely near resolution).
 *   100% trigger rate expected (one side always reaches 90c+).
 *
 * Winner: determined from Gamma API priceToBeat vs finalPrice (ground truth).
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/backtest-price-based.ts --days 1 --budget 100
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
const CONCURRENCY = parseInt(OPT('concurrency', '20'));

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
  finalPrice: number;
  winner: 'Up' | 'Down' | 'Unknown';
}

interface CycleData {
  market: MarketInfo;
  upPrices: PricePoint[];
  downPrices: PricePoint[];
}

interface TradeResult {
  slug: string;
  strategy: string;
  window: number;
  filledSide: string;
  fillPrice: number;
  secsBeforeClose: number;
  secsIntoCandle: number;
  shares: number;
  cost: number;
  pnl: number;
  won: boolean;
  winner: string;
  reversedAfterFill: boolean;
}

function generateSlugs(days: number): string[] {
  const now = Math.floor(Date.now() / 1000);
  const start = now - (days * 24 * 60 * 60);
  const slugs: string[] = [];
  let ts = Math.floor(start / 300) * 300;
  while (ts < now - 600) { // skip last 2 cycles (may not be resolved)
    slugs.push(`btc-updown-5m-${ts}`);
    ts += 300;
  }
  return slugs;
}

async function fetchMarketWithResolution(slug: string): Promise<MarketInfo | null> {
  try {
    const res = await fetch(`${GAMMA_API}/events?slug=${slug}`);
    if (!res.ok) return null;
    const events = await res.json() as any[];
    if (!events?.[0]?.markets?.[0]) return null;

    const event = events[0];
    const market = event.markets[0];
    const meta = event.eventMetadata || {};

    let tokenIds: string[] = [];
    try { tokenIds = JSON.parse(market.clobTokenIds); }
    catch { tokenIds = (market.clobTokenIds || '').split(',').map((s: string) => s.trim()); }

    const cycleOpen = parseInt(slug.match(/btc-updown-5m-(\d+)/)?.[1] || '0');
    const priceToBeat = meta.priceToBeat || 0;
    const finalPrice = meta.finalPrice || 0;

    // Ground truth winner from resolution
    let winner: 'Up' | 'Down' | 'Unknown' = 'Unknown';
    if (finalPrice > 0 && priceToBeat > 0) {
      winner = finalPrice > priceToBeat ? 'Up' : 'Down';
    } else {
      // Fallback: check outcomePrices
      const op = market.outcomePrices;
      if (op === '["1", "0"]' || op === '[1, 0]') winner = 'Up';
      else if (op === '["0", "1"]' || op === '[0, 1]') winner = 'Down';
    }

    return {
      slug, conditionId: market.conditionId,
      upTokenId: tokenIds[0] || '', downTokenId: tokenIds[1] || '',
      cycleOpen, cycleClose: cycleOpen + 300,
      priceToBeat, finalPrice, winner,
    };
  } catch { return null; }
}

async function fetchPriceHistory(tokenId: string, startTs: number, endTs: number): Promise<PricePoint[]> {
  try {
    const res = await fetch(`${CLOB_API}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=1`);
    if (!res.ok) return [];
    const data = await res.json() as { history: PricePoint[] };
    return data.history || [];
  } catch { return []; }
}

// Concurrent fetcher with rate limiting
async function fetchAllCycles(slugs: string[], concurrency: number): Promise<CycleData[]> {
  const cycles: CycleData[] = [];
  let idx = 0;
  let fetched = 0, failed = 0, noData = 0;

  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= slugs.length) break;

      const market = await fetchMarketWithResolution(slugs[i]);
      if (!market || !market.upTokenId || market.winner === 'Unknown') { failed++; continue; }

      // Fetch both price histories in parallel
      const [upPrices, downPrices] = await Promise.all([
        fetchPriceHistory(market.upTokenId, market.cycleOpen, market.cycleClose),
        fetchPriceHistory(market.downTokenId, market.cycleOpen, market.cycleClose),
      ]);

      if (upPrices.length === 0 && downPrices.length === 0) { noData++; continue; }

      cycles.push({ market, upPrices, downPrices });
      fetched++;

      if (fetched % 50 === 0) {
        console.log(`  ${fetched} fetched, ${failed} failed, ${noData} no data (${((i + 1) / slugs.length * 100).toFixed(0)}%)`);
      }
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  console.log(`  Done: ${fetched} cycles, ${failed} failed, ${noData} no data`);
  return cycles.sort((a, b) => a.market.cycleOpen - b.market.cycleOpen);
}

// For a given window (last N seconds), find if a price threshold was reached
function findPriceCrossing(
  prices: PricePoint[],
  threshold: number,
  direction: 'above' | 'below',
  windowStart: number,
  windowEnd: number
): PricePoint | null {
  // Also interpolate: if we have snapshots at t=180 (p=0.20) and t=240 (p=0.05),
  // the price likely crossed 0.10 somewhere between them
  for (const p of prices) {
    if (p.t < windowStart || p.t > windowEnd) continue;
    if (direction === 'above' && p.p >= threshold) return p;
    if (direction === 'below' && p.p <= threshold) return p;
  }
  return null;
}

// Check if price was on the "other side" of 50c before reaching the threshold
// (indicates it was the leading side that then reversed)
function wasLeadingBefore(prices: PricePoint[], fillTime: number, cycleOpen: number): boolean {
  // Was this side's price > 50c at any point before the fill?
  for (const p of prices) {
    if (p.t >= fillTime) break;
    if (p.t >= cycleOpen && p.p > 0.50) return true;
  }
  return false;
}

function simulateCycle(cycle: CycleData, budget: number): TradeResult[] {
  const results: TradeResult[] = [];
  const { market, upPrices, downPrices } = cycle;
  const windows = [60, 120, 180];

  for (const window of windows) {
    const windowStart = market.cycleClose - window;
    const windowEnd = market.cycleClose;

    // ── CHEAP TAIL (5c, 10c) ──
    // Place limit orders at target on BOTH sides
    // The side whose price drops to the target gets filled
    // We're buying the LOSING side cheaply, hoping for reversal
    for (const target of [0.05, 0.10]) {
      const upFill = findPriceCrossing(upPrices, target, 'below', windowStart, windowEnd);
      const downFill = findPriceCrossing(downPrices, target, 'below', windowStart, windowEnd);

      // Take earliest fill
      let fill: { side: string; time: number; price: number } | null = null;
      if (upFill && downFill) {
        fill = upFill.t <= downFill.t
          ? { side: 'Up', time: upFill.t, price: target }
          : { side: 'Down', time: downFill.t, price: target };
      } else if (upFill) {
        fill = { side: 'Up', time: upFill.t, price: target };
      } else if (downFill) {
        fill = { side: 'Down', time: downFill.t, price: target };
      }

      if (fill) {
        const shares = budget / target;
        const won = fill.side === market.winner;
        const pnl = won ? shares - budget : -budget;
        const reversed = won; // if cheap side won, it means market reversed

        results.push({
          slug: market.slug, strategy: `CHEAP_${(target * 100).toFixed(0)}c`,
          window, filledSide: fill.side, fillPrice: target,
          secsBeforeClose: market.cycleClose - fill.time,
          secsIntoCandle: fill.time - market.cycleOpen,
          shares, cost: budget, pnl, won, winner: market.winner,
          reversedAfterFill: reversed,
        });
      }
    }

    // ── EXPENSIVE TAIL (90c, 95c) ──
    // Place limit orders at target on BOTH sides
    // The side whose price rises to the target gets filled
    // We're buying the WINNING side, betting momentum continues
    for (const target of [0.90, 0.95]) {
      const upFill = findPriceCrossing(upPrices, target, 'above', windowStart, windowEnd);
      const downFill = findPriceCrossing(downPrices, target, 'above', windowStart, windowEnd);

      let fill: { side: string; time: number; price: number } | null = null;
      if (upFill && downFill) {
        fill = upFill.t <= downFill.t
          ? { side: 'Up', time: upFill.t, price: target }
          : { side: 'Down', time: downFill.t, price: target };
      } else if (upFill) {
        fill = { side: 'Up', time: upFill.t, price: target };
      } else if (downFill) {
        fill = { side: 'Down', time: downFill.t, price: target };
      }

      if (fill) {
        const shares = budget / target;
        const won = fill.side === market.winner;
        const pnl = won ? shares - budget : -budget;
        const reversed = !won; // if expensive side lost, market reversed

        results.push({
          slug: market.slug, strategy: `EXPENSIVE_${(target * 100).toFixed(0)}c`,
          window, filledSide: fill.side, fillPrice: target,
          secsBeforeClose: market.cycleClose - fill.time,
          secsIntoCandle: fill.time - market.cycleOpen,
          shares, cost: budget, pnl, won, winner: market.winner,
          reversedAfterFill: reversed,
        });
      }
    }
  }

  return results;
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('       BTC 5m PRICE-BASED BACKTESTER v2                       ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Days:           ${DAYS}`);
  console.log(`  Budget/trade:   $${BUDGET}`);
  console.log(`  Concurrency:    ${CONCURRENCY}`);
  console.log(`  Windows:        60s, 120s, 180s`);

  const slugs = generateSlugs(DAYS);
  console.log(`\n[1] Generated ${slugs.length} slugs for ${DAYS} day(s)`);

  console.log(`\n[2] Fetching market data + prices (concurrency=${CONCURRENCY})...`);
  const cycles = await fetchAllCycles(slugs, CONCURRENCY);

  console.log(`\n[3] Simulating strategies on ${cycles.length} cycles...\n`);

  const allResults: TradeResult[] = [];
  for (const cycle of cycles) {
    allResults.push(...simulateCycle(cycle, BUDGET));
  }

  // Group by strategy + window
  const strategyKeys = ['CHEAP_5c', 'CHEAP_10c', 'EXPENSIVE_90c', 'EXPENSIVE_95c'];
  const windows = [60, 120, 180];

  // Reversal analysis first
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       REVERSAL ANALYSIS                                      ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  How often does the leading side at time T differ from the winner?\n');

  for (const window of windows) {
    // For each cycle, check if the leading side at windowStart differs from winner
    let reversals = 0, total = 0;
    for (const cycle of cycles) {
      const windowStart = cycle.market.cycleClose - window;
      const upAtWindow = cycle.upPrices.filter(p => p.t >= windowStart && p.t <= windowStart + 30);
      if (upAtWindow.length === 0) continue;
      total++;
      const leadingSide = upAtWindow[0].p > 0.5 ? 'Up' : 'Down';
      if (leadingSide !== cycle.market.winner) reversals++;
    }
    console.log(`  Last ${window}s: ${reversals}/${total} reversals (${total > 0 ? (reversals / total * 100).toFixed(1) : 0}%)`);
  }

  // Strategy results
  for (const strat of strategyKeys) {
    console.log(`\n═══════════════════════════════════════════════════════════════`);
    console.log(`  ${strat}`);
    console.log(`═══════════════════════════════════════════════════════════════`);

    for (const window of windows) {
      const trades = allResults.filter(r => r.strategy === strat && r.window === window);
      if (trades.length === 0) {
        console.log(`  ${window}s window: No trades triggered`);
        continue;
      }

      const wins = trades.filter(t => t.won);
      const losses = trades.filter(t => !t.won);
      const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
      const totalCost = trades.reduce((s, t) => s + t.cost, 0);
      const winPnl = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
      const lossPnl = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
      const triggerRate = (trades.length / cycles.length * 100).toFixed(0);

      console.log(`\n  ── ${window}s window ──`);
      console.log(`  Triggered: ${trades.length}/${cycles.length} (${triggerRate}%) | Wins: ${wins.length} (${(wins.length / trades.length * 100).toFixed(0)}% WR)`);
      console.log(`  PnL: $${totalPnl.toFixed(0)} | Cost: $${totalCost.toFixed(0)} | ROCE: ${(totalPnl / totalCost * 100).toFixed(1)}%`);
      console.log(`  Avg win: $${winPnl.toFixed(2)} | Avg loss: $${lossPnl.toFixed(2)}`);

      // Show reversals for cheap strategies
      if (strat.startsWith('CHEAP')) {
        const reversals = trades.filter(t => t.reversedAfterFill).length;
        console.log(`  Reversals (cheap side won): ${reversals}/${trades.length} (${(reversals / trades.length * 100).toFixed(1)}%)`);
      }
      if (strat.startsWith('EXPENSIVE')) {
        const held = trades.filter(t => !t.reversedAfterFill).length;
        console.log(`  Momentum held: ${held}/${trades.length} (${(held / trades.length * 100).toFixed(1)}%)`);
      }
    }
  }

  // Summary table
  console.log(`\n\n═══════════════════════════════════════════════════════════════`);
  console.log(`       SUMMARY TABLE                                           `);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`${'Strategy'.padEnd(16)} | ${'Window'.padEnd(6)} | ${'Trades'.padStart(6)} | ${'Wins'.padStart(5)} | ${'WR%'.padStart(5)} | ${'PnL'.padStart(8)} | ${'ROCE%'.padStart(7)}`);
  console.log(`${'─'.repeat(16)} | ${'─'.repeat(6)} | ${'─'.repeat(6)} | ${'─'.repeat(5)} | ${'─'.repeat(5)} | ${'─'.repeat(8)} | ${'─'.repeat(7)}`);

  for (const strat of strategyKeys) {
    for (const window of windows) {
      const trades = allResults.filter(r => r.strategy === strat && r.window === window);
      if (trades.length === 0) continue;
      const wins = trades.filter(t => t.won);
      const pnl = trades.reduce((s, t) => s + t.pnl, 0);
      const cost = trades.reduce((s, t) => s + t.cost, 0);
      console.log(
        `${strat.padEnd(16)} | ${(window + 's').padEnd(6)} | ${String(trades.length).padStart(6)} | ${String(wins.length).padStart(5)} | ${(wins.length / trades.length * 100).toFixed(0).padStart(4)}% | $${pnl.toFixed(0).padStart(7)} | ${(pnl / cost * 100).toFixed(1).padStart(6)}%`
      );
    }
  }

  console.log(`\n  Total cycles: ${cycles.length} | BTC price range: $${Math.min(...cycles.map(c => c.market.priceToBeat)).toFixed(0)} - $${Math.max(...cycles.map(c => c.market.priceToBeat)).toFixed(0)}`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
