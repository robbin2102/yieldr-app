/**
 * Event Correlator
 * Matches MarketOrderInitiated with MarketExecuted events by orderId
 * Saves to MongoDB and emits application events
 */

import EventEmitter from 'events';
import TradeEvent from '../../models/TradeEvent';
import { TradeStatus } from './config/constants';
import { APP_EVENTS, FEATURES } from './config';
import { getPairSymbol } from './config/pairs';
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
 * In-memory storage for pending initiated events
 * Used to correlate with executed events
 */
const pendingInitiatedEvents = new Map<string, ParsedMarketOrderInitiatedEvent>();

/**
 * Queue for executed events that arrived before initiated
 * Will retry correlation after a delay
 */
const orphanedExecutedEvents = new Map<string, ParsedMarketExecutedEvent>();

/**
 * Process MarketOrderInitiated event
 * Stores in memory and checks if executed event is waiting
 */
export async function processMarketOrderInitiated(
  event: ParsedMarketOrderInitiatedEvent
): Promise<void> {
  try {
    const { orderId, trader } = event;

    console.log(
      `[Correlator] Processing MarketOrderInitiated - orderId: ${orderId}, trader: ${trader}`
    );

    // Check if this order already exists in DB
    const existing = await TradeEvent.findOne({ orderId });

    if (existing) {
      console.log(`[Correlator] Order ${orderId} already exists in DB, skipping`);
      return;
    }

    // Store in memory for correlation
    pendingInitiatedEvents.set(orderId, event);

    // Create PENDING record in DB
    const tradeEvent = new TradeEvent({
      orderId: event.orderId,
      status: TradeStatus.PENDING,
      trader: event.trader,
      pairIndex: event.pairIndex,
      pairSymbol: getPairSymbol(event.pairIndex),
      isBuy: event.isBuy,
      initiatedAt: event.initiatedAt,
      initiatedTxHash: event.initiatedTxHash,
      initiatedBlockNumber: event.initiatedBlockNumber,
    });

    await tradeEvent.save();

    console.log(`[Correlator] ✓ Saved PENDING order ${orderId}`);

    // Check if executed event is waiting (orphaned)
    const orphaned = orphanedExecutedEvents.get(orderId);
    if (orphaned) {
      console.log(`[Correlator] Found orphaned executed event for ${orderId}, correlating...`);
      orphanedExecutedEvents.delete(orderId);
      await processMarketExecuted(orphaned);
    }
  } catch (error) {
    console.error('[Correlator] Error processing MarketOrderInitiated:', error);
  }
}

/**
 * Process MarketExecuted event
 * Finds matching initiated event and updates DB
 */
