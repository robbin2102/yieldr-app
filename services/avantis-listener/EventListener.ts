/**
 * Event Listener
 * Real-time blockchain event monitoring with WebSocket/polling
 */

import { watchEvent } from './core/ViemClient';
import { CONTRACTS, MARKET_ORDER_INITIATED_EVENT, MARKET_EXECUTED_EVENT, FEATURES, RPC_CONFIG } from './config';
import { parseMarketOrderInitiated, parseMarketExecuted } from './EventParser';
import {
  processMarketOrderInitiated,
  processMarketExecuted,
} from './EventCorrelator';
import type { Log } from 'viem';

/**
 * EventListener class
 * Manages real-time event watching for specific wallets
 */
export class EventListener {
  private monitoredWallets: Set<string>;
  private unwatchInitiated: (() => void) | null = null;
  private unwatchExecuted: (() => void) | null = null;
  private isActive: boolean = false;
  private reconnectAttempts: number = 0;

  // Statistics
  private eventsProcessed: number = 0;
  private errorsCount: number = 0;
  private lastEventTime: Date | null = null;

  constructor(wallets: string[] = []) {
    this.monitoredWallets = new Set(wallets.map((w) => w.toLowerCase()));
    console.log(
      `[EventListener] Initialized with ${this.monitoredWallets.size} monitored wallets`
    );
  }

  /**
   * Start listening to events
   */
  async start(): Promise<void> {
    if (this.isActive) {
      console.warn('[EventListener] Already active');
      return;
    }

    if (!FEATURES.ENABLE_REALTIME_LISTENER) {
      console.log('[EventListener] Real-time listener disabled by feature flag');
      return;
    }

    console.log('[EventListener] Starting event listener...');

    try {
      // Watch MarketOrderInitiated events
      this.unwatchInitiated = watchEvent({
        address: CONTRACTS.TRADING,
        event: MARKET_ORDER_INITIATED_EVENT,
        onLogs: (logs) => this.handleMarketOrderInitiatedLogs(logs),
        onError: (error) => this.handleError('MarketOrderInitiated', error),
        poll: true, // Use polling for stability
        pollingInterval: RPC_CONFIG.RECONNECT_DELAY_MS,
      });

      // Watch MarketExecuted events
      this.unwatchExecuted = watchEvent({
        address: CONTRACTS.EVENTS,
        event: MARKET_EXECUTED_EVENT,
        onLogs: (logs) => this.handleMarketExecutedLogs(logs),
        onError: (error) => this.handleError('MarketExecuted', error),
        poll: true,
        pollingInterval: RPC_CONFIG.RECONNECT_DELAY_MS,
      });

      this.isActive = true;
      this.reconnectAttempts = 0;

      console.log('[EventListener] ✓ Event listener started successfully');
      console.log(
        `[EventListener] Monitoring ${this.monitoredWallets.size} wallets`
      );
    } catch (error) {
      console.error('[EventListener] Failed to start:', error);
      this.errorsCount++;
      throw error;
    }
  }

  /**
   * Stop listening to events
   */
  stop(): void {
    if (!this.isActive) {
      console.warn('[EventListener] Not active');
      return;
    }

    console.log('[EventListener] Stopping event listener...');

    if (this.unwatchInitiated) {
      this.unwatchInitiated();
      this.unwatchInitiated = null;
    }

    if (this.unwatchExecuted) {
      this.unwatchExecuted();
      this.unwatchExecuted = null;
    }

    this.isActive = false;

    console.log('[EventListener] ✓ Event listener stopped');
  }

  /**
   * Add wallet to monitoring list
   */
  addWallet(wallet: string): void {
    const normalized = wallet.toLowerCase();
    this.monitoredWallets.add(normalized);
    console.log(`[EventListener] Added wallet ${normalized} (total: ${this.monitoredWallets.size})`);
  }

  /**
   * Remove wallet from monitoring list
   */
  removeWallet(wallet: string): void {
    const normalized = wallet.toLowerCase();
    this.monitoredWallets.delete(normalized);
    console.log(`[EventListener] Removed wallet ${normalized} (total: ${this.monitoredWallets.size})`);
  }

