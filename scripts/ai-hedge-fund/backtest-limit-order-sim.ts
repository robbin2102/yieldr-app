/**
 * BTC 5m Limit Order Strategy Simulator
 *
 * Simulates limit order strategies using CLOB price snapshots + Gamma API winner data.
 *
 * Key insight: We only get ~5 price snapshots per 5m cycle (every ~60s), so we can't
 * see the exact moment a price like 90c was hit. Instead we use OBSERVED prices as
 * TRIGGERS and assume a limit order at a (potentially higher/lower) price would have
 * been filled if the trigger was observed.
 *
 * Strategies:
 *   EXPENSIVE (momentum): Buy the side whose price is rising. If it wins, profit.
 *   CHEAP (contrarian): Buy the side whose price is falling. Profit only on reversal.
 *
 * For each cycle, limit orders are placed on BOTH sides (Up and Down). The side that
 * first reaches the trigger price gets filled; the other side is cancelled.
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/backtest-limit-order-sim.ts --days 1 --budget 100
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

const WINDOWS = [60, 120, 180];

// ── Types ──────────────────────────────────────────────────────────────────────

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

interface StrategyConfig {
  name: string;
  triggerPrice: number;     // price that must be observed in snapshot
  fillPrice: number;        // assumed limit order fill price
  direction: 'expensive' | 'cheap';  // expensive = buy winning side, cheap = buy losing side
}

interface TradeResult {
  slug: string;
  strategy: string;
  window: number;
  triggered: boolean;
  filledSide: string;
  fillPrice: number;
  triggerTime: number;
  secsBeforeClose: number;
  won: boolean;
  pnl: number;
  winner: string;
  reversedAfterTrigger: boolean;
}

// ── Strategy definitions ───────────────────────────────────────────────────────

const strategies: StrategyConfig[] = [
  // Expensive strategies (buy the side going UP in price)
  { name: 'EXP_trigger80_fill90', triggerPrice: 0.80, fillPrice: 0.90, direction: 'expensive' },
  { name: 'EXP_trigger85_fill90', triggerPrice: 0.85, fillPrice: 0.90, direction: 'expensive' },
  { name: 'EXP_trigger80_fill80', triggerPrice: 0.80, fillPrice: 0.80, direction: 'expensive' },
  { name: 'EXP_trigger85_fill85', triggerPrice: 0.85, fillPrice: 0.85, direction: 'expensive' },
  // Cheap strategies (buy the side going DOWN in price)
  { name: 'CHEAP_trigger20_fill10', triggerPrice: 0.20, fillPrice: 0.10, direction: 'cheap' },
  { name: 'CHEAP_trigger15_fill10', triggerPrice: 0.15, fillPrice: 0.10, direction: 'cheap' },
  { name: 'CHEAP_trigger20_fill20', triggerPrice: 0.20, fillPrice: 0.20, direction: 'cheap' },
  { name: 'CHEAP_trigger15_fill15', triggerPrice: 0.15, fillPrice: 0.15, direction: 'cheap' },
];

// ── Slug generation ────────────────────────────────────────────────────────────

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

// ── API fetchers (copied from backtest-snapshot-based.ts) ──────────────────────

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

// Concurrent fetcher with worker pool
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

// ── Simulation logic ───────────────────────────────────────────────────────────

/**
 * For a given side's price snapshots within a window, find the earliest snapshot
 * that meets the trigger condition.
 *
 * - expensive direction: price >= triggerPrice (price rising toward 1.0)
 * - cheap direction: price <= triggerPrice (price falling toward 0.0)
 */
function findTrigger(
  prices: PricePoint[],
  triggerPrice: number,
  direction: 'expensive' | 'cheap',
  windowStart: number,
  windowEnd: number,
): PricePoint | null {
  for (const p of prices) {
    if (p.t < windowStart || p.t > windowEnd) continue;
    if (direction === 'expensive' && p.p >= triggerPrice) return p;
    if (direction === 'cheap' && p.p <= triggerPrice) return p;
  }
  return null;
}

