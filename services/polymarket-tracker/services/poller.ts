/**
 * Trade Poller Service
 * Polls for new trades every 60 seconds
 * Refreshes open positions every 5 minutes
 */

import { fetchNewActivity } from '../api/activity';
import { createLogger } from '../utils/logger';
import PolymarketTrade from '../../../models/PolymarketTrade';
import { computeMetrics, saveMetrics } from './metrics';
import { updateOpenPositions } from './positionUpdate';
import type { ActivityResponse } from '../types/polymarket';

const logger = createLogger('Poller');

export class TradePoller {
  private walletAddress: string;
  private lastSeenTimestamp: number;
  private tradeIntervalId: NodeJS.Timer | null = null;
  private positionIntervalId: NodeJS.Timer | null = null;
  private isPolling: boolean = false;
  private isRefreshingPositions: boolean = false;

  constructor(walletAddress: string) {
    this.walletAddress = walletAddress;
    this.lastSeenTimestamp = Math.floor(Date.now() / 1000);
  }

  /**
   * Start polling at specified intervals
   */
  start(tradeIntervalMs: number = 60000): void {
    const positionRefreshMs = 5 * 60 * 1000; // 5 minutes

    logger.info(
      `Starting poller for ${this.walletAddress} (trades: ${tradeIntervalMs / 1000}s, positions: ${positionRefreshMs / 1000}s)`
    );

    // Initial trade poll
    this.poll();

    // Schedule recurring trade polls (60s)
    this.tradeIntervalId = setInterval(() => this.poll(), tradeIntervalMs);

    // Schedule recurring position refresh (5min)
    this.positionIntervalId = setInterval(() => this.refreshPositions(), positionRefreshMs);
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.tradeIntervalId) {
      clearInterval(this.tradeIntervalId);
      this.tradeIntervalId = null;
    }
    if (this.positionIntervalId) {
      clearInterval(this.positionIntervalId);
      this.positionIntervalId = null;
    }
    logger.info(`Stopped poller for ${this.walletAddress}`);
  }

  /**
   * Poll for new trades
   */
  private async poll(): Promise<void> {
    if (this.isPolling) {
      logger.debug('Poll already in progress, skipping...');
      return;
    }

    this.isPolling = true;

    try {
      // Fetch new activities since last seen timestamp
      const activities = await fetchNewActivity(
        this.walletAddress,
        this.lastSeenTimestamp
      );

      if (activities.length === 0) {
        logger.debug(`No new activities for ${this.walletAddress}`);
        return;
      }

      logger.info(`Found ${activities.length} new activities for ${this.walletAddress}`);

      // Update last seen timestamp
      const maxTimestamp = Math.max(...activities.map((a) => a.timestamp));
      this.lastSeenTimestamp = maxTimestamp + 1; // Add 1 to avoid duplicates

      // Save to MongoDB
      await this.saveTrades(activities);

      // Log each activity
      activities.forEach((activity) => {
        const action = activity.type === 'REDEEM'
          ? `REDEEM ${activity.size.toFixed(2)} shares`
          : `${activity.side} ${activity.size.toFixed(2)} @ $${activity.price.toFixed(3)}`;

        logger.success(
          `  [${new Date(activity.timestamp * 1000).toISOString()}] ${action} - ${activity.outcome} - "${activity.title}"`
        );
      });

      // Note: Open positions are refreshed every 5 minutes by refreshPositions()
      // We don't fetch them here to avoid excessive API calls
    } catch (error: any) {
      logger.error(`Poll error for ${this.walletAddress}: ${error.message}`);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Refresh open positions (runs every 5 minutes)
   */
  private async refreshPositions(): Promise<void> {
    if (this.isRefreshingPositions) {
      logger.debug('Position refresh already in progress, skipping...');
      return;
    }

    this.isRefreshingPositions = true;

    try {
      logger.info(`Refreshing open positions for ${this.walletAddress}...`);

      // Update open positions from API
      await updateOpenPositions(this.walletAddress);

      // Recompute metrics with updated positions
      const metrics = await computeMetrics(this.walletAddress);
      await saveMetrics(this.walletAddress, metrics);

      logger.success('Open positions refreshed successfully');
    } catch (error: any) {
      logger.error(`Position refresh error: ${error.message}`);
    } finally {
      this.isRefreshingPositions = false;
    }
  }

  /**
   * Save trades to MongoDB
   */
  private async saveTrades(activities: ActivityResponse[]): Promise<void> {
    const operations = activities.map((activity) => ({
      updateOne: {
        filter: {
          walletAddress: this.walletAddress.toLowerCase(),
          transactionHash: activity.transactionHash,
        },
        update: {
          $set: {
            walletAddress: this.walletAddress.toLowerCase(),
            conditionId: activity.conditionId,
            asset: activity.asset,
            transactionHash: activity.transactionHash,
            activityType: activity.type,
            title: activity.title,
            slug: activity.slug,
            outcome: activity.outcome,
            outcomeIndex: activity.outcomeIndex,
            side: activity.side,
            size: activity.size,
            price: activity.price,
            usdcSize: activity.usdcSize,
            timestamp: new Date(activity.timestamp * 1000),
            detectedAt: new Date(),
          },
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        upsert: true,
      },
    }));

    if (operations.length > 0) {
      const result = await PolymarketTrade.bulkWrite(operations);
      logger.debug(
        `Saved: ${result.upsertedCount} new, ${result.modifiedCount} updated`
      );
    }
  }

  /**
   * Get wallet address being tracked
   */
  getWallet(): string {
    return this.walletAddress;
  }

  /**
   * Get last seen timestamp
   */
  getLastSeenTimestamp(): number {
    return this.lastSeenTimestamp;
  }
}
