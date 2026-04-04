/**
 * check-trader-positions.ts — open positions + 24h activity for all tracked traders.
 *
 * Shows:
 *   1. Open positions with current value > MIN_VALUE per trader
 *   2. All trades in last 24 hours with current price & unrealised PnL
 *   3. Activity summary across all traders
 *
 * Usage:
 *   npx tsx check-trader-positions.ts
 *   npx tsx check-trader-positions.ts --min-value 1   # filter positions by min $ value
 *   npx tsx check-trader-positions.ts --hours 48      # look back 48h for activity (default 24)
 */

const DATA_API  = 'https://data-api.polymarket.com';
const CLOB_API  = 'https://clob.polymarket.com';

const TRADERS = [
  { wallet: '0xbb0bd109b9f0c2a59b8819c466f064cf65ab3790', label: 'T1-Swing-665%' },
  { wallet: '0x2d4bf8f846bf68f43b9157bf30810d334ac6ca7a', label: 'T2-BuyHold-869%' },
  { wallet: '0x71abe97b83eaba3f06cb04fd4d9a03ee37d2f015', label: 'T3-Active' },
  { wallet: '0x1ba1bb6aa2490adbbbbb314bc07ff21a8cc71ce4', label: 'T4-BuyHold-448%' },
  { wallet: '0xcca90a5d3c8f2d6663817e3650d6adbe9ab44c9f', label: 'T5-Swing-241%' },
  { wallet: '0x25e28169faea17421fcd4cc361f6436d1e449a09', label: 'T6-Swing-267%' },
  { wallet: '0x843630d1b37be01868022d153ef1959dfcef4c19', label: 'T7-BuyHold-352%' },
];

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const MIN_VALUE  = parseFloat(argVal('min-value') ?? '0');
const HOURS_BACK = parseFloat(argVal('hours')     ?? '24');
const SINCE_SEC  = Math.floor(Date.now() / 1000) - HOURS_BACK * 3600;

