import { config } from '../config';
import { logger } from '../utils/logger';

const BASE = config.binance.baseUrl;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function binanceGet(path: string): Promise<any> {
  const url = `${BASE}${path}`;
  const res = await fetch(url);

  if (res.status === 400) {
    // Invalid symbol or bad request — not fatal, coin likely doesn't have a futures pair
    const text = await res.text();
    logger.debug('Binance', `400 on ${path}: ${text.slice(0, 100)}`);
    return null;
  }

  if (res.status === 429 || res.status === 418) {
    throw new Error(`Binance rate limited (${res.status}) on ${path}`);
  }

  if (!res.ok) {
    throw new Error(`Binance ${res.status} on ${path}`);
  }

  return res.json();
}

// ─── Funding Rate (fundingRate) ───────────────────────────────────────────────
// Returns actual settled 8h funding rates. Binance settles 3×/day (00:00, 08:00,
// 16:00 UTC). annualized = rate * 3 * 365 * 100.

export interface FundingRateRecord {
  timestamp: Date;
  funding_rate: number;
  annualized_rate: number;
}

export async function fetchFundingRates(
  pair: string,
  startTime?: number,
  limit = 1000,
): Promise<FundingRateRecord[]> {
  const params = new URLSearchParams({
    symbol: pair,
    limit: String(Math.min(limit, 1000)),
    ...(startTime ? { startTime: String(startTime) } : {}),
  });

  const data = await binanceGet(`/fapi/v1/fundingRate?${params}`);
  if (!data || !Array.isArray(data)) return [];

  return data.map((d: any) => {
    const fundingRate = parseFloat(d.fundingRate);
    return {
      timestamp:       new Date(d.fundingTime),
      funding_rate:    fundingRate,
      annualized_rate: fundingRate * 3 * 365 * 100,
    };
  });
}

// ─── Premium Index Klines (premiumIndexKlines) ────────────────────────────────
// 1h candles of the premium index. The `close` value approximates the predicted
// funding rate at the next 8h settlement. Used to show "current / predicted" rate.

export interface PremiumIndexKlineRecord {
  open_time:     Date;
  close_time:    Date;
  open_premium:  number;
  high_premium:  number;
  low_premium:   number;
  premium_index: number;   // close = current predicted funding rate
}

export async function fetchPremiumIndexKlines(
  pair: string,
  startTime?: number,
  limit = 1000,
): Promise<PremiumIndexKlineRecord[]> {
  const params = new URLSearchParams({
    symbol:   pair,
    interval: '1h',
    limit:    String(Math.min(limit, 1500)),
    ...(startTime ? { startTime: String(startTime) } : {}),
  });

  const data = await binanceGet(`/fapi/v1/premiumIndexKlines?${params}`);
  if (!data || !Array.isArray(data)) return [];

  return data.map((d: any[]) => ({
    open_time:     new Date(d[0]),
    open_premium:  parseFloat(d[1]),
    high_premium:  parseFloat(d[2]),
    low_premium:   parseFloat(d[3]),
    premium_index: parseFloat(d[4]),   // close
    close_time:    new Date(d[6]),
  }));
}

// ─── Open Interest (openInterestHist) ─────────────────────────────────────────

export interface OIRecord {
  timestamp: Date;
  open_interest_usdt: number;
}

export async function fetchOIHistory(
  pair: string,
  startTime?: number,
  limit = 500,
): Promise<OIRecord[]> {
  const params = new URLSearchParams({
    symbol: pair,
    period:  '15m',
    limit:   String(Math.min(limit, 500)),
    ...(startTime ? { startTime: String(startTime) } : {}),
  });

  const data = await binanceGet(`/futures/data/openInterestHist?${params}`);
  if (!data || !Array.isArray(data)) return [];

  return data.map((d: any) => ({
    timestamp:          new Date(d.timestamp),
    open_interest_usdt: parseFloat(d.sumOpenInterestValue),
  }));
}

// ─── Long/Short Ratios ────────────────────────────────────────────────────────

export interface LSRatioRecord {
  timestamp: Date;
  long_pct:  number;   // 0–100
  short_pct: number;   // 0–100
  ratio:     number;   // raw decimal from Binance
}

async function fetchLSRatio(endpoint: string, pair: string, startTime?: number, limit = 500): Promise<LSRatioRecord[]> {
  const params = new URLSearchParams({
    symbol: pair,
    period: '15m',
    limit:  String(Math.min(limit, 500)),
    ...(startTime ? { startTime: String(startTime) } : {}),
  });

  const data = await binanceGet(`${endpoint}?${params}`);
  if (!data || !Array.isArray(data)) return [];

  return data.map((d: any) => ({
    timestamp:  new Date(d.timestamp),
    long_pct:   parseFloat(d.longAccount ?? d.longPosition) * 100,
    short_pct:  parseFloat(d.shortAccount ?? d.shortPosition) * 100,
    ratio:      parseFloat(d.longShortRatio),
  }));
}

export function fetchGlobalLSRatio(pair: string, startTime?: number, limit = 500) {
  return fetchLSRatio('/futures/data/globalLongShortAccountRatio', pair, startTime, limit);
}

export function fetchTopAccountLSRatio(pair: string, startTime?: number, limit = 500) {
  return fetchLSRatio('/futures/data/topLongShortAccountRatio', pair, startTime, limit);
}

export function fetchTopPositionLSRatio(pair: string, startTime?: number, limit = 500) {
  return fetchLSRatio('/futures/data/topLongShortPositionRatio', pair, startTime, limit);
}

// ─── Coin → Pair mapping ──────────────────────────────────────────────────────

export function toPair(symbol: string): string {
  return `${symbol.toUpperCase()}USDT`;
}

// ─── Delay helper ─────────────────────────────────────────────────────────────

export { sleep };
