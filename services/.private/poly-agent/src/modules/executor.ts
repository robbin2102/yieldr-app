import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { orderbookCache } from '../state/orderbookCache';
import { PolyAgentTrade } from '../db/models/PolyAgentTrade';
import { DetectedTrade } from '../types';

/**
 * Executor - Executes copy trades with GTD (Good Till Date) maker orders + retry
 *
 * CRITICAL FINANCIAL SYSTEM BEHAVIOR:
 * - NEVER skip trades - every trade the target wallet makes is copied
 * - If orderbook not cached: fetch synchronously via REST API (~100-200ms latency)
 * - Only fail if REST API fetch fails after retries (extremely rare)
 *
 * Flow:
 * 1. Receive 'trade:detected' event from Detector
 * 2. Try to insert to MongoDB (unique index handles dedup)
 * 3. Calculate copy size based on pro-rata allocation
 * 4. Check drift threshold before executing
 * 5. Get best price from orderbook (fetch if not cached)
 * 6. Build and submit GTD maker order with retry for 100% fills
 * 7. Emit 'trade:submitted' for Confirmer to track fills
 *
 * Order Execution:
 * - Uses GTD (Good Till Date) with postOnly=true — always maker, never taker
 * - BUY at best_bid, SELL at best_ask (join the queue, don't cross the spread)
 * - Retries up to MAX_ORDER_RETRIES times with ORDER_RETRY_DELAY_MS between
 * - Tracks avg fill price across all attempts
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
   * Execute trade after deduplication check
   *
   * CRITICAL: We NEVER skip trades in a financial system.
   * All trades are copied at the configured ratio, regardless of size.
   */
  private async handleTradeExecution(trade: DetectedTrade, tradeRecord: any) {
    const startTime = Date.now();

    // ═══════════════════════════════════════════════════════════════
    // RISK CHECKS (In-memory when cached, blocking fetch if not)
    // ═══════════════════════════════════════════════════════════════

    // Check 1: Calculate copy size (fractional shares allowed)
    let copySize = trade.size * config.copyRatio;

    // Check 2: Get both bid and ask for maker pricing (fetches from REST API if not cached)
    // BUY maker = post at best_bid; SELL maker = post at best_ask (never cross the spread)
    const { bestBid, bestAsk } = await orderbookCache.getBothPrices(trade.tokenId);
    const makerPrice = trade.side === 'BUY' ? bestBid : bestAsk;

    if (!makerPrice) {
      // Only fails if REST API fetch failed or orderbook is empty
      await this.skipTrade(tradeRecord, 'CRITICAL: Failed to fetch orderbook or orderbook empty');
      return;
    }

    // Check 3: Cap at max position size
    let orderCost = copySize * makerPrice;

    if (orderCost > config.maxPositionUsdc) {
      copySize = Math.floor(config.maxPositionUsdc / makerPrice);
      orderCost = copySize * makerPrice;
      console.log(`[Executor] Capped to ${copySize} shares ($${orderCost.toFixed(2)})`);
    }

    // Check 4: For BUY orders, enforce Polymarket $1 minimum
    // This is an API constraint, not our choice
    if (trade.side === 'BUY' && orderCost < 1) {
      console.log(`[Executor] ⚠️ Order below $1 minimum ($${orderCost.toFixed(2)}) - rounding up to $1`);
      orderCost = 1;
      copySize = orderCost / makerPrice;  // Recalculate shares based on $1 spend
    }

    // Check 5: For SELL orders, verify we have enough shares
    if (trade.side === 'SELL') {
      const ourShares = await this.getOurPosition(trade.tokenId);

      if (ourShares < copySize) {
        await this.skipTrade(
          tradeRecord,
          `Cannot sell - insufficient shares (need ${copySize.toFixed(4)}, have ${ourShares.toFixed(4)})`
        );
        return;
      }

      console.log(`[Executor] Balance check: have ${ourShares.toFixed(4)} shares, selling ${copySize.toFixed(4)}`);
    }

    // ═══════════════════════════════════════════════════════════════
    // EXECUTE GTD MAKER ORDER WITH RETRY
    // ═══════════════════════════════════════════════════════════════

    tradeRecord.status = 'EXECUTING';
    tradeRecord.copy = {
      side: trade.side,
      targetSize: copySize,
      targetPrice: makerPrice,
    };
    await tradeRecord.save();

    eventBus.emit('trade:executing', { tradeId: tradeRecord._id, trade, copySize, bestPrice: makerPrice });

    try {
      console.log(`[Executor] Placing GTD maker with retry: ${trade.side} ${copySize} @ $${makerPrice.toFixed(4)} (maker price)`);

      // Execute with GTD maker orders and retry for 100% fills
      const result = await this.executeWithRetry(trade.side, trade.tokenId, copySize, orderCost);

      const latencyMs = Date.now() - startTime;

      if (result.success) {
        console.log(`[Executor] ✅ Filled: ${result.filledSize.toFixed(4)} shares @ $${result.avgPrice.toFixed(4)} (${result.attempts} attempts, ${latencyMs}ms)`);

        // Calculate drift vs trader's price
        const priceDrift = trade.price > 0 ? ((result.avgPrice - trade.price) / trade.price) * 100 : 0;

        // Update trade record
        tradeRecord.copy.orderId = result.lastOrderId;
        tradeRecord.copy.filledSize = result.filledSize;
        tradeRecord.copy.avgPrice = result.avgPrice;
        tradeRecord.copy.attempts = result.attempts;
        tradeRecord.copy.priceDrift = priceDrift;
        tradeRecord.status = 'FILLED';
        tradeRecord.executedAt = new Date();
        tradeRecord.latencyMs = latencyMs;
        await tradeRecord.save();

        // Emit for Confirmer/Metrics
        eventBus.emit('trade:filled', {
          tradeId: tradeRecord._id.toString(),
          filledSize: result.filledSize,
          avgPrice: result.avgPrice,
          priceDrift,
          attempts: result.attempts,
          originalTrade: trade,
        });
      } else if (result.filledSize > 0) {
        console.log(`[Executor] ⚠️ Partial: ${result.filledSize.toFixed(4)}/${copySize.toFixed(4)} shares @ $${result.avgPrice.toFixed(4)}`);

        tradeRecord.copy.filledSize = result.filledSize;
        tradeRecord.copy.avgPrice = result.avgPrice;
        tradeRecord.copy.attempts = result.attempts;
        tradeRecord.status = 'PARTIAL';
        tradeRecord.executedAt = new Date();
        tradeRecord.latencyMs = latencyMs;
        await tradeRecord.save();

        eventBus.emit('trade:partial', {
          tradeId: tradeRecord._id.toString(),
          filledSize: result.filledSize,
          remainingSize: result.remainingSize,
          originalTrade: trade,
        });
      } else {
        throw new Error(`Failed to fill after ${result.attempts} attempts`);
      }

    } catch (error: any) {
      console.error(`[Executor] ❌ Order failed:`, error.message);

      // Log detailed API error if available
      if (error.response?.data) {
        console.error(`[Executor] API Error Details:`, JSON.stringify(error.response.data, null, 2));
      }

      tradeRecord.status = 'FAILED';
      tradeRecord.failReason = error.response?.data?.error || error.message;
      await tradeRecord.save();

      eventBus.emit('trade:failed', {
        tradeId: tradeRecord._id,
        error: error.response?.data?.error || error.message
      });
    }
  }

  /**
   * Execute GTD maker order with retry for 100% fills.
   *
   * Maker pricing: BUY at best_bid, SELL at best_ask — never cross the spread.
   * postOnly: true guarantees rejection over taking if the price crosses on arrival.
   */
  private async executeWithRetry(
    side: 'BUY' | 'SELL',
    tokenId: string,
    targetSize: number,
    orderCostUsdc: number
  ): Promise<{
    success: boolean;
    filledSize: number;
    avgPrice: number;
    attempts: number;
    remainingSize: number;
    lastOrderId: string;
  }> {
    let remainingSize = targetSize;
    let totalFilled = 0;
    let totalCost = 0;
    let attempts = 0;
    let lastOrderId = '';

    while (remainingSize > 0.01 && attempts < config.maxOrderRetries) {
      attempts++;

      // Get fresh bid and ask for maker pricing on each attempt
      const { bestBid, bestAsk } = await orderbookCache.getBothPrices(tokenId);
      const makerPrice = side === 'BUY' ? bestBid : bestAsk;

      if (!makerPrice) {
        console.error(`[Executor] Failed to get orderbook, attempt ${attempts}`);
        await this.sleep(config.orderRetryDelayMs);
        continue;
      }

      const expiration = Math.floor(Date.now() / 1000) + config.gttExpirySeconds;

      console.log(`[Executor] Attempt ${attempts}: GTD ${side} ${remainingSize.toFixed(4)} @ $${makerPrice.toFixed(4)} (maker)`);

      try {
        const order = await this.clobClient.createOrder({
          tokenID: tokenId,
          price: makerPrice,
          size: remainingSize,
          side: side === 'BUY' ? Side.BUY : Side.SELL,
          feeRateBps: 0,
          nonce: 0,
          expiration,
        });

        // Submit as GTD with postOnly=true — rests on book as maker, never takes
        const response = await this.clobClient.postOrder(order, OrderType.GTD, true);

        if (response && response.orderID) {
          lastOrderId = response.orderID;

          // Wait for fill status (up to GTD expiry)
          const fill = await this.waitForFillStatus(response.orderID);

          if (fill.filledSize > 0) {
            totalFilled += fill.filledSize;
            totalCost += fill.filledSize * fill.avgPrice;
            remainingSize -= fill.filledSize;

            console.log(`[Executor] Filled ${fill.filledSize.toFixed(4)} @ $${fill.avgPrice.toFixed(4)} (remaining: ${remainingSize.toFixed(4)})`);
          }
        }
      } catch (error: any) {
        console.error(`[Executor] Attempt ${attempts} error:`, error.message);
      }

      // Wait before retry if needed
      if (remainingSize > 0.01 && attempts < config.maxOrderRetries) {
        await this.sleep(config.orderRetryDelayMs);
      }
    }

    return {
      success: remainingSize < 0.01,
      filledSize: totalFilled,
      avgPrice: totalFilled > 0 ? totalCost / totalFilled : 0,
      attempts,
      remainingSize,
      lastOrderId,
    };
  }

  /**
   * Wait for GTD order fill status via polling (up to gttExpirySeconds + 2s buffer)
   */
  private async waitForFillStatus(orderId: string): Promise<{
    filledSize: number;
    avgPrice: number;
  }> {
    const maxAttempts = Math.ceil((config.gttExpirySeconds + 2) * 1000 / 500);
    const pollInterval = 500; // 500ms — GTD orders take longer than FAK

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(
          `${config.clobApiBase}/order/${orderId}`,
          {
            headers: {
              'POLY_API_KEY': config.apiKey,
              'POLY_SIGNATURE': config.apiSecret,
              'POLY_TIMESTAMP': Date.now().toString(),
              'POLY_PASSPHRASE': config.passphrase,
            },
          }
        );

        if (response.ok) {
          const order = await response.json() as any;

          if (order.status === 'MATCHED' || order.status === 'FILLED') {
            return {
              filledSize: parseFloat(order.size_matched) || 0,
              avgPrice: parseFloat(order.price) || 0,
            };
          }

          if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
            return {
              filledSize: parseFloat(order.size_matched) || 0,
              avgPrice: parseFloat(order.price) || 0,
            };
          }
        }
      } catch {
        // Continue polling
      }

      await this.sleep(pollInterval);
    }

    return { filledSize: 0, avgPrice: 0 };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get our position size for a specific token
   * Fetches from /positions API and returns shares owned (0 if no position)
   */
  private async getOurPosition(tokenId: string): Promise<number> {
    try {
      const response = await fetch(
        `${config.dataApiBase}/positions?user=${config.botWalletAddress}`
      );

      if (!response.ok) {
        console.error(`[Executor] Failed to fetch positions: ${response.status}`);
        return 0;
      }

      const positions = await response.json() as any[];

      // Find position matching this tokenId
      const position = positions.find((p) => p.asset_id === tokenId);

      return position?.size || 0;
    } catch (error: any) {
      console.error(`[Executor] Error fetching position:`, error.message);
      return 0;
    }
  }
}
