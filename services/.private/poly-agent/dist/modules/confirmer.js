"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Confirmer = void 0;
const ws_1 = __importDefault(require("ws"));
const config_1 = require("../config");
const eventBus_1 = require("../state/eventBus");
const CopyTrade_1 = require("../db/models/CopyTrade");
const traderLoader_1 = require("./traderLoader");
/**
 * Confirmer — tracks GTD maker order fills via Polymarket WebSocket User Channel.
 *
 * WHY WEBSOCKET (NOT REST POLLING):
 *   Polymarket's GET /order/{id} returns 404 as soon as an order leaves the
 *   active-orders index (i.e. the moment it fills, cancels, or expires).
 *   There is no way to poll for fill status without hitting 404s on every fill.
 *   The correct approach — used by all Polymarket market-maker bots — is to
 *   subscribe to the User Channel and receive push notifications.
 *
 * Fill detection for GTD MAKER orders:
 *   When our maker order fills, Polymarket pushes a 'trade' event containing:
 *     maker_order_id = our order ID   ← we match on this
 *     taker_order_id = counterparty's order ID
 *   The previous code matched on taker_order_id, which NEVER matched our
 *   maker orders.
 *
 * Retry flow:
 *   When a GTD order expires without filling, Polymarket sends an 'order'
 *   event with type='CANCELLATION'. Confirmer emits 'order:expired' so
 *   GTTExecutor can place a fresh order with an updated price.
 *
 * Reconnect:
 *   Auto-reconnects on disconnect with 5s delay.
 *   No REST polling fallback — REST polling was the source of the 404 problem.
 */
