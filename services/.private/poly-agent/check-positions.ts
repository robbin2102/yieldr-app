/**
 * Check open positions and recent fills for the bot wallet.
 * Run with: npx tsx check-positions.ts
 *
 * Shows:
 *   1. Open positions with current value > $1
 *   2. Last 30 trades
 *   3. Trade activity summary grouped by market, bucketed by hour (1h, 2h, 3h...)
 */

import { config } from './src/config';

const DATA_API = config.dataApiBase || 'https://data-api.polymarket.com';
const wallet   = config.botWalletAddress;

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m ago` : `${h}h ago`;
}

async function main() {
  console.log(`\nBot wallet: ${wallet}\n`);

  // ── 1. Open positions (current value > $1) ───────────────────────────────────
  console.log('══════════════════════════════════════════');
  console.log('  OPEN POSITIONS  (value > $1)');
  console.log('══════════════════════════════════════════');

  const posRes  = await fetch(`${DATA_API}/positions?user=${wallet}&sizeThreshold=0.01&limit=500`);
  const posRaw  = await posRes.json() as any;
  const allPositions: any[] = Array.isArray(posRaw) ? posRaw : (posRaw.data ?? []);

  const positions = allPositions.filter((p: any) => {
    const size     = parseFloat(p.size         ?? '0');
    const curPrice = parseFloat(p.curPrice     ?? p.currentPrice ?? '0');
    const curVal   = parseFloat(p.currentValue ?? String(size * curPrice));
    return curVal > 1;
  });

  if (positions.length === 0) {
    console.log('  No positions with value > $1.');
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
      const tokenId = p.asset ?? p.tokenId ?? '—';
      console.log(
        `\n  [${i + 1}] ${p.title ?? p.outcome ?? 'Unknown market'}\n` +
        `      Outcome   : ${p.outcome ?? '—'}\n` +
        `      TokenId   : ${tokenId}\n` +
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
    console.log(`  Positions shown : ${positions.length} of ${allPositions.length} total`);
    console.log(`  Total cost      : $${totalInitialValue.toFixed(2)}`);
    console.log(`  Total value now : $${totalCurrentValue.toFixed(2)}`);
    console.log(`  Total PnL       : ${totalPnlSign}$${totalCashPnl.toFixed(2)}`);
    console.log('══════════════════════════════════════════\n');
  }

  // ── 2. Last 30 trades ────────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════');
  console.log('  RECENT FILLS (last 30)');
  console.log('══════════════════════════════════════════');

  const tradeRes = await fetch(
    `${DATA_API}/activity?user=${wallet}&limit=30&sortBy=TIMESTAMP&sortDirection=DESC`
  );
  const trades: any[] = await tradeRes.json() as any[];

  if (!Array.isArray(trades) || trades.length === 0) {
    console.log('  No recent trades found.');
  } else {
    trades.forEach((t: any, i: number) => {
      const tsMs = parseFloat(t.timestamp) * 1000;
      const ts   = new Date(tsMs).toISOString().slice(0, 19).replace('T', ' ');
      const ago  = timeAgo(tsMs);
      const usdc = parseFloat(t.usdcSize ?? '0').toFixed(2);
      console.log(
        `\n  [${i + 1}] ${ts}  (${ago})\n` +
        `      ${t.side ?? t.type} ${t.outcome} @ $${parseFloat(t.price ?? '0').toFixed(4)}\n` +
        `      Size: ${parseFloat(t.size ?? '0').toFixed(4)} shares  |  USDC: $${usdc}\n` +
        `      Market: ${(t.title ?? '').slice(0, 60)}\n` +
        `      Tx: ${t.transactionHash ?? '—'}`
      );
    });
  }

  // ── 3. Activity summary by market, bucketed by hour ─────────────────────────
  if (Array.isArray(trades) && trades.length > 0) {
    console.log('\n══════════════════════════════════════════');
    console.log('  TRADE SUMMARY BY MARKET');
    console.log('  (bucketed by hour: 1h = 0-60m ago, 2h = 60-120m ago, ...)');
    console.log('══════════════════════════════════════════');

    const now = Date.now();
    // Group trades by market title
    const byMarket = new Map<string, any[]>();
    for (const t of trades) {
      const key = (t.title ?? 'Unknown').slice(0, 55);
      if (!byMarket.has(key)) byMarket.set(key, []);
      byMarket.get(key)!.push(t);
    }

    for (const [market, mTrades] of byMarket) {
      // Bucket into hours: bucket 1 = 0-60m, bucket 2 = 60-120m, etc.
      const buckets = new Map<number, { buys: number; sells: number; usdcBuy: number; usdcSell: number; prices: number[] }>();

      for (const t of mTrades) {
        const tsMs  = parseFloat(t.timestamp) * 1000;
        const diffM = (now - tsMs) / 60000;
        const bucket = Math.ceil(diffM / 60) || 1; // 1-indexed hour bucket
        if (!buckets.has(bucket)) buckets.set(bucket, { buys: 0, sells: 0, usdcBuy: 0, usdcSell: 0, prices: [] });
        const b = buckets.get(bucket)!;
        const price = parseFloat(t.price ?? '0');
        const usdc  = parseFloat(t.usdcSize ?? '0');
        if ((t.side ?? t.type) === 'BUY') { b.buys++; b.usdcBuy += usdc; }
        else                              { b.sells++; b.usdcSell += usdc; }
        if (price > 0) b.prices.push(price);
      }

      console.log(`\n  ${market}`);
      const sortedBuckets = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
      for (const [bucket, b] of sortedBuckets) {
        const label    = bucket === 1 ? 'last 1h' : `${bucket - 1}h–${bucket}h ago`;
        const avgPrice = b.prices.length > 0 ? (b.prices.reduce((a, c) => a + c, 0) / b.prices.length) : 0;
        const parts: string[] = [];
        if (b.buys  > 0) parts.push(`BUY ×${b.buys} $${b.usdcBuy.toFixed(2)}`);
        if (b.sells > 0) parts.push(`SELL ×${b.sells} $${b.usdcSell.toFixed(2)}`);
        console.log(`      [${label.padEnd(12)}]  ${parts.join('  ')}  | avg fill $${avgPrice.toFixed(4)}`);
      }
    }

    console.log('\n══════════════════════════════════════════\n');
  }
}

main().catch(console.error);
