/**
 * Event Parser
 * Parses raw blockchain events and converts to application format
 */

import { decodeEventLog, type Log } from 'viem';
import {
  MARKET_ORDER_INITIATED_EVENT,
  MARKET_EXECUTED_EVENT,
} from './config/events';
import {
  fromPriceDecimals,
  fromLeverageDecimals,
  fromUsdcDecimals,
  fromPercentDecimals,
  fromTimestamp,
  toNumber,
  isValidAddress,
} from './core/decimals';
import type {
  RawMarketOrderInitiatedEvent,
  RawMarketExecutedEvent,
  ParsedMarketOrderInitiatedEvent,
  ParsedMarketExecutedEvent,
} from './types/events';

/**
 * Parse MarketOrderInitiated event log
 * @param log - Raw event log from blockchain
 * @returns Parsed event data
 */
export function parseMarketOrderInitiated(
  log: Log
): ParsedMarketOrderInitiatedEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: [MARKET_ORDER_INITIATED_EVENT],
      data: log.data,
      topics: log.topics,
    });

    const args = decoded.args as any;

    // Extract values
    const trader = (args.trader as string).toLowerCase();
    const orderId = args.orderId as bigint;
    const pairIndex = args.pairIndex as bigint;
    const open = args.open as boolean;
    const isBuy = args.isBuy as boolean;
    const timestamp = args.timestamp as bigint;

    // Validate trader address
    if (!isValidAddress(trader)) {
      console.error(`[EventParser] Invalid trader address: ${trader}`);
      return null;
    }

    // Convert to application format
    const parsed: ParsedMarketOrderInitiatedEvent = {
      orderId: orderId.toString(),
      trader,
      pairIndex: toNumber(pairIndex, 'pairIndex'),
      open,
      isBuy,
      initiatedAt: fromTimestamp(timestamp),
      initiatedTxHash: log.transactionHash || '',
      initiatedBlockNumber: toNumber(log.blockNumber || 0n, 'blockNumber'),
    };

    return parsed;
  } catch (error) {
    console.error('[EventParser] Failed to parse MarketOrderInitiated:', error);
    return null;
  }
}

/**
 * Parse MarketExecuted event log
 * @param log - Raw event log from blockchain
 * @returns Parsed event data
 */
export function parseMarketExecuted(log: Log): ParsedMarketExecutedEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: [MARKET_EXECUTED_EVENT],
      data: log.data,
      topics: log.topics,
    });

    const args = decoded.args as any;

    // Extract values
    const orderId = args.orderId as bigint;
    const trade = args.t as any; // Tuple
    const open = args.open as boolean;
    const price = args.price as bigint;
    const positionSizeUSDC = args.positionSizeUSDC as bigint;
    const percentProfit = args.percentProfit as bigint; // int256
    const usdcSentToTrader = args.usdcSentToTrader as bigint;

    // Extract from trade tuple
    const trader = (trade.trader as string).toLowerCase();
    const pairIndex = trade.pairIndex as bigint;
    const index = trade.index as bigint;
    const initialPosToken = trade.initialPosToken as bigint;
    const openPrice = trade.openPrice as bigint;
    const buy = trade.buy as boolean;
    const leverage = trade.leverage as bigint;
    const tp = trade.tp as bigint;
    const sl = trade.sl as bigint;
    const timestamp = trade.timestamp as bigint;

    // Validate trader address
    if (!isValidAddress(trader)) {
      console.error(`[EventParser] Invalid trader address: ${trader}`);
      return null;
    }

    // Convert decimals
    const collateralUsdc = fromUsdcDecimals(initialPosToken);
    const positionSize = fromUsdcDecimals(positionSizeUSDC);
    const openPriceNum = fromPriceDecimals(openPrice);
    const executionPriceNum = fromPriceDecimals(price);
    const leverageNum = fromLeverageDecimals(leverage);
    const tpNum = fromPriceDecimals(tp);
    const slNum = fromPriceDecimals(sl);

    // Use trade tuple timestamp (position open time)
    // Note: For close events, this shows when position was opened, not closed
    // Trade-off: Fast backfill vs accurate close timestamps
    const eventTimestamp = fromTimestamp(timestamp);

    // Base parsed event
    const parsed: ParsedMarketExecutedEvent = {
      orderId: orderId.toString(),
      trader,
      pairIndex: toNumber(pairIndex, 'pairIndex'),
      tradeIndex: toNumber(index, 'tradeIndex'),
      open,
      isBuy: buy,
      collateralUsdc,
      positionSizeUsdc: positionSize,
      leverage: leverageNum,
      openPrice: openPriceNum,
      executionPrice: executionPriceNum,
      tp: tpNum,
      sl: slNum,
      executedAt: eventTimestamp,
      executedTxHash: log.transactionHash || '',
      executedBlockNumber: toNumber(log.blockNumber || 0n, 'blockNumber'),
    };

    // If this is a close (open=false), add close-specific data
    if (!open) {
      parsed.closePrice = executionPriceNum;
      parsed.profitPercent = fromPercentDecimals(percentProfit);
      // PnL = total sent to trader - initial collateral
      parsed.pnlUsdc = fromUsdcDecimals(usdcSentToTrader) - fromUsdcDecimals(initialPosToken);
    }

    return parsed;
  } catch (error) {
    console.error('[EventParser] Failed to parse MarketExecuted:', error);
    return null;
  }
}

/**
 * Batch parse MarketOrderInitiated events
 * @param logs - Array of event logs
 * @returns Array of parsed events (nulls filtered out)
 */
export function batchParseMarketOrderInitiated(
  logs: Log[]
): ParsedMarketOrderInitiatedEvent[] {
  const parsed: ParsedMarketOrderInitiatedEvent[] = [];

  for (const log of logs) {
    const event = parseMarketOrderInitiated(log);
    if (event) {
      parsed.push(event);
    }
  }

  console.log(
    `[EventParser] Parsed ${parsed.length}/${logs.length} MarketOrderInitiated events`
  );

  return parsed;
}

/**
 * Batch parse MarketExecuted events
 * @param logs - Array of event logs
 * @returns Array of parsed events (nulls filtered out)
 */
export function batchParseMarketExecuted(logs: Log[]): ParsedMarketExecutedEvent[] {
  const parsed: ParsedMarketExecutedEvent[] = [];

  for (const log of logs) {
    const event = parseMarketExecuted(log);
    if (event) {
      parsed.push(event);
    }
  }

  console.log(
    `[EventParser] Parsed ${parsed.length}/${logs.length} MarketExecuted events`
  );

  return parsed;
}

/**
 * Validate parsed event has required fields
 * @param event - Parsed event
 * @returns true if valid
 */
export function validateParsedEvent(event: any): boolean {
  if (!event) return false;
  if (!event.orderId) {
    console.warn('[EventParser] Missing orderId');
    return false;
  }
  if (!event.trader) {
    console.warn('[EventParser] Missing trader');
    return false;
  }
  return true;
}
