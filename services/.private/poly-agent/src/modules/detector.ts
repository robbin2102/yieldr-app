import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { PolyAgentTrade } from '../db/models/PolyAgentTrade';
import { DetectedTrade, ActivityResponse } from '../types';

/**
 * Detector - Monitors target wallet for new trades
 *
 * - Polls Polymarket /activity API every 3 seconds
 * - Resumes from last seen trade in MongoDB
 * - Emits 'trade:detected' event for each new trade
 * - Deduplication handled by MongoDB unique index on txHash
 */
export class Detector {
  private lastSeenTimestamp: number;
  private intervalId: NodeJS.Timeout | null = null;
  private isPolling: boolean = false;

  constructor() {
    // Start from now (will be updated from DB on start())
    this.lastSeenTimestamp = Math.floor(Date.now() / 1000);
  }

  async start() {
    // Resume from last trade in DB
    const lastTrade = await PolyAgentTrade.findOne({})
      .sort({ 'original.timestamp': -1 })
      .lean();

    if (lastTrade?.original?.timestamp) {
      this.lastSeenTimestamp = Math.floor(new Date(lastTrade.original.timestamp).getTime() / 1000);
      console.log(`[Detector] Resuming from: ${new Date(this.lastSeenTimestamp * 1000).toISOString()}`);
    } else {
      console.log(`[Detector] Starting fresh from: ${new Date(this.lastSeenTimestamp * 1000).toISOString()}`);
    }

    console.log(`[Detector] Starting ${config.detectorIntervalMs}ms polling for ${config.targetWallet}`);

    // Start polling interval
    this.intervalId = setInterval(() => this.poll(), config.detectorIntervalMs);

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

  private async poll() {
    // Prevent overlapping polls
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      // Build API URL - only get trades AFTER lastSeenTimestamp
      const url = `${config.dataApiBase}/activity?user=${config.targetWallet}&type=TRADE&start=${this.lastSeenTimestamp}&limit=100&sortBy=TIMESTAMP&sortDirection=ASC`;

      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[Detector] API error: ${response.status} ${response.statusText}`);
        return;
      }

      const trades = await response.json() as ActivityResponse[];

      if (trades.length === 0) {
        // No new trades
        return;
      }

      console.log(`[Detector] Found ${trades.length} new trade(s)`);

      for (const trade of trades) {
        // Update timestamp for next poll
        if (trade.timestamp > this.lastSeenTimestamp) {
          this.lastSeenTimestamp = trade.timestamp;
        }

        // Build detected trade object
        const detectedTrade: DetectedTrade = {
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
        eventBus.emit('trade:detected', detectedTrade);
      }
    } catch (error) {
      console.error('[Detector] Poll error:', error);
    } finally {
      this.isPolling = false;
    }
  }
}
