/**
 * npm run fetch-coin BTC ETH SOL
 * Fetches and saves data for one or more coins, processed one by one.
 * Prints all indicators, derivatives, computed fields, and the MongoDB _id.
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '../../.env.local' });

import { connectDB, disconnectDB } from '../db';
import { fetchAllCoins } from '../fetchers/taapi';
import { fetchAggregateData, fetchPerCoinData, fetchCoinbasePremium } from '../fetchers/coinglass';
import { fetchBinanceCandle } from '../fetchers/binance';
import { buildAndSaveSnapshot } from '../processors/snapshot-builder';
import { logger } from '../utils/logger';

// ─── Formatting helpers ────────────────────────────────────────────────────────

function n(val: number | null | undefined, decimals = 2): string {
  if (val == null) return 'N/A';
  return val.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function usd(val: number | null | undefined): string {
  if (val == null) return 'N/A';
  const abs = Math.abs(val);
  const sign = val >= 0 ? '' : '-';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function pct(val: number | null | undefined, decimals = 4): string {
  if (val == null) return 'N/A';
  return (val >= 0 ? '+' : '') + val.toFixed(decimals) + '%';
}

// ─── Rich console output ───────────────────────────────────────────────────────

function printCoinSnapshot(docId: string, snapshot: Record<string, unknown>): void {
  const sym  = snapshot.symbol as string;
  const ts   = (snapshot.timestamp as Date).toISOString();
  const ind  = snapshot.indicators as any;
  const price = snapshot.price as any;
  const der  = snapshot.derivatives as any;
  const comp = snapshot.computed as any;
  const ms   = comp.market_structure as any;
  const pp   = ind.pivot_points as any;
  const fib  = ind.fibonacci as any;
  const ich  = ind.ichimoku as any;
  const activePatterns = ((snapshot.candlestick_patterns as any[]) ?? []).filter(p => p.value !== 0);

  const LINE = '═'.repeat(70);
  console.log(`\n${LINE}`);
  console.log(`  ${sym}  |  ${ts}  |  Mongo _id: ${docId}`);
  console.log(LINE);

  // ── Price ──────────────────────────────────────────────────────────────
  console.log('\nPRICE (1h Coinbase candle)');
  console.log(`  Open:   $${n(price?.open)}   Close:  $${n(price?.close)}`);
  console.log(`  High:   $${n(price?.high)}   Low:    $${n(price?.low)}`);
  console.log(`  Volume: ${n(price?.volume, 4)}`);

  // ── Moving Averages ───────────────────────────────────────────────────
  console.log('\nINDICATORS — Moving Averages');
  console.log(`  EMA   8:  $${n(ind.ema_8)}`);
  console.log(`  EMA  21:  $${n(ind.ema_21)}`);
  console.log(`  EMA  50:  $${n(ind.ema_50)}`);
  console.log(`  EMA 200:  $${n(ind.ema_200)}`);
  console.log(`  SMA  50:  $${n(ind.sma_50)}`);
  console.log(`  SMA 200:  $${n(ind.sma_200)}`);
  console.log(`  VWAP:     $${n(ind.vwap)}`);
  console.log(`  OBV:      ${n(ind.obv, 0)}`);
  console.log(`  CMF:      ${n(ind.cmf, 6)}`);

  // ── Momentum ──────────────────────────────────────────────────────────
  console.log('\nINDICATORS — Momentum');
  console.log(`  RSI-14:     ${n(ind.rsi_14)}`);
  console.log(`  MACD:       line=${n(ind.macd?.macd_line, 4)}  signal=${n(ind.macd?.signal_line, 4)}  histogram=${n(ind.macd?.histogram, 4)}`);
  console.log(`  StochRSI:   K=${n(ind.stoch_rsi?.k)}  D=${n(ind.stoch_rsi?.d)}`);
  console.log(`  ADX:        ${n(ind.adx?.adx)}  +DI=${n(ind.adx?.plus_di)}  -DI=${n(ind.adx?.minus_di)}`);
  console.log(`  Momentum:   ${n(ind.momentum, 4)}`);
  console.log(`  ATR-14:     ${n(ind.atr_14, 4)}`);

  // ── Bollinger Bands ───────────────────────────────────────────────────
  console.log('\nINDICATORS — Bollinger Bands');
  console.log(`  Upper:     $${n(ind.bbands?.upper)}`);
  console.log(`  Middle:    $${n(ind.bbands?.middle)}`);
  console.log(`  Lower:     $${n(ind.bbands?.lower)}`);
  console.log(`  Bandwidth: ${n(ind.bbands?.bandwidth, 4)}`);
  console.log(`  Squeeze:   value=${n(ind.squeeze?.value, 4)}  is_squeeze=${ind.squeeze?.is_squeeze ?? 'N/A'}`);

  // ── Ichimoku ──────────────────────────────────────────────────────────
  console.log('\nINDICATORS — Ichimoku');
  console.log(`  Tenkan:        $${n(ich?.tenkan)}`);
  console.log(`  Kijun:         $${n(ich?.kijun)}`);
  console.log(`  Senkou A:      $${n(ich?.senkou_a)}`);
  console.log(`  Senkou B:      $${n(ich?.senkou_b)}`);
  console.log(`  Current span A:$${n(ich?.current_span_a)}`);
  console.log(`  Current span B:$${n(ich?.current_span_b)}`);
  console.log(`  Lagging span A:${n(ich?.lagging_span_a, 0)}`);
  console.log(`  Lagging span B:${n(ich?.lagging_span_b, 0)}`);

  // ── Trend ─────────────────────────────────────────────────────────────
  console.log('\nINDICATORS — Trend');
  console.log(`  Supertrend:  $${n(ind.supertrend?.value)}  dir=${ind.supertrend?.direction ?? 'N/A'}`);
  console.log(`  PSAR:        $${n(ind.psar)}`);

  // ── Pivots ────────────────────────────────────────────────────────────
  console.log('\nINDICATORS — Pivot Points (classic floor)');
  console.log(`  PP:  $${n(pp?.pp)}`);
  console.log(`  R1:  $${n(pp?.r1)}   R2: $${n(pp?.r2)}   R3: $${n(pp?.r3)}`);
  console.log(`  S1:  $${n(pp?.s1)}   S2: $${n(pp?.s2)}   S3: $${n(pp?.s3)}`);

  // ── Fibonacci ─────────────────────────────────────────────────────────
  console.log('\nINDICATORS — Fibonacci Retracement');
  console.log(`  Trend:  ${fib?.trend ?? 'N/A'}`);
  console.log(`  0.236: $${n(fib?.level_236)}   0.382: $${n(fib?.level_382)}`);
  console.log(`  0.500: $${n(fib?.level_500)}   0.618: $${n(fib?.level_618)}   0.786: $${n(fib?.level_786)}`);

  // ── Swing Points ──────────────────────────────────────────────────────
  console.log('\nINDICATORS — Swing Points');
  console.log(`  Swing High: close=$${n(ind.swing_high?.close)}  high=$${n(ind.swing_high?.high)}`);
  console.log(`  Swing Low:  close=$${n(ind.swing_low?.close)}   low=$${n(ind.swing_low?.low)}`);

  // ── Market Structure ──────────────────────────────────────────────────
  console.log('\nMARKET STRUCTURE');
  console.log(`  Trend:            ${ms.trend ?? 'N/A'}`);
  console.log(`  EMA alignment:    ${ms.ema_alignment ?? 'N/A'}`);
  console.log(`  Supertrend dir:   ${ms.supertrend_direction ?? 'N/A'}`);
  console.log(`  RSI zone:         ${ms.rsi_zone ?? 'N/A'}`);
  console.log(`  Price vs VWAP:    ${ms.price_vs_vwap ?? 'N/A'}`);
  console.log(`  MACD bias:        ${ms.macd_bias ?? 'N/A'}`);
  console.log(`  Funding bias:     ${ms.funding_bias ?? 'N/A'}`);
  console.log(`  Ichimoku cloud:   ${ms.ichimoku_cloud_bias ?? 'N/A'}`);
  console.log(`  TK cross:         ${ms.ichimoku_tk_cross ?? 'N/A'}`);

  // ── MA Crossovers ─────────────────────────────────────────────────────
  console.log('\nMA CROSSOVERS (current alignment)');
  for (const cross of (comp.ma_crossovers as any[])) {
    const fast = n(cross.fast_value);
    const slow = n(cross.slow_value);
    const arrow = cross.state === 'above' ? '▲' : '▼';
    console.log(`  ${cross.fast.padEnd(6)} ${arrow} ${cross.slow.padEnd(6)}  ($${fast} vs $${slow})`);
  }

  // ── Derivatives ───────────────────────────────────────────────────────
  console.log('\nDERIVATIVES');
  const oi = der.open_interest;
  console.log(`  Open Interest:  ${usd(oi?.total_usd)}  (4h: ${pct(oi?.change_4h_pct)}  24h: ${pct(oi?.change_24h_pct)})`);
  const fr = der.funding_rate;
  const frCurrent   = fr?.current   != null ? (fr.current   * 100).toFixed(4) + '%' : 'N/A';
  const frOiW       = fr?.oi_weighted != null ? (fr.oi_weighted * 100).toFixed(4) + '%' : 'N/A';
  const frAnn       = fr?.annualized != null ? fr.annualized.toFixed(2) + '%' : 'N/A';
  console.log(`  Funding rate:   ${frCurrent}  (OI-weighted: ${frOiW}  annualized: ${frAnn})`);
  const ls = der.long_short_ratio;
  console.log(`  L/S Global:     L=${n(ls?.global_accounts?.long, 1)}%  S=${n(ls?.global_accounts?.short, 1)}%  ratio=${n(ls?.global_accounts?.ratio, 4)}`);
  console.log(`  L/S Top Accts:  L=${n(ls?.top_accounts?.long, 1)}%  S=${n(ls?.top_accounts?.short, 1)}%  ratio=${n(ls?.top_accounts?.ratio, 4)}`);
  console.log(`  L/S Top Pos:    L=${n(ls?.top_positions?.long, 1)}%  S=${n(ls?.top_positions?.short, 1)}%  ratio=${n(ls?.top_positions?.ratio, 4)}`);
  const liq = der.liquidations;
  console.log(`  Liq Latest:     Long=${usd(liq?.latest?.long_usd)}  Short=${usd(liq?.latest?.short_usd)}`);
  console.log(`  Liq 4h:         Long=${usd(liq?.h4?.long_usd)}  Short=${usd(liq?.h4?.short_usd)}`);
  console.log(`  Liq 24h:        Long=${usd(liq?.h24?.long_usd)}  Short=${usd(liq?.h24?.short_usd)}`);
  const tbs = der.taker_buy_sell;
  const buyPct  = tbs?.buy_ratio  != null ? (tbs.buy_ratio  * 100).toFixed(1) + '%' : 'N/A';
  const sellPct = tbs?.sell_ratio != null ? (tbs.sell_ratio * 100).toFixed(1) + '%' : 'N/A';
  console.log(`  Taker Buy:      ${usd(tbs?.buy_vol_usd)}  (${buyPct})`);
  console.log(`  Taker Sell:     ${usd(tbs?.sell_vol_usd)}  (${sellPct})`);
  console.log(`  Basis:          ${n(der.basis, 4)}`);
  if (der.coinbase_premium != null) {
    console.log(`  Coinbase Prem:  ${n(der.coinbase_premium, 4)}`);
  }

  // ── Alerts ────────────────────────────────────────────────────────────
  const alerts = (comp.alerts as any[]);
  if (alerts.length > 0) {
    console.log(`\nALERTS (${alerts.length})`);
    for (const a of alerts) {
      console.log(`  [${a.severity.toUpperCase().padEnd(6)}] ${a.message}`);
    }
  } else {
    console.log('\nALERTS: none');
  }

  // ── Active candlestick patterns ────────────────────────────────────────
  if (activePatterns.length > 0) {
    console.log(`\nCANDLESTICK PATTERNS (${activePatterns.length} active)`);
    for (const p of activePatterns) {
      console.log(`  ${p.pattern}  (value=${p.value})`);
    }
  } else {
    console.log('\nCANDLESTICK PATTERNS: none active');
  }

  console.log('');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const symbols = process.argv.slice(2).map(s => s.toUpperCase());
  if (symbols.length === 0) symbols.push('BTC');

  logger.info('Script', `Fetching data for ${symbols.length} coin(s): ${symbols.join(', ')}`);

  await connectDB();

  const timestamp = new Date();
  timestamp.setUTCMinutes(0, 0, 0);

  logger.info('Script', 'Fetching TAAPI indicators (bulk)...');
  const taapiMap = await fetchAllCoins(symbols);

  logger.info('Script', 'Fetching CoinGlass aggregate (bulk)...');
  const aggregateMap = await fetchAggregateData(symbols);

  logger.info('Script', 'Fetching Coinbase premium (shared)...');
  const premium = await fetchCoinbasePremium();

  const results: Array<{ symbol: string; ok: boolean; error?: string }> = [];

  for (const symbol of symbols) {
    logger.info('Script', `--- Processing ${symbol} ---`);
    try {
      logger.info('Script', `[${symbol}] Fetching CoinGlass per-coin...`);
      const perCoin = await fetchPerCoinData(symbol);

      logger.info('Script', `[${symbol}] Fetching Binance OHLCV...`);
      const binance = await fetchBinanceCandle(symbol);

      const taapi     = taapiMap.get(symbol)   ?? { indicators: {}, candlestick_patterns: [], errors: [] };
      const aggregate = aggregateMap.get(symbol)!;

      logger.info('Script', `[${symbol}] Building and saving snapshot...`);
      const { _id, snapshot } = await buildAndSaveSnapshot({ symbol, timestamp, tier: 'full', taapi, aggregate, perCoin, coinbasePremium: premium, binance });

      printCoinSnapshot(_id, snapshot);

      if (taapi.errors.length > 0) {
        logger.warn('Script', `[${symbol}] Fetch errors: ${taapi.errors.join(', ')}`);
      }

      results.push({ symbol, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Script', `[${symbol}] ✗ Failed: ${message}`);
      results.push({ symbol, ok: false, error: message });
    }
  }

  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  for (const r of results) {
    console.log(r.ok ? `  ✓ ${r.symbol}` : `  ✗ ${r.symbol}: ${r.error}`);
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} coin(s) succeeded`);
  console.log('══════════════════════════════════════════════════════════════════════\n');

  await disconnectDB();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