function simulateCycle(cycle: CycleData, budget: number): TradeResult[] {
  const results: TradeResult[] = [];
  const { market, upPrices, downPrices } = cycle;

  for (const strat of strategies) {
    for (const window of WINDOWS) {
      const windowStart = market.cycleClose - window;
      const windowEnd = market.cycleClose;

      // Check both sides for trigger
      const upTrigger = findTrigger(upPrices, strat.triggerPrice, strat.direction, windowStart, windowEnd);
      const downTrigger = findTrigger(downPrices, strat.triggerPrice, strat.direction, windowStart, windowEnd);

      // Take the earliest trigger — that side gets filled, other side cancelled
      let fill: { side: 'Up' | 'Down'; time: number } | null = null;
      if (upTrigger && downTrigger) {
        fill = upTrigger.t <= downTrigger.t
          ? { side: 'Up', time: upTrigger.t }
          : { side: 'Down', time: downTrigger.t };
      } else if (upTrigger) {
        fill = { side: 'Up', time: upTrigger.t };
      } else if (downTrigger) {
        fill = { side: 'Down', time: downTrigger.t };
      }

      if (!fill) {
        // Not triggered — record for counting purposes
        results.push({
          slug: market.slug, strategy: strat.name, window,
          triggered: false, filledSide: '', fillPrice: strat.fillPrice,
          triggerTime: 0, secsBeforeClose: 0,
          won: false, pnl: 0, winner: market.winner,
          reversedAfterTrigger: false,
        });
        continue;
      }

      const won = fill.side === market.winner;

      // PnL calculation:
      // Buy shares at fillPrice. If won, each share pays $1. If lost, shares worth $0.
      const shares = budget / strat.fillPrice;
      const pnl = won ? (shares * 1.0 - budget) : -budget;

      // Reversal analysis:
      // For expensive: trigger means price was high on that side. Reversal = that side lost.
      // For cheap: trigger means price was low on that side. Reversal = that side won (it recovered).
      const reversedAfterTrigger = strat.direction === 'expensive' ? !won : won;

      results.push({
        slug: market.slug, strategy: strat.name, window,
        triggered: true, filledSide: fill.side, fillPrice: strat.fillPrice,
        triggerTime: fill.time, secsBeforeClose: market.cycleClose - fill.time,
        won, pnl, winner: market.winner,
        reversedAfterTrigger,
      });
    }
  }

  return results;
}

// ── Output formatting ──────────────────────────────────────────────────────────

function printSummaryTable(allResults: TradeResult[], totalCycles: number) {
  const hdr = [
    'Strategy'.padEnd(25),
    'Window'.padEnd(8),
    'Cycles'.padStart(6),
    'Triggered'.padStart(9),
    'Wins'.padStart(6),
    'WR%'.padStart(6),
    'PnL'.padStart(10),
    'ROCE%'.padStart(8),
    '$/cycle'.padStart(8),
  ].join(' | ');

  const sep = [
    '\u2500'.repeat(25),
    '\u2500'.repeat(8),
    '\u2500'.repeat(6),
    '\u2500'.repeat(9),
    '\u2500'.repeat(6),
    '\u2500'.repeat(6),
    '\u2500'.repeat(10),
    '\u2500'.repeat(8),
    '\u2500'.repeat(8),
  ].join('\u2500|\u2500');

  console.log(hdr);
  console.log(sep);

  for (const strat of strategies) {
    for (const window of WINDOWS) {
      const trades = allResults.filter(r => r.strategy === strat.name && r.window === window);
      const triggered = trades.filter(r => r.triggered);
      const wins = triggered.filter(r => r.won);
      const totalPnl = triggered.reduce((s, t) => s + t.pnl, 0);
      const totalCost = triggered.length * BUDGET;
      const wr = triggered.length > 0 ? (wins.length / triggered.length * 100) : 0;
      const roce = totalCost > 0 ? (totalPnl / totalCost * 100) : 0;
      const perCycle = totalCycles > 0 ? (totalPnl / totalCycles) : 0;

      console.log([
        strat.name.padEnd(25),
        (window + 's').padEnd(8),
        String(totalCycles).padStart(6),
        String(triggered.length).padStart(9),
        String(wins.length).padStart(6),
        (wr.toFixed(0) + '%').padStart(6),
        ('$' + totalPnl.toFixed(0)).padStart(10),
        (roce.toFixed(1) + '%').padStart(8),
        ('$' + perCycle.toFixed(1)).padStart(8),
      ].join(' | '));
    }
  }
}

