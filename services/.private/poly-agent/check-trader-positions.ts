/**
 * check-trader-positions.ts
 *
 * Shows per trader:
 *   1. Active open positions (0.02 < curPrice < 0.99), filtered by --min-value
 *   2. Redeemable positions (curPrice >= 0.99, resolved Yes — collect these)
 *   3. Activity counts for 1d / 7d / 15d / 30d with unique markets traded
 *   4. 20% slot cap evaluation: is 5 slots enough given trading frequency?
 *
 * Usage:
 *   npx tsx check-trader-positions.ts
 *   npx tsx check-trader-positions.ts --min-value 100
 */

const DATA_API = 'https://data-api.polymarket.com';

const TRADERS = [
  { wallet: '0xbb0bd109b9f0c2a59b8819c466f064cf65ab3790', label: 'T1-Swing-665%' },
  { wallet: '0x2d4bf8f846bf68f43b9157bf30810d334ac6ca7a', label: 'T2-BuyHold-869%' },
  { wallet: '0x71abe97b83eaba3f06cb04fd4d9a03ee37d2f015', label: 'T3-Active' },
  { wallet: '0x1ba1bb6aa2490adbbbbb314bc07ff21a8cc71ce4', label: 'T4-BuyHold-448%' },
  { wallet: '0xcca90a5d3c8f2d6663817e3650d6adbe9ab44c9f', label: 'T5-Swing-241%' },
  { wallet: '0x25e28169faea17421fcd4cc361f6436d1e449a09', label: 'T6-Swing-267%' },
  { wallet: '0x843630d1b37be01868022d153ef1959dfcef4c19', label: 'T7-BuyHold-352%' },
];

const PERIODS = [
  { label: '1d',  ms:  1 * 86_400_000 },
  { label: '7d',  ms:  7 * 86_400_000 },
  { label: '15d', ms: 15 * 86_400_000 },
  { label: '30d', ms: 30 * 86_400_000 },
];

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const MIN_VALUE = parseFloat(argVal('min-value') ?? '0');

function pad(s: string, n: number)  { return String(s).slice(0, n).padEnd(n); }
function rpad(s: string, n: number) { return String(s).slice(0, n).padStart(n); }
function pct(n: number)             { return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }

// ── fetch all positions ───────────────────────────────────────────────────────
async function fetchPositions(wallet: string): Promise<any[]> {
  const res = await fetch(`${DATA_API}/positions?user=${wallet}&sizeThreshold=0.01&limit=500`);
  if (!res.ok) throw new Error(`positions HTTP ${res.status}`);
  const raw: any = await res.json();
  return Array.isArray(raw) ? raw : (raw.data ?? []);
}

