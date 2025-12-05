import { apiClient } from './client';
import { config } from '../config';
import { ActivityResponse, Trade } from '../types/polymarket';
import { createLogger } from '../utils/logger';
import { fetchAllPaginated } from '../utils/pagination';

const logger = createLogger('API:Activity');

/**
 * Fetch historical trades for a wallet (last N days)
 */
export async function fetchHistoricalTrades(
  walletAddress: string,
  days: number = 30
): Promise<Trade[]> {
  logger.info(`Fetching historical trades for ${walletAddress} (last ${days} days)...`);

  const now = Math.floor(Date.now() / 1000);
  const start = now - days * 24 * 60 * 60;

  const fetchPage = async (offset: number, limit: number): Promise<ActivityResponse[]> => {
    const url = apiClient.buildUrl(config.api.endpoints.activity, {
      user: walletAddress.toLowerCase(),
      type: 'TRADE',
      start,
      limit,
      offset,
      sortBy: 'TIMESTAMP',
      sortDirection: 'DESC',
    });

    return await apiClient.fetchWithDelay<ActivityResponse[]>(url);
  };

  // Fetch with pagination (max 500 per request)
  const allTrades = await fetchAllPaginated<ActivityResponse>(
    fetchPage,
    500, // Max limit per API
    config.polymarket.apiDelayMs
  );

  logger.success(`Fetched ${allTrades.length} historical trades`);

  // Transform to our Trade type
  return allTrades.map((t) => ({
    walletAddress: walletAddress.toLowerCase(),
    conditionId: t.conditionId,
    asset: t.asset,
    transactionHash: t.transactionHash,
    title: t.title,
    slug: t.slug,
    outcome: t.outcome,
    outcomeIndex: t.outcomeIndex,
    side: t.side,
    size: t.size,
    price: t.price,
    usdcSize: t.usdcSize,
    timestamp: new Date(t.timestamp * 1000),
    detectedAt: new Date(),
  }));
}

/**
 * Fetch new trades since a given timestamp (for polling)
 */
export async function fetchNewTrades(
  walletAddress: string,
  sinceTimestamp: number
): Promise<Trade[]> {
  logger.debug(`Polling for new trades for ${walletAddress} since ${new Date(sinceTimestamp * 1000).toISOString()}...`);

  const url = apiClient.buildUrl(config.api.endpoints.activity, {
    user: walletAddress.toLowerCase(),
    type: 'TRADE',
    start: sinceTimestamp,
    limit: 500,
    sortBy: 'TIMESTAMP',
    sortDirection: 'ASC', // ASC to get oldest first when polling
  });

  const trades = await apiClient.fetchWithDelay<ActivityResponse[]>(url);

  if (trades.length > 0) {
    logger.success(`Found ${trades.length} new trades`);
  }

  // Transform to our Trade type
  return trades.map((t) => ({
    walletAddress: walletAddress.toLowerCase(),
    conditionId: t.conditionId,
    asset: t.asset,
    transactionHash: t.transactionHash,
    title: t.title,
    slug: t.slug,
    outcome: t.outcome,
    outcomeIndex: t.outcomeIndex,
    side: t.side,
    size: t.size,
    price: t.price,
    usdcSize: t.usdcSize,
    timestamp: new Date(t.timestamp * 1000),
    detectedAt: new Date(),
  }));
}
