/**
 * Check open positions and recent fills for the bot wallet.
 * Run with: npx ts-node check-positions.ts
 */

import { config } from './src/config';

const DATA_API = config.dataApiBase || 'https://data-api.polymarket.com';
const wallet   = config.botWalletAddress;

async function main() {
  console.log(`\nBot wallet: ${wallet}\n`);

  // ── 1. Open positions ──────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════');
  console.log('  OPEN POSITIONS');
  console.log('══════════════════════════════════════════');

  const posRes  = await fetch(`${DATA_API}/positions?user=${wallet}&sizeThreshold=0.01&limit=500`);
  const posRaw  = await posRes.json() as any;
  const positions: any[] = Array.isArray(posRaw) ? posRaw : (posRaw.data ?? []);

  if (positions.length === 0) {
    console.log('  No open positions found.');
  } else {
    let totalCurrentValue = 0;
    let totalInitialValue = 0;
    let totalCashPnl      = 0;

    positions.forEach((p: any, i: number) => {
      const size         = parseFloat(p.size          ?? '0');
      const curPrice     = parseFloat(p.curPrice      ?? p.currentPrice ?? '0');
      const avgPrice     = parseFloat(p.avgPrice      ?? p.averagePrice ?? '0');
      const currentValue = parseFloat(p.currentValue  ?? String(size * curPrice));
      const initialValue = parseFloat(p.initialValue  ?? String(size * avgPrice));
      const cashPnl      = parseFloat(p.cashPnl       ?? String(currentValue - initialValue));
      const percentPnl   = avgPrice > 0 ? ((curPrice - avgPrice) / avgPrice * 100) : 0;

      totalCurrentValue += currentValue;
      totalInitialValue += initialValue;
      totalCashPnl      += cashPnl;

      const pnlSign = cashPnl >= 0 ? '+' : '';
      console.log(
        `\n  [${i + 1}] ${p.title ?? p.outcome ?? 'Unknown market'}\n` +
        `      Outcome   : ${p.outcome ?? '—'}\n` +
        `      Shares    : ${size.toFixed(4)}\n` +
        `      Avg price : $${avgPrice.toFixed(4)}\n` +
        `      Cur price : $${curPrice.toFixed(4)}\n` +
        `      Cost      : $${initialValue.toFixed(2)}\n` +
        `      Value now : $${currentValue.toFixed(2)}\n` +
        `      PnL       : ${pnlSign}$${cashPnl.toFixed(2)}  (${pnlSign}${percentPnl.toFixed(1)}%)`
      );
    });

    const totalPnlSign = totalCashPnl >= 0 ? '+' : '';
    console.log('\n──────────────────────────────────────────');
    console.log(`  Total cost      : $${totalInitialValue.toFixed(2)}`);
    console.log(`  Total value now : $${totalCurrentValue.toFixed(2)}`);
    console.log(`  Total PnL       : ${totalPnlSign}$${totalCashPnl.toFixed(2)}`);
    console.log('══════════════════════════════════════════\n');
  }

  // ── 2. Recent fills (last 20 trades) ──────────────────────────────────────
  console.log('══════════════════════════════════════════');
  console.log('  RECENT FILLS (last 20)');
  console.log('══════════════════════════════════════════');

  const tradeRes  = await fetch(
    `${DATA_API}/activity?user=${wallet}&limit=20&sortBy=TIMESTAMP&sortDirection=DESC`
  );
  const trades: any[] = await tradeRes.json() as any[];

  if (!Array.isArray(trades) || trades.length === 0) {
    console.log('  No recent trades found.');
  } else {
    trades.forEach((t: any, i: number) => {
      const ts   = new Date((parseFloat(t.timestamp) * 1000)).toISOString();
      const usdc = parseFloat(t.usdcSize ?? '0').toFixed(2);
      console.log(
        `\n  [${i + 1}] ${ts}\n` +
        `      ${t.side ?? t.type} ${t.outcome} @ $${parseFloat(t.price ?? '0').toFixed(4)}\n` +
        `      Size: ${parseFloat(t.size ?? '0').toFixed(4)} shares  |  USDC: $${usdc}\n` +
        `      Market: ${(t.title ?? '').slice(0, 60)}\n` +
        `      Tx: ${t.transactionHash ?? '—'}`
      );
    });
  }

  console.log('\n══════════════════════════════════════════\n');
}

main().catch(console.error);
