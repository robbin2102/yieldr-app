/**
 * Event Correlator
 * Matches open and close events using tradeKey (trader-pairIndex-tradeIndex)
 * Saves to MongoDB and emits application events
 */

import EventEmitter from 'events';
import TradeEvent from '../../models/TradeEvent';
import { APP_EVENTS, FEATURES } from './config';
import { getPairSymbol } from './config/pairs';
import { getBlock } from './core/ViemClient';
import type {
  ParsedMarketOrderInitiatedEvent,
  ParsedMarketExecutedEvent,
} from './types/events';
import type { Trade, TradeDirection } from './types/trades';

/**
 * Event emitter for application events
 */
export const eventEmitter = new EventEmitter();

/**
 * Get block timestamp from block number
 * Fetches the actual block and returns its timestamp
 */
async function getBlockTimestamp(blockNumber: number): Promise<Date> {
  try {
    const block = await getBlock(BigInt(blockNumber));
    return new Date(Number(block.timestamp) * 1000);
  } catch (error) {
    console.error(`[Correlator] Error fetching block ${blockNumber} timestamp:`, error);
    // Fallback to current time if block fetch fails
    return new Date();
  }
}

/**
 * Process MarketOrderInitiated event
 * Note: We primarily use MarketExecuted events now
 * This is kept for logging/debugging purposes
 */
export async function processMarketOrderInitiated(
  event: ParsedMarketOrderInitiatedEvent
): Promise<void> {
  // MarketOrderInitiated events don't have enough data (no tradeIndex)
  // We rely on MarketExecuted events which have the full trade tuple
  console.log(
    `[Correlator] Initiated event - orderId: ${event.orderId}, trader: ${event.trader}, open: ${event.open}`
  );
}

/**
 * Process MarketExecuted event
 * Uses tradeKey to link open and close events
 */
export async function processMarketExecuted(
  event: ParsedMarketExecutedEvent
): Promise<void> {
  try {
    const { orderId, trader, open, pairIndex, tradeIndex } = event;

    // Build tradeKey (composite key to link open and close)
    const tradeKey = `${trader.toLowerCase()}-${pairIndex}-${tradeIndex}`;

    console.log(
      `[Correlator] Processing MarketExecuted - orderId: ${orderId}, tradeKey: ${tradeKey}, open: ${open}`
    );

    // Determine if this is an open or close
    if (open) {
      // Position OPENED
      await handlePositionOpened(event, tradeKey);
    } else {
      // Position CLOSED
      await handlePositionClosed(event, tradeKey);
    }
  } catch (error) {
    console.error('[Correlator] Error processing MarketExecuted:', error);
  }
}

/**
 * Handle position opened (open=true)
 */
async function handlePositionOpened(
  event: ParsedMarketExecutedEvent,
  tradeKey: string
): Promise<void> {
  const { orderId, trader, pairIndex, tradeIndex } = event;

  // Fetch block timestamp for accurate open time
  const blockTimestamp = await getBlockTimestamp(event.executedBlockNumber);

  // Compute direction: LONG or SHORT
  const direction = event.isBuy ? 'LONG' : 'SHORT';

  // Check if this trade already exists
  let existingTrade = await TradeEvent.findOne({ tradeKey });

  if (existingTrade) {
    console.log(`[Correlator] Trade ${tradeKey} already exists, updating...`);
    // Update existing trade (in case we're re-processing)
    existingTrade.status = 'OPEN';
    existingTrade.openOrderId = orderId;
    existingTrade.initiatedAt = blockTimestamp;
    existingTrade.openTxHash = event.executedTxHash;
    existingTrade.openBlockNumber = event.executedBlockNumber;
    existingTrade.collateralUsdc = event.collateralUsdc;
    existingTrade.positionSizeUsdc = event.positionSizeUsdc;
    existingTrade.leverage = event.leverage;
    existingTrade.openPrice = event.openPrice;
    existingTrade.tp = event.tp;
    existingTrade.sl = event.sl;
    existingTrade.pairSymbol = getPairSymbol(pairIndex);
    await existingTrade.save();
  } else {
    // Create new trade record
    const newTrade = new TradeEvent({
      tradeKey,
      status: 'OPEN',
      trader: trader.toLowerCase(),
      platform: 'Avantis',
      pairIndex,
      tradeIndex,
      pairSymbol: getPairSymbol(pairIndex),
      direction,
      openOrderId: orderId,
      initiatedAt: blockTimestamp,
      openTxHash: event.executedTxHash,
      openBlockNumber: event.executedBlockNumber,
      collateralUsdc: event.collateralUsdc,
      positionSizeUsdc: event.positionSizeUsdc,
      leverage: event.leverage,
      openPrice: event.openPrice,
      tp: event.tp,
      sl: event.sl,
    });
    await newTrade.save();
  }

  console.log(`[Correlator] ✓ Position OPENED - tradeKey: ${tradeKey}, orderId: ${orderId}`);

  // Emit trade:opened event
  if (FEATURES.ENABLE_EVENT_EMISSION) {
    const tradeData = buildTradeOpenedEvent(event);
    eventEmitter.emit(APP_EVENTS.TRADE_OPENED, tradeData);
    console.log(`[Correlator] ✓ Emitted trade:opened event for ${tradeKey}`);
  }
}

