/**
 * Avantis Event Definitions and Topic Hashes
 */

import { parseAbiItem } from 'viem';

/**
 * MarketOrderInitiated Event
 * Emitted from Trading Contract (0x44914408...)
 */
export const MARKET_ORDER_INITIATED_EVENT = parseAbiItem(
  'event MarketOrderInitiated(address indexed trader, uint256 pairIndex, bool open, uint256 orderId, uint256 timestamp, bool isBuy)'
);

export const MARKET_ORDER_INITIATED_TOPIC =
  '0xe9092f5bd9dedfcde131b74a84f9c41981d96f1114420e39a57d92d9324ee076' as const;

/**
 * MarketExecuted Event
 * Emitted from Events Contract (0x0c16ff40...)
 */
export const MARKET_EXECUTED_EVENT = parseAbiItem(
  'event MarketExecuted(uint256 orderId, tuple(address trader, uint256 pairIndex, uint256 index, uint256 initialPosToken, uint256 positionSizeUSDC, uint256 openPrice, bool buy, uint256 leverage, uint256 tp, uint256 sl, uint256 timestamp) t, bool open, uint256 price, uint256 positionSizeUSDC, int256 percentProfit, uint256 usdcSentToTrader, bool isPnl)'
);

export const MARKET_EXECUTED_TOPIC =
  '0x5c00d8b4c6c92b4922d1bd61ef722ec9a29169acb95d956676b07be6a6643eea' as const;

/**
 * Application Event Names (for EventEmitter)
 */
export const APP_EVENTS = {
  TRADE_OPENED: 'trade:opened',
  TRADE_CLOSED: 'trade:closed',
  TRADE_TPSL_UPDATED: 'trade:tpsl:updated',
  BACKFILL_PROGRESS: 'backfill:progress',
  BACKFILL_COMPLETE: 'backfill:complete',
  BACKFILL_ERROR: 'backfill:error',
} as const;

export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];
