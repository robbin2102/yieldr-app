/**
 * npm run fetch-macro
 * Fetches and saves the daily macro snapshot (ETF flows, fear/greed, stablecoin mcap).
 * Prints all fetched values and the MongoDB _id of the saved document.
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '../../.env.local' });

import { connectDB, disconnectDB } from '../db';
import { buildAndSaveMacroDaily } from '../processors/macro-builder';

// ─── Formatting helpers ────────────────────────────────────────────────────────

function usd(val: number | null | undefined): string {
  if (val == null) return 'N/A';
  const abs = Math.abs(val);
  const sign = val >= 0 ? '+' : '-';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function n(val: number | null | undefined, decimals = 4): string {
  if (val == null) return 'N/A';
  return val.toFixed(decimals);
}

// ─── Rich console output ───────────────────────────────────────────────────────

function printMacroSnapshot(docId: string, doc: Record<string, unknown>): void {
  const date  = (doc.date as Date).toISOString().split('T')[0];
  const btcEtf  = doc.btc_etf as any;
  const ethEtf  = doc.eth_etf as any;
  const fg      = doc.fear_greed as any;
  const stable  = doc.stablecoin_mcap as any;
  const premium = doc.coinbase_premium as any;

  const LINE = '═'.repeat(70);
  console.log(`\n${LINE}`);
  console.log(`  MACRO DAILY  |  ${date}  |  Mongo _id: ${docId}`);
  console.log(LINE);

  // ── Fear & Greed ──────────────────────────────────────────────────────
  console.log('\nFEAR & GREED');
  console.log(`  Value:          ${fg?.value ?? 'N/A'}`);
  console.log(`  Classification: ${fg?.classification ?? 'N/A'}`);

  // ── BTC ETF ───────────────────────────────────────────────────────────
  console.log('\nBTC ETF');
  console.log(`  Total flow:   ${usd(btcEtf?.total_flow_usd)}`);
  console.log(`  Net assets:   ${usd(btcEtf?.net_assets_usd)}`);
  const btcFlows: Array<{ ticker: string; flow_usd: number }> = btcEtf?.flows_by_ticker ?? [];
  if (btcFlows.length > 0) {
    console.log('  By ticker:');
    for (const f of btcFlows) {
      console.log(`    ${f.ticker.padEnd(6)} ${usd(f.flow_usd)}`);
    }
  }

  // ── ETH ETF ───────────────────────────────────────────────────────────
  console.log('\nETH ETF');
  console.log(`  Total flow:   ${usd(ethEtf?.total_flow_usd)}`);
  const ethFlows: Array<{ ticker: string; flow_usd: number }> = ethEtf?.flows_by_ticker ?? [];
  if (ethFlows.length > 0) {
    console.log('  By ticker:');
    for (const f of ethFlows) {
      console.log(`    ${f.ticker.padEnd(6)} ${usd(f.flow_usd)}`);
    }
  }

  // ── Coinbase Premium ──────────────────────────────────────────────────
  console.log('\nCOINBASE PREMIUM');
  console.log(`  BTC: ${n(premium?.btc)}`);
  console.log(`  ETH: ${premium?.eth != null ? n(premium.eth) : 'N/A'}`);

  // ── Stablecoin Mcap ───────────────────────────────────────────────────
  console.log('\nSTABLECOIN MARKET CAP');
  console.log(`  Total:     ${usd(stable?.total_usd)}`);
  console.log(`  Change 24h:${usd(stable?.change_24h_usd)}`);

  console.log('');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await connectDB();

  try {
    const { _id, doc } = await buildAndSaveMacroDaily();
    printMacroSnapshot(_id, doc);
  } catch (err: any) {
    console.error('✗ fetch-macro failed:', err.message ?? err);
    await disconnectDB();
    process.exit(1);
  }

  await disconnectDB();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
