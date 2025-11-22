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
 * Using full ABI object format for tuple support
 */
export const MARKET_EXECUTED_EVENT = {
  type: 'event',
  name: 'MarketExecuted',
  inputs: [
    { name: 'orderId', type: 'uint256', indexed: false },
    {
      name: 't',
      type: 'tuple',
      indexed: false,
      components: [
        { name: 'trader', type: 'address' },
        { name: 'pairIndex', type: 'uint256' },
        { name: 'index', type: 'uint256' },
        { name: 'initialPosToken', type: 'uint256' },
        { name: 'positionSizeUSDC', type: 'uint256' },
        { name: 'openPrice', type: 'uint256' },
        { name: 'buy', type: 'bool' },
        { name: 'leverage', type: 'uint256' },
        { name: 'tp', type: 'uint256' },
        { name: 'sl', type: 'uint256' },
        { name: 'timestamp', type: 'uint256' },
      ],
    },
    { name: 'open', type: 'bool', indexed: false },
    { name: 'price', type: 'uint256', indexed: false },
    { name: 'positionSizeUSDC', type: 'uint256', indexed: false },
    { name: 'percentProfit', type: 'int256', indexed: false },
    { name: 'usdcSentToTrader', type: 'uint256', indexed: false },
    { name: 'isPnl', type: 'bool', indexed: false },
  ],
} as const;

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
