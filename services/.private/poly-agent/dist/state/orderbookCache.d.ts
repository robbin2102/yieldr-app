/**
 * OrderbookCache - THE ONLY CACHE IN THE SYSTEM
 *
 * Maintains real-time orderbook data via WebSocket Market Channel.
 * Required for fast execution - provides 0ms price lookups on critical path.
 *
 * Usage:
 * - subscribe(tokenId) - Subscribe to market updates for a token
 * - getBestPrice(tokenId, side) - Get best bid/ask (0ms lookup)
 * - hasOrderbook(tokenId) - Check if we have data yet
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
     * Get best price for immediate execution
     *
     * @param tokenId - Token to get price for
     * @param side - BUY = get best ask (lowest sell price), SELL = get best bid (highest buy price)
     * @returns Price or null if no orderbook data
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
