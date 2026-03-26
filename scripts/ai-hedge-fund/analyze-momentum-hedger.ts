/**
 * Momentum Hedger Model Reverse-Engineering
 *
 * Reconstructs each 5m cycle position-by-position to surface:
 * - Entry mechanics (when does betting start, which side first?)
 * - Dynamic balancing (how does asymmetry shift with momentum?)
 * - Scenario classification: MOMENTUM / NO_MOMENTUM / REVERSAL
 * - Size scaling logic (how much increases per trade?)
 * - P&L mechanics per scenario
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/analyze-momentum-hedger.ts <activity_json_file>
 *   npx tsx scripts/ai-hedge-fund/analyze-momentum-hedger.ts scripts/ai-hedge-fund/btc5m_trader_5k.json
 */

import fs from 'fs';

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
  size?: number; // shares
}

interface TradeEvent {
  relSec: number;        // seconds since cycle start (market open)
  side: string;          // 'Up' or 'Down'
  price: number;
  usdc: number;
  shares: number;
  // Running state after this trade
  upUsdc: number;
  downUsdc: number;
  upShares: number;
  downShares: number;
  asymmetry: number;     // (upUsdc - downUsdc) / (upUsdc + downUsdc) — positive = favoring Up
  totalDeployed: number;
}

interface CycleAnalysis {
  title: string;
  slug: string;
  cycleStartTs: number;   // market open timestamp (from slug)
  cycleEndTs: number;      // market close (startTs + 300)
  trades: TradeEvent[];
  // Summary
  totalTrades: number;
  upTrades: number;
  downTrades: number;
  upUsdc: number;
  downUsdc: number;
  upShares: number;
  downShares: number;
  totalDeployed: number;
  redeemUsdc: number;
  netPnl: number;
  // Asymmetry tracking
  initialSide: string;     // first trade side
  initialAsymmetry: number;  // asymmetry after first 10 seconds
  peakAsymmetry: number;
  finalAsymmetry: number;
  // Timing
  firstTradeRelSec: number;
  lastTradeRelSec: number;
  tradingSpanSec: number;
  // Scenario
  scenario: 'MOMENTUM' | 'NO_MOMENTUM' | 'REVERSAL' | 'UNKNOWN';
  wonSide: string;         // which side redeemed (from closed positions or inferred)
  favoredSide: string;     // which side had more USDC
  directionCorrect: boolean;
  // Phase analysis
  phases: PhaseInfo[];
}

interface PhaseInfo {
  startSec: number;
  endSec: number;
  trades: number;
  upUsdc: number;
  downUsdc: number;
  dominantSide: string;
  asymmetryStart: number;
  asymmetryEnd: number;
  description: string;
}

