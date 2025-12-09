/**
 * Confirmer - Tracks trade fills via WebSocket User Channel
 *
 * Flow:
 * 1. Connect to WSS User Channel with authentication
 * 2. Listen for 'trade:submitted' events from Executor
 * 3. Store order details in pendingOrders Map (for correlation)
 * 4. Receive fill notifications via WSS
 * 5. Match orderId → update MongoDB with fill details + slippage
 *
 * Note: pendingOrders Map is NOT a performance cache - just a small
 * correlation table to match WSS messages to our submitted orders.
 * It doesn't affect execution speed (post-execution only).
 */
export declare class Confirmer {
    private ws;
    private pendingOrders;
    private reconnecting;
    private heartbeatInterval;
    private pollingInterval;
    private pollingActive;
    connect(): Promise<void>;
    private authenticate;
    private reconnect;
    private startHeartbeat;
    private stopHeartbeat;
    /**
     * Start polling REST API for fill tracking (fallback when WebSocket fails)
     */
    private startPolling;
    /**
     * Stop REST API polling
     */
    private stopPolling;
    /**
     * Check pending orders via REST API
     */
    private checkPendingOrders;
    /**
     * Generate HMAC signature for REST API requests
     */
    private generateSignature;
    /**
     * Process fill data (common logic for WebSocket and polling)
     */
    private processFill;
    /**
     * Handle trade fill notification from WSS
     */
    private handleTradeFill;
    /**
     * Handle order update notification from WSS
     */
    private handleOrderUpdate;
    /**
     * Update slippage buffer in MongoDB (direct write, no cache)
     */
    private updateSlippageBuffer;
    disconnect(): void;
}
