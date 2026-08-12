import { erc20Abi } from 'viem';
import connectDB from '@/lib/mongoose';
import { TokenCache } from '@/models/TokenCache';
import { TokenOhlcCache } from '@/models/TokenOhlcCache';
import { getPublicClient, type EdgeChainId } from './chains';
import * as gt from './geckoterminal';

const PRICE_FRESH_MS = 5 * 60 * 1000; // live price good for 5 min before refetch

export type PriceSource = 'geckoterminal' | 'wallet_trades_proxy' | 'unavailable';

/**
 * Cache-first token metadata (symbol/decimals/pool/launch time). Checks
 * Mongo first; only calls out to GeckoTerminal on a miss, then writes the
 * result back - this is the passive indexing layer described in the plan.
 */
export async function getTokenMetadata(chain: EdgeChainId, address: string) {
  await connectDB();
  const lower = address.toLowerCase();

  let doc = await TokenCache.findOne({ chain, address: lower });
  if (doc && doc.poolAddress && doc.symbol) return doc;

  const [pool, onChain] = await Promise.all([
    doc?.poolAddress ? Promise.resolve(null) : gt.getTopPoolForToken(chain, lower),
    doc?.symbol ? Promise.resolve(null) : readOnChainSymbol(chain, lower),
  ]);

  doc = await TokenCache.findOneAndUpdate(
    { chain, address: lower },
    {
      $set: {
        ...(pool !== null ? { poolAddress: pool?.poolAddress?.toLowerCase() ?? null, launchTimestamp: pool?.createdAt ?? null } : {}),
        ...(onChain ? { symbol: onChain.symbol, name: onChain.name, decimals: onChain.decimals } : {}),
        source: pool ? 'geckoterminal' : (doc?.source ?? 'unknown'),
      },
    },
    { upsert: true, new: true }
  );
  return doc;
}

