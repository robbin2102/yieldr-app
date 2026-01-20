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
     *
     * CRITICAL: We NEVER skip trades in a financial system.
     * All trades are copied at the configured ratio, regardless of size.
     */
    async handleTradeExecution(trade, tradeRecord) {
        const startTime = Date.now();
        // ═══════════════════════════════════════════════════════════════
        // RISK CHECKS (In-memory when cached, blocking fetch if not)
        // ═══════════════════════════════════════════════════════════════
        // Check 1: Calculate copy size (fractional shares allowed)
        let copySize = trade.size * config_1.config.copyRatio;
        // Check 2: Get best price from orderbook (fetches from REST API if not cached)
        // This automatically handles cache miss and TTL expiration
        const bestPrice = await orderbookCache_1.orderbookCache.getBestPrice(trade.tokenId, trade.side);
        if (!bestPrice) {
            // Only fails if REST API fetch failed or orderbook is empty
            await this.skipTrade(tradeRecord, 'CRITICAL: Failed to fetch orderbook or orderbook empty');
            return;
        }
        // Check 3: Cap at max position size
        let orderCost = copySize * bestPrice;
        if (orderCost > config_1.config.maxPositionUsdc) {
            copySize = Math.floor(config_1.config.maxPositionUsdc / bestPrice);
            orderCost = copySize * bestPrice;
            console.log(`[Executor] Capped to ${copySize} shares ($${orderCost.toFixed(2)})`);
        }
        // Check 4: For BUY orders, enforce Polymarket $1 minimum
        // This is an API constraint, not our choice
        if (trade.side === 'BUY' && orderCost < 1) {
            console.log(`[Executor] ⚠️ Order below $1 minimum ($${orderCost.toFixed(2)}) - rounding up to $1`);
            orderCost = 1;
            copySize = orderCost / bestPrice; // Recalculate shares based on $1 spend
        }
        // Check 5: For SELL orders, verify we have enough shares
        if (trade.side === 'SELL') {
            const ourShares = await this.getOurPosition(trade.tokenId);
            if (ourShares < copySize) {
                await this.skipTrade(tradeRecord, `Cannot sell - insufficient shares (need ${copySize.toFixed(4)}, have ${ourShares.toFixed(4)})`);
                return;
            }
            console.log(`[Executor] Balance check: have ${ourShares.toFixed(4)} shares, selling ${copySize.toFixed(4)}`);
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
            // Create market order based on side
            let order;
            if (trade.side === 'BUY') {
                // BUY: use createMarketBuyOrder with amount in USDC
                order = await this.clobClient.createMarketBuyOrder({
                    tokenID: trade.tokenId,
                    amount: orderCost, // USDC to spend
                    price: bestPrice, // Add price parameter per API requirements
                    feeRateBps: 0,
                    nonce: 0,
                });
            }
            else {
                // SELL: use createOrder with explicit price and size
                order = await this.clobClient.createOrder({
                    tokenID: trade.tokenId,
                    price: bestPrice,
                    size: copySize, // Shares to sell
                    side: clob_client_1.Side.SELL,
                    feeRateBps: 0,
                    nonce: 0,
                });
            }
            console.log(`[Executor] Order created: ${JSON.stringify({
                side: trade.side,
                tokenID: trade.tokenId.slice(0, 16) + '...',
                amount: trade.side === 'BUY' ? orderCost : copySize,
                price: bestPrice,
            })}`);
            // Submit as Fill-Or-Kill (immediate full fill or cancel)
            const response = await this.clobClient.postOrder(order, clob_client_1.OrderType.FOK);
            // Check if response is valid
            if (!response || !response.orderID) {
                throw new Error('No orderID returned from API - order may have been rejected');
            }
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
            // Log detailed API error if available
            if (error.response?.data) {
                console.error(`[Executor] API Error Details:`, JSON.stringify(error.response.data, null, 2));
            }
            tradeRecord.status = 'FAILED';
            tradeRecord.failReason = error.response?.data?.error || error.message;
            await tradeRecord.save();
            eventBus_1.eventBus.emit('trade:failed', {
                tradeId: tradeRecord._id,
                error: error.response?.data?.error || error.message
            });
        }
    }
    /**
     * Get our position size for a specific token
     * Fetches from /positions API and returns shares owned (0 if no position)
     */
    async getOurPosition(tokenId) {
        try {
            const response = await fetch(`${config_1.config.dataApiBase}/positions?user=${config_1.config.botWalletAddress}`);
            if (!response.ok) {
                console.error(`[Executor] Failed to fetch positions: ${response.status}`);
                return 0;
            }
            const positions = await response.json();
            // Find position matching this tokenId
            const position = positions.find((p) => p.asset_id === tokenId);
            return position?.size || 0;
        }
        catch (error) {
            console.error(`[Executor] Error fetching position:`, error.message);
            return 0;
        }
    }
}
exports.Executor = Executor;
//# sourceMappingURL=executor.js.map