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
declare class OrderbookCache {
    private books;
    private readonly TTL_MS;
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
    getBestPrice(tokenId: string, side: 'BUY' | 'SELL'): Promise<number | null>;
    /**
     * Fetch orderbook from REST API and cache it (synchronous, blocking)
     *
     * CRITICAL: This is called when cache misses to ensure we NEVER skip trades.
     * Latency: ~100-200ms for REST API call.
     *
     * @param tokenId - Token to fetch orderbook for
     * @returns true if successful, false if failed
     */
    fetchOrderbookSync(tokenId: string): Promise<boolean>;
    /**
     * Check if we have fresh orderbook data for a token
     */
    hasOrderbook(tokenId: string): boolean;
    /**
     * Clear all cached orderbooks (useful for testing)
     */
    clearCache(): void;
}
export declare const orderbookCache: OrderbookCache;
export {};
