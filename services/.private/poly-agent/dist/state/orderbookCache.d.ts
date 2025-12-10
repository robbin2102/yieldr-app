/**
 * OrderbookCache - THE ONLY CACHE IN THE SYSTEM
 *
 * Maintains real-time orderbook data via WebSocket Market Channel.
 * For cache misses, fetches orderbook synchronously via REST API.
 *
 * CRITICAL: In a financial system, we NEVER skip trades due to missing orderbook.
 * If cache miss → fetch synchronously → cache → execute trade.
 *
 * Usage:
 * - getBestPrice(tokenId, side) - Get best bid/ask (0ms if cached, 100-200ms if fetch needed)
 * - subscribe(tokenId) - Subscribe to real-time WebSocket updates
 * - hasOrderbook(tokenId) - Check if data is cached
 */
declare class OrderbookCache {
    private ws;
    private books;
    private subscribedTokens;
    private reconnecting;
    connect(): Promise<void>;
    private reconnect;
    /**
     * Subscribe to orderbook updates for a token
     */
    subscribe(tokenId: string): void;
    private subscribeInternal;
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
     * Get best price for immediate execution
     *
     * CRITICAL: Returns null only if orderbook is empty (no bids/asks), not if uncached.
     * Caller must fetch orderbook first if not cached.
     *
     * @param tokenId - Token to get price for
     * @param side - BUY = get best ask (lowest sell price), SELL = get best bid (highest buy price)
     * @returns Price or null if orderbook is empty
     */
    getBestPrice(tokenId: string, side: 'BUY' | 'SELL'): number | null;
    /**
     * Check if we have orderbook data for a token
     */
    hasOrderbook(tokenId: string): boolean;
    /**
     * Apply incremental orderbook changes from WSS
     */
    private applyChanges;
    disconnect(): void;
}
export declare const orderbookCache: OrderbookCache;
export {};
