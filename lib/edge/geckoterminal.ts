import type { EdgeChainId } from './chains';

/**
 * Thin GeckoTerminal client (free public API - no key required today).
 * `COINGECKO_API_KEY`, if set later after upgrading to the paid plan, is
 * sent as an auth header automatically - no code change needed to swap in.
 *
 * GeckoTerminal network slugs are chain-specific and out of our control.
 * HOOD (Robinhood Chain) almost certainly isn't indexed yet as a new/
 * obscure chain - `NETWORK_SLUGS.hood === null` makes every call below a
 * clean no-op for it instead of guessing a slug that doesn't exist.
 */
const BASE_URL = 'https://api.geckoterminal.com/api/v2';

const NETWORK_SLUGS: Record<EdgeChainId, string | null> = {
  base: 'base',
  hood: null, // unknown / likely unindexed - confirm and fill in when known
  solana: 'solana',
};

function headers(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { 'x-cg-pro-api-key': key } : {};
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, { headers: headers() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function isChainIndexed(chain: EdgeChainId): boolean {
  return NETWORK_SLUGS[chain] !== null;
}

export interface GtPoolInfo {
  poolAddress: string;
  createdAt: Date | null;
}

/** Best pool for a token (by liquidity), plus its creation time as a launch-time proxy. */
export async function getTopPoolForToken(
  chain: EdgeChainId,
  tokenAddress: string
): Promise<GtPoolInfo | null> {
  const network = NETWORK_SLUGS[chain];
  if (!network) return null;

  const data = await get<any>(`/networks/${network}/tokens/${tokenAddress}/pools?page=1`);
  const pool = data?.data?.[0];
  if (!pool) return null;

  return {
    poolAddress: pool.attributes?.address,
    createdAt: pool.attributes?.pool_created_at ? new Date(pool.attributes.pool_created_at) : null,
  };
}

export interface GtCandle {
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** timeframe: 'minute' | 'hour' | 'day'; aggregate e.g. 15 for 15-min candles */
export async function getPoolOhlcv(
  chain: EdgeChainId,
  poolAddress: string,
  timeframe: 'minute' | 'hour' | 'day',
  aggregate: number,
  opts: { beforeTimestamp?: number; limit?: number } = {}
): Promise<GtCandle[]> {
  const network = NETWORK_SLUGS[chain];
  if (!network) return [];

  const params = new URLSearchParams({
    aggregate: String(aggregate),
    limit: String(opts.limit ?? 200),
    currency: 'usd',
  });
  if (opts.beforeTimestamp) params.set('before_timestamp', String(opts.beforeTimestamp));

  const data = await get<any>(
    `/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}?${params.toString()}`
  );
  const list: number[][] = data?.data?.attributes?.ohlcv_list ?? [];

  return list.map(([ts, open, high, low, close]) => ({
    ts: new Date(ts * 1000),
    open,
    high,
    low,
    close,
  }));
}

export async function getCurrentPriceUsd(chain: EdgeChainId, tokenAddress: string): Promise<number | null> {
  const network = NETWORK_SLUGS[chain];
  if (!network) return null;

  const data = await get<any>(`/simple/networks/${network}/token_price/${tokenAddress}`);
  const price = data?.data?.attributes?.token_prices?.[tokenAddress.toLowerCase()];
  return price ? Number(price) : null;
}
