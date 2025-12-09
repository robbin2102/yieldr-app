"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Detector = void 0;
const config_1 = require("../config");
const eventBus_1 = require("../state/eventBus");
const PolyAgentTrade_1 = require("../db/models/PolyAgentTrade");
/**
 * Detector - Monitors target wallet for new trades
 *
 * - Polls Polymarket /activity API every 3 seconds
 * - Always starts from NOW (no historical backfill - can't execute at old prices)
 * - Only executes real-time trades detected during polling
 * - Deduplication handled by MongoDB unique index on txHash
 */
class Detector {
    constructor() {
        this.intervalId = null;
        this.isPolling = false;
        this.pollCount = 0;
        this.lastPollTime = 0;
        // Start from now (no backfill on startup)
        this.lastSeenTimestamp = Math.floor(Date.now() / 1000);
    }
    async start() {
        const now = Math.floor(Date.now() / 1000);
        const oneMinuteAgo = now - 60;
        // Check if there was a recent trade (within 1 minute = graceful restart)
        const lastTrade = await PolyAgentTrade_1.PolyAgentTrade.findOne({})
            .sort({ 'original.timestamp': -1 })
            .lean();
        if (lastTrade?.original?.timestamp) {
            const lastTradeTimestamp = Math.floor(new Date(lastTrade.original.timestamp).getTime() / 1000);
            // Only resume if very recent (< 1 minute = quick restart, won't miss trades)
            if (lastTradeTimestamp >= oneMinuteAgo) {
                this.lastSeenTimestamp = lastTradeTimestamp;
                console.log(`[Detector] 🔄 Quick restart detected - resuming from ${new Date(this.lastSeenTimestamp * 1000).toISOString()}`);
            }
            else {
                this.lastSeenTimestamp = now;
                console.log(`[Detector] 🚀 Starting fresh from NOW (historical trades skipped - can't execute at old prices)`);
                console.log(`[Detector] Last DB trade was at ${new Date(lastTradeTimestamp * 1000).toISOString()}`);
            }
        }
        else {
            this.lastSeenTimestamp = now;
            console.log(`[Detector] 🚀 Starting fresh from NOW - no historical trades in DB`);
        }
        console.log(`[Detector] Starting ${config_1.config.detectorIntervalMs}ms polling for ${config_1.config.targetWallet}`);
        // Start polling interval
        this.intervalId = setInterval(() => this.poll(), config_1.config.detectorIntervalMs);
        // Immediate first poll
        this.poll();
    }
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            console.log('[Detector] Stopped');
        }
    }
    async poll() {
        // Prevent overlapping polls
        if (this.isPolling)
            return;
        this.isPolling = true;
        const pollStartTime = Date.now();
        const timeSinceLastPoll = this.lastPollTime > 0 ? pollStartTime - this.lastPollTime : 0;
        try {
            this.pollCount++;
            // Log activity every 10 polls (30 seconds)
            if (this.pollCount % 10 === 0) {
                const date = new Date(this.lastSeenTimestamp * 1000).toISOString();
                console.log(`[Detector] 👁️  Monitoring ${config_1.config.targetWallet.slice(0, 8)}... (${this.pollCount} checks, last: ${date})`);
            }
            // Build API URL - only get trades AFTER lastSeenTimestamp
            const url = `${config_1.config.dataApiBase}/activity?user=${config_1.config.targetWallet}&type=TRADE&start=${this.lastSeenTimestamp}&limit=100&sortBy=TIMESTAMP&sortDirection=ASC`;
            const apiCallStart = Date.now();
            const response = await fetch(url);
            const apiLatency = Date.now() - apiCallStart;
            if (!response.ok) {
                console.error(`[Detector] API error: ${response.status} ${response.statusText}`);
                return;
            }
            const trades = await response.json();
            if (trades.length === 0) {
                // No new trades - log every poll for testing
                if (timeSinceLastPoll > 0) {
                    console.log(`[Detector] Poll #${this.pollCount}: No new trades (gap: ${timeSinceLastPoll}ms, API: ${apiLatency}ms)`);
                }
                return;
            }
            console.log(`\n[Detector] ⚡ Poll #${this.pollCount}: Found ${trades.length} new trade(s)!`);
            console.log(`  Time since last poll: ${timeSinceLastPoll}ms`);
            console.log(`  API latency: ${apiLatency}ms`);
            for (const trade of trades) {
                // Update timestamp for next poll
                if (trade.timestamp > this.lastSeenTimestamp) {
                    this.lastSeenTimestamp = trade.timestamp;
                }
                // Build detected trade object
                const detectedTrade = {
                    txHash: trade.transactionHash,
                    conditionId: trade.conditionId,
                    tokenId: trade.asset,
                    side: trade.side,
                    size: trade.size,
                    price: trade.price,
                    usdcSize: trade.usdcSize,
                    timestamp: trade.timestamp,
                    title: trade.title,
                    outcome: trade.outcome,
                    detectedAt: Date.now(),
                };
                console.log(`\n[Detector] 🎯 Trade detected!`);
                console.log(`  ${trade.side} ${trade.size} ${trade.outcome} @ $${trade.price.toFixed(4)}`);
                console.log(`  Market: ${trade.title}`);
                console.log(`  Value: $${trade.usdcSize.toFixed(2)}`);
                console.log(`  TX: ${trade.transactionHash.slice(0, 16)}...`);
                // Emit for Executor (non-blocking)
                eventBus_1.eventBus.emit('trade:detected', detectedTrade);
            }
        }
        catch (error) {
            console.error('[Detector] Poll error:', error);
        }
        finally {
            this.isPolling = false;
            this.lastPollTime = pollStartTime;
        }
    }
}
exports.Detector = Detector;
//# sourceMappingURL=detector.js.map