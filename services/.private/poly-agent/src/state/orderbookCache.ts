import WebSocket from 'ws';
import { config } from '../config';
import { eventBus } from './eventBus';

interface OrderBook {
  bids: { price: number; size: number }[];  // Sorted high to low
  asks: { price: number; size: number }[];  // Sorted low to high
  lastUpdate: number;
}

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
class OrderbookCache {
  private ws: WebSocket | null = null;
  private books: Map<string, OrderBook> = new Map();
  private subscribedTokens: Set<string> = new Set();
  private reconnecting: boolean = false;

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      console.log('[OrderbookCache] Connecting to Market Channel...');

      this.ws = new WebSocket(config.wssMarket);

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
                .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
                .sort((a: any, b: any) => b.price - a.price),  // High to low
              asks: msg.asks
                .map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
                .sort((a: any, b: any) => a.price - b.price),  // Low to high
              lastUpdate: Date.now(),
            });

            const bestBid = msg.bids.length > 0 ? msg.bids[0].price : 'N/A';
            const bestAsk = msg.asks.length > 0 ? msg.asks[0].price : 'N/A';
            console.log(`[OrderbookCache] 📊 Orderbook snapshot: ${msg.asset_id.slice(0, 8)}... (bid: ${bestBid}, ask: ${bestAsk}, ${this.books.size} markets cached)`);
          } else if (msg.event_type === 'price_change') {
            // Incremental update
            this.applyChanges(msg.asset_id, msg.price_changes);
          }
        } catch (err) {
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

  private reconnect() {
    if (this.reconnecting) return;
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
  subscribe(tokenId: string) {
    if (this.subscribedTokens.has(tokenId)) return;
    this.subscribedTokens.add(tokenId);
    this.subscribeInternal(tokenId);
  }

  private subscribeInternal(tokenId: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log(`[OrderbookCache] Subscribing to ${tokenId.slice(0, 16)}...`);
      // Correct format from Polymarket docs: type = channel name
      this.ws.send(JSON.stringify({
        type: 'market',
        assets_ids: [tokenId],
      }));
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
      console.log(`[OrderbookCache] 🔄 Cache miss - fetching orderbook for ${tokenId.slice(0, 16)}...`);

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

      console.log(`[OrderbookCache] ✅ Fetched orderbook in ${fetchLatency}ms (bid: ${bestBid}, ask: ${bestAsk})`);

      // Subscribe to WebSocket for future updates
      this.subscribe(tokenId);

      return true;
    } catch (error: any) {
      console.error(`[OrderbookCache] ❌ Failed to fetch orderbook: ${error.message}`);
      return false;
    }
  }

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
  getBestPrice(tokenId: string, side: 'BUY' | 'SELL'): number | null {
    const book = this.books.get(tokenId);
    if (!book) return null;

    if (side === 'BUY') {
      // For BUY orders: take the best ask (lowest sell price)
      return book.asks.length > 0 ? book.asks[0].price : null;
    } else {
      // For SELL orders: take the best bid (highest buy price)
      return book.bids.length > 0 ? book.bids[0].price : null;
    }
  }

  /**
   * Check if we have orderbook data for a token
   */
  hasOrderbook(tokenId: string): boolean {
    return this.books.has(tokenId);
  }

  /**
   * Apply incremental orderbook changes from WSS
   */
  private applyChanges(assetId: string, changes: any[]) {
    const book = this.books.get(assetId);
    if (!book) return;

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
        book.bids.sort((a, b) => b.price - a.price);  // High to low
      } else {
        book.asks.sort((a, b) => a.price - b.price);  // Low to high
      }
    }

    book.lastUpdate = Date.now();
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
  }

}

export const orderbookCache = new OrderbookCache();