async function readOnChainSymbol(
  chain: EdgeChainId,
  address: string
): Promise<{ symbol: string; name: string; decimals: number } | null> {
  try {
    const client = getPublicClient(chain);
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({ address: address as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: address as `0x${string}`, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address: address as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    return { symbol, name, decimals };
  } catch {
    return null;
  }
}

/** Live price for current-holdings valuation. Cache-first, 5-min freshness. */
export async function getCurrentPriceUsd(
  chain: EdgeChainId,
  address: string
): Promise<{ priceUsd: number | null; source: PriceSource }> {
  await connectDB();
  const lower = address.toLowerCase();
  const doc = await TokenCache.findOne({ chain, address: lower });

  const isFresh =
    doc?.priceUpdatedAt && Date.now() - doc.priceUpdatedAt.getTime() < PRICE_FRESH_MS;
  if (isFresh && doc?.lastPriceUsd != null) {
    return { priceUsd: doc.lastPriceUsd, source: 'geckoterminal' };
  }

  const price = await gt.getCurrentPriceUsd(chain, lower);
  if (price != null) {
    await TokenCache.findOneAndUpdate(
      { chain, address: lower },
      { $set: { lastPriceUsd: price, priceUpdatedAt: new Date(), source: 'geckoterminal' } },
      { upsert: true }
    );
    return { priceUsd: price, source: 'geckoterminal' };
  }

  // Chain not indexed by GeckoTerminal (e.g. HOOD today) - fall back to the
  // wallet's own most recent trade price for this token as a rough proxy.
  return { priceUsd: doc?.lastPriceUsd ?? null, source: doc?.lastPriceUsd != null ? 'wallet_trades_proxy' : 'unavailable' };
}

/**
 * Record a price implied by the wallet's own trade (used as the fallback
 * proxy above when no external price feed covers the chain).
 */
export async function recordObservedTradePrice(chain: EdgeChainId, address: string, priceUsd: number, at: Date) {
  await connectDB();
  await TokenCache.findOneAndUpdate(
    { chain, address: address.toLowerCase() },
    { $set: { lastPriceUsd: priceUsd, priceUpdatedAt: at, source: 'wallet_trades_proxy' } },
    { upsert: true }
  );
}

export interface Candle {
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * OHLC candles covering [fromTs, toTs] for peak-capture / price-path
 * calculations. Cache-first: if enough candles already cover the window,
 * skip the network call entirely; otherwise fetch once and upsert - later
 * requests for an overlapping window get a cache hit for free.
 */
export async function getOhlcWindow(
  chain: EdgeChainId,
  poolAddress: string,
  fromTs: Date,
  toTs: Date
): Promise<{ candles: Candle[]; source: PriceSource }> {
  await connectDB();
  const pool = poolAddress.toLowerCase();

  const existing = await TokenOhlcCache.find({
    chain,
    poolAddress: pool,
    ts: { $gte: fromTs, $lte: toTs },
  }).sort({ ts: 1 });

  const spanMs = toTs.getTime() - fromTs.getTime();
  const expectedCandles = Math.max(1, Math.floor(spanMs / (15 * 60 * 1000)));
  const coversWindow = existing.length >= Math.min(expectedCandles, 4);

  if (coversWindow) {
    return { candles: existing.map(toCandle), source: 'geckoterminal' };
  }

  const fetched = await gt.getPoolOhlcv(chain, pool, 'minute', 15, {
    beforeTimestamp: Math.ceil(toTs.getTime() / 1000),
    limit: 500,
  });

  if (fetched.length === 0) {
    // Not indexed - degrade to whatever we already have (may be empty).
    return { candles: existing.map(toCandle), source: existing.length ? 'geckoterminal' : 'unavailable' };
  }

  await Promise.all(
    fetched.map((c) =>
      TokenOhlcCache.findOneAndUpdate(
        { chain, poolAddress: pool, ts: c.ts },
        { $set: { open: c.open, high: c.high, low: c.low, close: c.close, source: 'geckoterminal' } },
        { upsert: true }
      )
    )
  );

  const merged = await TokenOhlcCache.find({
    chain,
    poolAddress: pool,
    ts: { $gte: fromTs, $lte: toTs },
  }).sort({ ts: 1 });

  return { candles: merged.map(toCandle), source: 'geckoterminal' };
}

function toCandle(doc: any): Candle {
  return { ts: doc.ts, open: doc.open, high: doc.high, low: doc.low, close: doc.close };
}

export function peakPriceInWindow(candles: Candle[], fallback: number | null): number | null {
  if (candles.length === 0) return fallback;
  return Math.max(...candles.map((c) => c.high));
}

/**
 * USD price of a reference token (ETH/WETH/USDC) at a point in time - this
 * is what turns a reference-token trade leg into a USD size for the trade
 * it's funding/settling, without needing the traded meme token itself to
 * be indexed anywhere.
 */
export async function getReferencePriceUsd(
  chain: EdgeChainId,
  symbol: 'ETH' | 'WETH' | 'USDC' | 'USDG',
  at: Date,
  wethAddress?: string
): Promise<number> {
  if (symbol === 'USDC' || symbol === 'USDG') return 1;
  if (!wethAddress) return 0;

  const meta = await getTokenMetadata(chain, wethAddress);
  if (!meta?.poolAddress) return 0;

  const windowStart = new Date(at.getTime() - 20 * 60 * 1000);
  const windowEnd = new Date(at.getTime() + 20 * 60 * 1000);
  const { candles } = await getOhlcWindow(chain, meta.poolAddress, windowStart, windowEnd);
  if (candles.length === 0) {
    const live = await getCurrentPriceUsd(chain, wethAddress);
    return live.priceUsd ?? 0;
  }

  const nearest = candles.reduce((best, c) =>
    Math.abs(c.ts.getTime() - at.getTime()) < Math.abs(best.ts.getTime() - at.getTime()) ? c : best
  );
  return nearest.close;
}