/**
 * Handle position closed (open=false)
 */
async function handlePositionClosed(
  event: ParsedMarketExecutedEvent,
  tradeKey: string
): Promise<void> {
  const { orderId } = event;

  // Find existing open position by tradeKey
  const existingTrade = await TradeEvent.findOne({ tradeKey });

  if (!existingTrade) {
    console.warn(`[Correlator] No existing open position found for tradeKey ${tradeKey}`);
    return;
  }

  // Fetch block timestamp for accurate close time
  const closeBlockTimestamp = await getBlockTimestamp(event.executedBlockNumber);

  // Calculate duration (in seconds)
  const durationSeconds = existingTrade.initiatedAt
    ? Math.floor((closeBlockTimestamp.getTime() - existingTrade.initiatedAt.getTime()) / 1000)
    : 0;

  // ROI comes from contract's percentProfit field
  const roi = event.profitPercent || 0;

  // Update trade with close data
  existingTrade.status = 'CLOSED';
  existingTrade.closeOrderId = orderId;
  existingTrade.closedAt = closeBlockTimestamp;
  existingTrade.closeTxHash = event.executedTxHash;
  existingTrade.closeBlockNumber = event.executedBlockNumber;
  existingTrade.closePrice = event.closePrice;
  existingTrade.pnlUsdc = event.pnlUsdc;
  existingTrade.roi = roi;
  existingTrade.durationSeconds = durationSeconds;

  // Ensure open data is present (backfill from close event if missing)
  if (!existingTrade.collateralUsdc && event.collateralUsdc) {
    existingTrade.collateralUsdc = event.collateralUsdc;
  }
  if (!existingTrade.positionSizeUsdc && event.positionSizeUsdc) {
    existingTrade.positionSizeUsdc = event.positionSizeUsdc;
  }
  if (!existingTrade.leverage && event.leverage) {
    existingTrade.leverage = event.leverage;
  }
  if (!existingTrade.openPrice && event.openPrice) {
    existingTrade.openPrice = event.openPrice;
  }

  await existingTrade.save();

  console.log(
    `[Correlator] ✓ Position CLOSED - tradeKey: ${tradeKey}, PnL: ${event.pnlUsdc?.toFixed(2)} USDC, ROI: ${roi.toFixed(2)}%, Duration: ${durationSeconds}s`
  );

  // Emit trade:closed event
  if (FEATURES.ENABLE_EVENT_EMISSION) {
    const tradeData = buildTradeClosedEvent(event, existingTrade, durationSeconds, roi);
    eventEmitter.emit(APP_EVENTS.TRADE_CLOSED, tradeData);
    console.log(`[Correlator] ✓ Emitted trade:closed event for ${tradeKey}`);
  }
}

/**
 * Build trade opened event data
 */
function buildTradeOpenedEvent(event: ParsedMarketExecutedEvent) {
  return {
    orderId: event.orderId,
    trader: event.trader,
    pairIndex: event.pairIndex,
    pairSymbol: getPairSymbol(event.pairIndex),
    direction: (event.isBuy ? 'LONG' : 'SHORT') as TradeDirection,
    collateral: event.collateralUsdc || 0,
    positionSize: event.positionSizeUsdc || 0,
    leverage: event.leverage || 0,
    openPrice: event.openPrice || 0,
    tp: event.tp || 0,
    sl: event.sl || 0,
    txHash: event.executedTxHash,
    blockNumber: event.executedBlockNumber,
  };
}

/**
 * Build trade closed event data
 */
function buildTradeClosedEvent(
  event: ParsedMarketExecutedEvent,
  record: any,
  durationSeconds: number,
  roi: number
) {
  return {
    orderId: event.orderId,
    trader: event.trader,
    pairIndex: event.pairIndex,
    pairSymbol: getPairSymbol(event.pairIndex),
    direction: (event.isBuy ? 'LONG' : 'SHORT') as TradeDirection,
    closePrice: event.closePrice || 0,
    pnl: event.pnlUsdc || 0,
    roi,
    durationSeconds,
    txHash: event.executedTxHash,
    blockNumber: event.executedBlockNumber,
  };
}

/**
 * Clear all in-memory caches (for testing)
 * Note: With tradeKey-based correlation, we don't use in-memory caches anymore
 */
export function clearCaches(): void {
  console.log('[Correlator] No caches to clear (using tradeKey-based correlation)');
}