  /**
   * Check if wallet is monitored
   */
  private isMonitored(wallet: string): boolean {
    // If no wallets specified, monitor all
    if (this.monitoredWallets.size === 0) return true;

    return this.monitoredWallets.has(wallet.toLowerCase());
  }

  /**
   * Handle MarketOrderInitiated logs
   */
  private async handleMarketOrderInitiatedLogs(logs: Log[]): Promise<void> {
    if (logs.length === 0) return;

    console.log(`[EventListener] Received ${logs.length} MarketOrderInitiated events`);

    for (const log of logs) {
      try {
        const parsed = parseMarketOrderInitiated(log);

        if (!parsed) {
          console.warn('[EventListener] Failed to parse MarketOrderInitiated event');
          continue;
        }

        // Filter by monitored wallets
        if (!this.isMonitored(parsed.trader)) {
          if (FEATURES.ENABLE_VERBOSE_LOGGING) {
            console.log(
              `[EventListener] Skipping event for non-monitored wallet ${parsed.trader}`
            );
          }
          continue;
        }

        console.log(
          `[EventListener] MarketOrderInitiated - orderId: ${parsed.orderId}, trader: ${parsed.trader}, pair: ${parsed.pairIndex}`
        );

        await processMarketOrderInitiated(parsed);

        this.eventsProcessed++;
        this.lastEventTime = new Date();
      } catch (error) {
        console.error('[EventListener] Error handling MarketOrderInitiated:', error);
        this.errorsCount++;
      }
    }
  }

  /**
   * Handle MarketExecuted logs
   */
  private async handleMarketExecutedLogs(logs: Log[]): Promise<void> {
    if (logs.length === 0) return;

    console.log(`[EventListener] Received ${logs.length} MarketExecuted events`);

    for (const log of logs) {
      try {
        const parsed = parseMarketExecuted(log);

        if (!parsed) {
          console.warn('[EventListener] Failed to parse MarketExecuted event');
          continue;
        }

        // Filter by monitored wallets
        if (!this.isMonitored(parsed.trader)) {
          if (FEATURES.ENABLE_VERBOSE_LOGGING) {
            console.log(
              `[EventListener] Skipping event for non-monitored wallet ${parsed.trader}`
            );
          }
          continue;
        }

        console.log(
          `[EventListener] MarketExecuted - orderId: ${parsed.orderId}, trader: ${parsed.trader}, open: ${parsed.open}`
        );

        await processMarketExecuted(parsed);

        this.eventsProcessed++;
        this.lastEventTime = new Date();
      } catch (error) {
        console.error('[EventListener] Error handling MarketExecuted:', error);
        this.errorsCount++;
      }
    }
  }

  /**
   * Handle errors
   */
  private handleError(eventType: string, error: Error): void {
    console.error(`[EventListener] Error in ${eventType} watcher:`, error);
    this.errorsCount++;

    // Attempt reconnection
    this.attemptReconnect();
  }

  /**
   * Attempt to reconnect
   */
  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= RPC_CONFIG.MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `[EventListener] Max reconnect attempts (${RPC_CONFIG.MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`
      );
      this.stop();
      return;
    }

    this.reconnectAttempts++;

    const delay = Math.min(
      RPC_CONFIG.RECONNECT_DELAY_MS * this.reconnectAttempts,
      30000 // Max 30 seconds
    );

    console.log(
      `[EventListener] Attempting reconnect ${this.reconnectAttempts}/${RPC_CONFIG.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      this.stop();
      await this.start();
      console.log('[EventListener] ✓ Reconnected successfully');
    } catch (error) {
      console.error('[EventListener] Reconnect failed:', error);
      this.attemptReconnect(); // Try again
    }
  }

  /**
   * Get listener status
   */
  getStatus() {
    return {
      isActive: this.isActive,
      monitoredWallets: Array.from(this.monitoredWallets),
      eventsProcessed: this.eventsProcessed,
      errorsCount: this.errorsCount,
      lastEventTime: this.lastEventTime,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.eventsProcessed = 0;
    this.errorsCount = 0;
    this.lastEventTime = null;
    console.log('[EventListener] Statistics reset');
  }
}
