import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { orderbookCache } from '../state/orderbookCache';
import { PolyAgentTrade } from '../db/models/PolyAgentTrade';
import { DetectedTrade } from '../types';

/**
 * Executor - Executes copy trades with FOK orders
 *
 * Flow:
 * 1. Receive 'trade:detected' event from Detector
 * 2. Try to insert to MongoDB (unique index handles dedup)
 * 3. Run in-memory risk checks (<5ms)
 * 4. Build and submit FOK order to CLOB
 * 5. Emit 'trade:submitted' for Confirmer to track
 *
 * Risk checks (all in-memory, no blocking):
 * - Calculate copy size (trader size × copyRatio)
 * - Check minimum size threshold
 * - Get best price from orderbook cache
 * - Cap at max position size
 */
export class Executor {
  private clobClient: ClobClient;

  constructor(clobClient: ClobClient) {
    this.clobClient = clobClient;

    // Listen for detected trades
    eventBus.on('trade:detected', (trade: DetectedTrade) => {
      this.handleTrade(trade).catch((error) => {
        console.error('[Executor] Unhandled error:', error);
      });
    });

    // Listen for orderbook ready events to retry skipped trades
    eventBus.on('orderbook:ready', ({ tokenId }: { tokenId: string }) => {
      this.retrySkippedTrades(tokenId).catch((error) => {
        console.error('[Executor] Error retrying skipped trades:', error);
      });
    });
  }

  async initialize() {
    // Executor ready - nonce is managed internally by ClobClient
    console.log('[Executor] Initialized');
  }

  private async handleTrade(trade: DetectedTrade) {
    console.log(`\n[Executor] Processing ${trade.txHash.slice(0, 10)}...`);

    // ═══════════════════════════════════════════════════════════════
    // DEDUPLICATION - MongoDB unique index on txHash
    // ═══════════════════════════════════════════════════════════════
    let tradeRecord;
    try {
      tradeRecord = await PolyAgentTrade.create({
        originalTxHash: trade.txHash,
        original: {
          walletAddress: config.targetWallet,
          conditionId: trade.conditionId,
          tokenId: trade.tokenId,
          txHash: trade.txHash,
          side: trade.side,
          size: trade.size,
          price: trade.price,
          usdcSize: trade.usdcSize,
          timestamp: new Date(trade.timestamp * 1000),
          title: trade.title,
          outcome: trade.outcome,
        },
        status: 'DETECTED',
        detectedAt: new Date(trade.detectedAt),
      });
    } catch (error: any) {
      if (error.code === 11000) {
        // Duplicate key error - already processed
        console.log(`[Executor] ⏭️ Skip: Already processed`);
        return;
      }
      throw error;
    }

    // Execute the trade (risk checks + order submission)
    await this.handleTradeExecution(trade, tradeRecord);
  }

  private async skipTrade(tradeRecord: any, reason: string) {
    console.log(`[Executor] ⏭️ Skip: ${reason}`);

    tradeRecord.status = 'SKIPPED';
    tradeRecord.skipReason = reason;
    await tradeRecord.save();

    eventBus.emit('trade:skipped', { tradeId: tradeRecord._id, reason });
  }

  /**
   * Retry SKIPPED trades when orderbook data becomes available
   */
  private async retrySkippedTrades(tokenId: string) {
    // Find recent SKIPPED trades for this token that failed due to "No orderbook data"
    const skippedTrades = await PolyAgentTrade.find({
      'original.tokenId': tokenId,
      status: 'SKIPPED',
      skipReason: 'No orderbook data - subscribed for future',
      detectedAt: { $gt: new Date(Date.now() - 300000) }, // Last 5 minutes only
    }).limit(10); // Limit to prevent spam

    if (skippedTrades.length === 0) return;

    console.log(`[Executor] 🔄 Retrying ${skippedTrades.length} skipped trade(s) for token ${tokenId.slice(0, 8)}...`);

    for (const tradeRecord of skippedTrades) {
      // Extract original trade data with null safety
      const original = tradeRecord.original as any;

      // Validate that we have all required data (should always exist, but TypeScript safety)
      if (!original ||
          !original.txHash ||
          !original.conditionId ||
          !original.tokenId ||
          !original.side ||
          original.size == null ||
          original.price == null ||
          original.usdcSize == null ||
          !original.timestamp ||
          !original.title ||
          !original.outcome ||
          !tradeRecord.detectedAt) {
        console.error(`[Executor] ⚠️ Skip retry: Missing data in record ${tradeRecord._id}`);
        continue;
      }

      // Reconstruct DetectedTrade from validated database record
      const trade: DetectedTrade = {
        txHash: original.txHash as string,
        conditionId: original.conditionId as string,
        tokenId: original.tokenId as string,
        side: original.side as 'BUY' | 'SELL',
        size: original.size as number,
        price: original.price as number,
        usdcSize: original.usdcSize as number,
        timestamp: Math.floor(new Date(original.timestamp).getTime() / 1000),
        title: original.title as string,
        outcome: original.outcome as string,
        detectedAt: new Date(tradeRecord.detectedAt).getTime(),
      };

      // Reset status to DETECTED for retry
      tradeRecord.status = 'DETECTED';
      tradeRecord.skipReason = undefined;
      await tradeRecord.save();

      console.log(`[Executor] 🔄 Retry: ${trade.side} ${trade.size} ${trade.outcome}`);

      // Re-process the trade (will go through all risk checks again)
      await this.handleTradeExecution(trade, tradeRecord);
    }
  }

