/**
 * Fetch closed positions from Polymarket API
 */

import { buildUrl, fetchWithDelay } from './client';
import { ClosedPositionResponse } from '../types/polymarket';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { fetchPaginatedWithTimeFilter } from '../utils/pagination';

const logger = createLogger('Closed Positions API');

/**
 * Fetch closed positions for a wallet (last N days)
 * API limit: 50 per call, pagination required
 */
export async function fetchClosedPositions(
  walletAddress: string,
  days: number = CONFIG.DAYS.CLOSED_POSITIONS
): Promise<ClosedPositionResponse[]> {
  logger.info(`Fetching closed positions for ${walletAddress} (last ${days} days)`);

  // Calculate cutoff timestamp (seconds)
  const cutoffTimestamp = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

  // Fetch page function
  const fetchPage = async (offset: number): Promise<ClosedPositionResponse[]> => {
    const url = buildUrl('/closed-positions', {
      user: walletAddress,
      limit: CONFIG.LIMITS.CLOSED_POSITIONS,
      offset,
      sortBy: 'TIMESTAMP',
      sortDirection: 'DESC',
    });

    return fetchWithDelay<ClosedPositionResponse[]>(url);
  };

  // Fetch all pages with time filter
  const positions = await fetchPaginatedWithTimeFilter(
    fetchPage,
    CONFIG.LIMITS.CLOSED_POSITIONS,
    cutoffTimestamp
  );

  logger.success(`Fetched ${positions.length} closed positions`);

  return positions;
}
