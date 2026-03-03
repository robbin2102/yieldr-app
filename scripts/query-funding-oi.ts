/**
 * Fetch latest Funding Rate + OI data from market_snapshots for BTC & ETH
 */

import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import connectDB from '../lib/mongoose.js';
import MarketSnapshot from '../services/market-intelligence/src/models/MarketSnapshot.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('📊 FUNDING RATE + OPEN INTEREST — LIVE MONGO DATA');
  console.log('='.repeat(80));

  await connectDB();

  for (const symbol of SYMBOLS) {
    const asset = symbol.replace('USDT', '');

    // Fetch the 4 most recent snapshots (covers ~4h at 1h interval)
    const docs = await MarketSnapshot
      .find({ symbol })
      .sort({ timestamp: -1 })
      .limit(4)
      .select('timestamp derivatives')
      .lean();

    if (!docs.length) {
      console.log(`\n⚠️  No data found for ${symbol}`);
      continue;
    }

    console.log(`\n${'─'.repeat(80)}`);
    console.log(`⚡ ${asset}  (${docs.length} snapshots)`);
    console.log(`${'─'.repeat(80)}`);

    for (const doc of docs) {
      const ts = new Date(doc.timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      const d  = doc.derivatives as any;

      const fr  = d?.funding_rate   ?? {};
      const oi  = d?.open_interest  ?? {};
      const ls  = d?.long_short_ratio ?? {};

      const current     = fr.current     !== undefined ? (fr.current     * 100).toFixed(6)  + '%'  : 'n/a';
      const annualized  = fr.annualized  !== undefined ? (fr.annualized  * 100).toFixed(2)  + '%'  : 'n/a';
      const oiTotal     = oi.total_usd   !== undefined ? '$' + (oi.total_usd / 1e9).toFixed(3) + 'B' : 'n/a';
      const oi4h        = oi.change_4h_pct !== undefined ? (oi.change_4h_pct >= 0 ? '+' : '') + oi.change_4h_pct.toFixed(2) + '%' : 'n/a';

      const globalL  = ls.global_accounts?.long  !== undefined ? (ls.global_accounts.long  * 100).toFixed(1) + '%' : 'n/a';
      const globalS  = ls.global_accounts?.short !== undefined ? (ls.global_accounts.short * 100).toFixed(1) + '%' : 'n/a';
      const topAccL  = ls.top_accounts?.long     !== undefined ? (ls.top_accounts.long     * 100).toFixed(1) + '%' : 'n/a';
      const topAccS  = ls.top_accounts?.short    !== undefined ? (ls.top_accounts.short    * 100).toFixed(1) + '%' : 'n/a';
      const topPosL  = ls.top_positions?.long    !== undefined ? (ls.top_positions.long    * 100).toFixed(1) + '%' : 'n/a';
      const topPosS  = ls.top_positions?.short   !== undefined ? (ls.top_positions.short   * 100).toFixed(1) + '%' : 'n/a';

      console.log(`\n  🕐 ${ts}`);
      console.log(`     Funding   current=${current}  annualized=${annualized}`);
      console.log(`     OI        total=${oiTotal}  4h_chg=${oi4h}`);
      console.log(`     L/S  Global=${globalL}/${globalS}  TopTrader=${topAccL}/${topAccS}  TopPosition=${topPosL}/${topPosS}`);
    }
  }

  console.log('\n' + '='.repeat(80) + '\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ ERROR:', err.message);
  process.exit(1);
});
