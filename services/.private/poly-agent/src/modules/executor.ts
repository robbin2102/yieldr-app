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
  private nonceCounter: number = 0;

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
    // Pre-fetch nonce from CLOB
    this.nonceCounter = await this.clobClient.getNonce();
    console.log(`[Executor] Initialized with nonce: ${this.nonceCounter}`);
  }

  private async handleTrade(trade: DetectedTrade) {
    const startTime = Date.now();
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

      // Build market order
      const order = await this.clobClient.createMarketOrder({
        tokenID: trade.tokenId,
        side: trade.side === 'BUY' ? Side.BUY : Side.SELL,
        amount: trade.side === 'BUY' ? orderCost : copySize,  // BUY = USDC, SELL = shares
        price: bestPrice,
        feeRateBps: 0,  // Polymarket has 0 fees
        nonce: this.nonceCounter++,
      });

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

  private async skipTrade(tradeRecord: any, reason: string) {
    console.log(`[Executor] ⏭️ Skip: ${reason}`);

    tradeRecord.status = 'SKIPPED';
    tradeRecord.skipReason = reason;
    await tradeRecord.save();

    eventBus.emit('trade:skipped', { tradeId: tradeRecord._id, reason });
  }
}
