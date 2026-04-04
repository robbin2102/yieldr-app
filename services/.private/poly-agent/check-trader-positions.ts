/**
 * check-trader-positions.ts — fetch open positions for all tracked traders.
 *
 * Shows positions with current value > $0 per trader, with a summary table.
 *
 * Usage:
 *   npx tsx check-trader-positions.ts
 *   npx tsx check-trader-positions.ts --min-value 1   # filter by min $ value
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

const minValueArg = process.argv.indexOf('--min-value');
const MIN_VALUE   = minValueArg !== -1 ? parseFloat(process.argv[minValueArg + 1]) : 0;

async function fetchPositions(wallet: string): Promise<any[]> {
  const url = `${DATA_API}/positions?user=${wallet}&sizeThreshold=0.01&limit=500`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${wallet}`);
  const raw: any = await res.json();
  return Array.isArray(raw) ? raw : (raw.data ?? []);
}

function pad(s: string, n: number) { return s.slice(0, n).padEnd(n); }
function rpad(s: string, n: number) { return s.slice(0, n).padStart(n); }

async function main() {
  const minLabel = MIN_VALUE > 0 ? ` (min value $${MIN_VALUE})` : '';
  console.log(`\nTrader open positions${minLabel} — ${new Date().toISOString()}\n`);

  let grandTotal = 0;
  let grandCost  = 0;

  for (const trader of TRADERS) {
    let positions: any[];
    try {
      positions = await fetchPositions(trader.wallet);
    } catch (e: any) {
      console.log(`  ${trader.label}: ERROR — ${e.message}`);
      continue;
    }

    // Filter to positions with current value > MIN_VALUE
    const open = positions
      .map((p: any) => {
        const size    = parseFloat(p.size         ?? '0');
        const cur     = parseFloat(p.curPrice     ?? p.currentPrice  ?? '0');
        const avg     = parseFloat(p.avgPrice     ?? p.averagePrice  ?? '0');
        const value   = parseFloat(p.currentValue ?? String(size * cur));
        const cost    = parseFloat(p.initialValue ?? String(size * avg));
        const pnl     = value - cost;
        const pnlPct  = cost > 0 ? (pnl / cost * 100) : 0;
        return {
          title:   (p.title ?? p.marketTitle ?? 'Unknown').slice(0, 48),
          outcome: (p.outcome ?? '—').slice(0, 4),
          size, cur, avg, value, cost, pnl, pnlPct,
        };
      })
      .filter(p => p.value > MIN_VALUE)
      .sort((a, b) => b.value - a.value);

    if (open.length === 0) {
      console.log(`  ${trader.label.padEnd(20)}  —  no open positions > $${MIN_VALUE}`);
      continue;
    }

    const traderValue = open.reduce((s, p) => s + p.value, 0);
    const traderCost  = open.reduce((s, p) => s + p.cost,  0);
    const traderPnl   = traderValue - traderCost;
    grandTotal += traderValue;
    grandCost  += traderCost;

    console.log(`\n  ┌─ ${trader.label}  (${trader.wallet.slice(0, 10)}…)`);
    console.log(`  │  ${open.length} position(s)  |  value $${traderValue.toFixed(2)}  |  cost $${traderCost.toFixed(2)}  |  PnL ${traderPnl >= 0 ? '+' : ''}$${traderPnl.toFixed(2)}`);
    console.log(`  │`);
    console.log(`  │  ${pad('Market', 48)}  Out   Shares   Avg$    Cur$    Value$    PnL%`);
    console.log(`  │  ${'─'.repeat(95)}`);

    for (const p of open) {
      const pnlStr = (p.pnlPct >= 0 ? '+' : '') + p.pnlPct.toFixed(1) + '%';
      console.log(
        `  │  ${pad(p.title, 48)}  ${pad(p.outcome, 4)}  ` +
        `${rpad(p.size.toFixed(2), 7)}  ` +
        `${rpad(p.avg.toFixed(3), 6)}  ` +
        `${rpad(p.cur.toFixed(3), 6)}  ` +
        `${rpad(p.value.toFixed(2), 8)}  ` +
        `${rpad(pnlStr, 7)}`
      );
    }
    console.log(`  └${'─'.repeat(96)}`);
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  GRAND TOTAL VALUE : $${grandTotal.toFixed(2)}`);
  console.log(`  GRAND TOTAL COST  : $${grandCost.toFixed(2)}`);
  const grandPnl = grandTotal - grandCost;
  console.log(`  GRAND PnL         : ${grandPnl >= 0 ? '+' : ''}$${grandPnl.toFixed(2)}`);
  console.log(`${'═'.repeat(50)}\n`);
}

main().catch(console.error);
