import { apiClient } from './client';
import { config } from '../config';
import { PositionResponse, OpenPosition } from '../types/polymarket';
import { createLogger } from '../utils/logger';

const logger = createLogger('API:Positions');

export async function fetchOpenPositions(walletAddress: string): Promise<OpenPosition[]> {
  const url = apiClient.buildUrl(config.api.endpoints.positions, {
    user: walletAddress.toLowerCase(),
  });

  logger.info(`Fetching open positions for ${walletAddress}...`);

  const positions = await apiClient.fetchWithDelay<PositionResponse[]>(url);

  logger.success(`Fetched ${positions.length} open positions`);

  // Transform API response to our OpenPosition type
  return positions.map((p) => ({
    walletAddress: walletAddress.toLowerCase(),
    conditionId: p.conditionId,
    asset: p.asset,
    title: p.title,
    slug: p.slug,
    outcome: p.outcome,
    outcomeIndex: p.outcomeIndex,
    size: p.size,
    avgPrice: p.avgPrice,
    curPrice: p.curPrice,
    initialValue: p.initialValue,
    currentValue: p.currentValue,
    cashPnl: p.cashPnl,
    percentPnl: p.percentPnl,
    roi: p.initialValue > 0 ? (p.cashPnl / p.initialValue) * 100 : 0,
    endDate: new Date(p.endDate),
    redeemable: p.redeemable,
    fetchedAt: new Date(),
    updatedAt: new Date(),
  }));
}
