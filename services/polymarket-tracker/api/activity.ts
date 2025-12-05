/**
 * Fetch activity/trades from Polymarket API
 */

import { buildUrl, fetchWithDelay } from './client';
import { ActivityResponse } from '../types/polymarket';
import { CONFIG, ACTIVITY_TYPES } from '../config';
import { createLogger } from '../utils/logger';
import { fetchAllPaginated } from '../utils/pagination';

const logger = createLogger('Activity API');

/**
 * Fetch historical trades (TRADE type captures all buy/sell activity)
 * API limit: 500 per call, pagination supported
 */
export async function fetchHistoricalActivity(
  walletAddress: string,
  days: number = CONFIG.DAYS.HISTORICAL_TRADES
): Promise<ActivityResponse[]> {
  logger.info(`Fetching historical activity for ${walletAddress} (last ${days} days)`);

  const now = Math.floor(Date.now() / 1000);
  const start = now - days * 24 * 60 * 60;

  // Fetch page function
  const fetchPage = async (offset: number): Promise<ActivityResponse[]> => {
    const url = buildUrl('/activity', {
      user: walletAddress,
      type: ACTIVITY_TYPES.TRADE, // Only TRADE - captures all buy/sell activity
      start,
      limit: CONFIG.LIMITS.ACTIVITY,
      offset,
      sortBy: 'TIMESTAMP',
      sortDirection: 'DESC',
    });

    return fetchWithDelay<ActivityResponse[]>(url);
  };

  // Fetch all pages
  const activities = await fetchAllPaginated(
    fetchPage,
    CONFIG.LIMITS.ACTIVITY
  );

  logger.success(`Fetched ${activities.length} TRADE activities`);

  return activities;
}

/**
 * Fetch new activities since a timestamp (for polling)
 * Used by poller to detect new trades
 *
 * Optimized for 60s polling intervals:
 * - Uses precise time window (last 90s)
 * - Small limit (50) for efficiency
 * - No pagination needed for recent trades
 */
export async function fetchNewActivity(
  walletAddress: string,
  sinceTimestamp: number
): Promise<ActivityResponse[]> {
  const now = Math.floor(Date.now() / 1000);

  // For polling, use a precise window: last 90 seconds
  // (60s interval + 30s buffer for API delays)
  const windowStart = Math.max(sinceTimestamp, now - 90);

  logger.debug(
    `Polling ${walletAddress}: ${new Date(windowStart * 1000).toISOString()} to ${new Date(now * 1000).toISOString()}`
  );

  const url = buildUrl('/activity', {
    user: walletAddress,
    type: ACTIVITY_TYPES.TRADE, // Only TRADE - captures all buy/sell activity
    start: windowStart,
    end: now, // Bound the query to current time
    limit: 50, // Small limit for efficiency (enough for 60s of trading)
    sortBy: 'TIMESTAMP',
    sortDirection: 'ASC', // Ascending to get oldest first
  });

  const activities = await fetchWithDelay<ActivityResponse[]>(url, 0); // No delay for polling

  if (activities.length > 0) {
    logger.success(`Found ${activities.length} new activities`);
  }

  return activities;
}
