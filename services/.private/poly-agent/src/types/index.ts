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
 * Pending order tracked by Confirmer (v3 — GTD maker orders)
 *
 * Emitted by GTTExecutor as 'trade:submitted' after successful postOrder.
 * Confirmer stores this and matches incoming WebSocket trade events against
 * maker_order_id (GTD orders are always maker side).
 */
export interface PendingOrder {
  orderId:      string;   // CLOB order ID returned by postOrder
  tradeDocId:   string;   // MongoDB _id of the CopyTrade document
  traderWallet: string;   // Source trader wallet (for TraderLoader.recordFill)

  side:         'BUY' | 'SELL';
  tokenId:      string;
  conditionId:  string;
  targetUsdc:   number;         // Total USDC we're trying to fill (BUY)
  targetShares?: number;        // Target shares to sell (SELL proportional exit)
  limitPrice:   number;         // Price we posted at
  submittedAt: number;    // Date.now() when order was posted

  attempt:     number;    // 1-based attempt number (for retry cap check)

  // Original trade context (for priceDrift + latency calculations)
  traderPrice: number;
  traderTs:    number;    // Unix ms — trader's tx timestamp
  detectedAt:  number;    // Unix ms — when detector saw it

  // Accumulated across partial fills (updated in-place by Confirmer)
  filledSize:  number;
  filledCost:  number;
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
  event_type:       'trade';
  id:               string;
  maker_order_id:   string;   // Our order ID when we are the maker (GTD)
  taker_order_id:   string;   // Our order ID when we are the taker (FAK/FOK)
  status:           'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED';
  price:            string;
  size:             string;
  side:             'BUY' | 'SELL';
  asset_id:         string;
  market:           string;
  outcome:          string;
  timestamp:        string;
}

/**
 * WebSocket order update message
 */
export interface OrderUpdateMessage {
  event_type: 'order';
  id:         string;
  type:       'PLACEMENT' | 'UPDATE' | 'CANCELLATION';
  status:     'LIVE' | 'MATCHED' | 'CANCELLED';
}
