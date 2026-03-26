/**
 * Deep Position Reconstruction — Reverse-Engineering the Momentum Hedger
 *
 * For each 5m cycle, reconstructs the position trade-by-trade showing:
 * - Share-based asymmetry (not USDC) — this is what matters for P&L
 * - Running avg price per side
 * - Position size growth relative to price changes
 * - Implied BTC momentum from Up price changes
 * - How sizing decisions relate to momentum shifts
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/deep-position-analysis.ts <activity_json_file>
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
  size?: number;
}

interface PositionState {
  upShares: number;
  downShares: number;
  upUsdc: number;
  downUsdc: number;
  upAvgPrice: number;
  downAvgPrice: number;
  shareAsymmetry: number;   // (upShares - downShares) / (upShares + downShares)
  usdcAsymmetry: number;    // (upUsdc - downUsdc) / (upUsdc + downUsdc)
  totalShares: number;
  totalUsdc: number;
  impliedUpProb: number;    // latest Up buy price as market probability
  impliedDownProb: number;
}

interface TradeRow {
  relSec: number;
  side: string;
  price: number;
  usdc: number;
  shares: number;
  // Running state
  state: PositionState;
  // Deltas
  shareAsymDelta: number;
  priceVsPrev: number;      // price change from previous trade on same side
}

interface CycleDetail {
  title: string;
  slug: string;
  cycleOpenTs: number;
  trades: TradeRow[];
  redeemUsdc: number;
  netPnl: number;
  // Per-side summaries
  upSummary: { trades: number; shares: number; usdc: number; avgPrice: number; minPrice: number; maxPrice: number };
  downSummary: { trades: number; shares: number; usdc: number; avgPrice: number; minPrice: number; maxPrice: number };
  // Key metrics
  finalShareAsym: number;
  finalUsdcAsym: number;
  maxShareAsym: number;
  minShareAsym: number;
  combinedAvgCost: number;  // upAvgPrice + downAvgPrice
  scenario: string;
  // Momentum proxy
  priceSwing: number;       // max Up price - min Up price during cycle
  entryUpPrice: number;     // first Up trade price
  exitUpPrice: number;      // last Up trade price
  // Size scaling
  avgTradeSize: number;
  maxTradeSize: number;
  firstQuarterAvgSize: number;
  lastQuarterAvgSize: number;
}

function parseCycleOpen(slug: string): number {
  const match = slug?.match(/btc-updown-5m-(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

function buildPositionState(upShares: number, downShares: number, upUsdc: number, downUsdc: number, latestUpPrice: number, latestDownPrice: number): PositionState {
  const totalShares = upShares + downShares;
  const totalUsdc = upUsdc + downUsdc;
  return {
    upShares, downShares, upUsdc, downUsdc,
    upAvgPrice: upShares > 0 ? upUsdc / upShares : 0,
    downAvgPrice: downShares > 0 ? downUsdc / downShares : 0,
    shareAsymmetry: totalShares > 0 ? (upShares - downShares) / totalShares : 0,
    usdcAsymmetry: totalUsdc > 0 ? (upUsdc - downUsdc) / totalUsdc : 0,
    totalShares, totalUsdc,
    impliedUpProb: latestUpPrice,
    impliedDownProb: latestDownPrice,
  };
}

function analyzeCycles(activities: Activity[]): CycleDetail[] {
  const byCondition = new Map<string, Activity[]>();
  for (const a of activities) {
    const list = byCondition.get(a.conditionId) || [];
    list.push(a);
    byCondition.set(a.conditionId, list);
  }

  const cycles: CycleDetail[] = [];

  for (const [, acts] of byCondition) {
    const buys = acts.filter(a => a.type === 'TRADE' && a.side === 'BUY').sort((a, b) => a.timestamp - b.timestamp);
    const redeems = acts.filter(a => a.type === 'REDEEM');
    if (buys.length < 3) continue;

    const slug = buys[0].slug || '';
    const title = buys[0].title || '';
    const cycleOpenTs = parseCycleOpen(slug);

    let upShares = 0, downShares = 0, upUsdc = 0, downUsdc = 0;
    let latestUpPrice = 0, latestDownPrice = 0;
    let prevUpPrice = 0, prevDownPrice = 0;
    let prevShareAsym = 0;

    const upPrices: number[] = [];
    const downPrices: number[] = [];
    const trades: TradeRow[] = [];

    for (const b of buys) {
      const side = b.outcome || (b.outcomeIndex === 0 ? 'Up' : 'Down');
      const shares = b.size || (b.usdcSize / Math.max(b.price, 0.001));
      const relSec = cycleOpenTs > 0 ? b.timestamp - cycleOpenTs : (b.timestamp - buys[0].timestamp);

      let priceVsPrev = 0;
      if (side === 'Up') {
        priceVsPrev = prevUpPrice > 0 ? b.price - prevUpPrice : 0;
        prevUpPrice = b.price;
        latestUpPrice = b.price;
        upShares += shares;
        upUsdc += b.usdcSize;
        upPrices.push(b.price);
      } else {
        priceVsPrev = prevDownPrice > 0 ? b.price - prevDownPrice : 0;
        prevDownPrice = b.price;
        latestDownPrice = b.price;
        downShares += shares;
        downUsdc += b.usdcSize;
        downPrices.push(b.price);
      }

      const state = buildPositionState(upShares, downShares, upUsdc, downUsdc, latestUpPrice, latestDownPrice);
      const shareAsymDelta = state.shareAsymmetry - prevShareAsym;
      prevShareAsym = state.shareAsymmetry;

      trades.push({ relSec, side, price: b.price, usdc: b.usdcSize, shares, state, shareAsymDelta, priceVsPrev });
    }

    const redeemUsdc = redeems.reduce((s, r) => s + r.usdcSize, 0);
    const totalUsdc = upUsdc + downUsdc;
    const netPnl = redeemUsdc - totalUsdc;

    const finalState = trades[trades.length - 1].state;
    const shareAsyms = trades.map(t => t.state.shareAsymmetry);

    // Size scaling
    const allSizes = trades.map(t => t.usdc);
    const q1 = trades.slice(0, Math.ceil(trades.length / 4));
    const q4 = trades.slice(Math.floor(trades.length * 3 / 4));

    // Classify scenario based on share asymmetry
    const absAsym = Math.abs(finalState.shareAsymmetry);
    const maxAbsAsym = Math.max(...shareAsyms.map(Math.abs));
    let signChanges = 0;
    for (let i = 1; i < shareAsyms.length; i++) {
      if (shareAsyms[i] * shareAsyms[i-1] < 0 && Math.abs(shareAsyms[i]) > 0.05) signChanges++;
    }
    let scenario = 'UNKNOWN';
    if (absAsym > 0.20 && signChanges <= 1 && netPnl > 0) scenario = 'MOMENTUM';
    else if (absAsym < 0.15 && signChanges <= 2) scenario = 'NO_MOMENTUM';
    else if (signChanges >= 2) scenario = 'REVERSAL';
    else if (absAsym > 0.20) scenario = 'MOMENTUM';
    else scenario = 'NO_MOMENTUM';

    cycles.push({
      title, slug, cycleOpenTs, trades, redeemUsdc, netPnl,
      upSummary: {
        trades: upPrices.length, shares: upShares, usdc: upUsdc,
        avgPrice: upShares > 0 ? upUsdc / upShares : 0,
        minPrice: upPrices.length > 0 ? Math.min(...upPrices) : 0,
        maxPrice: upPrices.length > 0 ? Math.max(...upPrices) : 0,
      },
      downSummary: {
        trades: downPrices.length, shares: downShares, usdc: downUsdc,
        avgPrice: downShares > 0 ? downUsdc / downShares : 0,
        minPrice: downPrices.length > 0 ? Math.min(...downPrices) : 0,
        maxPrice: downPrices.length > 0 ? Math.max(...downPrices) : 0,
      },
      finalShareAsym: finalState.shareAsymmetry,
      finalUsdcAsym: finalState.usdcAsymmetry,
      maxShareAsym: Math.max(...shareAsyms),
      minShareAsym: Math.min(...shareAsyms),
      combinedAvgCost: (upShares > 0 ? upUsdc / upShares : 0) + (downShares > 0 ? downUsdc / downShares : 0),
      scenario,
      priceSwing: upPrices.length > 0 ? Math.max(...upPrices) - Math.min(...upPrices) : 0,
      entryUpPrice: upPrices[0] || 0,
      exitUpPrice: upPrices[upPrices.length - 1] || 0,
      avgTradeSize: allSizes.reduce((a, b) => a + b, 0) / allSizes.length,
      maxTradeSize: Math.max(...allSizes),
      firstQuarterAvgSize: q1.reduce((s, t) => s + t.usdc, 0) / Math.max(q1.length, 1),
      lastQuarterAvgSize: q4.reduce((s, t) => s + t.usdc, 0) / Math.max(q4.length, 1),
    });
  }

  return cycles.sort((a, b) => a.cycleOpenTs - b.cycleOpenTs);
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.log('Usage: npx tsx scripts/ai-hedge-fund/deep-position-analysis.ts <json_file>');
    process.exit(1);
  }

  const activities: Activity[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cycles = analyzeCycles(activities);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       DEEP POSITION ANALYSIS — SHARE-BASED MODEL            ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const c of cycles) {
    const time = c.title.match(/\d+:\d+[AP]M-\d+:\d+[AP]M/)?.[0] || c.title.slice(-25);
    const pnlStr = c.netPnl >= 0 ? `+$${c.netPnl.toFixed(0)}` : `-$${Math.abs(c.netPnl).toFixed(0)}`;

    console.log(`\n╔══ ${time} | ${c.scenario} | ${pnlStr} | deployed $${(c.upSummary.usdc + c.downSummary.usdc).toFixed(0)} ══╗`);
    console.log(`║ Up:   ${c.upSummary.trades} trades | ${c.upSummary.shares.toFixed(0)} shares | $${c.upSummary.usdc.toFixed(0)} | avg ${(c.upSummary.avgPrice*100).toFixed(1)}c [${(c.upSummary.minPrice*100).toFixed(0)}-${(c.upSummary.maxPrice*100).toFixed(0)}c]`);
    console.log(`║ Down: ${c.downSummary.trades} trades | ${c.downSummary.shares.toFixed(0)} shares | $${c.downSummary.usdc.toFixed(0)} | avg ${(c.downSummary.avgPrice*100).toFixed(1)}c [${(c.downSummary.minPrice*100).toFixed(0)}-${(c.downSummary.maxPrice*100).toFixed(0)}c]`);
    console.log(`║ Combined cost: ${(c.combinedAvgCost*100).toFixed(1)}c | Share asym: ${(c.finalShareAsym*100).toFixed(0)}% [range: ${(c.minShareAsym*100).toFixed(0)}% to ${(c.maxShareAsym*100).toFixed(0)}%]`);
    console.log(`║ Up price swing: ${(c.priceSwing*100).toFixed(0)}c (${(c.entryUpPrice*100).toFixed(0)}c→${(c.exitUpPrice*100).toFixed(0)}c) | Size: avg $${c.avgTradeSize.toFixed(1)} max $${c.maxTradeSize.toFixed(0)} Q1=$${c.firstQuarterAvgSize.toFixed(1)} Q4=$${c.lastQuarterAvgSize.toFixed(1)}`);

    // Show trade-by-trade with share asymmetry
    console.log(`║`);
    console.log(`║ Time  Side  Price   USDC    Shares  | ShareAsym  UsdcAsym  UpAvg  DnAvg  UpShr  DnShr  | Momentum`);
    console.log(`║ ────  ────  ─────   ────    ──────  | ─────────  ────────  ─────  ─────  ─────  ─────  | ────────`);

    // Sample: show every Nth trade to keep output manageable
    const step = Math.max(1, Math.floor(c.trades.length / 30));
    for (let i = 0; i < c.trades.length; i += step) {
      const t = c.trades[i];
      const s = t.state;
      const momentum = t.priceVsPrev > 0.01 ? '↑' : t.priceVsPrev < -0.01 ? '↓' : '·';
      const asymDir = t.shareAsymDelta > 0.01 ? '→Up' : t.shareAsymDelta < -0.01 ? '→Dn' : '  =';

      console.log(
        `║ +${String(t.relSec).padStart(3)}s  ${t.side.padEnd(4)}  ${(t.price*100).toFixed(0).padStart(3)}c  $${t.usdc.toFixed(0).padStart(6)}  ${t.shares.toFixed(0).padStart(6)}  | ` +
        `${(s.shareAsymmetry*100).toFixed(0).padStart(5)}%  ${(s.usdcAsymmetry*100).toFixed(0).padStart(6)}%  ` +
        `${(s.upAvgPrice*100).toFixed(1).padStart(5)}c ${(s.downAvgPrice*100).toFixed(1).padStart(5)}c ` +
        `${s.upShares.toFixed(0).padStart(5)} ${s.downShares.toFixed(0).padStart(5)}  | ` +
        `${momentum} ${asymDir}`
      );
    }
    // Always show last trade
    if (c.trades.length > 1) {
      const t = c.trades[c.trades.length - 1];
      const s = t.state;
      console.log(
        `║ +${String(t.relSec).padStart(3)}s  ${t.side.padEnd(4)}  ${(t.price*100).toFixed(0).padStart(3)}c  $${t.usdc.toFixed(0).padStart(6)}  ${t.shares.toFixed(0).padStart(6)}  | ` +
        `${(s.shareAsymmetry*100).toFixed(0).padStart(5)}%  ${(s.usdcAsymmetry*100).toFixed(0).padStart(6)}%  ` +
        `${(s.upAvgPrice*100).toFixed(1).padStart(5)}c ${(s.downAvgPrice*100).toFixed(1).padStart(5)}c ` +
        `${s.upShares.toFixed(0).padStart(5)} ${s.downShares.toFixed(0).padStart(5)}  | FINAL`
      );
    }
    console.log(`╚${'═'.repeat(100)}╝`);
  }

  // ── Aggregate Analysis ──────────────────────────────
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('       AGGREGATE ANALYSIS — SHARE vs USDC ASYMMETRY          ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('Cycle                    | ShareAsym | UsdcAsym | Combined | Shares(Up/Dn) | USDC(Up/Dn)     | PnL');
  console.log('─────────────────────────|───────────|──────────|──────────|───────────────|─────────────────|──────');
  for (const c of cycles) {
    const time = c.title.match(/\d+:\d+[AP]M-\d+:\d+[AP]M/)?.[0] || '?';
    console.log(
      `${time.padEnd(24)} | ${(c.finalShareAsym*100).toFixed(0).padStart(6)}%   | ${(c.finalUsdcAsym*100).toFixed(0).padStart(5)}%   | ${(c.combinedAvgCost*100).toFixed(1).padStart(6)}c | ` +
      `${c.upSummary.shares.toFixed(0).padStart(5)}/${c.downSummary.shares.toFixed(0).padStart(5)}   | ` +
      `$${c.upSummary.usdc.toFixed(0).padStart(5)}/$${c.downSummary.usdc.toFixed(0).padStart(5)}   | ` +
      `${c.netPnl >= 0 ? '+' : ''}$${c.netPnl.toFixed(0)}`
    );
  }

  // ── Key Insight: Share balancing ────────────────────
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('       KEY INSIGHT: IS THE BOT BALANCING SHARES OR DOLLARS?   ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let shareBalanced = 0, usdcBalanced = 0;
  for (const c of cycles) {
    if (Math.abs(c.finalShareAsym) < Math.abs(c.finalUsdcAsym)) shareBalanced++;
    else usdcBalanced++;
  }
  console.log(`Cycles where |shareAsym| < |usdcAsym| (share-balanced): ${shareBalanced}`);
  console.log(`Cycles where |usdcAsym| < |shareAsym| (usdc-balanced): ${usdcBalanced}`);

  const avgShareAsym = cycles.reduce((s, c) => s + Math.abs(c.finalShareAsym), 0) / cycles.length;
  const avgUsdcAsym = cycles.reduce((s, c) => s + Math.abs(c.finalUsdcAsym), 0) / cycles.length;
  console.log(`Avg |shareAsym|: ${(avgShareAsym*100).toFixed(1)}%`);
  console.log(`Avg |usdcAsym|: ${(avgUsdcAsym*100).toFixed(1)}%`);

  // ── P&L Model ──────────────────────────────────────
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('       P&L MODEL: HOW PROFIT IS GENERATED                     ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const c of cycles) {
    const time = c.title.match(/\d+:\d+[AP]M-\d+:\d+[AP]M/)?.[0] || '?';
    // If Up wins: PnL = upShares * $1 - upUsdc - downUsdc
    // If Down wins: PnL = downShares * $1 - upUsdc - downUsdc
    const pnlIfUpWins = c.upSummary.shares - c.upSummary.usdc - c.downSummary.usdc;
    const pnlIfDownWins = c.downSummary.shares - c.upSummary.usdc - c.downSummary.usdc;
    const actualWinner = c.netPnl > 0 ? (Math.abs(pnlIfUpWins - c.netPnl) < Math.abs(pnlIfDownWins - c.netPnl) ? 'Up' : 'Down') : '?';

    console.log(`${time.padEnd(20)} | If Up wins: $${pnlIfUpWins.toFixed(0).padStart(6)} | If Down wins: $${pnlIfDownWins.toFixed(0).padStart(6)} | Actual: ${actualWinner} → $${c.netPnl >= 0 ? '+' : ''}${c.netPnl.toFixed(0)}`);
  }

  // ── Total ──────────────────────────────────────────
  const totalPnl = cycles.reduce((s, c) => s + c.netPnl, 0);
  const totalDeployed = cycles.reduce((s, c) => s + c.upSummary.usdc + c.downSummary.usdc, 0);
  console.log(`\nTOTAL: ${cycles.length} cycles | PnL $${totalPnl.toFixed(0)} | Deployed $${totalDeployed.toFixed(0)} | ROCE ${(totalPnl/totalDeployed*100).toFixed(1)}%`);
}

main();
