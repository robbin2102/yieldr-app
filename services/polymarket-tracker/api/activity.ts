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
 * Fetch historical trades (TRADE + REDEEM) for last N days
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
      type: `${ACTIVITY_TYPES.TRADE},${ACTIVITY_TYPES.REDEEM}`,
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

  logger.success(`Fetched ${activities.length} activities (TRADE + REDEEM)`);

  return activities;
}

/**
 * Fetch new activities since a timestamp (for polling)
 * Used by poller to detect new trades
 */
export async function fetchNewActivity(
  walletAddress: string,
  sinceTimestamp: number
): Promise<ActivityResponse[]> {
  logger.debug(`Polling new activity for ${walletAddress} since ${new Date(sinceTimestamp * 1000).toISOString()}`);

  // Fetch page function
  const fetchPage = async (offset: number): Promise<ActivityResponse[]> => {
    const url = buildUrl('/activity', {
      user: walletAddress,
      type: `${ACTIVITY_TYPES.TRADE},${ACTIVITY_TYPES.REDEEM}`,
      start: sinceTimestamp,
      limit: CONFIG.LIMITS.ACTIVITY,
      offset,
      sortBy: 'TIMESTAMP',
      sortDirection: 'ASC', // Ascending to get oldest first
    });

    return fetchWithDelay<ActivityResponse[]>(url, 0); // No delay for polling
  };

  // Fetch all pages
  const activities = await fetchAllPaginated(
    fetchPage,
    CONFIG.LIMITS.ACTIVITY,
    10 // Max 10 pages for polling (should be enough)
  );

  if (activities.length > 0) {
    logger.success(`Found ${activities.length} new activities`);
  }

  return activities;
}
