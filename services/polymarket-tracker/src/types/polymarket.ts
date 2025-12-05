// API Response Types

export interface PositionResponse {
  conditionId: string;
  asset: string;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  endDate: string;
  redeemable: boolean;
}

export interface ClosedPositionResponse {
  conditionId: string;
  asset: string;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  totalBought: number;
  avgPrice: number;
  realizedPnl: number;
  timestamp: number; // Unix timestamp in seconds
  endDate: string;
}

export interface ActivityResponse {
  conditionId: string;
  asset: string;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  usdcSize: number;
  timestamp: number; // Unix timestamp in seconds
  transactionHash: string;
}

// Database Document Types

export interface OpenPosition {
  walletAddress: string;
  conditionId: string;
  asset: string;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  roi: number;
  endDate: Date;
  redeemable: boolean;
  fetchedAt: Date;
  updatedAt: Date;
}

export interface ClosedPosition {
  walletAddress: string;
  conditionId: string;
  asset: string;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  totalBought: number;
  avgPrice: number;
  realizedPnl: number;
  totalBet: number;
  amountWon: number;
  roi: number;
  won: boolean;
  closedAt: Date;
  endDate: Date;
  fetchedAt: Date;
}

export interface Trade {
  walletAddress: string;
  conditionId: string;
  asset: string;
  transactionHash: string;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  usdcSize: number;
  timestamp: Date;
  detectedAt: Date;
}

export interface PolymarketMetrics {
  walletAddress: string;
  openPositionsCount: number;
  totalUnrealizedPnl: number;
  closedPositionsCount: number;
  totalRealizedPnl: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  totalInvested: number;
  overallRoi: number;
  sharpeRatio: number;
  pnl1d: number;
  pnl7d: number;
  pnl30d: number;
  lastUpdated: Date;
}
