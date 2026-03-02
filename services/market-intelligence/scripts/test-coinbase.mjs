/**
 * Quick local test for the Coinbase candle fetcher.
 * Run from your Mac: node services/market-intelligence/scripts/test-coinbase.mjs
 */

const BASE = 'https://api.coinbase.com';

const now       = Math.floor(Date.now() / 1000);
const hourEnd   = Math.floor(now / 3600) * 3600;
const hourStart = hourEnd - 3600;
const dayEnd    = Math.floor(now / 86400) * 86400;
const dayStart  = dayEnd - 86400;

const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'PEPE'];

async function fetchCandle(symbol) {
  const productId = `${symbol}-USD`;
  const result = { symbol, open: null, high: null, low: null, close: null, volume: null, daily_high: null, daily_low: null, daily_close: null, error_1h: null, error_daily: null };

  // 1h candle
  try {
    const r = await fetch(`${BASE}/api/v3/brokerage/products/${productId}/candles?start=${hourStart}&end=${hourEnd}&granularity=ONE_HOUR`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const c = data?.candles?.[0];
    if (c) {
      result.open = parseFloat(c.open);
      result.high = parseFloat(c.high);
      result.low  = parseFloat(c.low);
      result.close = parseFloat(c.close);
      result.volume = parseFloat(c.volume);
    } else {
      result.error_1h = 'empty candles array';
    }
  } catch (e) {
    result.error_1h = e.message;
  }

  // Daily candle
  try {
    const r = await fetch(`${BASE}/api/v3/brokerage/products/${productId}/candles?start=${dayStart}&end=${dayEnd}&granularity=ONE_DAY`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const d = data?.candles?.[0];
    if (d) {
      result.daily_high  = parseFloat(d.high);
      result.daily_low   = parseFloat(d.low);
      result.daily_close = parseFloat(d.close);
    } else {
      result.error_daily = 'empty candles array';
    }
  } catch (e) {
    result.error_daily = e.message;
  }

  return result;
}

async function main() {
  console.log(`Testing Coinbase candle API — ${new Date().toISOString()}`);
  console.log(`1h window:    ${new Date(hourStart * 1000).toISOString()} → ${new Date(hourEnd * 1000).toISOString()}`);
  console.log(`Daily window: ${new Date(dayStart * 1000).toISOString()} → ${new Date(dayEnd * 1000).toISOString()}`);
  console.log('');

  let ok = 0, fail = 0;
  for (const symbol of COINS) {
    const r = await fetchCandle(symbol);
    const priceLine = r.close != null
      ? `close=$${r.close.toLocaleString()}  daily_H=$${r.daily_high?.toLocaleString() ?? 'null'}  daily_L=$${r.daily_low?.toLocaleString() ?? 'null'}`
      : `FAILED — 1h: ${r.error_1h}  daily: ${r.error_daily}`;
    const status = r.close != null ? '✅' : '❌';
    console.log(`${status} ${symbol.padEnd(6)} ${priceLine}`);
    r.close != null ? ok++ : fail++;
  }

  console.log('');
  console.log(`Result: ${ok}/${COINS.length} coins returned price data`);
  if (fail > 0) console.log(`⚠️  ${fail} coins returned no price (check if listed on Coinbase)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