// ── fetch activity with pagination until sinceMs ──────────────────────────────
async function fetchActivity(wallet: string, sinceMs: number): Promise<any[]> {
  const result: any[] = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const url = `${DATA_API}/activity?user=${wallet}&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`activity HTTP ${res.status}`);
    const raw: any = await res.json();
    const items: any[] = Array.isArray(raw) ? raw : (raw.data ?? []);
    if (items.length === 0) break;

    for (const t of items) {
      const ts = parseFloat(t.timestamp ?? '0') * 1000;
      if (ts < sinceMs) { return result; } // sorted DESC — stop here
      result.push(t);
    }

    if (items.length < limit) break;
    offset += limit;
  }
  return result;
}

// ── classify activity ─────────────────────────────────────────────────────────
// API schema: type='TRADE'|'REDEEM'|'MERGE'|'SPLIT'|'REWARD'|'CONVERSION'
//             side='BUY'|'SELL'  (only present when type==='TRADE')
function isTrade(t: any): boolean {
  return (t.type ?? '').toUpperCase() === 'TRADE' && (t.side === 'BUY' || t.side === 'SELL');
}
function tradeSide(t: any): string {
  return (t.side ?? '?').toUpperCase();
}
function marketKey(t: any): string {
  return t.conditionId ?? t.market ?? t.slug ?? t.title ?? t.asset ?? '?';
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now = Date.now();
  const since30d = now - PERIODS[3].ms;

  console.log(`\n${'═'.repeat(110)}`);
  console.log(`  TRADER POSITIONS & ACTIVITY  —  ${new Date().toISOString()}`);
  console.log(`  Min value filter: $${MIN_VALUE}`);
  console.log(`${'═'.repeat(110)}\n`);

  // Summary table rows collected for end
  const summary: Array<{
    label: string;
    activeCnt: number; activeVal: number; activeCost: number;
    redeemCnt: number; redeemVal: number;
    worthlessCnt: number;
    acts: Record<string, { trades: number; buys: number; sells: number; markets: Set<string> }>;
  }> = [];

  for (const trader of TRADERS) {
    console.log(`\n${'─'.repeat(110)}`);
    console.log(`  ${trader.label}  (${trader.wallet})`);
    console.log(`${'─'.repeat(110)}`);

    // ── fetch in parallel ───────────────────────────────────────────────────
    let positions: any[] = [];
    let allActs:   any[] = [];
    try {
      [positions, allActs] = await Promise.all([
        fetchPositions(trader.wallet),
        fetchActivity(trader.wallet, since30d),
      ]);
    } catch (e: any) {
      console.log(`  ERROR: ${e.message}`);
      continue;
    }

    // ── classify positions ──────────────────────────────────────────────────
    const mapped = positions.map((p: any) => {
      const size  = parseFloat(p.size         ?? '0');
      const cur   = parseFloat(p.curPrice     ?? p.currentPrice  ?? '0');
      const avg   = parseFloat(p.avgPrice     ?? p.averagePrice  ?? '0');
      const value = parseFloat(p.currentValue ?? String(size * cur));
      const cost  = parseFloat(p.initialValue ?? String(size * avg));
      return {
        title:   (p.title ?? p.marketTitle ?? 'Unknown').slice(0, 50),
        outcome: (p.outcome ?? '—').slice(0, 4),
        size, cur, avg, value, cost,
        pnl:    value - cost,
        pnlPct: cost > 0 ? ((value - cost) / cost * 100) : 0,
      };
    });

    const active    = mapped.filter(p => p.cur > 0.02 && p.cur < 0.99).sort((a, b) => b.value - a.value);
    const redeemable= mapped.filter(p => p.cur >= 0.99).sort((a, b) => b.value - a.value);
    const worthless = mapped.filter(p => p.cur <= 0.02);

    // ── active positions ────────────────────────────────────────────────────
    const activeFiltered = active.filter(p => p.value >= MIN_VALUE);
    const activeVal  = active.reduce((s, p) => s + p.value, 0);
    const activeCost = active.reduce((s, p) => s + p.cost,  0);
    const activePnl  = activeVal - activeCost;

    if (activeFiltered.length > 0) {
      console.log(`\n  ACTIVE POSITIONS (${active.length} total, showing ${activeFiltered.length} ≥ $${MIN_VALUE})`);
      console.log(`  Value $${activeVal.toFixed(2)}  |  Cost $${activeCost.toFixed(2)}  |  PnL ${activePnl >= 0 ? '+' : ''}$${activePnl.toFixed(2)} (${pct(activeCost > 0 ? activePnl / activeCost * 100 : 0)})`);
      console.log(`\n  ${pad('Market', 50)}  Out   Shares    Avg$    Cur$    Value$    PnL%`);
      console.log(`  ${'─'.repeat(100)}`);
      for (const p of activeFiltered) {
        console.log(
          `  ${pad(p.title, 50)}  ${pad(p.outcome, 4)}  ` +
          `${rpad(p.size.toFixed(2), 8)}  ` +
          `${rpad(p.avg.toFixed(3), 6)}  ` +
          `${rpad(p.cur.toFixed(3), 6)}  ` +
          `${rpad(p.value.toFixed(2), 8)}  ` +
          `${rpad(pct(p.pnlPct), 7)}`
        );
      }
    } else {
      console.log(`\n  ACTIVE: ${active.length} positions, total value $${activeVal.toFixed(2)} — none above $${MIN_VALUE} filter`);
    }

    // ── redeemable positions ────────────────────────────────────────────────
    const redeemVal = redeemable.reduce((s, p) => s + p.value, 0);
    if (redeemable.length > 0) {
      console.log(`\n  REDEEMABLE (resolved YES — collect these): ${redeemable.length} positions, total $${redeemVal.toFixed(2)}`);
      for (const p of redeemable.slice(0, 10)) {
        console.log(`    ${pad(p.title, 50)}  ${pad(p.outcome, 4)}  ${p.size.toFixed(2)} shares  ≈ $${p.value.toFixed(2)}`);
      }
      if (redeemable.length > 10) console.log(`    ... and ${redeemable.length - 10} more`);
    }

    // ── worthless ───────────────────────────────────────────────────────────
    const worthlessVal = worthless.reduce((s, p) => s + p.cost, 0);
    if (worthless.length > 0) {
      console.log(`  WORTHLESS (≤$0.02): ${worthless.length} positions  |  original cost $${worthlessVal.toFixed(2)}`);
    }

    // ── activity counts ─────────────────────────────────────────────────────
    const trades = allActs.filter(isTrade);
    console.log(`\n  ACTIVITY (last 30d fetched: ${allActs.length} events, ${trades.length} trades)`);
    console.log(`\n  Period   Trades   BUYs   SELLs   Unique Markets   Avg/week`);
    console.log(`  ${'─'.repeat(60)}`);

    const actsByPeriod: Record<string, { trades: number; buys: number; sells: number; markets: Set<string> }> = {};

    for (const p of PERIODS) {
      const cutoff = now - p.ms;
      const pt = trades.filter(t => parseFloat(t.timestamp ?? '0') * 1000 >= cutoff);
      const buys  = pt.filter(t => tradeSide(t) === 'BUY').length;
      const sells = pt.filter(t => tradeSide(t) === 'SELL').length;
      const markets = new Set(pt.map(marketKey));
      const weeks   = p.ms / (7 * 86_400_000);
      const avgPerWeek = (markets.size / weeks).toFixed(1);
      actsByPeriod[p.label] = { trades: pt.length, buys, sells, markets };
      console.log(
        `  ${rpad(p.label, 6)}   ${rpad(pt.length, 6)}   ${rpad(buys, 5)}   ${rpad(sells, 6)}   ` +
        `${rpad(markets.size, 15)}   ${avgPerWeek}/wk`
      );
    }

    // ── slot cap evaluation ─────────────────────────────────────────────────
    const weeklyMarkets = actsByPeriod['7d']?.markets.size ?? 0;
    const monthlyMarkets = actsByPeriod['30d']?.markets.size ?? 0;
    const avgWeekly = (monthlyMarkets / 4).toFixed(1);
    const slotsNeeded = Math.ceil(parseFloat(avgWeekly));
    const capPct = slotsNeeded > 0 ? Math.min(100, Math.round(100 / slotsNeeded)) : 20;

    console.log(`\n  SLOT CAP EVALUATION:`);
    console.log(`    Avg unique markets/week (30d): ${avgWeekly}  |  Last 7d: ${weeklyMarkets}`);
    console.log(`    Suggested slots: ${slotsNeeded}  →  per-slot cap: ${capPct}%  (20% = 5 slots)`);
    if (slotsNeeded <= 5) {
      console.log(`    ✅ 20% cap (5 slots) is sufficient for this trader`);
    } else if (slotsNeeded <= 10) {
      console.log(`    ⚠️  Consider 10% cap (10 slots) — trader opens ~${avgWeekly} positions/week`);
    } else {
      console.log(`    ❌ 20% cap too restrictive — trader very active (~${avgWeekly} positions/week)`);
    }

    summary.push({
      label: trader.label,
      activeCnt: active.length, activeVal, activeCost,
      redeemCnt: redeemable.length, redeemVal,
      worthlessCnt: worthless.length,
      acts: actsByPeriod,
    });
  }

  // ── grand summary table ───────────────────────────────────────────────────
  console.log(`\n\n${'═'.repeat(110)}`);
  console.log(`  SUMMARY TABLE`);
  console.log(`${'═'.repeat(110)}`);
  console.log(`\n  ${pad('Trader', 22)}  Act.Pos  Act.Val$  Redeem#  Redeem$   Worthless  1d-mkt  7d-mkt  15d-mkt  30d-mkt  Cap%`);
  console.log(`  ${'─'.repeat(108)}`);

  let grandActiveVal = 0, grandRedeemVal = 0;
  for (const r of summary) {
    const cap1d  = r.acts['1d']?.markets.size  ?? 0;
    const cap7d  = r.acts['7d']?.markets.size  ?? 0;
    const cap15d = r.acts['15d']?.markets.size ?? 0;
    const cap30d = r.acts['30d']?.markets.size ?? 0;
    const avgWk  = (cap30d / 4).toFixed(1);
    const slots  = Math.ceil(parseFloat(avgWk));
    const capPct = slots > 0 ? Math.min(100, Math.round(100 / slots)) : 20;
    grandActiveVal  += r.activeVal;
    grandRedeemVal  += r.redeemVal;
    console.log(
      `  ${pad(r.label, 22)}  ${rpad(r.activeCnt, 7)}  ${rpad(r.activeVal.toFixed(0), 8)}  ` +
      `${rpad(r.redeemCnt, 7)}  ${rpad(r.redeemVal.toFixed(0), 8)}  ` +
      `${rpad(r.worthlessCnt, 9)}  ${rpad(cap1d, 6)}  ${rpad(cap7d, 6)}  ` +
      `${rpad(cap15d, 7)}  ${rpad(cap30d, 7)}  ${capPct}%`
    );
  }
  console.log(`  ${'─'.repeat(108)}`);
  console.log(`  Total active value : $${grandActiveVal.toFixed(2)}`);
  console.log(`  Total redeemable   : $${grandRedeemVal.toFixed(2)}`);
  console.log(`${'═'.repeat(110)}\n`);
}

main().catch(console.error);
