import { config } from '../config';

interface OrderBook {
  bids: { price: number; size: number }[];  // Sorted high to low
  asks: { price: number; size: number }[];  // Sorted low to high
  lastUpdate: number;
}

/**
 * OrderbookCache - REST-only orderbook fetching with TTL caching
 *
 * CRITICAL: In a financial system, we NEVER skip trades due to missing orderbook.
 * - Cache miss → fetch synchronously via REST API (~100-200ms)
 * - Cache hit → use cached data (0ms)
 * - TTL: 2 seconds (keeps data fresh, reduces API calls)
 *
 * WebSocket removed due to corruption issues (overwriting good REST data with bad data).
 * REST API is reliable and fast enough for copy trading.
 *
 * Usage:
 * - getBestPrice(tokenId, side) - Get best bid/ask (fetches if not cached or expired)
 * - hasOrderbook(tokenId) - Check if data is cached and fresh
 */
class OrderbookCache {
  private books: Map<string, OrderBook> = new Map();
  private readonly TTL_MS = 2000;  // 2 second cache TTL

  /**
   * Get best price for immediate execution
   *
   * Automatically fetches from REST API if:
   * - Not in cache
   * - Cache expired (> TTL_MS old)
   *
   * @param tokenId - Token to get price for
   * @param side - BUY = get best ask (lowest sell price), SELL = get best bid (highest buy price)
   * @returns Price or null if fetch failed or orderbook empty
   */
  async getBestPrice(tokenId: string, side: 'BUY' | 'SELL'): Promise<number | null> {
    const book = this.books.get(tokenId);
    const now = Date.now();

    // Check if cache is fresh (< TTL_MS old)
    if (book && (now - book.lastUpdate) < this.TTL_MS) {
      // Cache hit - return immediately
      if (side === 'BUY') {
        return book.asks.length > 0 ? book.asks[0].price : null;
      } else {
        return book.bids.length > 0 ? book.bids[0].price : null;
      }
    }

    // Cache miss or expired - fetch fresh data
    const fetchSuccess = await this.fetchOrderbookSync(tokenId);
    if (!fetchSuccess) {
      return null;
    }

    // Get price from freshly fetched data
    const freshBook = this.books.get(tokenId);
    if (!freshBook) return null;

    if (side === 'BUY') {
      return freshBook.asks.length > 0 ? freshBook.asks[0].price : null;
    } else {
      return freshBook.bids.length > 0 ? freshBook.bids[0].price : null;
    }
  }

  /**
   * Fetch orderbook from REST API and cache it (synchronous, blocking)
   *
   * CRITICAL: This is called when cache misses to ensure we NEVER skip trades.
   * Latency: ~100-200ms for REST API call.
   *
   * @param tokenId - Token to fetch orderbook for
   * @returns true if successful, false if failed
   */
  async fetchOrderbookSync(tokenId: string): Promise<boolean> {
    try {
      const fetchStart = Date.now();
      console.log(`[OrderbookCache] 🔄 Fetching orderbook for ${tokenId.slice(0, 16)}...`);

      const url = `${config.clobApiBase}/book?token_id=${tokenId}`;
      const response = await fetch(url);

      if (!response.ok) {
        console.error(`[OrderbookCache] ❌ REST API error: ${response.status} ${response.statusText}`);
        return false;
      }

      const data = await response.json() as any;
      const fetchLatency = Date.now() - fetchStart;

      // Parse and cache orderbook
      this.books.set(tokenId, {
        bids: (data.bids || [])
          .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
          .sort((a: any, b: any) => b.price - a.price),  // High to low
        asks: (data.asks || [])
          .map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
          .sort((a: any, b: any) => a.price - b.price),  // Low to high
        lastUpdate: Date.now(),
      });

      const book = this.books.get(tokenId)!;
      const bestBid = book.bids.length > 0 ? book.bids[0].price : 'N/A';
      const bestAsk = book.asks.length > 0 ? book.asks[0].price : 'N/A';

      console.log(`[OrderbookCache] ✅ Fetched in ${fetchLatency}ms (bid: ${bestBid}, ask: ${bestAsk})`);

      return true;
    } catch (error: any) {
      console.error(`[OrderbookCache] ❌ Failed to fetch orderbook: ${error.message}`);
      return false;
    }
  }

  /**
   * Get both best bid and best ask in a single call.
   * Used by GTTExecutor to compute limit prices (ask - slack, bid + slack).
   */
  async getBothPrices(tokenId: string): Promise<{ bestBid: number | null; bestAsk: number | null }> {
    const book = this.books.get(tokenId);
    const now = Date.now();

    if (!book || (now - book.lastUpdate) >= this.TTL_MS) {
      const ok = await this.fetchOrderbookSync(tokenId);
      if (!ok) return { bestBid: null, bestAsk: null };
    }

    const fresh = this.books.get(tokenId);
    if (!fresh) return { bestBid: null, bestAsk: null };

    return {
      bestBid: fresh.bids.length > 0 ? fresh.bids[0].price : null,
      bestAsk: fresh.asks.length > 0 ? fresh.asks[0].price : null,
    };
  }

  /**
   * Check if we have fresh orderbook data for a token
   */
  hasOrderbook(tokenId: string): boolean {
    const book = this.books.get(tokenId);
    if (!book) return false;

    const now = Date.now();
    return (now - book.lastUpdate) < this.TTL_MS;
  }

  /**
   * Clear all cached orderbooks (useful for testing)
   */
  clearCache() {
    this.books.clear();
  }
}

export const orderbookCache = new OrderbookCache();
