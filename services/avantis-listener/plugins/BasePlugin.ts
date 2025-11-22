/**
 * Base Plugin Abstract Class
 * Foundation for extensible plugin system
 */

import type { Trade, TradeOpenedEvent, TradeClosedEvent } from '../types/trades';

/**
 * Abstract base class for all plugins
 * Plugins can react to trade events without modifying core service
 */
export abstract class BasePlugin {
  /**
   * Plugin name (for logging and identification)
   */
  abstract readonly name: string;

  /**
   * Whether this plugin is enabled
   */
  abstract readonly enabled: boolean;

  /**
   * Called when a position is opened
   * @param trade - Trade opened event data
   */
  abstract onTradeOpened(trade: TradeOpenedEvent): Promise<void>;

  /**
   * Called when a position is closed
   * @param trade - Trade closed event data
   */
  abstract onTradeClosed(trade: TradeClosedEvent): Promise<void>;

  /**
   * Optional: Called when TP/SL is updated
   * @param data - Update data
   */
  async onTPSLUpdated?(data: any): Promise<void>;

  /**
   * Cleanup resources when plugin is disabled or service shuts down
   */
  abstract cleanup(): void;

  /**
   * Safe execution wrapper
   * Catches errors to prevent plugin failures from crashing main service
   * @param fn - Function to execute
   */
  protected async execute(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      console.error(
        `[Plugin:${this.name}] Error executing plugin:`,
        error instanceof Error ? error.message : error
      );
      // Don't rethrow - plugin errors should not crash main service
    }
  }

  /**
   * Log helper
   * @param message - Log message
   * @param data - Optional data to log
   */
  protected log(message: string, data?: any): void {
    if (data) {
      console.log(`[Plugin:${this.name}] ${message}`, data);
    } else {
      console.log(`[Plugin:${this.name}] ${message}`);
    }
  }

  /**
   * Error log helper
   * @param message - Error message
   * @param error - Error object
   */
  protected logError(message: string, error: any): void {
    console.error(
      `[Plugin:${this.name}] ${message}`,
      error instanceof Error ? error.message : error
    );
  }
}
