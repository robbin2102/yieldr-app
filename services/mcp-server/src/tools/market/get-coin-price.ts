/**
 * get_coin_price Tool
 *
 * Fetches real-time OHLCV (price) data directly from TAAPI for one or more coins.
 * Uses the `candle` indicator on the binance spot exchange — no auth required beyond API key.
 *
 * Use this when:
 * - User asks "what is the price of X?"
 * - User asks for current/live price before making a trading decision
 * - Snapshot data is stale and you need a fresh close price
 * - You need price to contextualise indicators (e.g. "price vs EMA 200")
 */

import { z } from 'zod';

const TAAPI_BULK_URL = 'https://api.taapi.io/bulk';
const COINS_PER_REQUEST = 3; // TAAPI Pro plan: 3 constructs per bulk call

export const getCoinPriceSchema = z.object({
  symbols: z
    .union([z.string(), z.array(z.string())])
    .describe('Coin symbol(s) without /USDT. Single string ("BTC") or array (["BTC","ETH","SOL"]).'),
  timeframe: z
    .string()
    .optional()
    .default('1m')
    .describe('Candle timeframe for price: 1m, 5m, 15m, 1h, 4h, 1d. Default: 1m (most current).'),
});

export type GetCoinPriceInput = z.infer<typeof getCoinPriceSchema>;

interface CandleResult {
  symbol:    string;
  price:     number | null;  // close price
  open:      number | null;
  high:      number | null;
  low:       number | null;
  volume:    number | null;
  timestamp: string | null;  // ISO string of candle open time
  timeframe: string;
  source:    string;
}

async function fetchCandleBatch(
  symbols: string[],
  timeframe: string,
  apiKey: string,
): Promise<Map<string, CandleResult>> {
  const results = new Map<string, CandleResult>();

  const constructs = symbols.map(sym => ({
    exchange: 'binance',
    symbol: `${sym.toUpperCase()}/USDT`,
    interval: timeframe,
    indicators: [{ indicator: 'candle', id: `price_${sym.toUpperCase()}` }],
  }));

  const res = await fetch(TAAPI_BULK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: apiKey, construct: constructs }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TAAPI ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { data?: any[][] };
  const responseData = data.data ?? [];

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i].toUpperCase();
    const items: any[] = responseData[i] ?? [];
    const item = items.find(it => it.id === `price_${sym}`);
    const r = item?.result ?? null;

    results.set(sym, {
      symbol:    sym,
      price:     r?.close != null ? parseFloat(r.close) : null,
      open:      r?.open  != null ? parseFloat(r.open)  : null,
      high:      r?.high  != null ? parseFloat(r.high)  : null,
      low:       r?.low   != null ? parseFloat(r.low)   : null,
      volume:    r?.volume != null ? parseFloat(r.volume) : null,
      timestamp: r?.timestamp ? new Date(r.timestamp * 1000).toISOString() : null,
      timeframe,
      source:    'TAAPI candle (live)',
    });
  }

  return results;
}

export async function executeGetCoinPrice(input: GetCoinPriceInput) {
  const apiKey = process.env.TAAPI_API_KEY;
  if (!apiKey) throw new Error('TAAPI_API_KEY is not configured on this server');

  const { timeframe = '1m' } = input;
  const rawSymbols = Array.isArray(input.symbols) ? input.symbols : [input.symbols];
  const symbols = rawSymbols.map(s => s.toUpperCase().replace('/USDT', ''));

  const all = new Map<string, CandleResult>();

  // Batch into groups of 3 (TAAPI Pro plan limit per bulk call)
  for (let i = 0; i < symbols.length; i += COINS_PER_REQUEST) {
    const batch = symbols.slice(i, i + COINS_PER_REQUEST);
    const batchResults = await fetchCandleBatch(batch, timeframe, apiKey);
    for (const [sym, result] of batchResults) all.set(sym, result);

    // Small delay between batches to respect rate limits
    if (i + COINS_PER_REQUEST < symbols.length) {
      await new Promise(r => setTimeout(r, 600));
    }
  }

  const prices = Array.from(all.values());
  const fetched_at = new Date().toISOString();

  // Single coin: return flat object (easier for agent to read)
  if (prices.length === 1) {
    return { ...prices[0], fetched_at };
  }

  // Multiple coins: return summary + array
  return {
    fetched_at,
    timeframe,
    count: prices.length,
    prices: prices.map(p => ({
      symbol: p.symbol,
      price:  p.price,
      high:   p.high,
      low:    p.low,
      volume: p.volume,
      timestamp: p.timestamp,
    })),
  };
}

export const getCoinPriceTool = {
  name: 'get_coin_price',
  description:
    'Fetch real-time price (OHLCV) for one or more coins directly from Binance spot via TAAPI. ' +
    'Returns close price, open, high, low, volume, and candle timestamp. ' +
    'Use for: current price questions, price-relative analysis (price vs EMA/VWAP), ' +
    'or when snapshot data is too stale. Supports any timeframe (default: 1m for freshest price). ' +
    'Accepts a single symbol ("BTC") or array (["BTC","ETH","SOL"]).',
  inputSchema: getCoinPriceSchema,
  execute: executeGetCoinPrice,
};
