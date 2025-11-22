/**
 * Decimal conversion utilities for Avantis on-chain values
 */

import { DECIMALS } from '../config/constants';

/**
 * Convert price from on-chain format (10^10 precision) to human-readable
 * @param value - Raw price value from contract
 * @returns Price as number
 */
export function fromPriceDecimals(value: bigint): number {
  return Number(value) / Number(DECIMALS.PRICE);
}

/**
 * Convert leverage from on-chain format (10^10 precision) to human-readable
 * @param value - Raw leverage value from contract
 * @returns Leverage as number (e.g., 10.5 for 10.5x)
 */
export function fromLeverageDecimals(value: bigint): number {
  return Number(value) / Number(DECIMALS.LEVERAGE);
}

/**
 * Convert USDC amount from on-chain format (10^6 precision) to human-readable
 * @param value - Raw USDC value from contract
 * @returns USDC amount as number
 */
export function fromUsdcDecimals(value: bigint): number {
  return Number(value) / Number(DECIMALS.USDC);
}

/**
 * Convert percentage from on-chain format (10^10 precision) to human-readable
 * Handles negative values (int256)
 * @param value - Raw percentage value from contract
 * @returns Percentage as number (e.g., 15.5 for 15.5%)
 */
export function fromPercentDecimals(value: bigint): number {
  return Number(value) / Number(DECIMALS.PERCENT);
}

/**
 * Convert timestamp (seconds) to Date
 * @param timestamp - Unix timestamp in seconds
 * @returns Date object
 */
export function fromTimestamp(timestamp: bigint): Date {
  return new Date(Number(timestamp) * 1000);
}

/**
 * Estimate timestamp from block number
 * Base chain: ~2 second block time
 * Base genesis block: 0 at timestamp ~1686789347 (June 2023)
 * @param blockNumber - Block number
 * @returns Estimated Date
 */
export function estimateTimestampFromBlock(blockNumber: bigint | number): Date {
  const BASE_GENESIS_TIMESTAMP = 1686789347; // Approximate Base L2 genesis
  const BLOCK_TIME_SECONDS = 2;

  const blockNum = Number(blockNumber);
  const estimatedTimestamp = BASE_GENESIS_TIMESTAMP + (blockNum * BLOCK_TIME_SECONDS);

  return new Date(estimatedTimestamp * 1000);
}

/**
 * Safely convert bigint to number
 * Logs warning if value might lose precision
 * @param value - BigInt value
 * @param fieldName - Field name for logging
 * @returns Number value
 */
export function toNumber(value: bigint, fieldName: string = 'value'): number {
  const numValue = Number(value);

  // Check if conversion might lose precision (beyond Number.MAX_SAFE_INTEGER)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    console.warn(`[decimals] ${fieldName} value ${value} exceeds MAX_SAFE_INTEGER, precision may be lost`);
  }

  return numValue;
}

/**
 * Format USDC for display (2 decimal places)
 * @param usdc - USDC amount
 * @returns Formatted string
 */
export function formatUsdc(usdc: number): string {
  return usdc.toFixed(2);
}

/**
 * Format price for display (appropriate decimal places based on value)
 * @param price - Price value
 * @returns Formatted string
 */
export function formatPrice(price: number): string {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

/**
 * Format percentage for display
 * @param percent - Percentage value
 * @returns Formatted string with % sign
 */
export function formatPercent(percent: number): string {
  return `${percent.toFixed(2)}%`;
}

/**
 * Calculate ROI from PnL and collateral
 * @param pnl - Profit/Loss in USDC
 * @param collateral - Initial collateral in USDC
 * @returns ROI as percentage (e.g., 15.5 for 15.5%)
 */
export function calculateRoi(pnl: number, collateral: number): number {
  if (collateral === 0) return 0;
  return (pnl / collateral) * 100;
}

/**
 * Validate that a number is positive
 * @param value - Number to validate
 * @param fieldName - Field name for error message
 * @throws Error if value is negative
 */
export function validatePositive(value: number, fieldName: string): void {
  if (value < 0) {
    throw new Error(`${fieldName} must be positive, got ${value}`);
  }
}

/**
 * Validate Ethereum address format
 * @param address - Address to validate
 * @returns true if valid
 */
export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
