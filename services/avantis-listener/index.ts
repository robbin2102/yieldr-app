/**
 * Avantis Listener Service - Main Entry Point
 * Real-time and historical Avantis trading event monitoring
 */

import { EventListener } from './EventListener';
import { backfillWallet, backfillMultipleWallets, correctCloseTimestamps, type BackfillResult } from './Backfiller';
import { eventEmitter } from './EventCorrelator';
import { verifyConnection } from './core/ViemClient';
import { BasePlugin } from './plugins/BasePlugin';
import { APP_EVENTS } from './config';
import TradeEvent from '../../models/TradeEvent';
import type { TradeOpenedEvent, TradeClosedEvent } from './types/trades';

/**
 * Plugin Manager
 * Manages plugin lifecycle and event subscriptions
 */
class PluginManager {
  private plugins: BasePlugin[] = [];

  /**
   * Register a plugin
   * @param plugin - Plugin instance
   */
  register(plugin: BasePlugin): void {
    if (!plugin.enabled) {
      console.log(`[PluginManager] Plugin ${plugin.name} is disabled, skipping registration`);
      return;
    }

    this.plugins.push(plugin);

    // Subscribe to trade:opened events
    eventEmitter.on(APP_EVENTS.TRADE_OPENED, async (trade: TradeOpenedEvent) => {
      await this.safeExecute(plugin, () => plugin.onTradeOpened(trade));
    });

    // Subscribe to trade:closed events
    eventEmitter.on(APP_EVENTS.TRADE_CLOSED, async (trade: TradeClosedEvent) => {
      await this.safeExecute(plugin, () => plugin.onTradeClosed(trade));
    });

    // Subscribe to trade:tpsl:updated events (if plugin implements it)
    if (plugin.onTPSLUpdated) {
      eventEmitter.on(APP_EVENTS.TRADE_TPSL_UPDATED, async (data: any) => {
        await this.safeExecute(plugin, () => plugin.onTPSLUpdated!(data));
      });
    }

    console.log(`[PluginManager] ✓ Registered plugin: ${plugin.name}`);
  }

  /**
   * Safely execute plugin method
   * Prevents plugin errors from crashing the service
   */
  private async safeExecute(
    plugin: BasePlugin,
    fn: () => Promise<void>
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      console.error(
        `[PluginManager] Error executing plugin ${plugin.name}:`,
        error instanceof Error ? error.message : error
      );
      // Don't rethrow - continue processing other plugins
    }
  }

  /**
   * Cleanup all plugins
   */
  cleanup(): void {
    console.log(`[PluginManager] Cleaning up ${this.plugins.length} plugins...`);

    for (const plugin of this.plugins) {
      try {
        plugin.cleanup();
        console.log(`[PluginManager] ✓ Cleaned up plugin: ${plugin.name}`);
      } catch (error) {
        console.error(
          `[PluginManager] Error cleaning up plugin ${plugin.name}:`,
          error
        );
      }
    }

    eventEmitter.removeAllListeners();
    this.plugins = [];

    console.log('[PluginManager] ✓ All plugins cleaned up');
  }

  /**
   * Get list of registered plugins
   */
  getPlugins(): string[] {
    return this.plugins.map((p) => p.name);
  }
}

// Singleton instances
let listener: EventListener | null = null;
const pluginManager = new PluginManager();

/**
 * Start Avantis listener service
 * @param wallets - Array of wallet addresses to monitor
 */
export async function startAvantisListener(wallets: string[] = []): Promise<void> {
  console.log('[AvantisListener] Starting service...');

  try {
    // Verify RPC connection
    const connected = await verifyConnection();
    if (!connected) {
      throw new Error('Failed to connect to Base RPC');
    }

    // Create and start listener
    listener = new EventListener(wallets);
    await listener.start();

    // Future: Register plugins here
    // Example:
    // const tradeMirrorPlugin = new TradeMirrorPlugin();
    // pluginManager.register(tradeMirrorPlugin);

    console.log('[AvantisListener] ✓ Service started successfully');
    console.log(`[AvantisListener] Monitoring ${wallets.length} wallets`);
  } catch (error) {
    console.error('[AvantisListener] Failed to start service:', error);
    throw error;
  }
}

