/**
 * Type definitions for Poly-Agent
 */
/**
 * Detected trade from target wallet
 */
export interface DetectedTrade {
    txHash: string;
    conditionId: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    usdcSize: number;
    timestamp: number;
    title: string;
    outcome: string;
    detectedAt: number;
}
/**
 * Pending order tracked by Confirmer (v3 — GTD maker orders)
 *
 * Emitted by GTTExecutor as 'trade:submitted' after successful postOrder.
 * Confirmer stores this and matches incoming WebSocket trade events against
 * maker_order_id (GTD orders are always maker side).
 */
export interface PendingOrder {
    orderId: string;
    tradeDocId: string;
    traderWallet: string;
    side: 'BUY' | 'SELL';
    tokenId: string;
    conditionId: string;
    targetUsdc: number;
    targetShares?: number;
    limitPrice: number;
    submittedAt: number;
    attempt: number;
    traderPrice: number;
    traderTs: number;
    detectedAt: number;
    filledSize: number;
    filledCost: number;
}
/**
 * Polymarket Activity API response
 */
export interface ActivityResponse {
    timestamp: number;
    type: 'TRADE' | 'SPLIT' | 'MERGE' | 'REDEEM';
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    usdcSize: number;
    asset: string;
    conditionId: string;
    title: string;
    outcome: string;
    transactionHash: string;
}
/**
 * Polymarket Position API response
 */
export interface PositionResponse {
    conditionId: string;
    asset: string;
    size: number;
    avgPrice: number;
    curPrice: number;
    cashPnl: number;
    percentPnl: number;
    initialValue: number;
    currentValue: number;
    title: string;
    outcome: string;
    endDate: string;
    redeemable: boolean;
}
/**
 * WebSocket trade fill message from Polymarket User Channel.
 *
 * For GTD maker orders our order is on the maker side, so the relevant
 * field is maker_order_id (not taker_order_id).
 */
export interface TradeFillMessage {
    event_type: 'trade';
    id: string;
    maker_order_id: string;
    taker_order_id: string;
    status: 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED';
    price: string;
    size: string;
    side: 'BUY' | 'SELL';
    asset_id: string;
    market: string;
    outcome: string;
    timestamp: string;
}
/**
 * WebSocket order update message
 */
export interface OrderUpdateMessage {
    event_type: 'order';
    id: string;
    type: 'PLACEMENT' | 'UPDATE' | 'CANCELLATION';
    status: 'LIVE' | 'MATCHED' | 'CANCELLED';
}
