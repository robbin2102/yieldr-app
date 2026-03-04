/**
 * fetch_live_indicator Tool
 * Fetch real-time indicator data directly from TAAPI for any coin.
 * Use when indexed snapshot data isn't fresh enough, or user asks for
 * specific/current indicator values.
 */

import { z } from 'zod';

const TAAPI_BULK_URL = 'https://api.taapi.io/bulk';

// Core indicators fetched when no specific list is provided (max 20 per bulk call)
const CORE_INDICATORS: Record<string, any>[] = [
  { indicator: 'ema', period: 8 },
  { indicator: 'ema', period: 21 },
  { indicator: 'ema', period: 50 },
  { indicator: 'ema', period: 200 },
  { indicator: 'sma', period: 50 },
  { indicator: 'sma', period: 200 },
  { indicator: 'rsi' },
  { indicator: 'macd' },
  { indicator: 'stochrsi' },
  { indicator: 'adx' },
  { indicator: 'bbands' },
  { indicator: 'atr', period: 14 },
  { indicator: 'vwap' },
  { indicator: 'obv' },
  { indicator: 'cmf' },
  { indicator: 'ichimoku' },
  { indicator: 'supertrend' },
  { indicator: 'pivot_points' },
];

export const fetchLiveIndicatorSchema = z.object({
  symbol: z.string().describe('Coin symbol without /USDT, e.g. BTC, ETH, SOL'),
  indicators: z
    .array(z.string())
    .optional()
    .describe(
      'Specific indicators to fetch, e.g. ["rsi", "macd", "ema_8", "ema_21"]. ' +
        'For EMAs/SMAs with periods use format "ema_8", "sma_50". ' +
        'Omit to fetch all 18 core indicators.'
    ),
  timeframe: z
    .string()
    .optional()
    .default('1h')
    .describe('Candle timeframe: 1m, 5m, 15m, 1h, 4h, 1d. Default: 1h'),
});

export type FetchLiveIndicatorInput = z.infer<typeof fetchLiveIndicatorSchema>;

function parseIndicatorArg(ind: string): Record<string, any> {
  // Handle "ema_8", "sma_200" format
  const match = ind.match(/^([a-z]+)_(\d+)$/);
  if (match) {
    return { indicator: match[1], period: parseInt(match[2]) };
  }
  return { indicator: ind };
}

export async function executeFetchLiveIndicator(input: FetchLiveIndicatorInput) {
  const apiKey = process.env.TAAPI_API_KEY;
  if (!apiKey) throw new Error('TAAPI_API_KEY is not configured on this server');

  const { symbol, indicators, timeframe = '1h' } = input;
  const taapiSymbol = `${symbol.toUpperCase()}/USDT`;

  const indicatorList =
    indicators && indicators.length > 0
      ? indicators.map(parseIndicatorArg)
      : CORE_INDICATORS;

  // Chunk into groups of 20 (TAAPI bulk limit)
  const results: Record<string, any> = {};
  const chunks: Record<string, any>[][] = [];
  for (let i = 0; i < indicatorList.length; i += 20) {
    chunks.push(indicatorList.slice(i, i + 20));
  }

  for (const chunk of chunks) {
    const response = await fetch(TAAPI_BULK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: apiKey,
        construct: {
          exchange: 'binancefutures',
          symbol: taapiSymbol,
          interval: timeframe,
          indicators: chunk,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`TAAPI API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as { data?: any[] };
    const resultArr = data.data || [];

    for (const item of resultArr) {
      // Key format: "ema_8", "rsi", "macd", etc.
      const key = item.indicator + (item.period != null ? `_${item.period}` : '');
      results[key] = item.result ?? item.errors ?? null;
    }
  }

  return {
    symbol: symbol.toUpperCase(),
    timeframe,
    fetched_at: new Date().toISOString(),
    source: 'TAAPI real-time (live)',
    indicators_fetched: Object.keys(results).length,
    indicators: results,
  };
}

export const fetchLiveIndicatorTool = {
  name: 'fetch_live_indicator',
  description:
    'Fetch real-time indicator values from TAAPI for any coin. Use when the MongoDB snapshot is stale (>1h old) or when user explicitly asks for current/live data. ' +
    'Fetches all 18 core indicators (EMA 8/21/50/200, SMA 50/200, RSI, MACD, StochRSI, ADX, BBands, ATR, VWAP, OBV, CMF, Ichimoku, Supertrend, Pivots) by default, ' +
    'or specific indicators if provided.',
  inputSchema: fetchLiveIndicatorSchema,
  execute: executeFetchLiveIndicator,
};
