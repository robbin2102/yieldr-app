/**
 * OrderbookCacheV2 — REST orderbook with prefetch on trade detection.
 *
 * Key improvement over v1: prefetch() is called the moment OnChainDetector
 * emits a trade event, running in parallel with dedup and bet sizing.
 * By the time SafetyGuard needs the orderbook (~15ms later), it's already
 * cached — eliminating the 100-200ms blocking fetch from v1.
 *
 * REST-only (WS orderbook was dropped in v1 due to data corruption — kept).
 * TTL: 3s. Cache holds up to 200 books before evicting oldest.
 */

import { OrderBook } from '../types';

const TTL_MS      = 3_000;
const MAX_ENTRIES = 200;

export class OrderbookCacheV2 {
  private books    = new Map<string, OrderBook>();
  private inflight = new Map<string, Promise<OrderBook | null>>();

  constructor(
    private readonly clobApiBase: string,
  ) {}

  /**
   * Called immediately when a trade is detected — starts fetch in background.
   * If already cached and fresh, or already fetching, this is a no-op.
   */
  prefetch(tokenId: string): void {
    if (this.isFresh(tokenId)) return;
    if (this.inflight.has(tokenId)) return;
    this.fetchAndCache(tokenId);   // fire and forget
  }

  /**
   * Get orderbook for a token. Returns cached data if fresh, otherwise fetches.
   * Deduplicates concurrent callers — only one HTTP request per tokenId.
   */
  async get(tokenId: string): Promise<OrderBook | null> {
    if (this.isFresh(tokenId)) return this.books.get(tokenId)!;

    if (this.inflight.has(tokenId)) {
      return this.inflight.get(tokenId)!;
    }

    return this.fetchAndCache(tokenId);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private isFresh(tokenId: string): boolean {
    const b = this.books.get(tokenId);
    return !!b && (Date.now() - b.fetchedAt) < TTL_MS;
  }

  private fetchAndCache(tokenId: string): Promise<OrderBook | null> {
    const promise = this.doFetch(tokenId).then(book => {
      this.inflight.delete(tokenId);
      if (book) {
        if (this.books.size >= MAX_ENTRIES) {
          this.books.delete(this.books.keys().next().value!);
        }
        this.books.set(tokenId, book);
      }
      return book;
    }).catch(() => {
      this.inflight.delete(tokenId);
      return null;
    });

    this.inflight.set(tokenId, promise);
    return promise;
  }

  private async doFetch(tokenId: string): Promise<OrderBook | null> {
    // CLOB API expects decimal token ID; on-chain events give hex (0x...)
    const tokenIdDec = tokenId.startsWith('0x') ? BigInt(tokenId).toString() : tokenId;
    const url = `${this.clobApiBase}/book?token_id=${tokenIdDec}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return null;

    const data = await res.json() as any;
    const bids: { price: number; size: number }[] = (data.bids ?? [])
      .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .filter((b: any) => b.price > 0 && b.size > 0)
      .sort((a: any, b: any) => b.price - a.price);   // high → low

    const asks: { price: number; size: number }[] = (data.asks ?? [])
      .map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .filter((a: any) => a.price > 0 && a.size > 0)
      .sort((a: any, b: any) => a.price - b.price);   // low → high

    if (bids.length === 0 && asks.length === 0) return null;

    return {
      bestBid:   bids[0]?.price ?? 0,
      bestAsk:   asks[0]?.price ?? 0,
      bids,
      asks,
      fetchedAt: Date.now(),
    };
  }
}