  /**
   * Execute trade after deduplication check
   * Separated from handleTrade so it can be called for retries
   */
  private async handleTradeExecution(trade: DetectedTrade, tradeRecord: any) {
    const startTime = Date.now();

    // ═══════════════════════════════════════════════════════════════
    // RISK CHECKS (In-memory, <5ms total)
    // ═══════════════════════════════════════════════════════════════

    // Check 1: Calculate copy size
    let copySize = Math.floor(trade.size * config.copyRatio);

    if (copySize < config.minTradeSize) {
      await this.skipTrade(tradeRecord, `Size ${copySize} < min ${config.minTradeSize}`);
      return;
    }

    // Check 2: Get best price from orderbook cache (0ms lookup)
    const bestPrice = orderbookCache.getBestPrice(trade.tokenId, trade.side);

    if (!bestPrice) {
      // No orderbook data yet - subscribe for next time
      orderbookCache.subscribe(trade.tokenId);
      await this.skipTrade(tradeRecord, 'No orderbook data - subscribed for future');
      return;
    }

    // Check 3: Cap at max position size
    let orderCost = copySize * bestPrice;

    if (orderCost > config.maxPositionUsdc) {
      copySize = Math.floor(config.maxPositionUsdc / bestPrice);
      orderCost = copySize * bestPrice;
      console.log(`[Executor] Capped to ${copySize} shares ($${orderCost.toFixed(2)})`);
    }

    // Check 4: Final size check after capping
    if (copySize < config.minTradeSize) {
      await this.skipTrade(tradeRecord, `Capped size ${copySize} < min ${config.minTradeSize}`);
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // EXECUTE FOK ORDER
    // ═══════════════════════════════════════════════════════════════

    tradeRecord.status = 'EXECUTING';
    tradeRecord.copy = {
      side: trade.side,
      targetSize: copySize,
      targetPrice: bestPrice,
    };
    await tradeRecord.save();

    eventBus.emit('trade:executing', { tradeId: tradeRecord._id, trade, copySize, bestPrice });

    try {
      console.log(`[Executor] Placing FOK: ${trade.side} ${copySize} @ $${bestPrice.toFixed(4)}`);

      // Build order based on side (v3.0.0 API has different methods for BUY vs SELL)
      let order;

      if (trade.side === 'BUY') {
        // BUY orders: use createMarketBuyOrder (amount in USDC)
        order = await this.clobClient.createMarketBuyOrder(
          {
            tokenID: trade.tokenId,
            amount: orderCost,  // Amount in USDC
            feeRateBps: 0,  // Polymarket has 0 fees
          },
          '0.01'  // tickSize for price precision
        );
      } else {
        // SELL orders: use createOrder (size in shares, requires explicit price)
        order = await this.clobClient.createOrder(
          {
            tokenID: trade.tokenId,
            price: bestPrice,
            size: copySize,  // Size in shares
            side: Side.SELL,
            feeRateBps: 0,  // Polymarket has 0 fees
          },
          '0.01'  // tickSize for price precision
        );
      }

      // Submit as Fill-Or-Kill (immediate full fill or cancel)
      const response = await this.clobClient.postOrder(order, OrderType.FOK);

      const latencyMs = Date.now() - startTime;
      console.log(`[Executor] ✅ Submitted: ${response.orderID} (${latencyMs}ms)`);

      // Update trade record
      tradeRecord.copy.orderId = response.orderID;
      tradeRecord.executedAt = new Date();
      tradeRecord.latencyMs = latencyMs;
      await tradeRecord.save();

      // Emit for Confirmer to track fill
      eventBus.emit('trade:submitted', {
        tradeId: tradeRecord._id.toString(),
        orderId: response.orderID,
        expectedSize: copySize,
        expectedPrice: bestPrice,
        originalTrade: trade,
      });

    } catch (error: any) {
      console.error(`[Executor] ❌ Order failed:`, error.message);

      tradeRecord.status = 'FAILED';
      tradeRecord.failReason = error.message;
      await tradeRecord.save();

      eventBus.emit('trade:failed', { tradeId: tradeRecord._id, error: error.message });
    }
  }
}
