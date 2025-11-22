/**
 * Constants for Avantis Event Listener
 */

/**
 * Decimal Precision Constants
 * Used for converting on-chain values to human-readable format
 */
export const DECIMALS = {
  PRICE: 10n ** 10n, // Prices (openPrice, tp, sl, price)
  LEVERAGE: 10n ** 10n, // Leverage values
  USDC: 10n ** 6n, // USDC amounts (6 decimals)
  PERCENT: 10n ** 10n, // Percentage values (including percentProfit)
} as const;

/**
 * Block Configuration for Base Chain
 */
export const BLOCK_CONFIG = {
  BLOCK_TIME_SECONDS: 2, // Base L2 block time
  BLOCKS_PER_DAY: 43_200, // (24 * 60 * 60) / 2
  BLOCKS_PER_WEEK: 302_400,
  BLOCKS_PER_MONTH: 1_296_000, // ~30 days
  BLOCKS_PER_90_DAYS: 3_888_000,

  // Backfill settings (optimized for filtered queries)
  CHUNK_SIZE: 10_000, // QuickNode eth_getLogs limit is 10K blocks per request
  CHUNK_DELAY_MS: 50, // Wait 50ms between chunks
} as const;

/**
 * Trade Status Enum
 */
export enum TradeStatus {
  PENDING = 'PENDING', // Order initiated, not yet executed
  EXECUTED = 'EXECUTED', // Position opened
  CLOSED = 'CLOSED', // Position closed
}

/**
 * Retry Configuration
 */
export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  INITIAL_DELAY_MS: 1_000, // Start with 1 second
  MAX_DELAY_MS: 16_000, // Max 16 seconds
  EXPONENTIAL_BASE: 2, // Double delay each retry
} as const;

/**
 * RPC Configuration
 */
export const RPC_CONFIG = {
  BATCH_SIZE: 100, // Max events to process in one batch
  RECONNECT_DELAY_MS: 5_000, // Wait 5s before reconnecting WebSocket
  MAX_RECONNECT_ATTEMPTS: 10,
} as const;
