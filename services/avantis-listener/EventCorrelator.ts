/**
 * Event Correlator - Simplified
 * Stores MarketExecuted AND LimitExecuted events independently (no correlation needed)
 * Both event types contain complete trade data including PnL for CLOSE events
 *
 * IMPORTANT: Uses universal `positions` collection (not platform-specific)
 * - OPEN events → Add to `positions` + `historicaltrades`
 * - CLOSE events → Add to `historicaltrades` + Remove from `positions`
 */

import EventEmitter from 'events';
import TradeEvent from '../../models/TradeEvent';
import Position from '../../models/Position';
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
 * Add position to universal positions collection
 * Uses the same schema as Python service for compatibility
 */
async function addOpenPosition(
  event: ParsedMarketExecutedEvent | ParsedLimitExecutedEvent,
  timestamp: Date
): Promise<void> {
  try {
    const trader = event.trader.toLowerCase();
    const tradeIndex = event.tradeIndex;

    // Check if position already exists (by trader + tradeIndex, not orderId)
    const exists = await Position.findOne({
      walletAddress: trader,
      platform: 'Avantis',
      positionId: tradeIndex,
    });

    if (exists) {
      console.log(
        `[Correlator] Position already exists for trader ${trader}, tradeIndex ${tradeIndex}, skipping...`
      );
      return;
    }

    // Create position using universal schema (matches Python service format)
    const position = new Position({
      walletAddress: trader,
      type: 'PERP',
      platform: 'Avantis',
      positionId: tradeIndex, // KEY: Use tradeIndex as positionId for CLOSE matching
      status: 'active',

      // PERP-specific fields
      pair: getPairSymbol(event.pairIndex),
      direction: event.isBuy ? 'LONG' : 'SHORT',
      leverage: event.leverage,
      positionSize: event.positionSizeUsdc,
      margin: event.collateralUsdc,
      entryPrice: event.openPrice,
      currentPrice: event.openPrice, // Initial current price = entry price
      liquidationPrice: 0, // Calculate if needed, or leave for Python service
      pnl: 0, // Initial PnL is 0
      roi: 0, // Initial ROI is 0

      // Metadata
      createdAt: timestamp,
      updatedAt: timestamp,
      txHash: event.executedTxHash,
    });

    await position.save();
    console.log(
      `[Correlator] ✓ Added to positions - trader: ${trader}, tradeIndex: ${tradeIndex}, pair: ${getPairSymbol(event.pairIndex)}`
    );
  } catch (error) {
    console.error(
      `[Correlator] Error adding position for trader ${event.trader}, tradeIndex ${event.tradeIndex}:`,
      error
    );
  }
}

/**
 * Remove position from universal positions collection
 * Matches by trader + tradeIndex (not orderId, since CLOSE events have different orderIds)
 */
async function removeOpenPosition(trader: string, tradeIndex: number): Promise<void> {
  try {
    const result = await Position.deleteOne({
      walletAddress: trader.toLowerCase(),
      platform: 'Avantis',
      positionId: tradeIndex,
    });

    if (result.deletedCount > 0) {
      console.log(
        `[Correlator] ✓ Removed from positions - trader: ${trader}, tradeIndex: ${tradeIndex}`
      );
    } else {
      console.log(
        `[Correlator] ⚠️  Position not found in positions collection - trader: ${trader}, tradeIndex: ${tradeIndex} (may have been removed by Python service or never added)`
      );
    }
  } catch (error) {
    console.error(
      `[Correlator] Error removing position for trader ${trader}, tradeIndex ${tradeIndex}:`,
      error
    );
  }
}

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

    // Manage universal positions collection
    if (open) {
      // OPEN event - Add to positions
      await addOpenPosition(event, timestamp);
    } else {
      // CLOSE event - Remove from positions (match by trader + tradeIndex)
      await removeOpenPosition(trader, tradeIndex);
    }

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
