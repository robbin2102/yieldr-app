/**
 * TypeScript interfaces for Avantis events
 */

import { TradeStatus } from '../config/constants';

/**
 * Raw MarketOrderInitiated event (before decimal conversion)
 */
export interface RawMarketOrderInitiatedEvent {
  trader: string;
  pairIndex: bigint;
  open: boolean;
  orderId: bigint;
  timestamp: bigint;
  isBuy: boolean;
  transactionHash: string;
  blockNumber: bigint;
}

/**
 * Raw MarketExecuted event (before decimal conversion)
 */
export interface RawMarketExecutedEvent {
  orderId: bigint;
  trade: {
    trader: string;
    pairIndex: bigint;
    index: bigint;
    initialPosToken: bigint;
    positionSizeUSDC: bigint;
    openPrice: bigint;
    buy: boolean;
    leverage: bigint;
    tp: bigint;
    sl: bigint;
    timestamp: bigint;
  };
  open: boolean;
  price: bigint;
  positionSizeUSDC: bigint;
  percentProfit: bigint; // int256 - can be negative
  usdcSentToTrader: bigint;
  isPnl: boolean;
  transactionHash: string;
  blockNumber: bigint;
}

/**
 * Parsed MarketOrderInitiated event (after decimal conversion)
 */
export interface ParsedMarketOrderInitiatedEvent {
  orderId: string;
  trader: string;
  pairIndex: number;
  open: boolean;
  isBuy: boolean;
  initiatedAt: Date;
  initiatedTxHash: string;
  initiatedBlockNumber: number;
}

/**
 * Parsed MarketExecuted event (after decimal conversion)
 */
export interface ParsedMarketExecutedEvent {
  orderId: string;
  trader: string;
  pairIndex: number;
  tradeIndex: number;
  open: boolean;
  isBuy: boolean;

  // Position details
  collateralUsdc: number;
  positionSizeUsdc: number;
  leverage: number;

  // Prices
  openPrice: number;
  executionPrice: number;
  tp: number;
  sl: number;

  // Close-specific (when open=false)
  closePrice?: number;
  profitPercent?: number;
  pnlUsdc?: number;

  // Timestamps
  executedAt: Date;
  executedTxHash: string;
  executedBlockNumber: number;
}

/**
 * Parsed LimitExecuted event (after decimal conversion)
 * Same structure as MarketExecuted since they both contain the same trade tuple
 * The only difference is limitIndex and orderType, which we don't need to track
 */
export type ParsedLimitExecutedEvent = ParsedMarketExecutedEvent;

/**
 * Combined trade event for correlation
 */
export interface CorrelatedTradeEvent {
  orderId: string;
  status: TradeStatus;

  // From MarketOrderInitiated
  trader: string;
  pairIndex: number;
  isBuy: boolean;
  initiatedAt: Date;
  initiatedTxHash: string;
  initiatedBlockNumber: number;

  // From MarketExecuted (when executed)
  tradeIndex?: number;
  collateralUsdc?: number;
  positionSizeUsdc?: number;
  leverage?: number;
  openPrice?: number;
  executionPrice?: number;
  tp?: number;
  sl?: number;
  executedAt?: Date;
  executedTxHash?: string;
  executedBlockNumber?: number;

  // For closes (when open=false)
  closePrice?: number;
  profitPercent?: number;
  pnlUsdc?: number;
  closedAt?: Date;
  closedTxHash?: string;

  // Computed fields
  durationSeconds?: number;
  roi?: number;

  createdAt: Date;
  updatedAt: Date;
}
