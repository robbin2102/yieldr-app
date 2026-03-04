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

// Alternative Binance spot hostnames to try when primary returns 451 (geo-restriction).
// On each 451, we cycle to the next base URL and log once.
const BINANCE_FALLBACK_BASES = [
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
];

let currentBase = config.binance.spotBaseUrl;
let geo451Logged = false;

async function binanceGet(path: string): Promise<any> {
  const res = await fetch(`${currentBase}${path}`);

  if (res.status === 400) {
    throw new Error(`Binance 400: ${path}`);
  }

  // 451 = geo-restriction. Try rotating to an alternative Binance hostname.
  if (res.status === 451) {
    const triedBase = currentBase;
    const fallback = BINANCE_FALLBACK_BASES.find(b => b !== currentBase);
    if (fallback) {
      currentBase = fallback;
      if (!geo451Logged) {
        geo451Logged = true;
        logger.warn('Binance', `451 geo-restriction on ${triedBase} — switching to ${fallback}. Set BINANCE_SPOT_BASE_URL env var to configure.`);
      }
      // Retry once with the new base
      const retry = await fetch(`${currentBase}${path}`);
      if (!retry.ok) throw new Error(`Binance ${retry.status}: ${path}`);
      return retry.json();
    }
    // All alternates exhausted — throw with clear message
    throw new Error(`Binance 451: ${path}`);
  }

  if (!res.ok) throw new Error(`Binance ${res.status}: ${path}`);
  return res.json();
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
      // Geo-restriction with no working fallback — suppress per-symbol noise, already logged once above
      noSpotSymbols.add(symbol);
      if (!geo451Logged) {
        geo451Logged = true;
        logger.warn('Binance', `451 geo-restriction on all Binance spot endpoints. Set BINANCE_SPOT_BASE_URL=https://api.binance.us for US-hosted deployments.`);
      }
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
