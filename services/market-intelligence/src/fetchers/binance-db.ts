/**
 * Queries the binance_funding_1h and binance_derivatives_15m collections
 * written by the binance-fetcher service (Singapore Railway deployment).
 * Uses the raw mongoose connection to avoid registering duplicate Mongoose models.
 */

import { mongoose } from '../db';
import { logger } from '../utils/logger';

export interface BinanceFundingData {
  funding_rate: number;
  annualized_rate: number;
  timestamp: Date;
}

export interface BinanceDerivativesData {
  oi: {
    total_usdt:     number | null;
    change_4h_pct:  number | null;
    change_24h_pct: number | null;
  };
  long_short_global: {
    long: number | null; short: number | null; ratio: number | null;
  };
  long_short_top_accounts: {
    long: number | null; short: number | null; ratio: number | null;
  };
  long_short_top_positions: {
    long: number | null; short: number | null; ratio: number | null;
  };
  timestamp: Date | null;
}

/**
 * Returns the latest funding rate record for a symbol from binance_funding_1h.
 * Returns null if the collection is empty or symbol not found.
 */
export async function getLatestBinanceFunding(symbol: string): Promise<BinanceFundingData | null> {
  try {
    const db = mongoose.connection.db;
    if (!db) return null;

    const record = await db.collection('binance_funding_1h').findOne(
      { symbol: symbol.toUpperCase() },
      { sort: { timestamp: -1 } },
    );

    if (!record) return null;

    return {
      funding_rate:   record.funding_rate,
      annualized_rate: record.annualized_rate,
      timestamp:      record.timestamp,
    };
  } catch (err: any) {
    logger.debug('BinanceDB', `${symbol} funding lookup failed: ${err.message}`);
    return null;
  }
}

/**
 * Returns the latest OI + long/short ratio data for a symbol from binance_derivatives_15m.
 * Fetches the last 97 records to compute 4h and 24h OI change.
 * Returns null if the collection is empty or symbol not found.
 */
export async function getLatestBinanceDerivatives(symbol: string): Promise<BinanceDerivativesData | null> {
  try {
    const db = mongoose.connection.db;
    if (!db) return null;

    // Fetch last 97 records to compute OI change (96 × 15m = 24h, 16 × 15m = 4h)
    const records = await db.collection('binance_derivatives_15m')
      .find({ symbol: symbol.toUpperCase() })
      .sort({ timestamp: -1 })
      .limit(97)
      .toArray();

    if (records.length === 0) return null;

    const current = records[0];
    const prev4h  = records[16] ?? null;   // 16 × 15m = 4h
    const prev24h = records[96] ?? null;   // 96 × 15m = 24h

    const oi      = current.open_interest_usdt ?? null;
    const oiPrev4 = prev4h?.open_interest_usdt ?? null;
    const oiPrev24 = prev24h?.open_interest_usdt ?? null;

    const ls = (src: any) => src
      ? { long: src.long_pct ?? null, short: src.short_pct ?? null, ratio: src.ratio ?? null }
      : { long: null, short: null, ratio: null };

    return {
      oi: {
        total_usdt:     oi,
        change_4h_pct:  oi && oiPrev4  ? ((oi - oiPrev4)  / oiPrev4  * 100) : null,
        change_24h_pct: oi && oiPrev24 ? ((oi - oiPrev24) / oiPrev24 * 100) : null,
      },
      long_short_global:        ls(current.long_short_global),
      long_short_top_accounts:  ls(current.long_short_top_accounts),
      long_short_top_positions: ls(current.long_short_top_positions),
      timestamp: current.timestamp,
    };
  } catch (err: any) {
    logger.debug('BinanceDB', `${symbol} derivatives lookup failed: ${err.message}`);
    return null;
  }
}
