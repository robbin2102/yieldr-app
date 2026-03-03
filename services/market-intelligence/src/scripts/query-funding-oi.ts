/**
 * One-off script: fetch latest Funding Rate + OI from market_snapshots for BTC & ETH
 * Run: tsx src/scripts/query-funding-oi.ts
 */

import { connectDB, disconnectDB } from '../db';
import MarketSnapshot from '../models/MarketSnapshot';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];

function fmt(n: number | undefined, mult = 1, decimals = 4, suffix = '') {
  if (n === undefined || n === null) return 'n/a';
  return (n * mult).toFixed(decimals) + suffix;
}

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('📊 FUNDING RATE + OPEN INTEREST  —  RAW MONGO DATA');
  console.log('='.repeat(80));

  await connectDB();

  for (const symbol of SYMBOLS) {
    const asset = symbol.replace('USDT', '');

    // 4 most recent hourly snapshots
    const docs = await MarketSnapshot
      .find({ symbol })
      .sort({ timestamp: -1 })
      .limit(4)
      .select('timestamp derivatives')
      .lean();

    if (!docs.length) {
      console.log(`\n⚠️  No data for ${symbol}`);
      continue;
    }

    console.log(`\n${'─'.repeat(80)}`);
    console.log(`⚡ ${asset}  (${docs.length} snapshots, newest first)`);
    console.log(`${'─'.repeat(80)}`);

    for (const doc of docs) {
      const ts = new Date(doc.timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = (doc as any).derivatives ?? {};

      const fr  = d.funding_rate    ?? {};
      const oi  = d.open_interest   ?? {};
      const ls  = d.long_short_ratio ?? {};
      const gA  = ls.global_accounts  ?? {};
      const tA  = ls.top_accounts     ?? {};
      const tP  = ls.top_positions    ?? {};

      console.log(`\n  🕐 ${ts}`);

      // Funding
      console.log(`     💸 Funding:`);
      console.log(`        current     = ${fmt(fr.current,    100, 6, '%')}   (raw: ${fr.current ?? 'n/a'})`);
      console.log(`        annualized  = ${fmt(fr.annualized, 100, 2, '%')}`);

      // OI
      const oiB = oi.total_usd !== undefined ? `$${(oi.total_usd / 1e9).toFixed(3)}B` : 'n/a';
      console.log(`     📈 OI:`);
      console.log(`        total       = ${oiB}`);
      console.log(`        4h chg      = ${fmt(oi.change_4h_pct,  1, 2, '%')}`);
      console.log(`        24h chg     = ${fmt(oi.change_24h_pct, 1, 2, '%')}`);

      // L/S
      console.log(`     ⚖️  Long/Short:`);
      console.log(`        Global     L=${fmt(gA.long,  100,1,'%')} / S=${fmt(gA.short, 100,1,'%')}  ratio=${fmt(gA.ratio, 1, 3)}`);
      console.log(`        TopTrader  L=${fmt(tA.long,  100,1,'%')} / S=${fmt(tA.short, 100,1,'%')}  ratio=${fmt(tA.ratio, 1, 3)}`);
      console.log(`        TopPos     L=${fmt(tP.long,  100,1,'%')} / S=${fmt(tP.short, 100,1,'%')}  ratio=${fmt(tP.ratio, 1, 3)}`);
    }
  }

  console.log('\n' + '='.repeat(80) + '\n');
  await disconnectDB();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ ERROR:', err.message, err.stack);
  process.exit(1);
});
