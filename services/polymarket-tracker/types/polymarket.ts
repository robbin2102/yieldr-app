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
  currentPositionValue: number;    // Total worth of all open positions NOW
  initialInvestment: number;       // What was originally invested in open positions
  totalUnrealizedPnl: number;

  // Closed Positions
  closedPositionsCount: number;
  closedInvestment: number;        // What was invested in closed positions
  totalRealizedPnl: number;
  wins: number;
  losses: number;
  winRate: number;

  // Combined
  totalPnl: number;
  totalInvested: number;           // initialInvestment + closedInvestment
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
  profitFactor: number;            // Total Won / Total Lost (1.0+ is profitable)

  // Capital Analysis (for accurate ROI)
  avgBetSize: number;              // Average bet size across all closed positions
  medianBetSize: number;           // Median bet size
  maxBetSize: number;              // Maximum single bet size
  totalWon: number;                // Total $ won (sum of winning positions)
  totalLost: number;               // Total $ lost (sum of losing positions)

  // Capital-based ROI (more accurate than invested-based)
  roiOnAvgCapital: number;         // Total PnL / Avg Bet Size * 100
  roiOnMedianCapital: number;      // Total PnL / Median Bet Size * 100
  roiOnMaxCapital: number;         // Total PnL / Max Bet Size * 100
}
