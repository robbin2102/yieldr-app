/**
 * Fetches OHLCV candle data from Binance public REST API (no key required).
 * Used for: price.open/high/low/close/volume + daily OHLC for pivot point computation.
 */
import { config } from '../config';
import { logger } from '../utils/logger';

export interface BinanceCandleData {
  open:        number | null;
  high:        number | null;
  low:         number | null;
  close:       number | null;
  volume:      number | null;
  // Previous day's OHLC for computing classic floor-trader pivot points
  daily_high:  number | null;
  daily_low:   number | null;
  daily_close: number | null;
}

// Symbols confirmed to have no Binance spot pair — skip API calls silently.
// Populated at runtime on first 400 (invalid symbol) response; resets on restart.
const noSpotSymbols = new Set<string>();

// All Binance spot hostnames in priority order. Configured primary is tried first,
// then fallbacks in sequence. Once a working host is found it's reused for the session.
const ALL_SPOT_BASES = [
  config.binance.spotBaseUrl,
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
];

// Index into ALL_SPOT_BASES of the currently working host; persists across calls.
let baseIndex = 0;
let geo451Logged = false;

async function binanceGet(path: string): Promise<any> {
  // Try from current working base; on 451 rotate through all remaining options.
  for (let attempt = 0; attempt < ALL_SPOT_BASES.length; attempt++) {
    const idx = (baseIndex + attempt) % ALL_SPOT_BASES.length;
    const base = ALL_SPOT_BASES[idx];
    const res = await fetch(`${base}${path}`);

    if (res.status === 400) throw new Error(`Binance 400: ${path}`);

    if (res.status === 451) {
      if (!geo451Logged) {
        geo451Logged = true;
        logger.warn('Binance', `451 geo-restriction on ${base} — rotating endpoints. Set BINANCE_SPOT_BASE_URL to override.`);
      }
      continue; // try next host
    }

    if (!res.ok) throw new Error(`Binance ${res.status}: ${path}`);

    // Success — lock in this host index for future calls
    if (attempt > 0) {
      baseIndex = idx;
      logger.info('Binance', `Using ${base} after 451 on primary (index locked to ${idx})`);
    }
    return res.json();
  }

  throw new Error(`Binance 451: ${path} — all endpoints geo-restricted`);
}

const NULL_RESULT: BinanceCandleData = {
  open: null, high: null, low: null, close: null, volume: null,
  daily_high: null, daily_low: null, daily_close: null,
};

/**
 * Fetches the last COMPLETE 1h candle + previous day's OHLC for a given symbol.
 * Binance klines response: [open_time, open, high, low, close, volume, close_time, ...]
 */
export async function fetchBinanceCandle(symbol: string): Promise<BinanceCandleData> {
  if (noSpotSymbols.has(symbol)) return { ...NULL_RESULT };

  const result: BinanceCandleData = { ...NULL_RESULT };
  const pair = `${symbol}USDT`;

  // 1h candle — limit=2 gives [last_complete, currently_forming]; use index 0
  try {
    const klines: any[][] = await binanceGet(`/api/v3/klines?symbol=${pair}&interval=1h&limit=2`);
    if (Array.isArray(klines) && klines.length >= 1) {
      const c = klines[0]; // last complete 1h candle
      result.open   = parseFloat(c[1]);
      result.high   = parseFloat(c[2]);
      result.low    = parseFloat(c[3]);
      result.close  = parseFloat(c[4]);
      result.volume = parseFloat(c[5]);
      logger.debug('Binance', `${symbol} 1h OHLCV: O=${result.open} H=${result.high} L=${result.low} C=${result.close} V=${result.volume}`);
    }
  } catch (err: any) {
    if (err.message.includes('400')) {
      noSpotSymbols.add(symbol);
      logger.warn('Binance', `${symbol} has no spot pair on Binance — skipping price fetch for this session`);
    } else if (err.message.includes('451')) {
      // All endpoints exhausted — already logged once in binanceGet, suppress per-symbol noise
    } else {
      logger.warn('Binance', `${symbol} 1h candle failed: ${err.message}`);
    }
  }

  // Daily candle — limit=2, use index 0 (previous complete day)
  if (!noSpotSymbols.has(symbol)) {
    try {
      const dailyKlines: any[][] = await binanceGet(`/api/v3/klines?symbol=${pair}&interval=1d&limit=2`);
      if (Array.isArray(dailyKlines) && dailyKlines.length >= 1) {
        const d = dailyKlines[0]; // previous complete day
        result.daily_high  = parseFloat(d[2]);
        result.daily_low   = parseFloat(d[3]);
        result.daily_close = parseFloat(d[4]);
        logger.debug('Binance', `${symbol} prev-day H=${result.daily_high} L=${result.daily_low} C=${result.daily_close}`);
      }
    } catch (err: any) {
      logger.warn('Binance', `${symbol} daily candle failed: ${err.message}`);
    }
  }

  return result;
}

/** Returns the set of symbols skipped this session due to missing Binance spot pair. */
export function getNoSpotSymbols(): ReadonlySet<string> {
  return noSpotSymbols;
}
