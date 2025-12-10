"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderbookCache = void 0;
const ws_1 = __importDefault(require("ws"));
const config_1 = require("../config");
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
class OrderbookCache {
    constructor() {
        this.ws = null;
        this.books = new Map();
        this.subscribedTokens = new Set();
        this.reconnecting = false;
    }
    async connect() {
        return new Promise((resolve) => {
            console.log('[OrderbookCache] Connecting to Market Channel...');
            this.ws = new ws_1.default(config_1.config.wssMarket);
            this.ws.on('open', () => {
                console.log('[OrderbookCache] ✅ Connected');
                this.reconnecting = false;
                resolve();
            });
            this.ws.on('message', (data) => {
                try {
                    const dataStr = data.toString();
                    // Handle PONG responses (plain text, not JSON)
                    if (dataStr === 'PONG') {
                        return;
                    }
                    const msg = JSON.parse(dataStr);
                    if (msg.event_type === 'book') {
                        // Full orderbook snapshot
                        this.books.set(msg.asset_id, {
                            bids: msg.bids
                                .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
                                .sort((a, b) => b.price - a.price), // High to low
                            asks: msg.asks
                                .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
                                .sort((a, b) => a.price - b.price), // Low to high
                            lastUpdate: Date.now(),
                        });
                        const bestBid = msg.bids.length > 0 ? msg.bids[0].price : 'N/A';
                        const bestAsk = msg.asks.length > 0 ? msg.asks[0].price : 'N/A';
                        console.log(`[OrderbookCache] 📊 Orderbook snapshot: ${msg.asset_id.slice(0, 8)}... (bid: ${bestBid}, ask: ${bestAsk}, ${this.books.size} markets cached)`);
                    }
                    else if (msg.event_type === 'price_change') {
                        // Incremental update
                        this.applyChanges(msg.asset_id, msg.price_changes);
                    }
                }
                catch (err) {
                    console.error('[OrderbookCache] Parse error:', err);
                }
            });
            this.ws.on('close', () => {
                console.log('[OrderbookCache] Disconnected');
                this.reconnect();
            });
            this.ws.on('error', (err) => {
                console.error('[OrderbookCache] Error:', err.message);
            });
        });
    }
    reconnect() {
        if (this.reconnecting)
            return;
        this.reconnecting = true;
        console.log('[OrderbookCache] Reconnecting in 5s...');
        setTimeout(async () => {
            await this.connect();
            // Resubscribe to all tokens
            for (const tokenId of this.subscribedTokens) {
                this.subscribeInternal(tokenId);
            }
        }, 5000);
    }
    /**
     * Subscribe to orderbook updates for a token
     */
    subscribe(tokenId) {
        if (this.subscribedTokens.has(tokenId))
            return;
        this.subscribedTokens.add(tokenId);
        this.subscribeInternal(tokenId);
    }
    subscribeInternal(tokenId) {
        if (this.ws?.readyState === ws_1.default.OPEN) {
            console.log(`[OrderbookCache] Subscribing to ${tokenId.slice(0, 16)}...`);
            // Correct format from Polymarket docs: type = channel name
            this.ws.send(JSON.stringify({
                type: 'market',
                assets_ids: [tokenId],
            }));
        }
    }
    /**
     * Get best price for immediate execution
     *
     * @param tokenId - Token to get price for
     * @param side - BUY = get best ask (lowest sell price), SELL = get best bid (highest buy price)
     * @returns Price or null if no orderbook data
     */
    getBestPrice(tokenId, side) {
        const book = this.books.get(tokenId);
        if (!book)
            return null;
        if (side === 'BUY') {
            // For BUY orders: take the best ask (lowest sell price)
            return book.asks.length > 0 ? book.asks[0].price : null;
        }
        else {
            // For SELL orders: take the best bid (highest buy price)
            return book.bids.length > 0 ? book.bids[0].price : null;
        }
    }
    /**
     * Check if we have orderbook data for a token
     */
    hasOrderbook(tokenId) {
        return this.books.has(tokenId);
    }
    /**
     * Apply incremental orderbook changes from WSS
     */
    applyChanges(assetId, changes) {
        const book = this.books.get(assetId);
        if (!book)
            return;
        for (const change of changes) {
            const price = parseFloat(change.price);
            const size = parseFloat(change.size);
            const side = change.side === 'BUY' ? 'bids' : 'asks';
            // Remove existing level at this price
            book[side] = book[side].filter(l => l.price !== price);
            // Add new level if size > 0 (size = 0 means level removed)
            if (size > 0) {
                book[side].push({ price, size });
            }
            // Re-sort
            if (side === 'bids') {
                book.bids.sort((a, b) => b.price - a.price); // High to low
            }
            else {
                book.asks.sort((a, b) => a.price - b.price); // Low to high
            }
        }
        book.lastUpdate = Date.now();
    }
    disconnect() {
        this.ws?.close();
        this.ws = null;
    }
}
exports.orderbookCache = new OrderbookCache();
//# sourceMappingURL=orderbookCache.js.map