// ── helpers ──────────────────────────────────────────────────────────────────
function pad(s: string, n: number)  { return s.slice(0, n).padEnd(n); }
function rpad(s: string, n: number) { return s.slice(0, n).padStart(n); }
function pnlStr(pct: number)        { return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%'; }

// ── API fetchers ──────────────────────────────────────────────────────────────
async function fetchPositions(wallet: string): Promise<any[]> {
  const res = await fetch(`${DATA_API}/positions?user=${wallet}&sizeThreshold=0.01&limit=500`);
  if (!res.ok) throw new Error(`positions HTTP ${res.status}`);
  const raw: any = await res.json();
  return Array.isArray(raw) ? raw : (raw.data ?? []);
}

async function fetchActivity(wallet: string): Promise<any[]> {
  // Fetch enough to cover HOURS_BACK; 200 should cover 24h for active traders
  const res = await fetch(
    `${DATA_API}/activity?user=${wallet}&limit=200&sortBy=TIMESTAMP&sortDirection=DESC`
  );
  if (!res.ok) throw new Error(`activity HTTP ${res.status}`);
  const raw: any = await res.json();
  const items: any[] = Array.isArray(raw) ? raw : (raw.data ?? []);
  // Filter to within time window, only BUY/SELL trades
  return items.filter((t: any) => {
    const ts = parseFloat(t.timestamp ?? '0');
    const type = (t.type ?? t.side ?? '').toUpperCase();
    return ts >= SINCE_SEC && (type === 'BUY' || type === 'SELL');
  });
}

// Fetch mid price from CLOB orderbook for a token
const priceCache = new Map<string, number>();
async function fetchMidPrice(tokenId: string): Promise<number> {
  if (!tokenId) return 0;
  if (priceCache.has(tokenId)) return priceCache.get(tokenId)!;
  try {
    const res  = await fetch(`${CLOB_API}/book?token_id=${tokenId}`);
    if (!res.ok) return 0;
    const book: any = await res.json();
    const bids: any[] = book.bids ?? [];
    const asks: any[] = book.asks ?? [];
    if (bids.length === 0 && asks.length === 0) return 0;
    const bestBid = bids.length > 0 ? Math.max(...bids.map((b: any) => parseFloat(b.price))) : 0;
    const bestAsk = asks.length > 0 ? Math.min(...asks.map((a: any) => parseFloat(a.price))) : 0;
    const mid = bestBid > 0 && bestAsk > 0
      ? (bestBid + bestAsk) / 2
      : bestBid || bestAsk;
    priceCache.set(tokenId, mid);
    return mid;
  } catch {
    return 0;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  TRADER POSITIONS & ${HOURS_BACK}H ACTIVITY  —  ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(100)}\n`);

  let grandValue = 0, grandCost = 0;

  // Summary rows collected for the activity table at the end
  interface ActSummary {
    label: string; side: string; title: string; outcome: string;
    tradePrice: number; curPrice: number; size: number; usdc: number;
    curValue: number; pnl: number; pnlPct: number; ts: string;
  }
  const allActs: ActSummary[] = [];

  // ── Section 1: Open Positions ─────────────────────────────────────────────
  console.log(`  ── OPEN POSITIONS (value > $${MIN_VALUE}) ──\n`);

  for (const trader of TRADERS) {
    let positions: any[];
    try { positions = await fetchPositions(trader.wallet); }
    catch (e: any) { console.log(`  ${trader.label}: ERROR — ${e.message}`); continue; }

    const open = positions
      .map((p: any) => {
        const size  = parseFloat(p.size         ?? '0');
        const cur   = parseFloat(p.curPrice     ?? p.currentPrice  ?? '0');
        const avg   = parseFloat(p.avgPrice     ?? p.averagePrice  ?? '0');
        const value = parseFloat(p.currentValue ?? String(size * cur));
        const cost  = parseFloat(p.initialValue ?? String(size * avg));
        return {
          title:   (p.title ?? p.marketTitle ?? 'Unknown').slice(0, 48),
          outcome: (p.outcome ?? '—').slice(0, 4),
          size, cur, avg, value, cost,
          pnl:    value - cost,
          pnlPct: cost > 0 ? ((value - cost) / cost * 100) : 0,
        };
      })
      .filter(p => p.value > MIN_VALUE)
      .sort((a, b) => b.value - a.value);

    if (open.length === 0) {
      console.log(`  ${trader.label.padEnd(20)}  no open positions > $${MIN_VALUE}`);
      continue;
    }

    const tv = open.reduce((s, p) => s + p.value, 0);
    const tc = open.reduce((s, p) => s + p.cost,  0);
    const tp = tv - tc;
    grandValue += tv; grandCost += tc;

    console.log(`  ┌─ ${trader.label}  (${trader.wallet.slice(0, 10)}…)  ${open.length} pos  val $${tv.toFixed(2)}  cost $${tc.toFixed(2)}  PnL ${tp >= 0 ? '+' : ''}$${tp.toFixed(2)}`);
    console.log(`  │  ${pad('Market', 48)}  Out   Shares    Avg$    Cur$    Value$    PnL%`);
    console.log(`  │  ${'─'.repeat(96)}`);
    for (const p of open) {
      console.log(
        `  │  ${pad(p.title, 48)}  ${pad(p.outcome, 4)}  ` +
        `${rpad(p.size.toFixed(2), 8)}  ` +
        `${rpad(p.avg.toFixed(3), 6)}  ` +
        `${rpad(p.cur.toFixed(3), 6)}  ` +
        `${rpad(p.value.toFixed(2), 8)}  ` +
        `${rpad(pnlStr(p.pnlPct), 7)}`
      );
    }
    console.log(`  └${'─'.repeat(97)}\n`);
  }

  console.log(`  TOTAL OPEN VALUE : $${grandValue.toFixed(2)}  |  cost $${grandCost.toFixed(2)}  |  PnL ${(grandValue - grandCost) >= 0 ? '+' : ''}$${(grandValue - grandCost).toFixed(2)}`);

  // ── Section 2: 24h Activity ───────────────────────────────────────────────
  console.log(`\n\n  ── ${HOURS_BACK}H ACTIVITY (trades & current PnL) ──\n`);

  for (const trader of TRADERS) {
    let acts: any[];
    try { acts = await fetchActivity(trader.wallet); }
    catch (e: any) { console.log(`  ${trader.label}: ERROR — ${e.message}`); continue; }

    if (acts.length === 0) {
      console.log(`  ${trader.label.padEnd(20)}  no activity in last ${HOURS_BACK}h`);
      continue;
    }

    const tv = acts.reduce((s, t) => s + parseFloat(t.usdcSize ?? '0'), 0);
    console.log(`\n  ┌─ ${trader.label}  —  ${acts.length} trade(s) in ${HOURS_BACK}h  |  total $${tv.toFixed(2)} USDC`);
    console.log(`  │  ${'─'.repeat(110)}`);
    console.log(`  │  Time(UTC)           Side  ${pad('Market', 45)}  Out   Size     @Trade   @Now    CurVal$   PnL%`);
    console.log(`  │  ${'─'.repeat(110)}`);

    for (const t of acts) {
      const ts        = new Date(parseFloat(t.timestamp) * 1000).toISOString().slice(0, 16).replace('T', ' ');
      const side      = (t.type ?? t.side ?? '?').toUpperCase().slice(0, 4);
      const title     = (t.title ?? '').slice(0, 45);
      const outcome   = (t.outcome ?? '—').slice(0, 4);
      const size      = parseFloat(t.size ?? '0');
      const tradePrice = parseFloat(t.price ?? '0');
      const usdc      = parseFloat(t.usdcSize ?? '0');
      const tokenId   = t.asset ?? t.tokenId ?? t.assetId ?? '';

      const curPrice  = await fetchMidPrice(tokenId);
      const curValue  = side === 'BUY'  ? size * curPrice : 0;
      const cost      = side === 'BUY'  ? usdc            : 0;
      const pnl       = side === 'BUY'  ? curValue - cost : 0;
      const pnlP      = cost > 0        ? (pnl / cost * 100) : 0;

      const curValStr = side === 'BUY' ? `$${curValue.toFixed(2)}` : '(sold)';
      const pnlDisp   = side === 'BUY' ? rpad(pnlStr(pnlP), 7)    : '  —    ';

      console.log(
        `  │  ${ts}  ${rpad(side, 4)}  ${pad(title, 45)}  ${pad(outcome, 4)}  ` +
        `${rpad(size.toFixed(2), 7)}  ` +
        `${rpad(tradePrice.toFixed(3), 7)}  ` +
        `${rpad(curPrice > 0 ? curPrice.toFixed(3) : '  —  ', 6)}  ` +
        `${rpad(curValStr, 9)}  ` +
        `${pnlDisp}`
      );

      allActs.push({ label: trader.label, side, title, outcome, tradePrice, curPrice, size, usdc, curValue, pnl, pnlP, ts });
    }
    console.log(`  └${'─'.repeat(111)}\n`);
  }

  // ── Section 3: Activity Summary ───────────────────────────────────────────
  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  ACTIVITY SUMMARY  —  last ${HOURS_BACK}h`);
  console.log(`${'═'.repeat(100)}`);

  const buys  = allActs.filter(a => a.side === 'BUY');
  const sells = allActs.filter(a => a.side === 'SELL');
  const totalBuyUsdc  = buys.reduce((s, a) => s + a.usdc, 0);
  const totalSellUsdc = sells.reduce((s, a) => s + a.usdc, 0);
  const totalCurVal   = buys.reduce((s, a) => s + a.curValue, 0);
  const totalPnl      = buys.reduce((s, a) => s + a.pnl, 0);

  console.log(`\n  Total trades   : ${allActs.length}  (${buys.length} BUY  /  ${sells.length} SELL)`);
  console.log(`  Total BUY USDC : $${totalBuyUsdc.toFixed(2)}`);
  console.log(`  Total SELL USDC: $${totalSellUsdc.toFixed(2)}`);
  console.log(`  Open BUY value : $${totalCurVal.toFixed(2)}  (cost $${totalBuyUsdc.toFixed(2)})  PnL ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);

  if (buys.length > 0) {
    console.log(`\n  Top BUY positions by current PnL:`);
    const sorted = [...buys].sort((a, b) => b.pnl - a.pnl);
    for (const a of sorted.slice(0, 10)) {
      console.log(
        `    ${a.label.padEnd(20)}  ${pad(a.title, 45)}  ${pad(a.outcome, 4)}  ` +
        `@${a.tradePrice.toFixed(3)} → ${a.curPrice > 0 ? a.curPrice.toFixed(3) : '  —  '}  ` +
        `PnL ${pnlStr(a.pnlP).padStart(7)}`
      );
    }
  }

  console.log(`\n${'═'.repeat(100)}\n`);
}

main().catch(console.error);
