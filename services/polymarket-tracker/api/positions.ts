/**
 * Fetch open positions from Polymarket API
 */

import { buildUrl, fetchWithDelay } from './client';
import { OpenPositionResponse } from '../types/polymarket';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { fetchAllPaginated } from '../utils/pagination';

const logger = createLogger('Positions API');

/**
 * Fetch all open positions for a wallet
 * API limit: 500 per call, pagination supported
 */
export async function fetchOpenPositions(
  walletAddress: string
): Promise<OpenPositionResponse[]> {
  logger.info(`Fetching open positions for ${walletAddress}`);

  // Fetch page function
  const fetchPage = async (offset: number): Promise<OpenPositionResponse[]> => {
    const url = buildUrl('/positions', {
      user: walletAddress,
      limit: CONFIG.LIMITS.OPEN_POSITIONS,
      offset,
    });

    return fetchWithDelay<OpenPositionResponse[]>(url);
  };

  // Fetch all pages
  const positions = await fetchAllPaginated(
    fetchPage,
    CONFIG.LIMITS.OPEN_POSITIONS
  );

  logger.success(`Fetched ${positions.length} open positions`);

  return positions;
}