function printReversalAnalysis(allResults: TradeResult[]) {
  console.log('\n  Per-strategy reversal rates (of triggered cycles, how many reversed after trigger?):\n');

  for (const strat of strategies) {
    console.log(`  ${strat.name}:`);
    for (const window of WINDOWS) {
      const triggered = allResults.filter(r => r.strategy === strat.name && r.window === window && r.triggered);
      const reversed = triggered.filter(r => r.reversedAfterTrigger);
      const rate = triggered.length > 0 ? (reversed.length / triggered.length * 100).toFixed(1) : '0.0';
      console.log(`    ${window}s: ${reversed.length}/${triggered.length} reversed (${rate}%)`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('       BTC 5m LIMIT ORDER STRATEGY SIMULATOR');
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log(`  Days:           ${DAYS}`);
  console.log(`  Budget/trade:   $${BUDGET}`);
  console.log(`  Concurrency:    ${CONCURRENCY}`);
  console.log(`  Windows:        ${WINDOWS.join('s, ')}s`);
  console.log(`  Strategies:     ${strategies.length} (${strategies.filter(s => s.direction === 'expensive').length} expensive, ${strategies.filter(s => s.direction === 'cheap').length} cheap)`);
  console.log('');
  console.log('  Design: observed prices as TRIGGERS, assumed limit fills at configured price.');
  console.log('  Limit orders placed on BOTH sides; first trigger wins, other cancelled.');

  const slugs = generateSlugs(DAYS);
  console.log(`\n[1] Generated ${slugs.length} slugs for ${DAYS} day(s)`);

  console.log(`\n[2] Fetching market data + prices (concurrency=${CONCURRENCY})...`);
  const cycles = await fetchAllCycles(slugs, CONCURRENCY);

  console.log(`\n[3] Simulating ${strategies.length} strategies x ${WINDOWS.length} windows on ${cycles.length} cycles...\n`);

  const allResults: TradeResult[] = [];
  for (const cycle of cycles) {
    allResults.push(...simulateCycle(cycle, BUDGET));
  }

  // ── Summary Table ──
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('       SUMMARY TABLE');
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');
  printSummaryTable(allResults, cycles.length);

  // ── Reversal Analysis ──
  console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('       REVERSAL ANALYSIS');
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  printReversalAnalysis(allResults);

  // ── Per-strategy detail ──
  for (const strat of strategies) {
    console.log(`\n\u2500\u2500 ${strat.name} (${strat.direction}) \u2500\u2500`);
    console.log(`  Trigger: observe ${strat.triggerPrice} -> fill at ${strat.fillPrice}`);

    for (const window of WINDOWS) {
      const trades = allResults.filter(r => r.strategy === strat.name && r.window === window);
      const triggered = trades.filter(r => r.triggered);
      const wins = triggered.filter(r => r.won);
      const losses = triggered.filter(r => !r.won);
      const totalPnl = triggered.reduce((s, t) => s + t.pnl, 0);
      const totalCost = triggered.length * BUDGET;
      const triggerRate = (triggered.length / cycles.length * 100).toFixed(0);
      const wr = triggered.length > 0 ? (wins.length / triggered.length * 100).toFixed(0) : '0';

      const avgWinPnl = wins.length > 0 ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length) : 0;
      const avgLossPnl = losses.length > 0 ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;

      console.log(`  ${window}s: Triggered ${triggered.length}/${cycles.length} (${triggerRate}%) | Wins ${wins.length} (${wr}% WR) | PnL $${totalPnl.toFixed(0)} | ROCE ${totalCost > 0 ? (totalPnl / totalCost * 100).toFixed(1) : '0.0'}%`);
      console.log(`        Avg win: $${avgWinPnl.toFixed(2)} | Avg loss: $${avgLossPnl.toFixed(2)}`);
    }
  }

  // ── Footer ──
  console.log(`\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
  console.log(`  Total cycles: ${cycles.length}`);
  if (cycles.length > 0) {
    console.log(`  BTC price range: $${Math.min(...cycles.map(c => c.market.priceToBeat)).toFixed(0)} - $${Math.max(...cycles.map(c => c.market.priceToBeat)).toFixed(0)}`);
  }
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
