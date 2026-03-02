/**
 * Fetches OHLCV candle data from Coinbase Advanced Trade public REST API.
 * Used for: price.open/high/low/close/volume + daily OHLC for pivot point computation.
 *
 * NOTE: Previously used Binance, which returns HTTP 451 (geo-blocked) from Railway's
 * server region. Coinbase public candle API has no geo-restrictions and no key required.
 * Interface name kept as BinanceCandleData for backwards compatibility.
 */
import { logger } from '../utils/logger';

const BASE = 'https://api.coinbase.com';

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

async function coinbaseGet(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Coinbase ${res.status}: ${path}`);
  return res.json();
}

/**
 * Fetches the last COMPLETE 1h candle + previous day's OHLC for a given symbol.
 *
 * Coinbase candle response (newest-first):
 *   { candles: [{ start, open, high, low, close, volume }] }
 *
 * For 1h: request end=start-of-current-hour to exclude the forming candle.
 *   candles[0] = last complete 1h candle.
 * For daily: request end=today-midnight to get yesterday's complete candle.
 *   candles[0] = previous complete day.
 */
export async function fetchBinanceCandle(symbol: string): Promise<BinanceCandleData> {
  const result: BinanceCandleData = {
    open: null, high: null, low: null, close: null, volume: null,
    daily_high: null, daily_low: null, daily_close: null,
  };

  const productId = `${symbol}-USD`;
  const now = Math.floor(Date.now() / 1000);

  // 1h candle: end = start of current hour (excludes forming candle), start = 1h before
  const hourEnd   = Math.floor(now / 3600) * 3600;
  const hourStart = hourEnd - 3600;

  try {
    const data = await coinbaseGet(
      `/api/v3/brokerage/products/${productId}/candles?start=${hourStart}&end=${hourEnd}&granularity=ONE_HOUR`,
    );
    const candles: any[] = data?.candles ?? [];
    if (candles.length >= 1) {
      const c = candles[0]; // newest = last complete 1h candle
      result.open   = parseFloat(c.open);
      result.high   = parseFloat(c.high);
      result.low    = parseFloat(c.low);
      result.close  = parseFloat(c.close);
      result.volume = parseFloat(c.volume);
      logger.debug('Coinbase', `${symbol} 1h OHLCV: O=${result.open} H=${result.high} L=${result.low} C=${result.close} V=${result.volume}`);
    }
  } catch (err: any) {
    logger.warn('Coinbase', `${symbol} 1h candle failed: ${err.message}`);
  }

  // Daily candle: end = today midnight UTC (start of today), start = yesterday midnight
  const dayEnd   = Math.floor(now / 86400) * 86400;
  const dayStart = dayEnd - 86400;

  try {
    const data = await coinbaseGet(
      `/api/v3/brokerage/products/${productId}/candles?start=${dayStart}&end=${dayEnd}&granularity=ONE_DAY`,
    );
    const candles: any[] = data?.candles ?? [];
    if (candles.length >= 1) {
      const d = candles[0]; // previous complete day
      result.daily_high  = parseFloat(d.high);
      result.daily_low   = parseFloat(d.low);
      result.daily_close = parseFloat(d.close);
      logger.debug('Coinbase', `${symbol} prev-day H=${result.daily_high} L=${result.daily_low} C=${result.daily_close}`);
    }
  } catch (err: any) {
    logger.warn('Coinbase', `${symbol} daily candle failed: ${err.message}`);
  }

  return result;
}
