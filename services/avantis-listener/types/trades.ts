/**
 * Trade data types for application use
 */

import { TradeStatus } from '../config/constants';

/**
 * Trade direction
 */
export type TradeDirection = 'LONG' | 'SHORT';

/**
 * Complete trade data (for plugin events)
 */
export interface Trade {
  orderId: string;
  status: TradeStatus;
  trader: string;
  pairIndex: number;
  direction: TradeDirection;

  // Position details
  collateral: number; // USDC
  positionSize: number; // USDC
  leverage: number;

  // Prices
  openPrice: number;
  executionPrice: number;
  closePrice?: number;
  tp: number;
  sl: number;

  // Performance
  pnl?: number; // USDC
  profitPercent?: number;
  roi?: number;

  // Timestamps
  initiatedAt: Date;
  executedAt?: Date;
  closedAt?: Date;
  durationSeconds?: number;

  // Blockchain metadata
  initiatedTxHash: string;
  executedTxHash?: string;
  closedTxHash?: string;
  initiatedBlockNumber: number;
  executedBlockNumber?: number;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Trade opened event data (emitted by EventEmitter)
 */
export interface TradeOpenedEvent {
  orderId: string;
  trader: string;
  pairIndex: number;
  direction: TradeDirection;
  collateral: number;
  positionSize: number;
  leverage: number;
  openPrice: number;
  executionPrice: number;
  tp: number;
  sl: number;
  executedAt: Date;
  txHash: string;
  blockNumber: number;
}

/**
 * Trade closed event data (emitted by EventEmitter)
 */
export interface TradeClosedEvent {
  orderId: string;
  trader: string;
  pairIndex: number;
  direction: TradeDirection;
  closePrice: number;
  pnl: number;
  profitPercent: number;
  roi: number;
  durationSeconds: number;
  closedAt: Date;
  txHash: string;
  blockNumber: number;
}

/**
 * Backfill progress event data
 */
export interface BackfillProgressEvent {
  wallet: string;
  processedBlocks: number;
  totalBlocks: number;
  percentComplete: number;
  eventsFound: number;
  currentBlock: number;
}

/**
 * Backfill complete event data
 */
export interface BackfillCompleteEvent {
  wallet: string;
  totalBlocks: number;
  totalEvents: number;
  tradesFound: number;
  startBlock: number;
  endBlock: number;
  durationMs: number;
}

/**
 * Query filters for trade history
 */
export interface TradeQueryFilters {
  trader?: string;
  status?: TradeStatus;
  pairIndex?: number;
  direction?: TradeDirection;
  minPnl?: number;
  maxPnl?: number;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Aggregated trade statistics
 */
export interface TradeStatistics {
  trader: string;
  totalTrades: number;
  openTrades: number;
  closedTrades: number;

  // Performance
  totalPnl: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgRoi: number;

  // Position metrics
  totalVolume: number;
  avgPositionSize: number;
  avgLeverage: number;
  avgDurationSeconds: number;

  // Time-based PnL
  pnl24h: number;
  pnl7d: number;
  pnl30d: number;

  // Updated timestamp
  lastTradeAt?: Date;
  computedAt: Date;
}
