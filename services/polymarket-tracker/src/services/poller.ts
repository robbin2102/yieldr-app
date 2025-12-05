import { fetchNewTrades } from '../api/activity';
import { Trade as TradeModel } from '../db/models/Trade';
import { createLogger } from '../utils/logger';
import { sendWebhookNotification } from './notifications';

const logger = createLogger('Poller');

export class TradePoller {
  private walletAddress: string;
  private lastSeenTimestamp: number;
  private intervalId: NodeJS.Timer | null = null;
  private isPolling: boolean = false;

  constructor(walletAddress: string) {
    this.walletAddress = walletAddress.toLowerCase();
    // Start from current time (only fetch new trades from now on)
    this.lastSeenTimestamp = Math.floor(Date.now() / 1000);
    logger.info(`Initialized poller for ${this.walletAddress}`);
  }

  start(intervalMs: number = 60000) {
    if (this.intervalId) {
      logger.warn(`Poller already running for ${this.walletAddress}`);
      return;
    }

    logger.info(`Starting poller for ${this.walletAddress} (interval: ${intervalMs}ms)`);

    // Do initial poll immediately
    this.poll();

    // Then poll at regular intervals
    this.intervalId = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info(`Stopped poller for ${this.walletAddress}`);
    }
  }

  private async poll() {
    if (this.isPolling) {
      logger.warn(`Poll already in progress for ${this.walletAddress}, skipping...`);
      return;
    }

    this.isPolling = true;

    try {
      // Fetch trades since last seen timestamp
      const newTrades = await fetchNewTrades(this.walletAddress, this.lastSeenTimestamp);

      if (newTrades.length === 0) {
        logger.debug(`No new trades for ${this.walletAddress}`);
        return;
      }

      logger.info(`Found ${newTrades.length} new trades for ${this.walletAddress}`);

      // Update last seen timestamp to the most recent trade
      const latestTimestamp = Math.max(...newTrades.map((t) => Math.floor(t.timestamp.getTime() / 1000)));
      this.lastSeenTimestamp = latestTimestamp + 1; // Add 1 second to avoid fetching same trade again

      // Save trades to database
      let savedCount = 0;
      let duplicateCount = 0;

      for (const trade of newTrades) {
        try {
          await TradeModel.create(trade);
          savedCount++;

          // Log trade details
          logger.success(
            `  ${trade.side} ${trade.size} shares of "${trade.outcome}" in "${trade.title}" @ $${trade.price.toFixed(4)} (Total: $${trade.usdcSize.toFixed(2)})`
          );

          // Send webhook notification
          await sendWebhookNotification('trade_detected', {
            walletAddress: trade.walletAddress,
            title: trade.title,
            outcome: trade.outcome,
            side: trade.side,
            size: trade.size,
            price: trade.price,
            usdcSize: trade.usdcSize,
            timestamp: trade.timestamp.toISOString(),
            transactionHash: trade.transactionHash,
          });
        } catch (error: any) {
          if (error.code === 11000) {
            // Duplicate trade (already in DB)
            duplicateCount++;
          } else {
            logger.error(`Failed to save trade ${trade.transactionHash}:`, error);
          }
        }
      }

      logger.success(
        `Saved ${savedCount} new trades for ${this.walletAddress}` +
          (duplicateCount > 0 ? ` (${duplicateCount} duplicates skipped)` : '')
      );
    } catch (error) {
      logger.error(`Poll failed for ${this.walletAddress}:`, error);
    } finally {
      this.isPolling = false;
    }
  }

  getStatus() {
    return {
      walletAddress: this.walletAddress,
      isRunning: this.intervalId !== null,
      lastSeenTimestamp: this.lastSeenTimestamp,
      lastSeenDate: new Date(this.lastSeenTimestamp * 1000).toISOString(),
    };
  }
}

export class PollerManager {
  private pollers: Map<string, TradePoller> = new Map();

  addWallet(walletAddress: string, intervalMs: number = 60000) {
    const wallet = walletAddress.toLowerCase();

    if (this.pollers.has(wallet)) {
      logger.warn(`Poller already exists for ${wallet}`);
      return this.pollers.get(wallet)!;
    }

    const poller = new TradePoller(wallet);
    poller.start(intervalMs);
    this.pollers.set(wallet, poller);

    logger.success(`Added poller for ${wallet}`);
    return poller;
  }

  removeWallet(walletAddress: string) {
    const wallet = walletAddress.toLowerCase();
    const poller = this.pollers.get(wallet);

    if (!poller) {
      logger.warn(`No poller found for ${wallet}`);
      return;
    }

    poller.stop();
    this.pollers.delete(wallet);
    logger.success(`Removed poller for ${wallet}`);
  }

  stopAll() {
    logger.info(`Stopping all pollers (${this.pollers.size} active)`);
    this.pollers.forEach((poller) => poller.stop());
    this.pollers.clear();
  }

  getStatus() {
    return Array.from(this.pollers.values()).map((poller) => poller.getStatus());
  }
}
