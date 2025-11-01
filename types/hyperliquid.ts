/**
 * Hyperliquid API Type Definitions
 * API Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
 */

/**
 * Position data from Hyperliquid clearinghouse
 */
export interface HyperliquidPosition {
  coin: string;              // Asset symbol (e.g., "BTC", "ETH")
  szi: string;               // Size string (positive = long, negative = short)
  entryPx: string;          // Entry price as string
  liquidationPx: string | null;  // Liquidation price (null if not applicable)
  marginUsed: string;       // Margin used for this position
  unrealizedPnl: string;    // Unrealized PnL
  returnOnEquity: string;   // ROE percentage
  positionValue: string;    // Total position value
  leverage: {
    value: number;          // Leverage multiplier
    type: string;           // "cross" or "isolated"
  };
}

/**
 * Asset position wrapper from clearinghouseState response
 */
export interface HyperliquidAssetPosition {
  position: HyperliquidPosition;
  type: string;  // "oneWay" typically
}

/**
 * Margin summary from clearinghouse
 */
export interface HyperliquidMarginSummary {
  accountValue: string;       // Total account value
  totalMarginUsed: string;    // Total margin across all positions
  totalNtlPos: string;        // Total notional position value
  totalRawUsd: string;        // Raw USD balance
  withdrawable: string;       // Amount available to withdraw
}

/**
 * Complete clearinghouse state response
 */
export interface HyperliquidClearinghouseState {
  assetPositions: HyperliquidAssetPosition[];
  marginSummary: HyperliquidMarginSummary;
  crossMarginSummary: HyperliquidMarginSummary;
  withdrawable: string;
  time: number;  // Timestamp
}

/**
 * API request format for Hyperliquid info endpoint
 */
export interface HyperliquidAPIRequest {
  type: 'clearinghouseState' | 'userFills' | 'openOrders' | 'portfolio' | 'userFillsByTime';
  user: string;  // Ethereum address (case-insensitive)
  startTime?: number;  // Unix timestamp in milliseconds (for userFillsByTime)
  endTime?: number;    // Unix timestamp in milliseconds (for userFillsByTime)
  aggregateByTime?: boolean;  // For userFillsByTime
}

/**
 * Standardized PERP position format (matching Avantis schema)
 */
export interface StandardizedPerpPosition {
  type: 'PERP';
  platform: 'Hyperliquid' | 'Avantis';
  pair: string;              // e.g., "BTC/USD"
  direction: 'LONG' | 'SHORT';
  leverage: number;
  positionSize: number;      // Total position value in USD
  margin: number;            // Margin/collateral used
  entryPrice: number;
  currentPrice: number;      // Current market price
  liquidationPrice: number | null;
  pnl: number;               // Profit/Loss
  roi: number;               // Return on Investment (%)
  status: 'active' | 'closed';
  positionId: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * API response format for position endpoints
 */
export interface PositionAPIResponse {
  success: boolean;
  data?: {
    totalPositions: number;
    positions: StandardizedPerpPosition[];
    summary: {
      totalPnL: number;
      totalMargin: number;
      overallROI: number;
      accountValue?: number;  // Hyperliquid-specific
      withdrawable?: number;  // Hyperliquid-specific
    };
  };
  error?: string;
  message?: string;
}

/**
 * User fills (trade history) response
 */
export interface HyperliquidUserFill {
  coin: string;
  px: string;         // Price
  sz: string;         // Size
  side: string;       // "A" (ask/sell) or "B" (bid/buy)
  time: number;       // Timestamp
  startPosition: string;
  dir: string;        // "Open Long", "Close Long", etc.
  closedPnl: string;  // Realized PnL (if position closed)
  hash: string;       // Transaction hash
  oid: number;        // Order ID
  crossed: boolean;   // Whether order crossed the spread
  fee: string;        // Trading fee
  tid: number;        // Trade ID
  liquidation: boolean;
}

/**
 * Portfolio PnL response
 */
export interface HyperliquidPortfolio {
  day: string;
  week: string;
  month: string;
  allTime: string;
  perpDay: string;
  perpWeek: string;
  perpMonth: string;
  perpAllTime: string;
}
