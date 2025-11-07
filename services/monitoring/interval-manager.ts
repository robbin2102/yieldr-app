/**
 * Interval Manager
 *
 * Determines whether platforms need to be fetched based on:
 * - Time since last fetch
 * - Position count (for dynamic intervals)
 * - Platform-specific rules
 */

import { getLastSnapshot } from './snapshot-service';

export interface FetchDecisions {
  shouldFetchAvantis: boolean;
  shouldFetchHyperliquid: boolean;
  shouldFetchLP: boolean;
  avantisInterval: number; // For logging/debugging
  hyperliquidInterval: number;
  lpInterval: number;
}

/**
 * Determines which platforms need to be fetched for a manager
 */
export async function decidePlatformFetches(
  managerId: string
): Promise<FetchDecisions> {
  const now = Date.now();

  // Hyperliquid: Always fetch (60s interval, fast API)
  const shouldFetchHyperliquid = true;
  const hyperliquidInterval = 60000;

  // Avantis: Dynamic interval based on position count
  let shouldFetchAvantis = true;
  let avantisInterval = 300000; // Default: 5 minutes

  try {
    const lastAvantisSnapshot = await getLastSnapshot(managerId, 'avantis');

    if (lastAvantisSnapshot) {
      const positionCount = lastAvantisSnapshot.positions?.length || 0;
      const timeSinceLastFetch = now - lastAvantisSnapshot.snapshotTime.getTime();

      // Dynamic interval based on position count
      // >5 positions = active trader = 120s (2min)
      // ≤5 positions = less active = 300s (5min)
      avantisInterval = positionCount > 5 ? 120000 : 300000;

      shouldFetchAvantis = timeSinceLastFetch > avantisInterval;
    }
    // If no snapshot exists, fetch (first time)
  } catch (error) {
    console.warn(`[IntervalManager] Error checking Avantis interval: ${error}`);
    // On error, default to fetching
    shouldFetchAvantis = true;
  }

  // LP: 300s interval (5 minutes, stable positions)
  let shouldFetchLP = true;
  const lpInterval = 300000;

  try {
    const lastLPSnapshot = await getLastSnapshot(managerId, 'aerodrome');

    if (lastLPSnapshot) {
      const timeSinceLastFetch = now - lastLPSnapshot.snapshotTime.getTime();
      shouldFetchLP = timeSinceLastFetch > lpInterval;
    }
    // If no snapshot exists, fetch (first time)
  } catch (error) {
    console.warn(`[IntervalManager] Error checking LP interval: ${error}`);
    // On error, default to fetching
    shouldFetchLP = true;
  }

  return {
    shouldFetchAvantis,
    shouldFetchHyperliquid,
    shouldFetchLP,
    avantisInterval,
    hyperliquidInterval,
    lpInterval,
  };
}

/**
 * Formats interval duration for logging
 */
export function formatInterval(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}
