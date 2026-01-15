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
  timestamp: number;        // Unix seconds
  title: string;
  outcome: string;
  detectedAt: number;       // Unix milliseconds
}

/**
 * Pending order being tracked by Confirmer
 */
export interface PendingOrder {
  tradeId: string;          // MongoDB _id of PolyAgentTrade
  orderId: string;          // CLOB order ID
  expectedSize: number;     // Shares we expect to fill
  expectedPrice: number;    // Price we submitted at
  originalTrade: DetectedTrade;
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
 * WebSocket trade fill message
 */
export interface TradeFillMessage {
  event_type: 'trade';
  id: string;
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