export async function processMarketExecuted(
  event: ParsedMarketExecutedEvent
): Promise<void> {
  try {
    const { orderId, trader, open } = event;

    console.log(
      `[Correlator] Processing MarketExecuted - orderId: ${orderId}, trader: ${trader}, open: ${open}`
    );

    // Find initiated event in memory or DB
    let initiated = pendingInitiatedEvents.get(orderId);
    let existingRecord = await TradeEvent.findOne({ orderId });

    // If no initiated event found, this is orphaned
    if (!initiated && !existingRecord) {
      console.warn(
        `[Correlator] No initiated event found for orderId ${orderId}, queuing as orphaned`
      );
      orphanedExecutedEvents.set(orderId, event);

      // Retry after 5 seconds
      setTimeout(async () => {
        if (orphanedExecutedEvents.has(orderId)) {
          console.log(`[Correlator] Retrying orphaned event ${orderId}...`);
          orphanedExecutedEvents.delete(orderId);
          await processMarketExecuted(event);
        }
      }, 5000);

      return;
    }

    // Remove from pending memory
    if (initiated) {
      pendingInitiatedEvents.delete(orderId);
    }

    // Determine if this is an open or close
    if (open) {
      // Position OPENED
      await handlePositionOpened(event, existingRecord);
    } else {
      // Position CLOSED
      await handlePositionClosed(event, existingRecord);
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
  existingRecord: any
): Promise<void> {
  const { orderId } = event;

  // Update DB with execution data
  const updateData = {
    status: TradeStatus.EXECUTED,
    pairSymbol: getPairSymbol(event.pairIndex),
    tradeIndex: event.tradeIndex,
    collateralUsdc: event.collateralUsdc,
    positionSizeUsdc: event.positionSizeUsdc,
    leverage: event.leverage,
    openPrice: event.openPrice,
    executionPrice: event.executionPrice,
    tp: event.tp,
    sl: event.sl,
    executedAt: event.executedAt,
    executedTxHash: event.executedTxHash,
    executedBlockNumber: event.executedBlockNumber,
  };

  if (existingRecord) {
    // Update existing PENDING record
    Object.assign(existingRecord, updateData);
    await existingRecord.save();
  } else {
    // Create new record (in case initiated was missed)
    const newRecord = new TradeEvent({
      orderId: event.orderId,
      trader: event.trader,
      pairIndex: event.pairIndex,
      isBuy: event.isBuy,
      initiatedAt: event.executedAt, // Use executed time as fallback
      initiatedTxHash: event.executedTxHash,
      initiatedBlockNumber: event.executedBlockNumber,
      ...updateData,
    });
    await newRecord.save();
  }

  console.log(`[Correlator] ✓ Position OPENED - orderId: ${orderId}`);

  // Emit trade:opened event
  if (FEATURES.ENABLE_EVENT_EMISSION) {
    const tradeData = buildTradeOpenedEvent(event);
    eventEmitter.emit(APP_EVENTS.TRADE_OPENED, tradeData);
    console.log(`[Correlator] ✓ Emitted trade:opened event for ${orderId}`);
  }
}

/**
 * Handle position closed (open=false)
 */
async function handlePositionClosed(
  event: ParsedMarketExecutedEvent,
  existingRecord: any
): Promise<void> {
  const { orderId } = event;

  if (!existingRecord) {
    console.warn(`[Correlator] No existing record found for close of orderId ${orderId}`);
    return;
  }

  // Calculate duration
  const openedAt = existingRecord.executedAt || existingRecord.initiatedAt;
  const durationSeconds = Math.floor(
    (event.executedAt.getTime() - openedAt.getTime()) / 1000
  );

  // ROI comes from contract's percentProfit field
  const roi = event.profitPercent || 0;

  // Update DB with close data
  existingRecord.status = TradeStatus.CLOSED;
  existingRecord.closePrice = event.closePrice;
  existingRecord.pnlUsdc = event.pnlUsdc;
  existingRecord.roi = roi;
  existingRecord.closedAt = event.executedAt;
  existingRecord.closedTxHash = event.executedTxHash;
  existingRecord.durationSeconds = durationSeconds;

  await existingRecord.save();

  console.log(
    `[Correlator] ✓ Position CLOSED - orderId: ${orderId}, PnL: ${event.pnlUsdc?.toFixed(2)} USDC, ROI: ${roi.toFixed(2)}%`
  );

  // Emit trade:closed event
  if (FEATURES.ENABLE_EVENT_EMISSION) {
    const tradeData = buildTradeClosedEvent(event, existingRecord, durationSeconds, roi);
    eventEmitter.emit(APP_EVENTS.TRADE_CLOSED, tradeData);
    console.log(`[Correlator] ✓ Emitted trade:closed event for ${orderId}`);
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
    executionPrice: event.executionPrice || 0,
    tp: event.tp || 0,
    sl: event.sl || 0,
    executedAt: event.executedAt,
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
    closedAt: event.executedAt,
    txHash: event.executedTxHash,
    blockNumber: event.executedBlockNumber,
  };
}

/**
 * Get pending events count (for monitoring)
 */
export function getPendingEventsCount(): number {
  return pendingInitiatedEvents.size;
}

/**
 * Get orphaned events count (for monitoring)
 */
export function getOrphanedEventsCount(): number {
  return orphanedExecutedEvents.size;
}

/**
 * Clear all in-memory caches (for testing)
 */
export function clearCaches(): void {
  pendingInitiatedEvents.clear();
  orphanedExecutedEvents.clear();
  console.log('[Correlator] Caches cleared');
}
