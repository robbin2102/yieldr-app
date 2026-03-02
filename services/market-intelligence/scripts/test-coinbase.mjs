/**
 * Quick local test for the Coinbase Exchange candle fetcher.
 * Run from services/market-intelligence/: node scripts/test-coinbase.mjs
 *
 * Uses Coinbase Exchange public API (no auth required):
 *   GET https://api.exchange.coinbase.com/products/{id}/candles
 *   Response: [[time, low, high, open, close, volume], ...] newest-first
 */

const BASE = 'https://api.exchange.coinbase.com';

const now       = Math.floor(Date.now() / 1000);
const hourEnd   = Math.floor(now / 3600) * 3600;
const hourStart = hourEnd - 3600;
const dayEnd    = Math.floor(now / 86400) * 86400;
const dayStart  = dayEnd - 86400;

// Mix of top coins + some alts to check coverage
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'MATIC', 'ADA', 'DOT'];

// Must match SYMBOL_MAP in src/fetchers/binance.ts
const SYMBOL_MAP = {
  MATIC: 'POL', // Polygon rebranded MATIC → POL in Sept 2024
};

async function fetchCandle(symbol) {
  const productId = `${SYMBOL_MAP[symbol] ?? symbol}-USD`;
  const result = { symbol, close: null, high: null, low: null, daily_close: null, daily_high: null, daily_low: null, error_1h: null, error_daily: null };

  const startIso1h = new Date(hourStart * 1000).toISOString();
  const endIso1h   = new Date(hourEnd * 1000).toISOString();

  try {
    const r = await fetch(`${BASE}/products/${productId}/candles?start=${startIso1h}&end=${endIso1h}&granularity=3600`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const candles = await r.json();
    if (Array.isArray(candles) && candles.length >= 1) {
      // [time, low, high, open, close, volume]
      result.close = parseFloat(candles[0][4]);
      result.high  = parseFloat(candles[0][2]);
      result.low   = parseFloat(candles[0][1]);
    } else {
      result.error_1h = 'empty response';
    }
  } catch (e) {
    result.error_1h = e.message;
  }

  const startIsoDay = new Date(dayStart * 1000).toISOString();
  const endIsoDay   = new Date(dayEnd * 1000).toISOString();

  try {
    const r = await fetch(`${BASE}/products/${productId}/candles?start=${startIsoDay}&end=${endIsoDay}&granularity=86400`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const candles = await r.json();
    if (Array.isArray(candles) && candles.length >= 1) {
      result.daily_close = parseFloat(candles[0][4]);
      result.daily_high  = parseFloat(candles[0][2]);
      result.daily_low   = parseFloat(candles[0][1]);
    } else {
      result.error_daily = 'empty response';
    }
  } catch (e) {
    result.error_daily = e.message;
  }

  return result;
}

async function main() {
  console.log(`Coinbase Exchange candle test — ${new Date().toISOString()}`);
  console.log(`1h:    ${new Date(hourStart * 1000).toISOString()} → ${new Date(hourEnd * 1000).toISOString()}`);
  console.log(`Daily: ${new Date(dayStart * 1000).toISOString()} → ${new Date(dayEnd * 1000).toISOString()}`);
  console.log('');

  let ok = 0, fail = 0;
  for (const symbol of COINS) {
    const r = await fetchCandle(symbol);
    if (r.close != null) {
      console.log(`✅ ${symbol.padEnd(6)} close=$${r.close.toLocaleString().padStart(10)}  daily H/L/C: $${r.daily_high?.toLocaleString() ?? 'null'} / $${r.daily_low?.toLocaleString() ?? 'null'} / $${r.daily_close?.toLocaleString() ?? 'null'}`);
      ok++;
    } else {
      console.log(`❌ ${symbol.padEnd(6)} 1h: ${r.error_1h}  daily: ${r.error_daily}`);
      fail++;
    }
  }

  console.log('');
  console.log(`Result: ${ok}/${COINS.length} coins have price data`);
  if (fail > 0) console.log(`⚠️  ${fail} coins unavailable on Coinbase Exchange (will use null price)`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
