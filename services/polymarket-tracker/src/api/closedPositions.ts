import { apiClient } from './client';
import { config } from '../config';
import { ClosedPositionResponse, ClosedPosition } from '../types/polymarket';
import { createLogger } from '../utils/logger';
import { fetchAllPaginated } from '../utils/pagination';

const logger = createLogger('API:ClosedPositions');

export async function fetchClosedPositions(
  walletAddress: string,
  days: number = 30
): Promise<ClosedPosition[]> {
  logger.info(`Fetching closed positions for ${walletAddress} (last ${days} days)...`);

  const fetchPage = async (offset: number, limit: number): Promise<ClosedPositionResponse[]> => {
    const url = apiClient.buildUrl(config.api.endpoints.closedPositions, {
      user: walletAddress.toLowerCase(),
      limit,
      offset,
      sortBy: 'TIMESTAMP',
      sortDirection: 'DESC',
    });

    return await apiClient.fetchWithDelay<ClosedPositionResponse[]>(url);
  };

  // Fetch with pagination (max 50 per request)
  const allPositions = await fetchAllPaginated<ClosedPositionResponse>(
    fetchPage,
    50, // Max limit per API
    config.polymarket.apiDelayMs
  );

  // Filter to last N days
  const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000;
  const filteredPositions = allPositions.filter((p) => p.timestamp * 1000 >= cutoffTime);

  logger.success(
    `Fetched ${filteredPositions.length} closed positions (filtered from ${allPositions.length} total)`
  );

  // Transform to our ClosedPosition type
  return filteredPositions.map((p) => {
    const totalBet = p.avgPrice * p.totalBought;
    const amountWon = totalBet + p.realizedPnl;

    return {
      walletAddress: walletAddress.toLowerCase(),
      conditionId: p.conditionId,
      asset: p.asset,
      title: p.title,
      slug: p.slug,
      outcome: p.outcome,
      outcomeIndex: p.outcomeIndex,
      totalBought: p.totalBought,
      avgPrice: p.avgPrice,
      realizedPnl: p.realizedPnl,
      totalBet,
      amountWon,
      roi: totalBet > 0 ? (p.realizedPnl / totalBet) * 100 : 0,
      won: p.realizedPnl > 0,
      closedAt: new Date(p.timestamp * 1000),
      endDate: new Date(p.endDate),
      fetchedAt: new Date(),
    };
  });
}
