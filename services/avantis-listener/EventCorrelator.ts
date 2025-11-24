/**
 * Event Correlator - Simplified
 * Stores MarketExecuted AND LimitExecuted events independently (no correlation needed)
 * Both event types contain complete trade data including PnL for CLOSE events
 *
 * IMPORTANT ARCHITECTURE DECISION:
 * - This service ONLY logs events to `historicaltrades` collection
 * - Python service manages `positions` collection (source of truth)
 * - Avoids tradeIndex collision issues and sync complexity
 *
 * Flow:
 * - OPEN/CLOSE events → Save to `historicaltrades` only
 * - Python service → Manages `positions` (on page refresh)
 */

import EventEmitter from 'events';
import TradeEvent from '../../models/TradeEvent';
import { APP_EVENTS, FEATURES } from './config';
import { getPairSymbol } from './config/pairs';
import { getBlock } from './core/ViemClient';
import type {
  ParsedMarketOrderInitiatedEvent,
  ParsedMarketExecutedEvent,
  ParsedLimitExecutedEvent,
} from './types/events';
import type { TradeDirection } from './types/trades';

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
 * Note: Position management removed from this service
 * Python service is now the sole manager of the `positions` collection
 * This avoids tradeIndex collision issues and keeps architecture simple
 */

/**
 * Process MarketOrderInitiated event
 * Note: Not needed with simplified approach - we only store MarketExecuted events
 */
export async function processMarketOrderInitiated(
  event: ParsedMarketOrderInitiatedEvent
): Promise<void> {
  // No-op - we don't process these anymore
  console.log(
    `[Correlator] Initiated event (skipped) - orderId: ${event.orderId}, trader: ${event.trader}, open: ${event.open}`
  );
}

/**
 * Process Executed event (Market OR Limit) - Simplified approach
 * Each event is stored independently as OPEN or CLOSE
 * Works for both MarketExecuted and LimitExecuted since they have the same structure
 */
export async function processMarketExecuted(
  event: ParsedMarketExecutedEvent | ParsedLimitExecutedEvent
): Promise<void> {
  try {
    const { orderId, trader, open, pairIndex, tradeIndex } = event;

    console.log(
      `[Correlator] Processing executed event - orderId: ${orderId}, type: ${open ? 'OPEN' : 'CLOSE'}, trader: ${trader}`
    );

    // Check if event already exists
    const exists = await TradeEvent.findOne({ orderId });
    if (exists) {
      console.log(`[Correlator] Event ${orderId} already processed, skipping...`);
      return;
    }

    // Fetch block timestamp
    const timestamp = await getBlockTimestamp(event.executedBlockNumber);

    // Create trade event
    const tradeEvent = new TradeEvent({
      orderId,
      eventType: open ? 'OPEN' : 'CLOSE',
      trader: trader.toLowerCase(),
      platform: 'Avantis',
      pairIndex,
      pairSymbol: getPairSymbol(pairIndex),
      tradeIndex,
      direction: event.isBuy ? 'LONG' : 'SHORT',
      timestamp,
      txHash: event.executedTxHash,
      blockNumber: event.executedBlockNumber,
      collateralUsdc: event.collateralUsdc,
      positionSizeUsdc: event.positionSizeUsdc,
      leverage: event.leverage,
      // OPEN event specific fields
      openPrice: open ? event.openPrice : undefined,
      tp: open ? event.tp : undefined,
      sl: open ? event.sl : undefined,
      // CLOSE event specific fields
      closePrice: !open ? event.closePrice : undefined,
      pnlUsdc: !open ? event.pnlUsdc : undefined,
      roi: !open ? event.profitPercent : undefined,
    });

    await tradeEvent.save();

    console.log(
      `[Correlator] ✓ Event saved - orderId: ${orderId}, type: ${open ? 'OPEN' : 'CLOSE'}${
        !open ? `, PnL: ${event.pnlUsdc?.toFixed(2)} USDC, ROI: ${event.profitPercent?.toFixed(2)}%` : ''
      }`
    );

    // Note: Position management is handled by Python service
    // This service only logs events to historicaltrades

    // Emit application events
    if (FEATURES.ENABLE_EVENT_EMISSION) {
      if (open) {
        const tradeData = buildTradeOpenedEvent(event);
        eventEmitter.emit(APP_EVENTS.TRADE_OPENED, tradeData);
        console.log(`[Correlator] ✓ Emitted trade:opened event for ${orderId}`);
      } else {
        const tradeData = buildTradeClosedEvent(event);
        eventEmitter.emit(APP_EVENTS.TRADE_CLOSED, tradeData);
        console.log(`[Correlator] ✓ Emitted trade:closed event for ${orderId}`);
      }
    }
  } catch (error) {
    console.error('[Correlator] Error processing MarketExecuted:', error);
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
function buildTradeClosedEvent(event: ParsedMarketExecutedEvent) {
  return {
    orderId: event.orderId,
    trader: event.trader,
    pairIndex: event.pairIndex,
    pairSymbol: getPairSymbol(event.pairIndex),
    direction: (event.isBuy ? 'LONG' : 'SHORT') as TradeDirection,
    closePrice: event.closePrice || 0,
    pnl: event.pnlUsdc || 0,
    roi: event.profitPercent || 0,
    txHash: event.executedTxHash,
    blockNumber: event.executedBlockNumber,
  };
}

/**
 * Clear all in-memory caches (for testing)
 * Note: With simplified approach, we don't use caches
 */
export function clearCaches(): void {
  console.log('[Correlator] No caches to clear (simplified event storage)');
}