/**
 * Stop Avantis listener service
 */
export function stopAvantisListener(): void {
  console.log('[AvantisListener] Stopping service...');

  if (listener) {
    listener.stop();
    listener = null;
  }

  pluginManager.cleanup();

  console.log('[AvantisListener] ✓ Service stopped');
}

/**
 * Add wallet to monitoring list
 */
export function addMonitoredWallet(wallet: string): void {
  if (!listener) {
    throw new Error('Listener not started');
  }
  listener.addWallet(wallet);
}

/**
 * Remove wallet from monitoring list
 */
export function removeMonitoredWallet(wallet: string): void {
  if (!listener) {
    throw new Error('Listener not started');
  }
  listener.removeWallet(wallet);
}

/**
 * Get listener status
 */
export function getListenerStatus() {
  if (!listener) {
    return {
      isActive: false,
      monitoredWallets: [],
      eventsProcessed: 0,
      errorsCount: 0,
      lastEventTime: null,
      reconnectAttempts: 0,
      plugins: [],
    };
  }

  return {
    ...listener.getStatus(),
    plugins: pluginManager.getPlugins(),
  };
}

/**
 * Backfill historical events for a wallet
 * @param wallet - Wallet address
 * @param daysBack - Number of days to backfill (default 90)
 */
export async function backfillWalletHistory(
  wallet: string,
  daysBack: number = 90
): Promise<BackfillResult> {
  console.log(`[AvantisListener] Starting backfill for ${wallet} (${daysBack} days)`);

  // Perform main backfill
  const result = await backfillWallet({ wallet, daysBack });

  // Correct close timestamps for closed trades (minimal RPC overhead)
  console.log('[AvantisListener] Correcting close timestamps for closed trades...');
  const correctionResult = await correctCloseTimestamps(wallet);

  console.log(
    `[AvantisListener] ✓ Timestamp correction: ${correctionResult.corrected} trades updated, ` +
    `${correctionResult.uniqueBlocks} blocks fetched in ${(correctionResult.durationMs / 1000).toFixed(1)}s`
  );

  return result;
}

/**
 * Backfill multiple wallets
 */
export async function backfillMultipleWalletsHistory(
  wallets: string[],
  daysBack: number = 90
): Promise<BackfillResult[]> {
  console.log(`[AvantisListener] Starting backfill for ${wallets.length} wallets`);
  return await backfillMultipleWallets(wallets, { daysBack });
}

/**
 * Get trade history for a wallet
 */
export async function getWalletTrades(wallet: string, limit: number = 100) {
  return await TradeEvent.find({ trader: wallet.toLowerCase() })
    .sort({ initiatedAt: -1 })
    .limit(limit)
    .lean();
}

/**
 * Get open positions for a wallet
 */
export async function getOpenPositions(wallet: string) {
  return await TradeEvent.find({
    trader: wallet.toLowerCase(),
    status: 'EXECUTED',
  })
    .sort({ initiatedAt: -1 })
    .lean();
}

/**
 * Get closed positions for a wallet
 */
export async function getClosedPositions(wallet: string, limit: number = 100) {
  return await TradeEvent.find({
    trader: wallet.toLowerCase(),
    status: 'CLOSED',
  })
    .sort({ closedAt: -1 })
    .limit(limit)
    .lean();
}

/**
 * Register a plugin
 */
export function registerPlugin(plugin: BasePlugin): void {
  pluginManager.register(plugin);
}

/**
 * Cleanup handler for graceful shutdown
 */
process.on('SIGTERM', async () => {
  console.log('[AvantisListener] Received SIGTERM, shutting down gracefully...');
  stopAvantisListener();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[AvantisListener] Received SIGINT, shutting down gracefully...');
  stopAvantisListener();
  process.exit(0);
});

// Export types and utilities
export { APP_EVENTS } from './config';
export type { Trade, TradeStatistics, TradeQueryFilters } from './types/trades';
export type { BackfillResult } from './Backfiller';
export { BasePlugin } from './plugins/BasePlugin';
