/**
 * Event Parser
 * Parses raw blockchain events and converts to application format
 */

import { decodeEventLog, type Log } from 'viem';
import {
  MARKET_ORDER_INITIATED_EVENT,
  MARKET_EXECUTED_EVENT,
} from './config/events';
import { getBlock } from './core/ViemClient';
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
export async function parseMarketExecuted(log: Log): Promise<ParsedMarketExecutedEvent | null> {
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

    // For timestamp:
    // - Trade tuple's timestamp is ALWAYS the position open time
    // - For open events: use trade tuple timestamp (correct)
    // - For close events: fetch actual block timestamp (actual close time)
    let eventTimestamp: Date;
    if (open) {
      eventTimestamp = fromTimestamp(timestamp); // Position open time from tuple
    } else {
      // Fetch actual block to get real timestamp for close event
      const block = await getBlock(log.blockNumber || 0n);
      eventTimestamp = new Date(Number(block.timestamp) * 1000);
    }

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
 * Batch parse MarketExecuted events with block timestamp caching
 * @param logs - Array of event logs
 * @returns Array of parsed events (nulls filtered out)
 */
export async function batchParseMarketExecuted(logs: Log[]): Promise<ParsedMarketExecutedEvent[]> {
  const parsed: ParsedMarketExecutedEvent[] = [];

  // Build cache of block timestamps for close events
  // This avoids fetching the same block multiple times
  const blockTimestampCache = new Map<bigint, Date>();

  // Collect unique block numbers for close events
  const closeEventBlocks = new Set<bigint>();
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: [MARKET_EXECUTED_EVENT],
        data: log.data,
        topics: log.topics,
      });
      const args = decoded.args as any;
      const open = args.open as boolean;

      // If this is a close event, we'll need its block timestamp
      if (!open && log.blockNumber) {
        closeEventBlocks.add(log.blockNumber);
      }
    } catch (error) {
      // Skip invalid events
      continue;
    }
  }

  // Batch fetch all unique block timestamps in parallel
  if (closeEventBlocks.size > 0) {
    console.log(`[EventParser] Pre-fetching ${closeEventBlocks.size} unique block timestamps...`);
    const blockFetches = Array.from(closeEventBlocks).map(async (blockNum) => {
      try {
        const block = await getBlock(blockNum);
        return { blockNum, timestamp: new Date(Number(block.timestamp) * 1000) };
      } catch (error) {
        console.error(`[EventParser] Failed to fetch block ${blockNum}:`, error);
        return null;
      }
    });

    const blockResults = await Promise.all(blockFetches);
    for (const result of blockResults) {
      if (result) {
        blockTimestampCache.set(result.blockNum, result.timestamp);
      }
    }
    console.log(`[EventParser] ✓ Cached ${blockTimestampCache.size} block timestamps`);
  }

  // Now parse all events using the cache
  for (const log of logs) {
    const event = await parseMarketExecutedWithCache(log, blockTimestampCache);
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
 * Parse MarketExecuted with cached block timestamps
 */
async function parseMarketExecutedWithCache(
  log: Log,
  blockTimestampCache: Map<bigint, Date>
): Promise<ParsedMarketExecutedEvent | null> {
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

    // For timestamp: use cache for close events
    let eventTimestamp: Date;
    if (open) {
      eventTimestamp = fromTimestamp(timestamp); // Position open time from tuple
    } else {
      // Use cached block timestamp (already fetched in batch)
      const cachedTimestamp = blockTimestampCache.get(log.blockNumber || 0n);
      if (cachedTimestamp) {
        eventTimestamp = cachedTimestamp;
      } else {
        // Fallback: fetch if not in cache (shouldn't happen)
        const block = await getBlock(log.blockNumber || 0n);
        eventTimestamp = new Date(Number(block.timestamp) * 1000);
      }
    }

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
