/**
 * Trade Poller Service
 * Polls for new trades every 60 seconds
 */

import { fetchNewActivity } from '../api/activity';
import { createLogger } from '../utils/logger';
import PolymarketTrade from '../../../models/PolymarketTrade';
import type { ActivityResponse } from '../types/polymarket';

const logger = createLogger('Poller');

export class TradePoller {
  private walletAddress: string;
  private lastSeenTimestamp: number;
  private intervalId: NodeJS.Timer | null = null;
  private isPolling: boolean = false;

  constructor(walletAddress: string) {
    this.walletAddress = walletAddress;
    this.lastSeenTimestamp = Math.floor(Date.now() / 1000);
  }

  /**
   * Start polling at specified interval
   */
  start(intervalMs: number = 60000): void {
    logger.info(
      `Starting poller for ${this.walletAddress} (interval: ${intervalMs / 1000}s)`
    );

    // Initial poll
    this.poll();

    // Schedule recurring polls
    this.intervalId = setInterval(() => this.poll(), intervalMs);
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info(`Stopped poller for ${this.walletAddress}`);
    }
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
    } catch (error: any) {
      logger.error(`Poll error for ${this.walletAddress}: ${error.message}`);
    } finally {
      this.isPolling = false;
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
