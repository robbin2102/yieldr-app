/**
 * Confirmer — tracks GTD maker order fills via Polymarket WebSocket User Channel.
 *
 * WHY WEBSOCKET (NOT REST POLLING):
 *   Polymarket's GET /order/{id} returns 404 as soon as an order leaves the
 *   active-orders index (i.e. the moment it fills, cancels, or expires).
 *   There is no way to poll for fill status without hitting 404s on every fill.
 *   The correct approach — used by all Polymarket market-maker bots — is to
 *   subscribe to the User Channel and receive push notifications.
 *
 * Fill detection for GTD MAKER orders:
 *   When our maker order fills, Polymarket pushes a 'trade' event containing:
 *     maker_order_id = our order ID   ← we match on this
 *     taker_order_id = counterparty's order ID
 *   The previous code matched on taker_order_id, which NEVER matched our
 *   maker orders.
 *
 * Retry flow:
 *   When a GTD order expires without filling, Polymarket sends an 'order'
 *   event with type='CANCELLATION'. Confirmer emits 'order:expired' so
 *   GTTExecutor can place a fresh order with an updated price.
 *
 * Reconnect:
 *   Auto-reconnects on disconnect with 5s delay.
 *   No REST polling fallback — REST polling was the source of the 404 problem.
 */
export declare class Confirmer {
    private ws;
    private pendingOrders;
    private reconnecting;
    private heartbeatInterval;
    private stuckScanInterval;
    private stopped;
    connect(): Promise<void>;
    disconnect(): void;
    /**
     * Periodically scan for EXECUTING docs that have been stuck longer than
     * gttExpirySeconds + 60s. Emits 'order:expired' so GTTExecutor retries them.
     * Catches fills missed by WebSocket during running sessions (not just restarts).
     */
    startStuckOrderScan(): void;
    private sendAuth;
    /**
     * Handle 'trade' event from User Channel.
     *
     * For GTD maker orders our orderId is in maker_order_id.
     * We also check taker_order_id for completeness (handles any FAK/taker orders).
     *
     * Partial fills accumulate: multiple trade events may arrive for one order.
     * We keep the pending entry until the total filled cost covers 90%+ of target.
     */
    private handleTradeFill;
    /**
     * Handle 'order' event from User Channel.
     *
     * CANCELLATION = order left the book without filling (expired GTD or manual cancel).
     * Emit 'order:expired' so GTTExecutor can retry with a fresh price.
     */
    private handleOrderUpdate;
    private startHeartbeat;
    private stopHeartbeat;
    private scheduleReconnect;
    /**
     * Called after reconnect to handle orders whose fill events may have been
     * missed during the disconnect window.
     *
     * Any pending order older than gttExpirySeconds + 30s has definitely expired
     * on Polymarket's side. Emit 'order:expired' so GTTExecutor retries it.
     * This prevents orders getting stuck in EXECUTING forever after a WS gap.
     */
    private reviewStaleOrders;
    /**
     * On bot startup, scan MongoDB for EXECUTING docs left over from a previous
     * run. These will never receive a fill event (WebSocket session is new).
     * Mark them FAILED so they don't silently block allocation.
     */
    static clearStaleExecutingDocs(): Promise<void>;
}