// Parse cycle start timestamp from slug: btc-updown-5m-{unix_ts}
function parseCycleStartFromSlug(slug: string): number {
  const match = slug?.match(/btc-updown-5m-(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

// Classify scenario based on asymmetry trajectory
function classifyScenario(trades: TradeEvent[], finalAsymmetry: number, directionCorrect: boolean): 'MOMENTUM' | 'NO_MOMENTUM' | 'REVERSAL' | 'UNKNOWN' {
  if (trades.length < 5) return 'UNKNOWN';

  // Track asymmetry over time
  const asymmetries = trades.map(t => t.asymmetry);
  const absAsymmetries = asymmetries.map(Math.abs);
  const peakAbs = Math.max(...absAsymmetries);
  const finalAbs = Math.abs(finalAsymmetry);

  // Check for sign change (reversal)
  let signChanges = 0;
  for (let i = 1; i < asymmetries.length; i++) {
    if (asymmetries[i] * asymmetries[i - 1] < 0 && Math.abs(asymmetries[i]) > 0.1) {
      signChanges++;
    }
  }

  if (signChanges >= 2) return 'REVERSAL';
  if (finalAbs < 0.15) return 'NO_MOMENTUM';
  if (finalAbs > 0.25 && directionCorrect) return 'MOMENTUM';
  if (finalAbs > 0.25 && !directionCorrect) return 'REVERSAL';
  return 'NO_MOMENTUM';
}

// Build phases: group consecutive trades into directional phases
function buildPhases(trades: TradeEvent[]): PhaseInfo[] {
  if (trades.length === 0) return [];

  const phases: PhaseInfo[] = [];
  let phaseStart = 0;

  for (let i = 1; i <= trades.length; i++) {
    // Phase boundary: gap > 5 seconds or side emphasis shifts
    const isEnd = i === trades.length;
    const gapSec = !isEnd ? trades[i].relSec - trades[i - 1].relSec : 999;
    const shifted = !isEnd && i > phaseStart + 2 &&
      Math.sign(trades[i].asymmetry) !== Math.sign(trades[phaseStart].asymmetry) &&
      Math.abs(trades[i].asymmetry) > 0.1;

    if (isEnd || gapSec > 8 || shifted) {
      const phaseTrades = trades.slice(phaseStart, i);
      const upUsdc = phaseTrades.filter(t => t.side === 'Up').reduce((s, t) => s + t.usdc, 0);
      const downUsdc = phaseTrades.filter(t => t.side === 'Down').reduce((s, t) => s + t.usdc, 0);
      const dominant = upUsdc > downUsdc ? 'Up' : 'Down';

      let desc = '';
      if (upUsdc > 0 && downUsdc > 0) {
        const ratio = Math.max(upUsdc, downUsdc) / Math.max(Math.min(upUsdc, downUsdc), 1);
        desc = `BOTH (${dominant} ${ratio.toFixed(1)}x) $${(upUsdc + downUsdc).toFixed(0)}`;
      } else {
        desc = `${dominant} only $${(upUsdc + downUsdc).toFixed(0)}`;
      }

      phases.push({
        startSec: phaseTrades[0].relSec,
        endSec: phaseTrades[phaseTrades.length - 1].relSec,
        trades: phaseTrades.length,
        upUsdc, downUsdc,
        dominantSide: dominant,
        asymmetryStart: phaseTrades[0].asymmetry,
        asymmetryEnd: phaseTrades[phaseTrades.length - 1].asymmetry,
        description: desc,
      });

      if (!isEnd) phaseStart = i;
    }
  }

  return phases;
}

function analyzeCycles(activities: Activity[]): CycleAnalysis[] {
  // Group by conditionId
  const byCondition = new Map<string, Activity[]>();
  for (const a of activities) {
    const list = byCondition.get(a.conditionId) || [];
    list.push(a);
    byCondition.set(a.conditionId, list);
  }

  const cycles: CycleAnalysis[] = [];

  for (const [conditionId, acts] of byCondition) {
    const buys = acts.filter(a => a.type === 'TRADE' && a.side === 'BUY').sort((a, b) => a.timestamp - b.timestamp);
    const redeems = acts.filter(a => a.type === 'REDEEM');

    if (buys.length === 0) continue;

    const slug = buys[0].slug || '';
    const title = buys[0].title || '';
    const cycleStartTs = parseCycleStartFromSlug(slug);
    const cycleEndTs = cycleStartTs + 300;

    // Build trade events with running totals
    let upUsdc = 0, downUsdc = 0, upShares = 0, downShares = 0;
    const trades: TradeEvent[] = [];

    for (const b of buys) {
      const side = b.outcome || (b.outcomeIndex === 0 ? 'Up' : 'Down');
      const shares = b.size || (b.usdcSize / Math.max(b.price, 0.001));
      const relSec = cycleStartTs > 0 ? b.timestamp - cycleStartTs : (b.timestamp - buys[0].timestamp);

      if (side === 'Up') { upUsdc += b.usdcSize; upShares += shares; }
      else { downUsdc += b.usdcSize; downShares += shares; }

      const total = upUsdc + downUsdc;
      const asymmetry = total > 0 ? (upUsdc - downUsdc) / total : 0;

      trades.push({
        relSec, side, price: b.price, usdc: b.usdcSize, shares,
        upUsdc, downUsdc, upShares, downShares,
        asymmetry, totalDeployed: total,
      });
    }

    const redeemUsdc = redeems.reduce((s, r) => s + r.usdcSize, 0);
    const totalDeployed = upUsdc + downUsdc;
    const netPnl = redeemUsdc - totalDeployed;
    const finalAsymmetry = totalDeployed > 0 ? (upUsdc - downUsdc) / totalDeployed : 0;

    // Determine which side won
    const wonSide = redeemUsdc > 0
      ? (upShares > downShares && netPnl > -totalDeployed * 0.3 ? 'Up' : 'Down')
      : 'Unknown';
    // More accurate: check if Up or Down had more shares AND the PnL is positive for that side
    const favoredSide = upUsdc > downUsdc ? 'Up' : 'Down';
    const directionCorrect = netPnl > 0;

    // Early asymmetry (first 10 seconds)
    const earlyTrades = trades.filter(t => t.relSec <= trades[0].relSec + 10);
    const initialAsymmetry = earlyTrades.length > 0 ? earlyTrades[earlyTrades.length - 1].asymmetry : 0;
    const peakAsymmetry = trades.reduce((max, t) => Math.abs(t.asymmetry) > Math.abs(max) ? t.asymmetry : max, 0);

    const scenario = classifyScenario(trades, finalAsymmetry, directionCorrect);
    const phases = buildPhases(trades);

    cycles.push({
      title, slug, cycleStartTs, cycleEndTs,
      trades,
      totalTrades: buys.length,
      upTrades: buys.filter(b => (b.outcome || '') === 'Up' || b.outcomeIndex === 0).length,
      downTrades: buys.filter(b => (b.outcome || '') === 'Down' || b.outcomeIndex === 1).length,
      upUsdc, downUsdc, upShares, downShares,
      totalDeployed, redeemUsdc, netPnl,
      initialSide: trades[0]?.side || '?',
      initialAsymmetry, peakAsymmetry, finalAsymmetry,
      firstTradeRelSec: trades[0]?.relSec || 0,
      lastTradeRelSec: trades[trades.length - 1]?.relSec || 0,
      tradingSpanSec: (trades[trades.length - 1]?.relSec || 0) - (trades[0]?.relSec || 0),
      scenario, wonSide, favoredSide, directionCorrect, phases,
    });
  }

  return cycles.sort((a, b) => a.cycleStartTs - b.cycleStartTs);
}

// ── Main Analysis ─────────────────────────────────────────────

function main() {
  const file = process.argv[2];
  if (!file) {
    console.log('Usage: npx tsx scripts/ai-hedge-fund/analyze-momentum-hedger.ts <activity_json_file>');
    process.exit(1);
  }

  const activities: Activity[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Loaded ${activities.length} activities\n`);

  const cycles = analyzeCycles(activities);
  const tradingCycles = cycles.filter(c => c.totalTrades > 0);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       MOMENTUM HEDGER MODEL — CYCLE-BY-CYCLE ANALYSIS       ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── Per-Cycle Detail ────────────────────────────────
  for (const c of tradingCycles) {
    const timeStr = c.title.match(/\d+:\d+[AP]M-\d+:\d+[AP]M/)?.[0] || c.title.slice(-20);
    const pnlStr = c.netPnl >= 0 ? `+$${c.netPnl.toFixed(0)}` : `-$${Math.abs(c.netPnl).toFixed(0)}`;
    const dir = c.directionCorrect ? '✓' : '✗';

    console.log(`── ${timeStr} | ${c.scenario.padEnd(13)} | ${pnlStr.padStart(7)} ${dir} | deployed $${c.totalDeployed.toFixed(0)} | asym: ${(c.initialAsymmetry * 100).toFixed(0)}%→${(c.finalAsymmetry * 100).toFixed(0)}% ──`);
    console.log(`   Up: ${c.upTrades} trades $${c.upUsdc.toFixed(0)} (${c.upShares.toFixed(0)} shares) | Down: ${c.downTrades} trades $${c.downUsdc.toFixed(0)} (${c.downShares.toFixed(0)} shares)`);
    console.log(`   First: ${c.initialSide} @+${c.firstTradeRelSec}s | Span: ${c.tradingSpanSec}s | Favored: ${c.favoredSide}`);

    // Show phases
    for (let i = 0; i < c.phases.length; i++) {
      const p = c.phases[i];
      console.log(`   Phase ${i + 1} [+${p.startSec}-${p.endSec}s]: ${p.description} | asym ${(p.asymmetryStart * 100).toFixed(0)}%→${(p.asymmetryEnd * 100).toFixed(0)}%`);
    }

    // Show asymmetry trajectory (sampled every ~30s)
    const snapshots = [0, 30, 60, 120, 180, 240, 300].map(sec => {
      const closest = c.trades.filter(t => t.relSec <= sec);
      return closest.length > 0 ? closest[closest.length - 1] : null;
    });
    const trajectory = snapshots.map((s, i) => {
      if (!s) return '---';
      return `${(s.asymmetry * 100).toFixed(0)}%`;
    });
    console.log(`   Trajectory [0s,30s,60s,120s,180s,240s,300s]: ${trajectory.join(' → ')}`);
    console.log('');
  }

  // ── Aggregate Statistics ────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('       AGGREGATE MODEL STATISTICS                             ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const byScenario = new Map<string, CycleAnalysis[]>();
  for (const c of tradingCycles) {
    const list = byScenario.get(c.scenario) || [];
    list.push(c);
    byScenario.set(c.scenario, list);
  }

  for (const [scenario, cycles2] of byScenario) {
    const wins = cycles2.filter(c => c.netPnl > 0);
    const losses = cycles2.filter(c => c.netPnl <= 0);
    const avgPnl = cycles2.reduce((s, c) => s + c.netPnl, 0) / cycles2.length;
    const avgDeployed = cycles2.reduce((s, c) => s + c.totalDeployed, 0) / cycles2.length;
    const avgAbsAsym = cycles2.reduce((s, c) => s + Math.abs(c.finalAsymmetry), 0) / cycles2.length;
    const avgTrades = cycles2.reduce((s, c) => s + c.totalTrades, 0) / cycles2.length;
    const avgSpan = cycles2.reduce((s, c) => s + c.tradingSpanSec, 0) / cycles2.length;
    const avgWinPnl = wins.length > 0 ? wins.reduce((s, c) => s + c.netPnl, 0) / wins.length : 0;
    const avgLossPnl = losses.length > 0 ? losses.reduce((s, c) => s + c.netPnl, 0) / losses.length : 0;

    console.log(`── ${scenario} (${cycles2.length} cycles) ──`);
    console.log(`   Win/Loss: ${wins.length}W / ${losses.length}L (${(wins.length / cycles2.length * 100).toFixed(0)}%)`);
    console.log(`   Avg PnL: $${avgPnl.toFixed(0)} | Win avg: $${avgWinPnl.toFixed(0)} | Loss avg: $${avgLossPnl.toFixed(0)}`);
    console.log(`   Avg deployed: $${avgDeployed.toFixed(0)} | Avg |asymmetry|: ${(avgAbsAsym * 100).toFixed(0)}%`);
    console.log(`   Avg trades/cycle: ${avgTrades.toFixed(0)} | Avg span: ${avgSpan.toFixed(0)}s`);
    console.log('');
  }

  // ── Entry Timing ────────────────────────────────────
  console.log('── ENTRY TIMING ──');
  const entryDelays = tradingCycles.map(c => c.firstTradeRelSec);
  console.log(`   First trade after cycle open: min=${Math.min(...entryDelays)}s max=${Math.max(...entryDelays)}s avg=${(entryDelays.reduce((a, b) => a + b, 0) / entryDelays.length).toFixed(0)}s`);

  // ── Size Scaling ────────────────────────────────────
  console.log('\n── SIZE SCALING PATTERNS ──');
  // Average USDC per trade in first 30s vs last 30s of each cycle
  let early30Usdc = 0, early30Count = 0, late30Usdc = 0, late30Count = 0;
  for (const c of tradingCycles) {
    const lastRelSec = c.lastTradeRelSec;
    for (const t of c.trades) {
      if (t.relSec <= c.firstTradeRelSec + 30) { early30Usdc += t.usdc; early30Count++; }
      if (t.relSec >= lastRelSec - 30) { late30Usdc += t.usdc; late30Count++; }
    }
  }
  console.log(`   First 30s avg trade: $${early30Count > 0 ? (early30Usdc / early30Count).toFixed(2) : 0}`);
  console.log(`   Last 30s avg trade:  $${late30Count > 0 ? (late30Usdc / late30Count).toFixed(2) : 0}`);

  // ── Asymmetry Distribution ──────────────────────────
  console.log('\n── ASYMMETRY DISTRIBUTION ──');
  const asymBuckets = { '<10%': 0, '10-25%': 0, '25-50%': 0, '50-75%': 0, '>75%': 0 };
  for (const c of tradingCycles) {
    const abs = Math.abs(c.finalAsymmetry) * 100;
    if (abs < 10) asymBuckets['<10%']++;
    else if (abs < 25) asymBuckets['10-25%']++;
    else if (abs < 50) asymBuckets['25-50%']++;
    else if (abs < 75) asymBuckets['50-75%']++;
    else asymBuckets['>75%']++;
  }
  for (const [bucket, count] of Object.entries(asymBuckets)) {
    console.log(`   ${bucket.padEnd(8)}: ${count} cycles`);
  }

  // ── Combined Cost Analysis ──────────────────────────
  console.log('\n── COMBINED COST (Up avg price + Down avg price) ──');
  const combinedCosts: number[] = [];
  for (const c of tradingCycles) {
    if (c.upShares > 0 && c.downShares > 0) {
      const upAvg = c.upUsdc / c.upShares;
      const downAvg = c.downUsdc / c.downShares;
      combinedCosts.push(upAvg + downAvg);
    }
  }
  if (combinedCosts.length > 0) {
    combinedCosts.sort((a, b) => a - b);
    console.log(`   Min: ${(combinedCosts[0] * 100).toFixed(1)}c | Max: ${(combinedCosts[combinedCosts.length - 1] * 100).toFixed(1)}c`);
    console.log(`   Avg: ${(combinedCosts.reduce((a, b) => a + b, 0) / combinedCosts.length * 100).toFixed(1)}c`);
    console.log(`   Median: ${(combinedCosts[Math.floor(combinedCosts.length / 2)] * 100).toFixed(1)}c`);
    console.log(`   <100c: ${combinedCosts.filter(c => c < 1.0).length} | >=100c: ${combinedCosts.filter(c => c >= 1.0).length}`);
  }

  // ── Momentum Detection ──────────────────────────────
  console.log('\n── MOMENTUM INDICATOR: Initial side vs final favored side ──');
  let sameDirection = 0, reversed = 0;
  for (const c of tradingCycles) {
    const initialFavor = c.initialAsymmetry > 0 ? 'Up' : 'Down';
    if (initialFavor === c.favoredSide) sameDirection++;
    else reversed++;
  }
  console.log(`   Same direction: ${sameDirection} | Reversed: ${reversed} | Total: ${tradingCycles.length}`);

  // ── Summary ─────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  const totalPnl = tradingCycles.reduce((s, c) => s + c.netPnl, 0);
  const totalDep = tradingCycles.reduce((s, c) => s + c.totalDeployed, 0);
  console.log(`TOTAL: ${tradingCycles.length} cycles | PnL $${totalPnl.toFixed(0)} | Deployed $${totalDep.toFixed(0)} | ROCE ${(totalPnl / totalDep * 100).toFixed(1)}%`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main();