class Confirmer {
    constructor() {
        this.ws = null;
        this.pendingOrders = new Map(); // orderId → PendingOrder
        this.reconnecting = false;
        this.heartbeatInterval = null;
        this.stuckScanInterval = null;
        this.stopped = false;
    }
    async connect() {
        return new Promise((resolve, reject) => {
            console.log('[Confirmer] Connecting to WebSocket User Channel...');
            this.ws = new ws_1.default(config_1.config.wssUser);
            const authTimeout = setTimeout(() => {
                if (!this.stopped) {
                    console.error('[Confirmer] Auth timeout — no response in 10s');
                    this.ws?.close();
                    reject(new Error('Confirmer auth timeout'));
                }
            }, 10000);
            this.ws.on('open', () => {
                this.sendAuth();
                clearTimeout(authTimeout);
                this.reconnecting = false;
                this.startHeartbeat();
                console.log('[Confirmer] ✅ Connected to User Channel — waiting for fill events');
                resolve();
            });
            this.ws.on('message', (data) => {
                const raw = data.toString();
                if (raw === 'PONG')
                    return;
                let msg;
                try {
                    msg = JSON.parse(raw);
                }
                catch {
                    return;
                }
                if (msg.event_type === 'trade') {
                    this.handleTradeFill(msg).catch(err => console.error('[Confirmer] Fill handler error:', err.message));
                }
                else if (msg.event_type === 'order') {
                    this.handleOrderUpdate(msg).catch(err => console.error('[Confirmer] Order update error:', err.message));
                }
            });
            this.ws.on('close', (code) => {
                clearTimeout(authTimeout);
                this.stopHeartbeat();
                console.log(`[Confirmer] Disconnected (code: ${code})`);
                if (!this.stopped)
                    this.scheduleReconnect();
            });
            this.ws.on('error', (err) => {
                clearTimeout(authTimeout);
                console.error('[Confirmer] WebSocket error:', err.message);
            });
            // Track pending orders emitted by GTTExecutor
            eventBus_1.eventBus.on('trade:submitted', (pending) => {
                this.pendingOrders.set(pending.orderId, pending);
                console.log(`[Confirmer] Tracking order ${pending.orderId.slice(0, 12)}... (attempt ${pending.attempt}, doc ${pending.tradeDocId})`);
            });
        });
    }
    disconnect() {
        this.stopped = true;
        this.stopHeartbeat();
        if (this.stuckScanInterval) {
            clearInterval(this.stuckScanInterval);
            this.stuckScanInterval = null;
        }
        this.ws?.close();
        this.ws = null;
    }
    /**
     * Periodically scan for EXECUTING docs that have been stuck longer than
     * gttExpirySeconds + 60s. Emits 'order:expired' so GTTExecutor retries them.
     * Catches fills missed by WebSocket during running sessions (not just restarts).
     */
    startStuckOrderScan() {
        const scanIntervalMs = 60000; // scan every 60s
        this.stuckScanInterval = setInterval(async () => {
            if (this.stopped)
                return;
            const staleMs = (config_1.config.gttExpirySeconds + 60) * 1000;
            const cutoff = Date.now() - staleMs;
            const { CopyTrade } = await Promise.resolve().then(() => __importStar(require('../db/models/CopyTrade')));
            const stale = await CopyTrade.find({ status: 'EXECUTING', submittedAt: { $lt: cutoff } });
            if (stale.length === 0)
                return;
            const ts = new Date().toISOString().slice(11, 19);
            console.warn(`[${ts}] [Confirmer] ⚠️  ${stale.length} stuck EXECUTING doc(s) found — triggering retry`);
            for (const doc of stale) {
                // Build a minimal PendingOrder from the doc so GTTExecutor can retry
                const pending = {
                    tradeDocId: doc._id.toString(),
                    traderWallet: doc.sourceWallet,
                    side: doc.side,
                    tokenId: doc.tokenId,
                    conditionId: doc.conditionId,
                    targetUsdc: doc.copyBetUsdc,
                    targetShares: doc.side === 'SELL' ? doc.targetShares : undefined,
                    filledSize: 0,
                    filledCost: 0,
                    attempt: (doc.attempts ?? 1),
                    traderPrice: doc.traderPrice,
                    traderTs: doc.traderTs,
                    detectedAt: doc.detectedAt,
                    orderId: doc.orderId ?? '',
                    limitPrice: 0,
                    submittedAt: doc.submittedAt ?? Date.now(),
                };
                eventBus_1.eventBus.emit('order:expired', pending);
            }
        }, scanIntervalMs);
    }
    sendAuth() {
        this.ws?.send(JSON.stringify({
            type: 'user',
            markets: [],
            auth: {
                apiKey: config_1.config.apiKey,
                secret: config_1.config.apiSecret,
                passphrase: config_1.config.passphrase,
            },
        }));
    }
    /**
     * Handle 'trade' event from User Channel.
     *
     * For GTD maker orders our orderId is in maker_order_id.
     * We also check taker_order_id for completeness (handles any FAK/taker orders).
     *
     * Partial fills accumulate: multiple trade events may arrive for one order.
     * We keep the pending entry until the total filled cost covers 90%+ of target.
     */
    async handleTradeFill(msg) {
        // Match on maker_order_id first (GTD maker), fallback to taker_order_id
        const matchId = this.pendingOrders.has(msg.maker_order_id)
            ? msg.maker_order_id
            : msg.taker_order_id;
        const pending = this.pendingOrders.get(matchId);
        if (!pending) {
            // Log unmatched fills so we can diagnose orderId format mismatches
            if (this.pendingOrders.size > 0) {
                const knownIds = [...this.pendingOrders.keys()].map(k => k.slice(0, 12)).join(', ');
                const ts = new Date().toISOString().slice(11, 19);
                console.warn(`[${ts}] [Confirmer] ⚠️  Fill event — unmatched order maker=${(msg.maker_order_id ?? '').slice(0, 12)} taker=${(msg.taker_order_id ?? '').slice(0, 12)} | tracking: [${knownIds}]`);
            }
            return; // Not our order
        }
        const fillSize = parseFloat(msg.size ?? '0');
        const fillPrice = parseFloat(msg.price ?? '0');
        if (fillSize <= 0)
            return;
        // Accumulate partial fills
        pending.filledSize += fillSize;
        pending.filledCost += fillSize * fillPrice;
        const avgFillPrice = pending.filledCost / pending.filledSize;
        const filledUsdc = pending.filledCost;
        const priceDrift = pending.traderPrice > 0
            ? ((avgFillPrice - pending.traderPrice) / pending.traderPrice) * 100
            : 0;
        const filledAt = Date.now();
        const fillLatencyMs = filledAt - pending.submittedAt;
        const totalLatencyMs = filledAt - pending.traderTs;
        // Determine if fully filled (>= 90% of target).
        // SELL orders use targetShares (shares-based); BUY orders use targetUsdc.
        const fullyFilled = pending.targetShares !== undefined
            ? pending.filledSize >= pending.targetShares * 0.9
            : filledUsdc >= pending.targetUsdc * 0.9;
        const status = fullyFilled ? 'FILLED' : 'PARTIAL';
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`[${ts}] [Confirmer] ✅ ${status} via WebSocket | doc=${pending.tradeDocId}\n` +
            `          ${pending.filledSize.toFixed(2)} shares @ $${avgFillPrice.toFixed(4)}` +
            ` | drift ${priceDrift >= 0 ? '+' : ''}${priceDrift.toFixed(2)}%` +
            ` | latency ${totalLatencyMs}ms | attempt ${pending.attempt}`);
        // Update CopyTrade document
        await CopyTrade_1.CopyTrade.findByIdAndUpdate(pending.tradeDocId, {
            status,
            filledAt,
            fillLatencyMs,
            totalLatencyMs,
            filledSize: pending.filledSize,
            avgFillPrice,
            filledUsdc,
            priceDrift,
            attempts: pending.attempt,
        });
        // BUY fills consume allocation; SELL fills recycle proceeds back into the pool.
        if (pending.side === 'BUY') {
            await traderLoader_1.TraderLoader.recordFill(pending.traderWallet, filledUsdc);
        }
        else {
            await traderLoader_1.TraderLoader.recordSellFill(pending.traderWallet, filledUsdc);
        }
        eventBus_1.eventBus.emit('trade:filled', {
            tradeDocId: pending.tradeDocId,
            traderWallet: pending.traderWallet,
            filledSize: pending.filledSize,
            avgFillPrice,
            priceDrift,
            totalLatencyMs,
            attempts: pending.attempt,
        });
        if (fullyFilled) {
            this.pendingOrders.delete(matchId);
        }
        // If partial: keep tracking — more fill events may arrive for same order
    }
    /**
     * Handle 'order' event from User Channel.
     *
     * CANCELLATION = order left the book without filling (expired GTD or manual cancel).
     * Emit 'order:expired' so GTTExecutor can retry with a fresh price.
     */
    async handleOrderUpdate(msg) {
        if (msg.type !== 'CANCELLATION')
            return;
        const pending = this.pendingOrders.get(msg.id);
        if (!pending)
            return;
        this.pendingOrders.delete(msg.id);
        const ts = new Date().toISOString().slice(11, 19);
        if (pending.filledSize > 0) {
            // Partially filled before expiry — record what we got
            const avgFillPrice = pending.filledCost / pending.filledSize;
            const filledUsdc = pending.filledCost;
            const totalLatencyMs = Date.now() - pending.traderTs;
            const priceDrift = pending.traderPrice > 0
                ? ((avgFillPrice - pending.traderPrice) / pending.traderPrice) * 100
                : 0;
            console.log(`[${ts}] [Confirmer] ⚠️  Order expired with partial fill: ${pending.filledSize.toFixed(2)} shares`);
            await CopyTrade_1.CopyTrade.findByIdAndUpdate(pending.tradeDocId, {
                status: 'PARTIAL',
                filledSize: pending.filledSize,
                avgFillPrice,
                filledUsdc,
                priceDrift,
                totalLatencyMs,
                attempts: pending.attempt,
            });
            if (pending.side === 'BUY') {
                await traderLoader_1.TraderLoader.recordFill(pending.traderWallet, filledUsdc);
            }
            else {
                await traderLoader_1.TraderLoader.recordSellFill(pending.traderWallet, filledUsdc);
            }
            // Don't retry — we got a partial fill, not a full miss
            return;
        }
        // Expired with zero fill — trigger retry in GTTExecutor
        console.log(`[${ts}] [Confirmer] ⏱  Order expired unfilled (attempt ${pending.attempt}) — requesting retry`);
        eventBus_1.eventBus.emit('order:expired', pending);
    }
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            if (this.ws?.readyState === ws_1.default.OPEN) {
                this.ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, 30000);
    }
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }
    scheduleReconnect() {
        if (this.reconnecting)
            return;
        this.reconnecting = true;
        console.log('[Confirmer] Reconnecting in 5s...');
        setTimeout(() => {
            this.reconnecting = false;
            this.connect()
                .then(() => this.reviewStaleOrders())
                .catch(err => console.error('[Confirmer] Reconnect failed:', err.message));
        }, 5000);
    }
    /**
     * Called after reconnect to handle orders whose fill events may have been
     * missed during the disconnect window.
     *
     * Any pending order older than gttExpirySeconds + 30s has definitely expired
     * on Polymarket's side. Emit 'order:expired' so GTTExecutor retries it.
     * This prevents orders getting stuck in EXECUTING forever after a WS gap.
     */
    reviewStaleOrders() {
        const staleThresholdMs = (config_1.config.gttExpirySeconds + 30) * 1000;
        const now = Date.now();
        let staleCount = 0;
        for (const [orderId, pending] of this.pendingOrders) {
            if (now - pending.submittedAt > staleThresholdMs) {
                console.warn(`[Confirmer] Stale order after reconnect: ${orderId.slice(0, 12)}... (doc ${pending.tradeDocId}) — re-queuing as expired`);
                this.pendingOrders.delete(orderId);
                eventBus_1.eventBus.emit('order:expired', pending);
                staleCount++;
            }
        }
        if (staleCount > 0) {
            console.log(`[Confirmer] Reviewed ${staleCount} stale order(s) after reconnect`);
        }
    }
    /**
     * On bot startup, scan MongoDB for EXECUTING docs left over from a previous
     * run. These will never receive a fill event (WebSocket session is new).
     * Mark them FAILED so they don't silently block allocation.
     */
    static async clearStaleExecutingDocs() {
        const { CopyTrade } = await Promise.resolve().then(() => __importStar(require('../db/models/CopyTrade')));
        const staleMs = 5 * 60 * 1000; // anything EXECUTING for > 5min is from a prior run
        const cutoff = Date.now() - staleMs;
        const result = await CopyTrade.updateMany({ status: 'EXECUTING', submittedAt: { $lt: cutoff } }, { $set: { status: 'FAILED', failReason: 'Bot restarted while order was in-flight' } });
        if (result.modifiedCount > 0) {
            console.warn(`[Confirmer] Cleared ${result.modifiedCount} stale EXECUTING doc(s) from previous run`);
        }
    }
}
exports.Confirmer = Confirmer;
//# sourceMappingURL=confirmer.js.map