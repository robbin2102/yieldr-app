/**
 * Polymarket API Response Types
 */

// Open Position Response
export interface OpenPositionResponse {
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  endDate?: string;
  redeemable?: boolean;
}

// Closed Position Response
export interface ClosedPositionResponse {
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  outcomeIndex: number;
  totalBought: number;
  avgPrice: number;
  realizedPnl: number;
  timestamp: number;      // Unix timestamp (seconds)
  endDate?: string;
}

// Activity/Trade Response
export interface ActivityResponse {
  id: string;
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  outcomeIndex?: number;
  type: 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL';  // Only for TRADE
  size: number;
  price: number;
  usdcSize: number;
  timestamp: number;       // Unix timestamp (seconds)
  transactionHash: string;
}

// Trader Metrics
export interface TraderMetrics {
  // Open Positions
  openPositionsCount: number;
  totalUnrealizedPnl: number;

  // Closed Positions
  closedPositionsCount: number;
  totalRealizedPnl: number;
  wins: number;
  losses: number;
  winRate: number;

  // Combined
  totalPnl: number;
  totalInvested: number;
  overallRoi: number;

  // Time-based PnL
  pnl1d: number;
  pnl7d: number;
  pnl30d: number;
  roi1d: number;
  roi7d: number;
  roi30d: number;

  // Risk Metrics
  sharpeRatio: number;
}
