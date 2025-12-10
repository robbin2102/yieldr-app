"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Executor = void 0;
const clob_client_1 = require("@polymarket/clob-client");
const config_1 = require("../config");
const eventBus_1 = require("../state/eventBus");
const orderbookCache_1 = require("../state/orderbookCache");
const PolyAgentTrade_1 = require("../db/models/PolyAgentTrade");
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
 *
 * Note: NO RETRY LOGIC in Phase 1 testing
 * - If no orderbook data, trade is skipped permanently
 * - OrderbookCache subscribes for future trades on same token
 * - Retry logic will be added in Phase 2 after testing
 */
class Executor {
    constructor(clobClient) {
        this.clobClient = clobClient;
        // Listen for detected trades
        eventBus_1.eventBus.on('trade:detected', (trade) => {
            this.handleTrade(trade).catch((error) => {
                console.error('[Executor] Unhandled error:', error);
            });
        });
    }
    async initialize() {
        // Executor ready - nonce is managed internally by ClobClient
        console.log('[Executor] Initialized');
    }
    async handleTrade(trade) {
        console.log(`\n[Executor] Processing ${trade.txHash.slice(0, 10)}...`);
        // ═══════════════════════════════════════════════════════════════
        // DEDUPLICATION - MongoDB unique index on txHash
        // ═══════════════════════════════════════════════════════════════
        let tradeRecord;
        try {
            tradeRecord = await PolyAgentTrade_1.PolyAgentTrade.create({
                originalTxHash: trade.txHash,
                original: {
                    walletAddress: config_1.config.targetWallet,
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
        }
        catch (error) {
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
    async skipTrade(tradeRecord, reason) {
        console.log(`[Executor] ⏭️ Skip: ${reason}`);
        tradeRecord.status = 'SKIPPED';
        tradeRecord.skipReason = reason;
        await tradeRecord.save();
        eventBus_1.eventBus.emit('trade:skipped', { tradeId: tradeRecord._id, reason });
    }
    /**
     * Execute trade after deduplication check
     */
    async handleTradeExecution(trade, tradeRecord) {
        const startTime = Date.now();
        // ═══════════════════════════════════════════════════════════════
        // RISK CHECKS (In-memory, <5ms total)
        // ═══════════════════════════════════════════════════════════════
        // Check 1: Calculate copy size
        let copySize = Math.floor(trade.size * config_1.config.copyRatio);
        if (copySize < config_1.config.minTradeSize) {
            await this.skipTrade(tradeRecord, `Size ${copySize} < min ${config_1.config.minTradeSize}`);
            return;
        }
        // Check 2: Get best price from orderbook cache (0ms lookup)
        const bestPrice = orderbookCache_1.orderbookCache.getBestPrice(trade.tokenId, trade.side);
        if (!bestPrice) {
            // No orderbook data yet - subscribe for future trades on this token
            // NOTE: This trade is skipped permanently (Phase 1 - no retries)
            // Future trades on this token will have orderbook data from cache
            orderbookCache_1.orderbookCache.subscribe(trade.tokenId);
            await this.skipTrade(tradeRecord, 'No orderbook data (Phase 1: skipped permanently, subscribed for future trades)');
            return;
        }
        // Check 3: Cap at max position size
        let orderCost = copySize * bestPrice;
        if (orderCost > config_1.config.maxPositionUsdc) {
            copySize = Math.floor(config_1.config.maxPositionUsdc / bestPrice);
            orderCost = copySize * bestPrice;
            console.log(`[Executor] Capped to ${copySize} shares ($${orderCost.toFixed(2)})`);
        }
        // Check 4: Final size check after capping
        if (copySize < config_1.config.minTradeSize) {
            await this.skipTrade(tradeRecord, `Capped size ${copySize} < min ${config_1.config.minTradeSize}`);
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
        eventBus_1.eventBus.emit('trade:executing', { tradeId: tradeRecord._id, trade, copySize, bestPrice });
        try {
            console.log(`[Executor] Placing FOK: ${trade.side} ${copySize} @ $${bestPrice.toFixed(4)}`);
            // Build order based on side (v3.0.0 API has different methods for BUY vs SELL)
            let order;
            if (trade.side === 'BUY') {
                // BUY orders: use createMarketBuyOrder (amount in USDC)
                order = await this.clobClient.createMarketBuyOrder({
                    tokenID: trade.tokenId,
                    amount: orderCost, // Amount in USDC
                    feeRateBps: 0, // Polymarket has 0 fees
                }, '0.01' // tickSize for price precision
                );
            }
            else {
                // SELL orders: use createOrder (size in shares, requires explicit price)
                order = await this.clobClient.createOrder({
                    tokenID: trade.tokenId,
                    price: bestPrice,
                    size: copySize, // Size in shares
                    side: clob_client_1.Side.SELL,
                    feeRateBps: 0, // Polymarket has 0 fees
                }, '0.01' // tickSize for price precision
                );
            }
            // Submit as Fill-Or-Kill (immediate full fill or cancel)
            const response = await this.clobClient.postOrder(order, clob_client_1.OrderType.FOK);
            const latencyMs = Date.now() - startTime;
            console.log(`[Executor] ✅ Submitted: ${response.orderID} (${latencyMs}ms)`);
            // Update trade record
            tradeRecord.copy.orderId = response.orderID;
            tradeRecord.executedAt = new Date();
            tradeRecord.latencyMs = latencyMs;
            await tradeRecord.save();
            // Emit for Confirmer to track fill
            eventBus_1.eventBus.emit('trade:submitted', {
                tradeId: tradeRecord._id.toString(),
                orderId: response.orderID,
                expectedSize: copySize,
                expectedPrice: bestPrice,
                originalTrade: trade,
            });
        }
        catch (error) {
            console.error(`[Executor] ❌ Order failed:`, error.message);
            tradeRecord.status = 'FAILED';
            tradeRecord.failReason = error.message;
            await tradeRecord.save();
            eventBus_1.eventBus.emit('trade:failed', { tradeId: tradeRecord._id, error: error.message });
        }
    }
}
exports.Executor = Executor;
//# sourceMappingURL=executor.js.map