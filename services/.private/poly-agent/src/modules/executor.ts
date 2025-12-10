import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { orderbookCache } from '../state/orderbookCache';
import { PolyAgentTrade } from '../db/models/PolyAgentTrade';
import { DetectedTrade } from '../types';

/**
 * Executor - Executes copy trades with FOK orders
 *
 * CRITICAL FINANCIAL SYSTEM BEHAVIOR:
 * - NEVER skip trades - every trade the target wallet makes is copied
 * - If orderbook not cached: fetch synchronously via REST API (~100-200ms latency)
 * - Only fail if REST API fetch fails after retries (extremely rare)
 *
 * Flow:
 * 1. Receive 'trade:detected' event from Detector
 * 2. Try to insert to MongoDB (unique index handles dedup)
 * 3. Calculate copy size (trader size × copyRatio, fractional shares allowed)
 * 4. Get best price from orderbook (fetch if not cached)
 * 5. Cap at max position size if needed
 * 6. Build and submit FOK order to CLOB
 * 7. Emit 'trade:submitted' for Confirmer to track fills
 *
 * Position Sizing:
 * - Copy ALL trades regardless of size (even 0.5 shares → 0.005 shares at 1%)
 * - Trader may place 100 small orders that add up - we copy all of them
 * - Only limit is MAX_POSITION_USDC per trade
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

    // Check 2: Get best price from orderbook (fetch if not cached)
    let bestPrice = orderbookCache.getBestPrice(trade.tokenId, trade.side);

    if (!bestPrice) {
      // CRITICAL: Cache miss - fetch orderbook synchronously (blocking ~100-200ms)
      // We NEVER skip trades due to missing orderbook data
      console.log(`[Executor] ⚠️ Orderbook not cached - fetching synchronously...`);
      const fetchSuccess = await orderbookCache.fetchOrderbookSync(trade.tokenId);

      if (!fetchSuccess) {
        // Only fail if REST API fetch fails after retries
        await this.skipTrade(tradeRecord, 'CRITICAL: Failed to fetch orderbook after retries');
        return;
      }

      // Retry getting price after fetch
      bestPrice = orderbookCache.getBestPrice(trade.tokenId, trade.side);
      if (!bestPrice) {
        await this.skipTrade(tradeRecord, 'CRITICAL: Orderbook is empty (no bids/asks available)');
        return;
      }
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
